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
    set((s) => ({
      ...fresh(),
      doc: result.doc,
      session: s.session + 1,
      ocr: { ...s.ocr, running: false, progress: null, done: [] },
    }));
    if (result.doc.signed)
      get().toast("This PDF is digitally signed. Any change will invalidate the signature.", "warning");
    if (result.doc.repaired) get().toast("This file was damaged and has been repaired.", "info");
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
    ocr: { running: false, progress: null, done: [], languages: readStored<string[]>(LANG_KEY, []) },
    theme: readStored<AppState["theme"]>(THEME_KEY, "system"),

    async openFiles(files) {
      if (!files.length) return;
      const pdf = files.find(isPdf);
      try {
        if (pdf) {
          await get().openBytes(new Uint8Array(await pdf.arrayBuffer()), pdf.name);
          for (const extra of files.filter((f) => f !== pdf && isPdf(f))) {
            const bytes = new Uint8Array(await extra.arrayBuffer());
            await get().run("Adding " + extra.name, () => engine.insertPdf(bytes, get().doc!.pageCount));
          }
          return;
        }
        const images = files.filter(isImage);
        if (images.length) {
          set({ busy: "Turning images into a PDF" });
          const data = await Promise.all(images.map(toEngineImage));
          const name = images[0]!.name.replace(/\.\w+$/, "") + ".pdf";
          opened(await engine.createFromImages(data, name), new Uint8Array(), name);
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
      await get().openBytes(p.bytes, p.fileName, password);
    },
    cancelPassword: () => set({ passwordPrompt: null }),

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
      set((s) => ({
        doc: result.doc,
        dirty: result.canUndo,
        canUndo: result.canUndo,
        canRedo: result.canRedo,
        currentPage: Math.min(s.currentPage, result.doc.pageCount - 1),
        search: result.changedPages.length ? { ...s.search, matches: [], active: -1 } : s.search,
      }));
      for (const w of result.warnings) get().toast(w, "warning");
      if (result.fallbackFonts.length)
        get().toast(
          `The original font could not draw some characters, so ${result.fallbackFonts.join(", ")} was used.`,
          "info",
          { label: "Upload font", run: () => get().openPanel("fonts") },
        );
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
      set((s) => ({ ocr: { ...s.ocr, running: true, progress: null } }));
      try {
        for (const page of pages) {
          if (abort.signal.aborted || get().session !== session) break;
          set((s) => ({ ocr: { ...s.ocr, progress: { page, status: "Preparing page", progress: 0 } } }));
          const image = await engine.renderPage(page, OCR_SCALE);
          const result = await recognizePage(image, {
            languages: langs,
            scale: OCR_SCALE,
            signal: abort.signal,
            onProgress: (progress) => set((s) => ({ ocr: { ...s.ocr, progress } })),
          });
          if (abort.signal.aborted || get().session !== session) break;
          get().applyMutation(await engine.setOcrResult(result));
          set((s) => ({ ocr: { ...s.ocr, done: [...new Set([...s.ocr.done, page])] } }));
        }
      } catch (e) {
        if (!abort.signal.aborted) get().toast("Text recognition failed: " + errorText(e), "error");
      } finally {
        set((s) => ({ ocr: { ...s.ocr, running: false, progress: null } }));
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
        set({ dirty: false });
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
    setPlacement: (placement) => set({ placement }),
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
