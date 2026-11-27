/** Small helpers shared by the OPS files. */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { addResource, ownResources, readPageContent, writePageContent } from "../content/page";
import { concatBytes, encodeLatin1, parseContent, type Operation } from "../content/tokenizer";
import { num } from "../geom";
import type { Matrix, RGB, Rect } from "../types";

/** load a page, run `fn`, always release it (a page kept alive would be served stale after changes) */
export function withPage<T>(doc: MuPDF.PDFDocument, index: number, fn: (page: MuPDF.PDFPage) => T): T {
  assertPage(doc, index);
  const page = doc.loadPage(index);
  try {
    return fn(page);
  } finally {
    page.destroy();
  }
}

export function assertPage(doc: MuPDF.PDFDocument, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= doc.countPages())
    throw new Error(`Page ${index + 1} does not exist`);
}

/** user space -> page space */
export function pageTransform(doc: MuPDF.PDFDocument, index: number): Matrix {
  return withPage(doc, index, (p) => p.getTransform() as Matrix);
}

export function pageBounds(doc: MuPDF.PDFDocument, index: number): Rect {
  return withPage(doc, index, (p) => p.getBounds() as Rect);
}

/** valid, de-duplicated, sorted page indices; all pages when omitted */
export function pageSelection(doc: MuPDF.PDFDocument, pages?: number[]): number[] {
  if (!pages) return Array.from({ length: doc.countPages() }, (_, i) => i);
  for (const p of pages) assertPage(doc, p);
  return [...new Set(pages)].sort((a, b) => a - b);
}

export function normalizeRect(r: Rect): Rect {
  if (!r.every((v) => Number.isFinite(v))) throw new Error("Invalid rectangle");
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

export function contains(outer: Rect, inner: Rect, tolerance = 0.5): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  );
}

export const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

export const fillColor = (c: RGB) => `${c.map(num).join(" ")} rg`;
export const strokeColor = (c: RGB) => `${c.map(num).join(" ")} RG`;

export function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

export function streamBytes(obj: MuPDF.PDFObject): Uint8Array {
  return obj.readStream().asUint8Array().slice();
}

/** shallow copy of a dictionary (values are shared) */
export function copyDict(doc: MuPDF.PDFDocument, source: MuPDF.PDFObject, skip: string[] = []): MuPDF.PDFObject {
  const out = doc.newDictionary();
  if (!source.isNull())
    source.forEach((v, k) => {
      if (!skip.includes(String(k))) out.put(k, v);
    });
  return out;
}

/** a resource dictionary (and its category dictionaries) that can be changed without affecting anyone else */
export function copyResources(doc: MuPDF.PDFDocument, resources: MuPDF.PDFObject): MuPDF.PDFObject {
  const out = doc.newDictionary();
  if (!resources.isNull())
    resources.forEach((v, k) => {
      if (v.isDictionary()) out.put(k, copyDict(doc, v));
      else out.put(k, v);
    });
  return out;
}

export function arrayItems(obj: MuPDF.PDFObject): MuPDF.PDFObject[] {
  const out: MuPDF.PDFObject[] = [];
  if (obj.isArray()) for (let i = 0; i < obj.length; i++) out.push(obj.get(i));
  return out;
}

export function newArrayOf(doc: MuPDF.PDFDocument, items: unknown[]): MuPDF.PDFObject {
  const a = doc.newArray();
  for (const item of items) a.push(item);
  return a;
}

export function numbers(obj: MuPDF.PDFObject, fallback: number[]): number[] {
  if (!obj.isArray() || obj.length < fallback.length) return fallback;
  return fallback.map((_, i) => obj.get(i).asNumber());
}

export const objectNumber = (o: MuPDF.PDFObject) => (o.isIndirect() ? o.asIndirect() : 0);

/**
 * Append operators drawn in the page's default coordinate system. The existing content is wrapped in
 * q/Q only when it leaves the graphics state changed, so repeated appends never nest deeper.
 */
export function appendToPage(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, segment: string): void {
  const old = readPageContent(page);
  writePageContent(doc, page, concatBytes([isolate(old), encodeLatin1("\n" + segment + "\n")]));
}

const STATE_OPS = new Set(
  "cm gs w J j M d ri i CS cs SC SCN sc scn G g RG rg K k Tc Tw Tz TL Tf Tr Ts W W*".split(" "),
);

