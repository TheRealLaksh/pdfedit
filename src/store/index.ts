/**
 * App state shared by the viewer and the shell. UI components never call the engine for mutations
 * directly: use the actions here (or `run` for a one-off) so revisions, undo state and notices stay right.
 */
import { create } from "zustand";
import { engine } from "../engine/client";
import { OCR_SCALE, recognizePage } from "../ocr";
import type {
  DocInfo, FindMatch, LineEdit, MutationResult, NewPageObject, OcrProgress, OpenResult, PageObject, Point, Rect, RGB, TextStyle,
} from "../engine/types";

export type ToolId =
  | "select" | "edit-text" | "add-text" | "image" | "signature" | "highlight" | "rect" | "ellipse"
  | "line" | "arrow" | "ink" | "whiteout" | "redact";

export type PanelId = "pages" | "find" | "forms" | "export" | "ocr" | "signature" | "stamp" | "fonts" | "about";

export type Selection =
  | { type: "object"; page: number; id: string }
  | { type: "image"; page: number; id: string }
  | null;

export interface ToolOptions {
  color: RGB;
  fill: RGB | null;
  strokeWidth: number;
  opacity: number;
  text: TextStyle;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  message: string;
  action?: { label: string; run: () => void };
}

/** something waiting for the user to tap a spot on a page (image or signature) */
export type Placement =
  | { kind: "image"; data: Uint8Array; width: number; height: number; label: string }
  | { kind: "ink"; paths: Point[][]; width: number; height: number; color: RGB; strokeWidth: number }
  | null;

export interface AppState {
  doc: DocInfo | null;
  /** increments every time a new document is opened */
  session: number;
  busy: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  currentPage: number;
  /** "fit" = fit page width; number = CSS pixels per PDF point */
  zoom: number | "fit";
  tool: ToolId;
  toolOptions: ToolOptions;
  selection: Selection;
  /** line being edited inline */
  editing: { page: number; lineId: string } | null;
  panel: PanelId | null;
  placement: Placement;
  toasts: Toast[];
  passwordPrompt: { bytes: Uint8Array; fileName: string; wrong: boolean } | null;
  scrollRequest: { page: number; rect?: Rect; nonce: number } | null;
  search: { query: string; matches: FindMatch[]; active: number };
  ocr: { running: boolean; progress: OcrProgress | null; done: number[]; languages: string[] };
  theme: "system" | "light" | "dark";

  openFiles(files: File[]): Promise<void>;
  /** a picture being edited in the image editor (separate from the PDF document) */
  image: File | null;
  openImage(file: File): void;
  closeImage(): void;
  /** turn pictures into a PDF and open it */
  openImagesAsPdf(files: File[]): Promise<void>;
  openBytes(bytes: Uint8Array, fileName: string, password?: string): Promise<void>;
  submitPassword(password: string): Promise<void>;
  cancelPassword(): void;
  closeDoc(): Promise<void>;

