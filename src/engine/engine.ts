/**
 * The engine: owns the open document, routes calls to modules, wraps every mutation in a journal
 * operation and keeps undo state. Runs inside the web worker, and directly in node tests.
 */
import * as mupdf from "mupdf";
import { createAssetLoader, emptyState, type AssetLoader, type DocState, type EngineContext, type ModuleChange } from "./context";
import type { DocInfo, EngineAPI, EngineRequest, EngineResponse, MutationResult, OpenResult, PageText, Rect } from "./types";
import * as text from "./text";
import * as fonts from "./fonts";
import * as ocr from "./ocr";
import * as ops from "./ops";
import { inspectPage, type PageRisk } from "./ops/guard";

/** largest picture of a page that is drawn in one piece; bigger requests come back at a smaller scale */
const MAX_RENDER_PIXELS = 40_000_000;
const MAX_RENDER_SIDE = 16_000;

const DAMAGED = "This PDF is damaged: its pages could not be read.";
const NOT_PDF = "This file is not a PDF. Choose a PDF, or a PNG or JPEG picture.";

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
  /** part of new ids: the same file opened again gives the same ids, a different file different ones */
  private seed = "0";
  private risks = new Map<number, PageRisk>();

  constructor(private assets: AssetLoader = createAssetLoader()) {}

  /** for tests */
  get context(): EngineContext {
    if (!this.ctx) throw new Error("No document is open");
    return this.ctx;
  }

  async open(bytes: Uint8Array, fileName: string, password?: string): Promise<OpenResult> {
    if (!bytes.length) throw new Error("This file is empty, so there is no PDF to read.");
    // pictures given a .pdf name are still welcome
    if (isPicture(bytes)) return this.createFromImages([bytes], fileName.replace(/\.[^.]*$/, "") + ".pdf");
    let doc: mupdf.Document;
    try {
      doc = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch (e) {
      if (isFatalError(e)) throw e;
      const why = /crypt/i.test(message(e))
        ? "It is protected in a way that cannot be opened here, for example with a certificate"
        : "It may be damaged, incomplete or another kind of file";
      throw new Error(`This file could not be read as a PDF. ${why} (${message(e)})`);
    }
    let kept = false;
    try {
      let encrypted = false;
      if (doc.needsPassword()) {
        encrypted = true;
        if (password === undefined || !doc.authenticatePassword(password))
          return { status: "password", wrong: password !== undefined };
      }
      const pdf = doc.asPDF();
      if (!pdf) throw new Error(NOT_PDF);
      checkReadable(pdf);
      this.restartCounters(bytes, fileName);
      const result = this.adopt(pdf, fileName, encrypted);
      kept = true;
      return result;
    } finally {
      if (!kept) {
        try {
          doc.destroy();
        } catch {
          /* MuPDF may be past helping */
        }
      }
    }
  }

  async createFromImages(images: Uint8Array[], fileName: string): Promise<OpenResult> {
    if (!images.length) throw new Error("No pictures were chosen.");
    // built on the side: a picture that cannot be read leaves the open document alone
    const scratch = new mupdf.PDFDocument();
    let bytes: Uint8Array;
    try {
      scratch.enableJournal();
      scratch.beginOperation("Create from images");
      await ops.insertImagesAsPages(this.makeContext(scratch), images, 0);
      scratch.endOperation();
      bytes = scratch.saveToBuffer("").asUint8Array().slice();
    } finally {
      scratch.destroy();
    }
    this.restartCounters(images[0]!, fileName);
    // creating the document is not an undoable step
    return this.adopt(new mupdf.PDFDocument(bytes), fileName, false);
  }

  /** revisions and ids start over, so that doing the same things again gives the same results */
  private restartCounters(bytes: Uint8Array, fileName: string): void {
    this.revisionCounter = 1;
    this.ids = 0;
    this.seed = fingerprint(bytes, fileName);
  }

  private makeContext(pdf: mupdf.PDFDocument): EngineContext {
    return {
      mupdf,
      doc: pdf,
      state: emptyState(),
      blobs: new Map(),
      userFonts: this.userFonts,
      assets: this.assets,
      cache: new Map(),
      newId: (prefix) => `${prefix}-${this.seed}-${(this.ids++).toString(36)}`,
    };
  }

  /** make `pdf` the open document; the previous one stays if this one cannot be described */
  private adopt(pdf: mupdf.PDFDocument, fileName: string, encrypted: boolean): OpenResult {
    const { doc, ctx, past, future, revisions, risks } = this;
    const previous = { doc, ctx, fileName: this.fileName, encrypted: this.encrypted, past, future, revisions, risks };
    Object.assign(this, { doc: pdf, ctx: this.makeContext(pdf), fileName, encrypted, past: [], future: [] });
    this.revisions = [];
    this.risks = new Map();
    let info: DocInfo;
    try {
      // read once before the journal starts: MuPDF repairs broken page trees as it meets them
      info = this.info();
      pdf.enableJournal();
    } catch (e) {
      Object.assign(this, previous);
      throw e;
    }
    previous.doc?.destroy();
    return { status: "ok", doc: info };
  }

  async close(): Promise<void> {
    this.ctx = null;
    this.doc?.destroy();
    this.doc = null;
    this.risks.clear();
  }

  /** false when MuPDF no longer answers sensibly: the worker has to be replaced */
  healthy(): boolean {
    try {
      this.doc?.countPages();
      new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 1, 1], false).destroy();
      return true;
    } catch {
      return false;
    }
  }

  /** stop before work that would hang or crash on one of these pages (all pages when omitted) */
  private guard(kind: keyof PageRisk, pages?: number[] | number): void {
    const doc = this.context.doc;
    const count = doc.countPages();
    const list = typeof pages === "number" ? [pages] : (pages ?? Array.from({ length: count }, (_, i) => i));
    for (const page of list) {
      if (!Number.isInteger(page) || page < 0 || page >= count) continue; // the module reports this
      let risk = this.risks.get(page);
      if (!risk) {
        try {
          risk = inspectPage(doc, page);
        } catch (e) {
          if (isFatalError(e)) throw e;
          risk = {};
        }
        this.risks.set(page, risk);
      }
      const reason = risk[kind];
      if (reason) throw new Error(list.length > 1 ? `Page ${page + 1}: ${reason}` : reason);
    }
  }

  /** search options limited to the pages that can be read safely: one hostile page must not stop a search */
  private searchable<T extends { pages?: number[] }>(options: T = {} as T): T {
    const doc = this.context.doc;
    const wanted = options.pages ?? Array.from({ length: doc.countPages() }, (_, i) => i);
    const safe = wanted.filter((page) => {
      try {
        this.guard("edit", page);
        return true;
      } catch (e) {
        if (isFatalError(e)) throw e;
        return false;
      }
    });
    if (safe.length === wanted.length) return options;
    if (!safe.length) this.guard("edit", wanted[0]);
    return { ...options, pages: safe };
  }

  /**
   * A read that makes MuPDF repair something on the way (damaged form or page trees) is only allowed
   * inside an operation: run it again inside one that does not count as an undo step.
   */
  private lazily<T>(read: () => T): T {
    try {
      return read();
    } catch (e) {
      if (!/alter an object other than in an operation/i.test(message(e))) throw e;
      const doc = this.context.doc;
      doc.beginImplicitOperation();
      try {
        return read();
      } finally {
        doc.endOperation();
      }
    }
  }

  private info(): DocInfo {
    const doc = this.context.doc;
    const count = doc.countPages();
    const pages = [];
    for (let i = 0; i < count; i++) {
      // one broken page must not take the whole document with it
      let width = 612;
      let height = 792;
      try {
        const page = doc.loadPage(i);
        const [x0, y0, x1, y1] = page.getBounds();
        page.destroy();
        if (Number.isFinite(x1 - x0) && Number.isFinite(y1 - y0)) [width, height] = [x1 - x0, y1 - y0];
      } catch (e) {
        if (isFatalError(e) || /alter an object/i.test(message(e))) throw e;
      }
      pages.push({ width, height, revision: (this.revisions[i] ??= this.revisionCounter++) });
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
      xfa: !form.isNull() && !form.get("XFA").isNull(),
      restricted: !this.encrypted && !doc.getTrailer().get("Encrypt").isNull() && !doc.hasPermission("edit"),
    };
  }

  async renderPage(page: number, scale: number, clip?: Rect) {
    this.guard("render", page);
    return this.lazily(() => this.draw(page, scale, clip));
  }

  private draw(page: number, requested: number, clip?: Rect) {
    const ctx = this.context;
    const p = ctx.doc.loadPage(page);
    let pixmap: mupdf.Pixmap | null = null;
    let device: mupdf.DrawDevice | null = null;
    try {
      const bounds = p.getBounds();
      // pixel box in device space
      const area = clip
        ? [clip[0] + bounds[0], clip[1] + bounds[1], clip[2] + bounds[0], clip[3] + bounds[1]]
        : bounds;
      const w = Math.abs(area[2]! - area[0]!);
      const h = Math.abs(area[3]! - area[1]!);
      if (!(requested > 0) || !Number.isFinite(requested * (w + h))) throw new Error("This page has no usable size.");
      const scale = Math.min(
        requested,
        Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, w * h)),
        MAX_RENDER_SIDE / Math.max(1, w, h),
      );
      const bbox: Rect = [
        Math.floor(area[0]! * scale),
        Math.floor(area[1]! * scale),
        Math.ceil(area[2]! * scale),
        Math.ceil(area[3]! * scale),
      ];
      if (bbox[2] <= bbox[0]) bbox[2] = bbox[0] + 1;
      if (bbox[3] <= bbox[1]) bbox[3] = bbox[1] + 1;
      pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
      pixmap.clear(255);
      device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      p.run(device, mupdf.Matrix.scale(scale, scale));
      device.close();
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const data = new Uint8ClampedArray(pixmap.getPixels()) as Uint8ClampedArray<ArrayBuffer>;
      return { page, revision: this.revisions[page]!, width, height, data };
    } finally {
      device?.destroy();
      pixmap?.destroy();
      p.destroy();
    }
  }

  /* ---------- mutation plumbing ---------- */

  private async mutate(name: string, fn: (ctx: EngineContext) => Promise<ModuleChange> | ModuleChange): Promise<MutationResult> {
    const ctx = this.context;
    const before = structuredClone(ctx.state);
    const ids = this.ids;
    ctx.cache.clear();
    const position = ctx.doc.getJournal().position;
    ctx.doc.beginOperation(name);
    let change: ModuleChange;
    try {
      change = await fn(ctx);
    } catch (e) {
      ctx.state = before;
      this.ids = ids;
      // after a failure deep inside MuPDF the operation may be gone: keep the original error
      try {
        ctx.doc.abandonOperation();
        this.invalidate(ctx);
      } catch {
        /* the worker checks healthy() and replaces itself */
      }
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
    this.risks.clear();
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
    this.guard("edit", page);
    const merged = this.lazily(() => ocr.mergePageText(this.context, text.analyzePage(this.context, page)));
    return { ...merged, revision: this.revisions[page]! };
  }

  editLines: EngineAPI["editLines"] = (page, edits) =>
    this.mutate("Edit text", async (ctx) => {
      this.guard("edit", page);
      const ocrEdits = edits.filter((e) => e.lineId.startsWith("ocr:"));
      const contentEdits = edits.filter((e) => !e.lineId.startsWith("ocr:"));
      const changes: ModuleChange[] = [];
      // content edits first: their line ids come from the current page revision
      if (contentEdits.length) changes.push(await text.editLines(ctx, page, contentEdits));
      if (ocrEdits.length) changes.push(await ocr.editOcrLines(ctx, page, ocrEdits));
      return mergeChanges(changes);
    });

  findText: EngineAPI["findText"] = async (query, options) => {
    return text.findText(this.context, query, this.searchable(options));
  };

  replaceText: EngineAPI["replaceText"] = (query, replacement, options, matches) =>
    this.mutate("Replace text", (ctx) => {
      return text.replaceText(ctx, query, replacement, this.searchable(options), matches);
    });

  /* ---------- fonts ---------- */

  listFonts: EngineAPI["listFonts"] = async () => fonts.listFonts(this.context);

  getLineFont: EngineAPI["getLineFont"] = async (page, lineId) => text.getLineFont(this.context, page, lineId);
  getChoiceFont: EngineAPI["getChoiceFont"] = async (id, bold, italic) =>
    fonts.getChoiceFont(this.context, id, bold, italic);

  addUserFont: EngineAPI["addUserFont"] = async (name, bytes) => fonts.addUserFont(this.context, name, bytes);

  /* ---------- OCR ---------- */

  setOcrResult: EngineAPI["setOcrResult"] = (result) =>
    this.mutate("Recognise text", (ctx) => ocr.setOcrResult(ctx, result));

  makeSearchable: EngineAPI["makeSearchable"] = (pages) =>
    this.mutate("Make searchable", (ctx) => {
      this.guard("edit", pages);
      return ocr.makeSearchable(ctx, pages);
    });

  /* ---------- objects, images, forms, pages, export ---------- */

  listObjects: EngineAPI["listObjects"] = async (page) => ops.listObjects(this.context, page);
  addObject: EngineAPI["addObject"] = (object) =>
    this.mutate("Add", (ctx) => {
      this.guard("edit", object.page);
      return ops.addObject(ctx, object);
    });
  updateObject: EngineAPI["updateObject"] = (object) =>
    this.mutate("Change", (ctx) => {
      this.guard("edit", object.page);
      return ops.updateObject(ctx, object);
    });
  removeObject: EngineAPI["removeObject"] = (id) => this.mutate("Remove", (ctx) => ops.removeObject(ctx, id));

  listImages: EngineAPI["listImages"] = async (page) => {
    this.guard("edit", page);
    return this.lazily(() => ops.listImages(this.context, page));
  };
  moveImage: EngineAPI["moveImage"] = (page, id, rect) =>
    this.mutate("Move image", (ctx) => {
      this.guard("edit", page);
      return ops.moveImage(ctx, page, id, rect);
    });
  deleteImage: EngineAPI["deleteImage"] = (page, id) =>
    this.mutate("Delete image", (ctx) => {
      this.guard("edit", page);
      return ops.deleteImage(ctx, page, id);
    });
  replaceImage: EngineAPI["replaceImage"] = (page, id, data) =>
    this.mutate("Replace image", (ctx) => {
      this.guard("edit", page);
      return ops.replaceImage(ctx, page, id, data);
    });

  listFormFields: EngineAPI["listFormFields"] = async () => this.lazily(() => ops.listFormFields(this.context));
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
    this.mutate("Redact", (ctx) => {
      this.guard("redact", page);
      return ops.redactAreas(ctx, page, rects);
    });
  addWatermark: EngineAPI["addWatermark"] = (options) =>
    this.mutate("Watermark", (ctx) => {
      this.guard("edit", options.pages);
      return ops.addWatermark(ctx, options);
    });
  addPageNumbers: EngineAPI["addPageNumbers"] = (options) =>
    this.mutate("Page numbers", (ctx) => {
      this.guard("edit", options.pages);
      return ops.addPageNumbers(ctx, options);
    });

  exportPdf: EngineAPI["exportPdf"] = async (options) => {
    // flattening has to process what the pages draw
    if (options?.flatten) this.guard("render", options.pages);
    return ops.exportPdf(this.context, options);
  };
  exportPageImage: EngineAPI["exportPageImage"] = async (page, dpi, format) => {
    this.guard("render", page);
    return this.lazily(() => ops.exportPageImage(this.context, page, dpi, format));
  };
  exportText: EngineAPI["exportText"] = async (pages) => {
    this.guard("edit", pages);
    return ops.exportText(this.context, pages);
  };
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

/** errors after which this instance of MuPDF cannot be trusted: only a new worker helps */
export function isFatalError(e: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) return true;
  const text = message(e);
  const dead = /memory access out of bounds|table index is out of bounds|Aborted\(|out of memory|allocation failed|malloc.*failed|non-existent operation|during an operation/i;
  if (dead.test(text)) return true;
  return e instanceof RangeError && /call stack/i.test(text) && /wasm/i.test(e.stack ?? "");
}

const NOT_DOWNLOADED = "Part of the editor could not be downloaded. Check your connection and try again.";
export const RESTARTED = "The PDF engine could not process this and was restarted. Your earlier changes are kept.";

/** what to tell the user: MuPDF's and the browser's own wording means nothing to them */
export function describeError(e: unknown): string {
  if (isFatalError(e)) return RESTARTED;
  const text = message(e);
  if (/too many nested graphics states|exception stack overflow|call stack/i.test(text))
    return "This page is nested too deeply to be processed.";
  if (/compression bomb/i.test(text)) return "This page unpacks to far more data than can be processed.";
  return text;
}

/** run one call for the client (see client.ts). `fatal` asks it to replace this worker. */
export async function answer(engine: Engine, request: EngineRequest): Promise<EngineResponse & { fatal?: boolean }> {
  const { id, method, args } = request;
  try {
    const fn = engine[method] as (...a: unknown[]) => Promise<unknown>;
    const result = await fn.apply(engine, args);
    // some modules carry on after an error of their own: make sure MuPDF survived it
    if (!engine.healthy()) return { id, ok: false, error: RESTARTED, fatal: true };
    return { id, ok: true, result };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const fatal = isFatalError(e) || !engine.healthy();
    // a part of the editor that is fetched when first needed did not arrive
    const offline = /NetworkError|Failed to fetch dynamically|Importing a module script failed/i.test(error.message);
    const text = offline && /Aborted|module/i.test(error.message) ? NOT_DOWNLOADED : fatal ? RESTARTED : describeError(error);
    return { id, ok: false, error: text, stack: error.stack, fatal };
  }
}

/** PNG, JPEG, GIF, BMP or TIFF data */
function isPicture(b: Uint8Array): boolean {
  const starts = (...head: number[]) => head.every((v, i) => b[i] === v);
  return (
    starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
    starts(0xff, 0xd8, 0xff) ||
    starts(0x47, 0x49, 0x46, 0x38) ||
    (starts(0x42, 0x4d) && b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0) ||
    starts(0x49, 0x49, 0x2a, 0x00) ||
    starts(0x4d, 0x4d, 0x00, 0x2a)
  );
}

function checkReadable(pdf: mupdf.PDFDocument): void {
  const damaged = (e: unknown) => (isFatalError(e) ? e : new Error(`${DAMAGED} (${message(e)})`));
  let count: number;
  try {
    count = pdf.countPages();
  } catch (e) {
    throw damaged(e);
  }
  if (count < 1) throw new Error("This PDF has no pages.");
  try {
    pdf.loadPage(0).destroy();
  } catch (e) {
    throw damaged(e);
  }
}

/** FNV-1a over the name, the length and a spread of bytes */
function fingerprint(bytes: Uint8Array, name: string): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => (h = Math.imul(h ^ v, 0x01000193) >>> 0);
  for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i));
  mix(bytes.length);
  const step = Math.max(1, Math.floor(bytes.length / 65536));
  for (let i = 0; i < bytes.length; i += step) mix(bytes[i]!);
  for (let i = Math.max(0, bytes.length - 1024); i < bytes.length; i++) mix(bytes[i]!);
  return h.toString(36);
}
