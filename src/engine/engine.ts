/**
 * The engine: owns the open document, routes calls to modules, wraps every mutation in a journal
 * operation and keeps undo state. Runs inside the web worker, and directly in node tests.
 */
import * as mupdf from "mupdf";
import { createAssetLoader, emptyState, type AssetLoader, type DocState, type EngineContext, type ModuleChange } from "./context";
import type { DocInfo, EngineAPI, MutationResult, OpenResult, PageText, Rect } from "./types";
import * as text from "./text";
import * as fonts from "./fonts";
import * as ocr from "./ocr";
import * as ops from "./ops";

export class Engine implements EngineAPI {
  private doc: mupdf.PDFDocument | null = null;
  private ctx: EngineContext | null = null;
  private fileName = "document.pdf";
  private encrypted = false;
  private revisions: number[] = [];
  private revisionCounter = 1;
  private past: DocState[] = [];
  private future: DocState[] = [];
  private userFonts: EngineContext["userFonts"] = new Map();
  private ids = 0;

  constructor(private assets: AssetLoader = createAssetLoader()) {}

  /** for tests */
  get context(): EngineContext {
    if (!this.ctx) throw new Error("No document is open");
    return this.ctx;
  }

  async open(bytes: Uint8Array, fileName: string, password?: string): Promise<OpenResult> {
    let doc: mupdf.Document;
    try {
      doc = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch (e) {
      throw new Error(`This file could not be read as a PDF (${message(e)})`);
    }
    let encrypted = false;
    if (doc.needsPassword()) {
      encrypted = true;
      if (password === undefined || !doc.authenticatePassword(password)) {
        doc.destroy();
        return { status: "password", wrong: password !== undefined };
      }
    }
    const pdf = doc.asPDF();
    if (!pdf) throw new Error("This file is not a PDF");
    return this.adopt(pdf, fileName, encrypted);
  }

  async createFromImages(images: Uint8Array[], fileName: string): Promise<OpenResult> {
    const pdf = new mupdf.PDFDocument();
    this.adopt(pdf, fileName, false);
    pdf.beginOperation("Create from images");
    await ops.insertImagesAsPages(this.context, images, 0);
    pdf.endOperation();
    // creating the document is not an undoable step
    return this.adopt(new mupdf.PDFDocument(pdf.saveToBuffer("").asUint8Array().slice()), fileName, false);
  }

  private adopt(pdf: mupdf.PDFDocument, fileName: string, encrypted: boolean): OpenResult {
    if (pdf.countPages() < 0) throw new Error("This PDF has no pages");
    this.doc = pdf;
    this.fileName = fileName;
    this.encrypted = encrypted;
    this.past = [];
    this.future = [];
    pdf.enableJournal();
    this.ctx = {
      mupdf,
      doc: pdf,
      state: emptyState(),
      blobs: new Map(),
      userFonts: this.userFonts,
      assets: this.assets,
      cache: new Map(),
      newId: (prefix) => `${prefix}-${Date.now().toString(36)}-${(this.ids++).toString(36)}`,
    };
    this.revisions = Array.from({ length: pdf.countPages() }, () => this.revisionCounter++);
    return { status: "ok", doc: this.info() };
  }

  async close(): Promise<void> {
    this.ctx = null;
    this.doc?.destroy();
    this.doc = null;
  }

  private info(): DocInfo {
    const doc = this.context.doc;
    const count = doc.countPages();
    const pages = [];
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      pages.push({ width: x1 - x0, height: y1 - y0, revision: (this.revisions[i] ??= this.revisionCounter++) });
      page.destroy();
    }
    const form = doc.getTrailer().get("Root", "AcroForm");
    const fields = form.isNull() ? null : form.get("Fields");
    const sigFlags = form.isNull() ? null : form.get("SigFlags");
    return {
      fileName: this.fileName,
      pageCount: count,
      pages,
      encrypted: this.encrypted,
      signed: !!sigFlags && sigFlags.isNumber() && (sigFlags.asNumber() & 1) === 1,
      hasForms: !!fields && fields.isArray() && fields.length > 0,
      repaired: doc.wasRepaired(),
    };
  }