  /** run a mutating engine call: shows `label` while busy, applies the result, reports errors */
  run(label: string, call: () => Promise<MutationResult>): Promise<MutationResult | null>;
  applyMutation(result: MutationResult): void;
  editLine(page: number, edit: LineEdit): Promise<MutationResult | null>;
  addObject(object: NewPageObject): Promise<MutationResult | null>;
  updateObject(object: PageObject): Promise<MutationResult | null>;
  deleteSelection(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;

  runOcr(pages: number[], languages?: string[]): Promise<void>;
  cancelOcr(): void;
  setOcrLanguages(languages: string[]): void;

  /** export and save to the user's device */
  download(options?: import("../engine/types").ExportOptions): Promise<void>;

  setTool(tool: ToolId): void;
  setToolOptions(patch: Partial<ToolOptions>): void;
  select(selection: Selection): void;
  startEditing(page: number, lineId: string): void;
  stopEditing(): void;
  openPanel(panel: PanelId | null): void;
  setPlacement(placement: Placement): void;
  setZoom(zoom: number | "fit"): void;
  setCurrentPage(page: number): void;
  scrollTo(page: number, rect?: Rect): void;
  setSearch(search: Partial<AppState["search"]>): void;
  setTheme(theme: AppState["theme"]): void;
  toast(message: string, kind?: Toast["kind"], action?: Toast["action"]): void;
  dismissToast(id: number): void;
}

const THEME_KEY = "pdfedit.theme";
const LANG_KEY = "pdfedit.ocr-languages";

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

let toastId = 1;
let runningCalls = 0;
let ocrAbort: AbortController | null = null;
/** files chosen together with a protected PDF, waiting for its password */
let waitingFiles: { before: File[]; after: File[] } | null = null;
/** pages whose "has recognised text" state must be read again (undo and page moves change it) */
const staleOcrPages = new Set<number>();
let ocrUsed = false;
let checkingOcr = false;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isImage = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(f.name);

/** MuPDF reads PNG/JPEG/GIF/BMP/TIFF; anything else the browser can decode gets converted to PNG */
export async function toEngineImage(file: Blob): Promise<Uint8Array> {
  if (/^image\/(png|jpeg|gif|bmp|tiff)$/.test(file.type)) return new Uint8Array(await file.arrayBuffer());
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

export function saveBytes(bytes: Uint8Array, fileName: string, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const useStore = create<AppState>()((set, get) => {
  const fresh = () => ({
    busy: null,
    dirty: false,
    canUndo: false,
    canRedo: false,
    currentPage: 0,
    zoom: "fit" as const,
    tool: "edit-text" as ToolId,
    selection: null,
    editing: null,
    panel: null,
    placement: null,
    passwordPrompt: null,
    scrollRequest: null,
    search: { query: "", matches: [], active: -1 },
  });

  const opened = (result: OpenResult, bytes: Uint8Array, fileName: string) => {
    if (result.status === "password") {
      set({ passwordPrompt: { bytes, fileName, wrong: result.wrong }, busy: null });
      return;
    }
    // recognition of the previous document is over
    ocrAbort?.abort();
    ocrUsed = false;
    staleOcrPages.clear();
    set((s) => ({
      ...fresh(),
      image: null,
      doc: result.doc,
      session: s.session + 1,
      ocr: { ...s.ocr, running: false, progress: null, done: [] },
    }));
    if (result.doc.signed)
      get().toast("This PDF is digitally signed. Any change will invalidate the signature.", "warning");
    if (result.doc.repaired) get().toast("This file was damaged and has been repaired.", "info");
    if (result.doc.restricted)
      get().toast(
        "The author of this PDF restricted editing. The downloaded copy will not carry that restriction, so only edit it if you are allowed to.",
        "warning",
      );
    if (result.doc.xfa)
      get().toast("This PDF uses an XFA form. Some fields only appear in Adobe's software.", "warning");
  };

  /** take over an engine result: document state, undo state and notices */
  const apply = (result: MutationResult) => {
    set((s) => ({
      doc: result.doc,
      dirty: result.canUndo,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
      currentPage: Math.min(s.currentPage, result.doc.pageCount - 1),
      search: result.changedPages.length ? { ...s.search, matches: [], active: -1 } : s.search,
      // an older "Undo" offer would now take back this change instead of the one it names
      toasts: s.toasts.filter((t) => t.action?.label !== "Undo"),
    }));
    for (const w of result.warnings) get().toast(w, "warning");
    const fonts = result.fallbackFonts;
    if (fonts.length)
      get().toast(
        `The original font could not draw some characters, so ${fonts.join(", ")} ${fonts.length > 1 ? "were" : "was"} used.`,
        "info",
        { label: "Upload font", run: () => get().openPanel("fonts") },
      );
  };

  const refreshOcrDone = async (changed: number[]) => {
    if (!ocrUsed) return;
    const count = get().doc?.pageCount ?? 0;
    if (get().ocr.done.some((p) => p >= count))
      set((s) => ({ ocr: { ...s.ocr, done: s.ocr.done.filter((p) => p < count) } }));
    for (const page of changed) staleOcrPages.add(page);
    if (checkingOcr) return;
    checkingOcr = true;
    try {
      for (const page of staleOcrPages) {
        staleOcrPages.delete(page);
        const session = get().session;
        if (page >= (get().doc?.pageCount ?? 0)) continue;
        const text = await engine.getPageText(page);
        // changed again meanwhile: it is back in the set and will be read again
        if (get().session !== session || staleOcrPages.has(page)) continue;
        const has = text.lines.some((line) => line.id.startsWith("ocr:"));
        if (has !== get().ocr.done.includes(page))
          set((s) => ({
            ocr: {
              ...s.ocr,
              done: has ? [...s.ocr.done, page].sort((a, b) => a - b) : s.ocr.done.filter((p) => p !== page),
            },
          }));
      }
    } catch {
      /* the document went away */
    } finally {
      checkingOcr = false;
    }
  };

  /** resolves once no other engine change is on its way */
  const settled = () =>
    new Promise<void>((resolve) => {
      if (!get().busy) return resolve();
      const stop = useStore.subscribe((s) => {
        if (s.busy) return;
        stop();
        resolve();
      });
    });

  /** add the other files chosen with the opened PDF, keeping the order they were picked in */
  const addFiles = async ({ before, after }: { before: File[]; after: File[] }) => {
    let front = 0;
    for (const [i, file] of [...before, ...after].entries()) {
      const count = get().doc!.pageCount;
      const at = i < before.length ? front : count;
      try {
        set({ busy: "Adding " + file.name });
        if (isPdf(file)) get().applyMutation(await engine.insertPdf(new Uint8Array(await file.arrayBuffer()), at));
        else get().applyMutation(await engine.insertImagesAsPages([await toEngineImage(file)], at));
        if (i < before.length) front += get().doc!.pageCount - count;
      } catch (e) {
        get().toast(`${file.name} was not added: ${errorText(e)}`, "error");
      } finally {
        set({ busy: null });
      }
    }
  };

  /** run an open; true when it replaced the current document */
  const replaced = async (open: () => Promise<void>) => {
    const session = get().session;
    await open();
    return get().session !== session;
  };

  return {
    doc: null,
    session: 0,
    ...fresh(),
    toolOptions: {
      color: [0.07, 0.07, 0.09],
      fill: null,
      strokeWidth: 2,
      opacity: 1,
      text: { family: "Noto Sans", bold: false, italic: false, serif: false, mono: false, size: 14, color: [0.07, 0.07, 0.09] },
    },
    toasts: [],
    image: null,
    openImage: (file) => set({ image: file }),
    closeImage: () => set({ image: null }),
    async openImagesAsPdf(images) {
      try {
        set({ busy: "Turning images into a PDF", image: null });
        const data = await Promise.all(
          images.map(async (file) => {
            try {
              // the engine drops the open document before it reads the pictures, so check them first
              if (!/tiff?$/i.test(file.type || file.name)) (await createImageBitmap(file)).close();
              return await toEngineImage(file);
            } catch {
              throw new Error(`${file.name} could not be read as an image.`);
            }
          }),
        );
        const name = images[0]!.name.replace(/.w+$/, "") + ".pdf";
        try {
          opened(await engine.createFromImages(data, name), new Uint8Array(), name);
        } catch (e) {
          // the engine no longer holds the old document: showing it would export an empty file
          if (get().doc) await get().closeDoc();
          throw e;
        }
      } catch (e) {
        set({ busy: null });
        get().toast(errorText(e), "error");
      }
    },
    ocr: { running: false, progress: null, done: [], languages: readStored<string[]>(LANG_KEY, []) },
    theme: readStored<AppState["theme"]>(THEME_KEY, "system"),

    async openFiles(files) {
      if (!files.length) return;
      const pdf = files.find(isPdf);
      try {
        if (pdf) {
          const bytes = new Uint8Array(await pdf.arrayBuffer());
          const split = files.indexOf(pdf);
          const wanted = (f: File) => isPdf(f) || isImage(f);
          const extras = { before: files.slice(0, split).filter(wanted), after: files.slice(split + 1).filter(wanted) };
          waitingFiles = null;
          if (await replaced(() => get().openBytes(bytes, pdf.name))) await addFiles(extras);
          else if (get().passwordPrompt) waitingFiles = extras;
          return;
        }
        const images = files.filter(isImage);
        if (images.length) {
          // one picture opens in the image editor; several become a PDF
          if (images.length === 1 && !get().doc) get().openImage(images[0]!);
          else await get().openImagesAsPdf(images);
          return;
        }
        // unknown extension: let the engine decide
        const first = files[0]!;
        await get().openBytes(new Uint8Array(await first.arrayBuffer()), first.name);
      } catch (e) {
        set({ busy: null });
        get().toast(errorText(e), "error");
      }
    },

    async openBytes(bytes, fileName, password) {
      set({ busy: "Opening " + fileName });
      try {
        const copy = bytes.slice();
        opened(await engine.open(copy, fileName, password), bytes, fileName);
      } catch (e) {
        get().toast(errorText(e), "error");
      } finally {
        set({ busy: null });
      }
    },

    async submitPassword(password) {
      const p = get().passwordPrompt;
      if (!p) return;
      set({ passwordPrompt: null });
      const done = await replaced(() => get().openBytes(p.bytes, p.fileName, password));
      if (done && waitingFiles) {
        const extras = waitingFiles;
        waitingFiles = null;
        await addFiles(extras);
      }
    },
    cancelPassword: () => {
      waitingFiles = null;
      set({ passwordPrompt: null });
    },

    async closeDoc() {
      ocrAbort?.abort();
      await engine.close();
      set({ ...fresh(), doc: null });
    },

    async run(label, call) {
      set({ busy: label });
      runningCalls++;
      try {
        const result = await call();
        get().applyMutation(result);
        return result;
      } catch (e) {
        get().toast(errorText(e), "error");
        return null;
      } finally {
        // calls can overlap: stay busy until the last one finishes
        if (--runningCalls === 0) set({ busy: null });
      }
    },

    applyMutation(result) {
      apply(result);
      void refreshOcrDone(result.changedPages);
    },

    editLine: (page, edit) => get().run("Updating text", () => engine.editLines(page, [edit])),
    addObject: (object) => get().run("Adding", () => engine.addObject(object)),
    updateObject: (object) => get().run("Updating", () => engine.updateObject(object)),

    async deleteSelection() {
      const s = get().selection;
      if (!s) return;
      set({ selection: null });
      await get().run("Deleting", () =>
        s.type === "object" ? engine.removeObject(s.id) : engine.deleteImage(s.page, s.id),
      );
    },

    async undo() {
      if (!get().canUndo || get().busy) return;
      set({ editing: null, selection: null });
      await get().run("Undoing", () => engine.undo());
    },
    async redo() {
      if (!get().canRedo || get().busy) return;
      set({ editing: null, selection: null });
      await get().run("Redoing", () => engine.redo());
    },

    async runOcr(pages, languages) {
      if (get().ocr.running) return;
      const abort = (ocrAbort = new AbortController());
      const langs = languages ?? get().ocr.languages;
      const session = get().session;
      // results belong to the page as it was when the run started: editing or moving it makes them wrong
      const before = new Map(pages.map((p) => [p, get().doc?.pages[p]?.revision]));
      const unchanged = (p: number) => get().doc?.pages[p]?.revision === before.get(p);
      let skipped = 0;
      set((s) => ({ ocr: { ...s.ocr, running: true, progress: null } }));
      try {
        for (const page of pages) {
          if (abort.signal.aborted || get().session !== session) break;
          if (!unchanged(page)) {
            skipped++;
            continue;
          }
          set((s) => ({ ocr: { ...s.ocr, progress: { page, status: "Preparing page", progress: 0 } } }));
          const image = await engine.renderPage(page, OCR_SCALE);
          const result = await recognizePage(image, {
            languages: langs,
            scale: OCR_SCALE,
            signal: abort.signal,
            onProgress: (progress) => set((s) => ({ ocr: { ...s.ocr, progress } })),
          });
          await settled();
          if (abort.signal.aborted || get().session !== session) break;
          if (!unchanged(page)) {
            skipped++;
            continue;
          }
          apply(await engine.setOcrResult(result));
          ocrUsed = true;
          set((s) => ({ ocr: { ...s.ocr, done: [...new Set([...s.ocr.done, page])] } }));
        }
        if (skipped && !abort.signal.aborted && get().session === session)
          get().toast(
            `${skipped === 1 ? "A page" : skipped + " pages"} changed while the text was being read and ${skipped === 1 ? "was" : "were"} skipped. Run recognition again.`,
            "warning",
            { label: "Recognise text", run: () => get().openPanel("ocr") },
          );
      } catch (e) {
        if (!abort.signal.aborted) get().toast("Text recognition failed: " + errorText(e), "error");
      } finally {
        // a stopped run must not end the one started after it
        if (ocrAbort === abort) set((s) => ({ ocr: { ...s.ocr, running: false, progress: null } }));
      }
    },
    cancelOcr() {
      ocrAbort?.abort();
      set((s) => ({ ocr: { ...s.ocr, running: false, progress: null } }));
    },
    setOcrLanguages(languages) {
      writeStored(LANG_KEY, languages);
      set((s) => ({ ocr: { ...s.ocr, languages } }));
    },

    async download(options) {
      const doc = get().doc;
      if (!doc) return;
      set({ busy: "Preparing your PDF" });
      try {
        const bytes = await engine.exportPdf(options);
        saveBytes(bytes, doc.fileName.replace(/\.pdf$/i, "") + " (edited).pdf");
        // a copy of only some pages does not save the whole document
        if (!options?.pages) set({ dirty: false });
      } catch (e) {
        get().toast(errorText(e), "error");
      } finally {
        set({ busy: null });
      }
    },

    setTool: (tool) => set({ tool, selection: null, editing: null, placement: null }),
    setToolOptions: (patch) => set((s) => ({ toolOptions: { ...s.toolOptions, ...patch } })),
    select: (selection) => set({ selection, editing: null }),
    startEditing: (page, lineId) => set({ editing: { page, lineId }, selection: null }),
    stopEditing: () => set({ editing: null }),
    openPanel: (panel) => set({ panel }),
    setPlacement: (placement) =>
      set((s) => ({
        placement,
        // the image and signature tools do nothing without something to place
        tool: !placement && s.placement && (s.tool === "image" || s.tool === "signature") ? "edit-text" : s.tool,
      })),
    setZoom: (zoom) => set({ zoom: zoom === "fit" ? zoom : Math.min(8, Math.max(0.2, zoom)) }),
    setCurrentPage: (currentPage) => set({ currentPage }),
    scrollTo: (page, rect) => set({ scrollRequest: { page, rect, nonce: Math.random() }, currentPage: page }),
    setSearch: (search) => set((s) => ({ search: { ...s.search, ...search } })),
    setTheme(theme) {
      writeStored(THEME_KEY, theme);
      set({ theme });
    },
    toast(message, kind = "info", action) {
      const id = toastId++;
      set((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== message).slice(-3), { id, kind, message, action }] }));
      setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 6000);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});