function isolate(content: Uint8Array): Uint8Array {
  let depth = 0;
  let lowest = 0;
  let text = false;
  let marked = 0;
  let dirty = false;
  for (const { op } of parseContent(content)) {
    if (op === "q") depth++;
    else if (op === "Q") lowest = Math.min(lowest, --depth);
    else if (op === "BT") text = true;
    else if (op === "ET") text = false;
    else if (op === "BMC" || op === "BDC") marked++;
    else if (op === "EMC") marked = Math.max(0, marked - 1);
    else if (depth <= 0 && STATE_OPS.has(op)) dirty = true;
  }
  if (!dirty && depth === 0 && lowest === 0 && !text && !marked) return content;
  const open = 1 - lowest;
  const close = (text ? "ET\n" : "") + "EMC\n".repeat(marked) + "Q\n".repeat(open + depth);
  return concatBytes([encodeLatin1("q\n".repeat(open)), content, encodeLatin1("\n" + close)]);
}

export interface Segment {
  ops: Operation[];
  /** index of the BDC and its EMC */
  first: number;
  last: number;
  start: number;
  end: number;
}

/** the id stored in a `/PEObj <</PEId (...)>> BDC` operator */
export function markerId(operation: Operation, resources: MuPDF.PDFObject): string | null {
  if (operation.op !== "BDC") return null;
  const [tag, props] = operation.operands;
  if (tag?.type !== "name" || tag.value !== "PEObj" || !props) return null;
  if (props.type === "dict") {
    const id = props.value.PEId;
    return id?.type === "string" ? latin1(id.value) : null;
  }
  if (props.type === "name") {
    const entry = resources.get("Properties", props.value, "PEId");
    return entry.isString() ? entry.asString() : null;
  }
  return null;
}

export function findSegment(content: Uint8Array, resources: MuPDF.PDFObject, id: string): Segment | null {
  const ops = parseContent(content);
  const first = ops.findIndex((o) => markerId(o, resources) === id);
  if (first < 0) return null;
  let depth = 0;
  for (let i = first; i < ops.length; i++) {
    const op = ops[i]!.op;
    if (op === "BMC" || op === "BDC") depth++;
    else if (op === "EMC" && --depth === 0)
      return { ops: ops.slice(first, i + 1), first, last: i, start: ops[first]!.start, end: ops[i]!.end };
  }
  return null;
}

export interface FormSpec {
  bbox: Rect;
  content: string;
  resources: MuPDF.PDFObject;
  /** composite as a unit (needed for opacity / blend modes) */
  group?: boolean;
}

export function makeForm(doc: MuPDF.PDFDocument, spec: FormSpec): MuPDF.PDFObject {
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Form"));
  dict.put("BBox", newArrayOf(doc, spec.bbox.map((v) => doc.newReal(v))));
  dict.put("Resources", spec.resources);
  if (spec.group) dict.put("Group", { S: "Transparency", I: true });
  return doc.addStream(encodeLatin1(spec.content), dict);
}

export function makeAlphaState(doc: MuPDF.PDFDocument, opacity: number, blend: "Normal" | "Multiply"): MuPDF.PDFObject {
  const gs = doc.newDictionary();
  gs.put("Type", doc.newName("ExtGState"));
  gs.put("ca", doc.newReal(opacity));
  gs.put("CA", doc.newReal(opacity));
  gs.put("BM", doc.newName(blend));
  return doc.addObject(gs);
}

export interface Placement {
  form: MuPDF.PDFObject;
  opacity: number;
  blend: "Normal" | "Multiply";
}

/** register the form (and its transparency state) on a page; returns `q ... Do Q` */
export function drawFormOps(
  ctx: EngineContext,
  page: MuPDF.PDFPage,
  resources: MuPDF.PDFObject,
  placement: Placement,
  toUser: Matrix,
): string {
  const name = addResource(ctx.doc, resources, "XObject", "PEf", placement.form);
  let gs = "";
  if (placement.opacity < 1 || placement.blend !== "Normal") {
    const state = makeAlphaState(ctx.doc, placement.opacity, placement.blend);
    gs = `/${addResource(ctx.doc, resources, "ExtGState", "PEg", state)} gs `;
  }
  return `q ${gs}${toUser.map(num).join(" ")} cm /${name} Do Q`;
}

export { addResource, ownResources, readPageContent, writePageContent };
