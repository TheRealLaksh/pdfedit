/** Page tools: rotate, delete, reorder, duplicate, insert, extract and split. */
import type * as MuPDF from "mupdf";
import type { EngineContext, ModuleChange, OcrPageState } from "../context";
import { apply, invert, multiply, transformRect } from "../geom";
import { encodeLatin1, parseContent, spliceContent } from "../content/tokenizer";
import type { Matrix, OcrPageResult, PageObject, Point } from "../types";
import { blankObject, removeAnnots, scrubStructure, subtypeOf } from "./annots";
import { cloneDocument } from "./clone";
import { embedImage } from "./imageData";
import { insertAnnotations } from "./insert";
import {
  arrayItems, assertPage, copyDict, markerId, newArrayOf, objectNumber, ownResources, pageSelection, pageTransform,
  readPageContent, withPage, writePageContent,
} from "./shared";

const INHERITED = ["Resources", "MediaBox", "CropBox", "Rotate"];

export function pageRefs(doc: MuPDF.PDFDocument): MuPDF.PDFObject[] {
  return Array.from({ length: doc.countPages() }, (_, i) => doc.findPage(i));
}

/**
 * Make exactly these page objects, in this order, the pages of the document. The tree is flattened; page
 * objects keep their identity, so bookmarks, links and form fields keep working.
 */
export function setPageList(doc: MuPDF.PDFDocument, refs: MuPDF.PDFObject[]): void {
  const root = doc.getTrailer().get("Root", "Pages");
  // pull inherited attributes down before any parent link changes
  for (const ref of refs)
    for (const key of INHERITED)
      if (ref.get(key).isNull() && !ref.get("Parent").isNull()) {
        const value = ref.getInheritable(key);
        if (!value.isNull()) ref.put(key, value);
      }
  for (const ref of refs) ref.put("Parent", root);
  root.put("Kids", newArrayOf(doc, refs));
  root.put("Count", doc.newInteger(refs.length));
}

/* ---------- state that is keyed by page index ---------- */

/** `to(old)` is the new index of a page, or null when the page is gone */
function remapState(ctx: EngineContext, to: (old: number) => number | null): void {
  for (const [id, object] of Object.entries(ctx.state.objects)) {
    const next = to(object.page);
    if (next === null) delete ctx.state.objects[id];
    else object.page = next;
  }
  const ocr: Record<number, OcrPageState> = {};
  for (const [key, entry] of Object.entries(ctx.state.ocr)) {
    const next = to(Number(key));
    if (next === null) continue;
    entry.result.page = next;
    ocr[next] = entry;
  }
  ctx.state.ocr = ocr;
}

const from = (start: number, count: number) => Array.from({ length: Math.max(0, count - start) }, (_, i) => start + i);

/* ---------- rotate ---------- */

export async function rotatePages(ctx: EngineContext, pages: number[], degrees: 90 | 180 | 270): Promise<ModuleChange> {
  const selected = pageSelection(ctx.doc, pages);
  if (!selected.length) throw new Error("No pages selected");
  for (const index of selected) {
    const before = pageTransform(ctx.doc, index);
    const ref = ctx.doc.findPage(index);
    const current = ref.getInheritable("Rotate");
    const rotate = ((((current.isNumber() ? current.asNumber() : 0) + degrees) % 360) + 360) % 360;
    ref.put("Rotate", ctx.doc.newInteger(rotate));
    // old page space -> new page space
    const delta = multiply(invert(before), pageTransform(ctx.doc, index));
    for (const object of Object.values(ctx.state.objects))
      if (object.page === index) turnObject(object, delta, degrees);
    const ocr = ctx.state.ocr[index];
    if (ocr) turnOcr(ocr.result, delta);
  }
  return { changedPages: selected };
}