  async renderPage(page: number, scale: number, clip?: Rect) {
    const ctx = this.context;
    const p = ctx.doc.loadPage(page);
    const bounds = p.getBounds();
    // pixel box in device space
    const area = clip
      ? [clip[0] + bounds[0], clip[1] + bounds[1], clip[2] + bounds[0], clip[3] + bounds[1]]
      : bounds;
    const bbox: Rect = [
      Math.floor(area[0]! * scale),
      Math.floor(area[1]! * scale),
      Math.ceil(area[2]! * scale),
      Math.ceil(area[3]! * scale),
    ];
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    p.run(device, mupdf.Matrix.scale(scale, scale));
    device.close();
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const data = new Uint8ClampedArray(pixmap.getPixels()) as Uint8ClampedArray<ArrayBuffer>;
    device.destroy();
    pixmap.destroy();
    p.destroy();
    return { page, revision: this.revisions[page]!, width, height, data };
  }

  /* ---------- mutation plumbing ---------- */

  private async mutate(name: string, fn: (ctx: EngineContext) => Promise<ModuleChange> | ModuleChange): Promise<MutationResult> {
    const ctx = this.context;
    const before = structuredClone(ctx.state);
    ctx.cache.clear();
    const position = ctx.doc.getJournal().position;
    ctx.doc.beginOperation(name);
    let change: ModuleChange;
    try {
      change = await fn(ctx);
    } catch (e) {
      ctx.doc.abandonOperation();
      ctx.state = before;
      this.invalidate(ctx);
      throw e;
    }
    ctx.doc.endOperation();
    this.invalidate(ctx);
    // MuPDF drops operations that changed nothing: only record a step it can actually undo
    if (ctx.doc.getJournal().position > position) {
      this.past.push(before);
      this.future = [];
    }
    return this.result(change);
  }

  /** MuPDF keeps parsed fonts and images in a store and does not notice changed objects: drop it. */
  private invalidate(ctx: EngineContext): void {
    ctx.cache.clear();
    mupdf.emptyStore();
  }

  private result(change: ModuleChange): MutationResult {
    const doc = this.context.doc;
    const count = doc.countPages();
    this.revisions.length = Math.min(this.revisions.length, count);
    for (const p of change.changedPages) if (p >= 0 && p < count) this.revisions[p] = this.revisionCounter++;
    return {
      doc: this.info(),
      changedPages: change.changedPages,
      warnings: change.warnings ?? [],
      // internal names some producers give embedded fonts mean nothing to the user
      fallbackFonts: [...new Set(change.fallbackFonts ?? [])].filter(
        (n) => !/^(OTS-derived-font|CIDFont\+|[FT]\d+(_\d+)?$)/i.test(n),
      ),
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      createdId: change.createdId,
      count: change.count,
    };
  }

  private allPages(): number[] {
    return Array.from({ length: this.context.doc.countPages() }, (_, i) => i);
  }

  async undo(): Promise<MutationResult> {
    const ctx = this.context;
    const previous = this.past.pop();
    if (!previous || !ctx.doc.canUndo()) return this.result({ changedPages: [] });
    this.future.push(structuredClone(ctx.state));
    ctx.doc.undo();
    ctx.state = previous;
    this.invalidate(ctx);
    return this.result({ changedPages: this.allPages() });
  }

  async redo(): Promise<MutationResult> {
    const ctx = this.context;
    const next = this.future.pop();
    if (!next || !ctx.doc.canRedo()) return this.result({ changedPages: [] });
    this.past.push(structuredClone(ctx.state));
    ctx.doc.redo();
    ctx.state = next;
    this.invalidate(ctx);
    return this.result({ changedPages: this.allPages() });
  }

  /* ---------- text ---------- */

  async getPageText(page: number): Promise<PageText> {
    const base = text.analyzePage(this.context, page);
    const merged = ocr.mergePageText(this.context, base);
    return { ...merged, revision: this.revisions[page]! };
  }

  editLines: EngineAPI["editLines"] = (page, edits) =>
    this.mutate("Edit text", async (ctx) => {
      const ocrEdits = edits.filter((e) => e.lineId.startsWith("ocr:"));
      const contentEdits = edits.filter((e) => !e.lineId.startsWith("ocr:"));
      const changes: ModuleChange[] = [];
      // content edits first: their line ids come from the current page revision
      if (contentEdits.length) changes.push(await text.editLines(ctx, page, contentEdits));
      if (ocrEdits.length) changes.push(await ocr.editOcrLines(ctx, page, ocrEdits));
      return mergeChanges(changes);
    });

  findText: EngineAPI["findText"] = async (query, options) => text.findText(this.context, query, options);

  replaceText: EngineAPI["replaceText"] = (query, replacement, options, matches) =>
    this.mutate("Replace text", (ctx) => text.replaceText(ctx, query, replacement, options, matches));

  /* ---------- fonts ---------- */

  listFonts: EngineAPI["listFonts"] = async () => fonts.listFonts(this.context);

