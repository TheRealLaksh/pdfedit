/**
 * App state shared by the viewer and the shell. UI components never call the engine for mutations
 * directly: use the actions here (or `run` for a one-off) so revisions, undo state and notices stay right.
 */
import { create } from "zustand";
import { clearDraft, engine, restoreDraft } from "../engine/client";
import { OCR_SCALE, recognizePage } from "../ocr";
import { openProblem, plain, refusal } from "../ui/shell/errors";
import { DRAFT, NOTICE } from "../ui/shell/strings";
import type {
  DocInfo, ExportOptions, FindMatch, LineEdit, MutationResult, NewPageObject, OcrProgress, OpenResult, PageObject, Point, Rect, RGB, TextStyle,
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
  /** stays until it is dismissed (warnings about the document itself) */
  sticky?: boolean;
}

/** a finished copy of the document, waiting to be saved or shared */
export interface Prepared {
  bytes: Uint8Array;
  name: string;
  options: ExportOptions;
  /** which state of which document it was made from */
  stamp: string;
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
  /** why the last file did not open, shown on the start screen until the next attempt */
  openError: string | null;
  /** a short sentence for screen readers about the change that just happened */
  announcement: { text: string; nonce: number };

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
  download(options?: ExportOptions): Promise<void>;
  /** export without saving: for the finish sheet, where sharing needs a fresh tap */
  prepare(options?: ExportOptions, label?: string): Promise<Prepared | null>;
  /** the copy has left the app (saved or shared): the changes in it are safe */
  markSaved(copy: Prepared): void;
  /** reopen the unsaved work kept on this device */
  resumeDraft(): Promise<void>;

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
  toast(message: string, kind?: Toast["kind"], action?: Toast["action"], options?: { sticky?: boolean }): void;
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
const errorText = (e: unknown) => plain(e instanceof Error ? e.message : String(e));
/** substitute fonts already announced for the open document, so one notice per font is enough */
const toldFonts = new Set<string>();
/** names PDF producers give to the document's own fonts; they are not substitutes */
const OWN_FONT = /^[A-Z]{6}\+|(MT|PSMT)$|MT[,-]/;
/** what screen readers hear once a change has been made */
const SPOKEN: Record<string, string> = {
  "Updating text": NOTICE.updated,
  Undoing: NOTICE.undone,
  Redoing: NOTICE.redone,
};

const stampOf = (s: { session: number; doc: DocInfo | null }) =>
  `${s.session}:${s.doc?.pages.map((p) => p.revision).join(",") ?? ""}`;

/** "report (edited).pdf" stays that, however often it is opened and saved again */
export function editedName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "").replace(/(\s*\(edited\))+$/i, "");
  return `${base} (edited).pdf`;
}
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
    openError: null,
  });

  const opened = (result: OpenResult, bytes: Uint8Array, fileName: string) => {
    if (result.status === "password") {
      set({ passwordPrompt: { bytes, fileName, wrong: result.wrong }, busy: null });
      return;
    }
    // recognition of the previous document is over
    ocrAbort?.abort();
    toldFonts.clear();
    ocrUsed = false;
    staleOcrPages.clear();
    set((s) => ({
      ...fresh(),
      image: null,
      doc: result.doc,
      session: s.session + 1,
      // notices about the previous document are of no use now
      toasts: [],
      ocr: { ...s.ocr, running: false, progress: null, done: [] },
    }));
    const sticky = { sticky: true };
    if (result.doc.signed) get().toast(NOTICE.signed, "warning", undefined, sticky);
    if (result.doc.repaired) get().toast(NOTICE.repaired, "info");
    if (result.doc.restricted) get().toast(NOTICE.restricted, "warning", undefined, sticky);
    if (result.doc.xfa) get().toast(NOTICE.xfa, "warning", undefined, sticky);
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
    const substitutes = result.fallbackFonts.filter((f) => !OWN_FONT.test(f));
    const fonts = (substitutes.length ? substitutes : result.fallbackFonts).filter((f) => !toldFonts.has(f));
    if (fonts.length) {
      for (const f of fonts) toldFonts.add(f);
      get().toast(NOTICE.fallback(fonts), "info", { label: NOTICE.uploadFont, run: () => get().openPanel("fonts") });
    }
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
    let joined = 0;
    for (const [i, file] of [...before, ...after].entries()) {
      const count = get().doc!.pageCount;
      const at = i < before.length ? front : count;
      try {
        set({ busy: "Adding " + file.name });
        if (isPdf(file)) get().applyMutation(await engine.insertPdf(new Uint8Array(await file.arrayBuffer()), at));
        else get().applyMutation(await engine.insertImagesAsPages([await toEngineImage(file)], at));
        if (i < before.length) front += get().doc!.pageCount - count;
        joined++;
      } catch (e) {
        get().toast(`${file.name} was not added: ${errorText(e)}`, "error");
      } finally {
        set({ busy: null });
      }
    }
    if (joined) get().toast(NOTICE.joined(joined + 1), "success");
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
    announcement: { text: "", nonce: 0 },
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
        if (get().doc) get().toast(errorText(e), "error");
        else set({ openError: errorText(e) });
      }
    },
    ocr: { running: false, progress: null, done: [], languages: readStored<string[]>(LANG_KEY, []) },
    theme: readStored<AppState["theme"]>(THEME_KEY, "system"),

    async openFiles(files) {
      if (!files.length) return;
      set({ openError: null });
      const turnedAway = files.map(refusal).find((reason) => reason !== null);
      if (turnedAway) {
        if (get().doc) get().toast(turnedAway, "error");
        else set({ openError: turnedAway });
        return;
      }
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
      set({ busy: "Opening " + fileName, openError: null });
      try {
        const copy = bytes.slice();
        opened(await engine.open(copy, fileName, password), bytes, fileName);
      } catch (e) {
        console.warn("open failed", e);
        const message = openProblem(fileName, e instanceof Error ? e.message : String(e));
        // with a document open the message goes over it; otherwise it stays on the start screen
        if (get().doc) get().toast(message, "error");
        else set({ openError: message });
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
        set((s) => ({ announcement: { text: SPOKEN[label] ?? NOTICE.changed, nonce: s.announcement.nonce + 1 } }));
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

    async editLine(page, edit) {
      const result = await get().run("Updating text", () => engine.editLines(page, [edit]));
      if (result && edit.text === "" && result.canUndo)
        get().toast(NOTICE.lineDeleted, "success", { label: NOTICE.undo, run: () => void get().undo() });
      return result;
    },
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
      let read = 0;
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
          read++;
        }
        if (read && !skipped && !abort.signal.aborted && get().session === session)
          get().toast(read === 1 ? NOTICE.recognised(pages[0]! + 1) : NOTICE.recognisedMany(read), "success");
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
      const copy = await get().prepare(options);
      if (!copy) return;
      saveBytes(copy.bytes, copy.name);
      get().markSaved(copy);
    },
    async prepare(options = {}, label = "Preparing your PDF") {
      const doc = get().doc;
      if (!doc) return null;
      set({ busy: label });
      try {
        const bytes = await engine.exportPdf(options);
        return { bytes, name: editedName(doc.fileName), options, stamp: stampOf(get()) };
      } catch (e) {
        get().toast(errorText(e), "error");
        return null;
      } finally {
        set({ busy: null });
      }
    },
    markSaved(copy) {
      // a copy of only some pages does not save the whole document, and neither does one that is already behind
      if (copy.options.pages || copy.stamp !== stampOf(get())) return;
      set({ dirty: false });
      // nothing unsaved is left to recover
      void clearDraft();
    },
    async resumeDraft() {
      if (get().busy) return;
      set({ busy: DRAFT.restoring, openError: null });
      try {
        const found = await restoreDraft();
        if (!found) throw new Error("nothing to restore");
        opened({ status: "ok", doc: found.doc }, new Uint8Array(), found.fileName);
        set({ canUndo: found.canUndo, canRedo: found.canRedo, dirty: true });
        if (found.failed) get().toast(DRAFT.partly(found.failed), "warning");
      } catch (e) {
        console.warn("draft", e);
        set({ openError: DRAFT.failed });
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
    toast(message, kind = "info", action, options) {
      const id = toastId++;
      set((s) => {
        const others = s.toasts.filter((t) => t.message !== message);
        // room for four passing notes; the ones that must be read are never pushed out
        let surplus = others.filter((t) => !t.sticky).length - 3;
        const kept = others.filter((t) => t.sticky || surplus-- <= 0);
        // the notice's own component times it, so the time stops while it is being read or is out of sight
        return { toasts: [...kept, { id, kind, message, action, sticky: options?.sticky }] };
      });
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});