function turnObject(object: PageObject, delta: Matrix, degrees: number): void {
  const [x0, y0, x1, y1] = object.rect;
  const [cx, cy] = apply(delta, [(x0 + x1) / 2, (y0 + y1) / 2]);
  let w = x1 - x0;
  let h = y1 - y0;
  if (object.kind === "text" || object.kind === "image") {
    object.rotation = ((object.rotation ?? 0) + degrees) % 360;
  } else {
    if (degrees !== 180) [w, h] = [h, w];
    const turn = (p: Point) => apply(delta, p);
    if (object.kind === "line" || object.kind === "arrow") {
      object.from = turn(object.from);
      object.to = turn(object.to);
    } else if (object.kind === "ink") object.paths = object.paths.map((path) => path.map(turn));
  }
  object.rect = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

function turnOcr(result: OcrPageResult, delta: Matrix): void {
  for (const line of result.lines) {
    line.rect = transformRect(delta, line.rect);
    if (line.baseline) line.baseline = [apply(delta, line.baseline[0]), apply(delta, line.baseline[1])];
    for (const word of line.words) word.rect = transformRect(delta, word.rect);
  }
}

/* ---------- delete / reorder ---------- */

function namedDestinations(doc: MuPDF.PDFDocument): (name: string) => MuPDF.PDFObject | null {
  let tree: Record<string, MuPDF.PDFObject> | null = null;
  return (name) => {
    const old = doc.getTrailer().get("Root", "Dests", name);
    if (!old.isNull()) return old;
    tree ??= doc.loadNameTree("Dests") ?? {};
    return tree[name] ?? null;
  };
}

/** object number of the page a link / bookmark dictionary jumps to inside this document, or 0 */
export function destinationPage(
  doc: MuPDF.PDFDocument,
  item: MuPDF.PDFObject,
  named = namedDestinations(doc),
): number {
  let dest = item.get("Dest");
  const action = item.get("A");
  if (dest.isNull() && !action.isNull()) {
    const kind = action.get("S");
    if (kind.isName() && kind.asName() === "GoTo") dest = action.get("D");
  }
  if (dest.isName() || dest.isString()) {
    const found = named(dest.isName() ? dest.asName() : dest.asString());
    if (!found) return 0;
    dest = found;
  }
  if (dest.isDictionary()) dest = dest.get("D");
  return dest.isArray() && dest.length ? objectNumber(dest.get(0)) : 0;
}

/** remove bookmarks that lead to deleted pages (children are kept, so their parent stays as a heading) */
function pruneOutlines(doc: MuPDF.PDFDocument, gone: Set<number>): void {
  const root = doc.getTrailer().get("Root", "Outlines");
  if (root.isNull()) return;
  const named = namedDestinations(doc);
  const seen = new Set<number>();
  const prune = (parent: MuPDF.PDFObject): number => {
    const kept: MuPDF.PDFObject[] = [];
    let visible = 0;
    for (let item = parent.get("First"); item.isDictionary(); item = item.get("Next")) {
      const number = objectNumber(item);
      if (seen.has(number)) break;
      seen.add(number);
      const below = item.get("First").isNull() ? 0 : prune(item);
      const dead = gone.has(destinationPage(doc, item, named));
      if (dead && item.get("First").isNull()) continue;
      if (dead) {
        item.delete("Dest");
        item.delete("A");
      }
      kept.push(item);
      visible += 1 + (item.get("Count").isNumber() && item.get("Count").asNumber() > 0 ? below : 0);
    }
    for (const key of ["First", "Last", "Count"]) parent.delete(key);
    kept.forEach((item, i) => {
      item.delete("Prev");
      item.delete("Next");
      if (i > 0) item.put("Prev", kept[i - 1]);
      if (i + 1 < kept.length) item.put("Next", kept[i + 1]);
    });
    if (kept.length) {
      parent.put("First", kept[0]);
      parent.put("Last", kept.at(-1));
      parent.put("Count", doc.newInteger(visible));
    }
    return visible;
  };
  prune(root);
}

/** remove pages and everything that would keep their content alive in the saved file */
export function discardPages(doc: MuPDF.PDFDocument, keep: MuPDF.PDFObject[]): void {
  const kept = new Set(keep.map(objectNumber));
  const removed = pageRefs(doc).filter((ref) => !kept.has(objectNumber(ref)));
  const gone = new Set(removed.map(objectNumber));
  if (gone.size) {
    const named = namedDestinations(doc);
    for (const page of keep)
      removeAnnots(doc, page, (a, subtype) => subtype === "Link" && gone.has(destinationPage(doc, a, named)));
    pruneOutlines(doc, gone);
    scrubStructure(doc, gone);
    const catalog = doc.getTrailer().get("Root");
    const open = catalog.get("OpenAction");
    if (!open.isNull()) {
      const probe = doc.newDictionary();
      probe.put(open.isArray() ? "Dest" : "A", open);
      if (gone.has(destinationPage(doc, probe, named))) catalog.delete("OpenAction");
    }
  }
  const shared = new Set(
    keep.flatMap((page) => arrayItems(page.get("Annots")).map(objectNumber)),
  );
  setPageList(doc, keep);
  for (const page of removed) {
    removeAnnots(doc, page, (a) => !shared.has(objectNumber(a)));
    blankObject(page);
  }
}

export async function deletePages(ctx: EngineContext, pages: number[]): Promise<ModuleChange> {
  const selected = pageSelection(ctx.doc, pages);
  const count = ctx.doc.countPages();
  if (!selected.length) throw new Error("No pages selected");
  if (selected.length >= count) throw new Error("A document needs at least one page");
  const drop = new Set(selected);
  discardPages(ctx.doc, pageRefs(ctx.doc).filter((_, i) => !drop.has(i)));
  remapState(ctx, (old) => (drop.has(old) ? null : old - selected.filter((s) => s < old).length));
  return { changedPages: from(Math.min(selected[0]!, count - selected.length - 1), count - selected.length) };
}

export async function reorderPages(ctx: EngineContext, order: number[]): Promise<ModuleChange> {
  const count = ctx.doc.countPages();
  if (order.length !== count || new Set(order).size !== count) throw new Error("The new page order is not complete");
  order.forEach((p) => assertPage(ctx.doc, p));
  const refs = pageRefs(ctx.doc);
  setPageList(ctx.doc, order.map((old) => refs[old]!));
  const position = new Map(order.map((old, i) => [old, i]));
  remapState(ctx, (old) => position.get(old) ?? null);
  return { changedPages: order.flatMap((old, i) => (old === i ? [] : [i])) };
}

/* ---------- duplicate ---------- */

/**
 * Copy a widget so that it belongs to the same field as the original (the PDF way of showing one value in
 * two places).
 */
function twinWidget(doc: MuPDF.PDFDocument, widget: MuPDF.PDFObject): MuPDF.PDFObject {
  let parent = widget.get("Parent");
  if (!widget.get("T").isNull() || parent.isNull()) {
    // field and widget are one dictionary: split the field off so that it can have two widgets
    const field = doc.addObject(doc.newDictionary());
    for (const key of ["FT", "T", "TU", "TM", "V", "DV", "Ff", "Opt", "MaxLen", "DA", "DS", "RV", "Q", "AA", "I", "TI", "Lock", "SV"]) {
      const value = widget.get(key);
      if (value.isNull()) continue;
      field.put(key, value);
      widget.delete(key);
    }
    const holder = parent.isNull() ? doc.getTrailer().get("Root", "AcroForm") : parent;
    const key = parent.isNull() ? "Fields" : "Kids";
    const number = objectNumber(widget);
    if (!holder.isNull()) {
      const list = arrayItems(holder.get(key));
      const at = list.findIndex((item) => objectNumber(item) === number);
      if (at >= 0) list[at] = field;
      else list.push(field);
      holder.put(key, newArrayOf(doc, list));
    }
    if (!parent.isNull()) field.put("Parent", parent);
    field.put("Kids", newArrayOf(doc, [widget]));
    widget.put("Parent", field);
    parent = field;
  }
  const copy = doc.addObject(copyDict(doc, widget));
  parent.get("Kids").push(copy);
  return copy;
}

export async function duplicatePage(ctx: EngineContext, page: number): Promise<ModuleChange> {
  const { doc } = ctx;
  assertPage(doc, page);
  const refs = pageRefs(doc);
  const source = refs[page]!;
  const dict = copyDict(doc, source, ["Annots", "StructParents", "Parent", "B"]);
  for (const key of INHERITED) {
    const value = source.getInheritable(key);
    if (!value.isNull()) dict.put(key, value);
  }
  const copy = doc.addObject(dict);
  const annots = arrayItems(source.get("Annots")).filter((a) => subtypeOf(a) !== "Popup");
  if (annots.length) {
    const twins = annots.map((annot) => {
      const twin =
        subtypeOf(annot) === "Widget" && annot.isIndirect()
          ? twinWidget(doc, annot)
          : doc.addObject(copyDict(doc, annot, ["Popup", "IRT", "StructParent"]));
      twin.put("P", copy);
      return twin;
    });
    copy.put("Annots", newArrayOf(doc, twins));
  }
  copy.put("Parent", source.get("Parent"));
  refs.splice(page + 1, 0, copy);
  setPageList(doc, refs);

  const objects = Object.values(ctx.state.objects).filter((o) => o.page === page);
  const ocr = ctx.state.ocr[page] ? structuredClone(ctx.state.ocr[page]) : null;
  remapState(ctx, (old) => (old > page ? old + 1 : old));
  if (objects.length) renameObjects(ctx, page + 1, objects.map((o) => o.id));
  if (ocr) {
    ocr.result.page = page + 1;
    ocr.pageObject = copy.asIndirect();
    ctx.state.ocr[page + 1] = ocr;
  }
  return { changedPages: from(page + 1, doc.countPages()) };
}

/** give the objects drawn on a copied page their own ids and registry entries */
function renameObjects(ctx: EngineContext, index: number, ids: string[]): void {
  withPage(ctx.doc, index, (page) => {
    const resources = ownResources(ctx.doc, page);
    const content = readPageContent(page);
    const renamed = new Map(ids.map((id) => [id, ctx.newId("obj")]));
    const edits = parseContent(content).flatMap((op) => {
      const next = renamed.get(markerId(op, resources) ?? "");
      return next ? [{ start: op.start, end: op.end, replacement: `/PEObj <</PEId (${next})>> BDC` }] : [];
    });
    writePageContent(ctx.doc, page, spliceContent(content, edits));
    // registry order is stacking order
    for (const [oldId, newId] of renamed)
      ctx.state.objects[newId] = { ...structuredClone(ctx.state.objects[oldId]!), id: newId, page: index };
  });
}

/* ---------- insert ---------- */

function insertPosition(doc: MuPDF.PDFDocument, at: number): number {
  return Math.max(0, Math.min(doc.countPages(), Number.isFinite(at) ? Math.trunc(at) : doc.countPages()));
}

/** splice new page objects in and move page-indexed state out of the way */
function insertRefs(ctx: EngineContext, at: number, added: MuPDF.PDFObject[]): ModuleChange {
  const refs = pageRefs(ctx.doc);
  refs.splice(at, 0, ...added);
  setPageList(ctx.doc, refs);
  remapState(ctx, (old) => (old >= at ? old + added.length : old));
  return { changedPages: from(at, ctx.doc.countPages()) };
}

function newPage(doc: MuPDF.PDFDocument, width: number, height: number, resources: unknown, content: Uint8Array) {
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("Page"));
  dict.put("MediaBox", newArrayOf(doc, [0, 0, doc.newReal(width), doc.newReal(height)]));
  dict.put("Resources", resources);
  dict.put("Contents", doc.addStream(content, doc.newDictionary()));
  return doc.addObject(dict);
}