  addUserFont: EngineAPI["addUserFont"] = async (name, bytes) => fonts.addUserFont(this.context, name, bytes);

  /* ---------- OCR ---------- */

  setOcrResult: EngineAPI["setOcrResult"] = (result) =>
    this.mutate("Recognise text", (ctx) => ocr.setOcrResult(ctx, result));

  makeSearchable: EngineAPI["makeSearchable"] = (pages) =>
    this.mutate("Make searchable", (ctx) => ocr.makeSearchable(ctx, pages));

  /* ---------- objects, images, forms, pages, export ---------- */

  listObjects: EngineAPI["listObjects"] = async (page) => ops.listObjects(this.context, page);
  addObject: EngineAPI["addObject"] = (object) => this.mutate("Add", (ctx) => ops.addObject(ctx, object));
  updateObject: EngineAPI["updateObject"] = (object) => this.mutate("Change", (ctx) => ops.updateObject(ctx, object));
  removeObject: EngineAPI["removeObject"] = (id) => this.mutate("Remove", (ctx) => ops.removeObject(ctx, id));

  listImages: EngineAPI["listImages"] = async (page) => ops.listImages(this.context, page);
  moveImage: EngineAPI["moveImage"] = (page, id, rect) =>
    this.mutate("Move image", (ctx) => ops.moveImage(ctx, page, id, rect));
  deleteImage: EngineAPI["deleteImage"] = (page, id) =>
    this.mutate("Delete image", (ctx) => ops.deleteImage(ctx, page, id));
  replaceImage: EngineAPI["replaceImage"] = (page, id, data) =>
    this.mutate("Replace image", (ctx) => ops.replaceImage(ctx, page, id, data));

  listFormFields: EngineAPI["listFormFields"] = async () => ops.listFormFields(this.context);
  setFormField: EngineAPI["setFormField"] = (page, id, value) =>
    this.mutate("Fill field", (ctx) => ops.setFormField(ctx, page, id, value));

  rotatePages: EngineAPI["rotatePages"] = (pages, degrees) =>
    this.mutate("Rotate pages", (ctx) => ops.rotatePages(ctx, pages, degrees));
  deletePages: EngineAPI["deletePages"] = (pages) => this.mutate("Delete pages", (ctx) => ops.deletePages(ctx, pages));
  reorderPages: EngineAPI["reorderPages"] = (order) =>
    this.mutate("Reorder pages", (ctx) => ops.reorderPages(ctx, order));
  duplicatePage: EngineAPI["duplicatePage"] = (page) =>
    this.mutate("Duplicate page", (ctx) => ops.duplicatePage(ctx, page));
  insertBlankPage: EngineAPI["insertBlankPage"] = (at, w, h) =>
    this.mutate("Insert page", (ctx) => ops.insertBlankPage(ctx, at, w, h));
  insertPdf: EngineAPI["insertPdf"] = (bytes, at, password) =>
    this.mutate("Insert PDF", (ctx) => ops.insertPdf(ctx, bytes, at, password));
  insertImagesAsPages: EngineAPI["insertImagesAsPages"] = (images, at) =>
    this.mutate("Insert images", (ctx) => ops.insertImagesAsPages(ctx, images, at));
  extractPages: EngineAPI["extractPages"] = async (pages) => ops.extractPages(this.context, pages);
  splitDocument: EngineAPI["splitDocument"] = async (ranges) => ops.splitDocument(this.context, ranges);

  redactAreas: EngineAPI["redactAreas"] = (page, rects) =>
    this.mutate("Redact", (ctx) => ops.redactAreas(ctx, page, rects));
  addWatermark: EngineAPI["addWatermark"] = (options) =>
    this.mutate("Watermark", (ctx) => ops.addWatermark(ctx, options));
  addPageNumbers: EngineAPI["addPageNumbers"] = (options) =>
    this.mutate("Page numbers", (ctx) => ops.addPageNumbers(ctx, options));

  exportPdf: EngineAPI["exportPdf"] = async (options) => ops.exportPdf(this.context, options);
  exportPageImage: EngineAPI["exportPageImage"] = async (page, dpi, format) =>
    ops.exportPageImage(this.context, page, dpi, format);
  exportText: EngineAPI["exportText"] = async (pages) => ops.exportText(this.context, pages);
}

function mergeChanges(changes: ModuleChange[]): ModuleChange {
  return {
    changedPages: [...new Set(changes.flatMap((c) => c.changedPages))],
    warnings: changes.flatMap((c) => c.warnings ?? []),
    fallbackFonts: changes.flatMap((c) => c.fallbackFonts ?? []),
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