export async function insertBlankPage(ctx: EngineContext, at: number, width: number, height: number): Promise<ModuleChange> {
  if (!(width > 0 && height > 0)) throw new Error("Invalid page size");
  const clamp = (v: number) => Math.min(14400, Math.max(3, v));
  const position = insertPosition(ctx.doc, at);
  const page = newPage(ctx.doc, clamp(width), clamp(height), ctx.doc.newDictionary(), encodeLatin1(""));
  return insertRefs(ctx, position, [page]);
}

export async function insertPdf(ctx: EngineContext, bytes: Uint8Array, at: number, password?: string): Promise<ModuleChange> {
  let source: MuPDF.Document;
  try {
    source = ctx.mupdf.Document.openDocument(bytes, "application/pdf");
  } catch {
    throw new Error("This file could not be read as a PDF");
  }
  try {
    if (source.needsPassword()) {
      if (password === undefined) throw new Error("This PDF is password protected. Enter its password to insert it.");
      if (!source.authenticatePassword(password)) throw new Error("Wrong password for the PDF being inserted");
    }
    const pdf = source.asPDF();
    if (!pdf || pdf.countPages() < 1) throw new Error("This file has no pages that can be inserted");
    const position = insertPosition(ctx.doc, at);
    const map = ctx.doc.newGraftMap();
    const sources = pageRefs(pdf);
    const added = sources.map((page) => {
      const dict = ctx.doc.newDictionary();
      dict.put("Type", ctx.doc.newName("Page"));
      for (const key of ["Contents", "Resources", "MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox", "Rotate", "UserUnit", "Group"]) {
        const value = page.getInheritable(key);
        if (!value.isNull()) dict.put(key, map.graftObject(value));
      }
      return ctx.doc.addObject(dict);
    });
    const warnings = insertAnnotations(ctx.doc, pdf, map, sources, added);
    map.destroy();
    return { ...insertRefs(ctx, position, added), warnings };
  } finally {
    source.destroy();
  }
}

export async function insertImagesAsPages(ctx: EngineContext, images: Uint8Array[], at: number): Promise<ModuleChange> {
  if (!images.length) throw new Error("No images selected");
  const { doc } = ctx;
  // Engine.createFromImages fills a brand new journaled document outside of any operation
  const fresh = doc.countPages() === 0;
  if (fresh) doc.beginImplicitOperation();
  try {
    const position = insertPosition(doc, at);
    const added = images.map((data) => {
      const image = embedImage(ctx, data);
      const [width, height] = imagePageSize(image.width, image.height, image.dpi);
      const resources = doc.newDictionary();
      resources.put("XObject", { Im0: image.ref });
      const content = `q ${width.toFixed(3)} 0 0 ${height.toFixed(3)} 0 0 cm ${image.orient.join(" ")} cm /Im0 Do Q`;
      return newPage(doc, width, height, resources, encodeLatin1(content));
    });
    return insertRefs(ctx, position, added);
  } finally {
    if (fresh) doc.endOperation();
  }
}

/** real size for scans that say their resolution, otherwise an A4-sized long edge in the image's shape */
export function imagePageSize(width: number, height: number, dpi: number): [number, number] {
  if (dpi >= 100) {
    const w = (width * 72) / dpi;
    const h = (height * 72) / dpi;
    if (Math.max(w, h) >= 144 && Math.max(w, h) <= 1300) return [w, h];
  }
  const scale = 842 / Math.max(width, height);
  return [Math.max(3, width * scale), Math.max(3, height * scale)];
}

/* ---------- extract / split ---------- */

export function extractPages(ctx: EngineContext, pages: number[]): Uint8Array {
  const wanted = [...new Set(pages)];
  if (!wanted.length) throw new Error("No pages selected");
  wanted.forEach((p) => assertPage(ctx.doc, p));
  const clone = cloneDocument(ctx);
  try {
    const refs = pageRefs(clone);
    discardPages(clone, wanted.map((p) => refs[p]!));
    return clone.saveToBuffer("garbage=compact,compress,encrypt=none").asUint8Array().slice();
  } finally {
    clone.destroy();
  }
}

export function splitDocument(ctx: EngineContext, ranges: number[][]): Uint8Array[] {
  if (!ranges.length) throw new Error("No page ranges given");
  return ranges.map((range) => extractPages(ctx, range));
}
