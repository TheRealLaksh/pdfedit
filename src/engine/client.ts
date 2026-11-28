/**
 * Main-thread proxy for the engine worker: `await engine.renderPage(0, 2)`.
 *
 * One call is sent at a time. The proxy remembers how the open document was built (the file and every
 * change that succeeded), so when the worker dies (a wasm crash, out of memory, a call that never ends)
 * it starts a new one, rebuilds the document and carries on. Only the call that caused it fails.
 */
import { createDraftKeeper, type DraftInfo, type DraftJournal, type DraftKeeper } from "./draft";
import type { DocInfo, EngineAPI, EngineRequest, EngineResponse, MutationResult, OpenResult } from "./types";

export type { DraftInfo } from "./draft";

/** `fatal`: the worker that sends this cannot be used any more */
type Reply = EngineResponse & { fatal?: boolean };

interface Step {
  method: string;
  args: unknown[];
}

interface Call extends Step {
  id: number;
  /** set while rebuilding the document after a restart: nobody waits for the answer */
  replay?: "open" | "change";
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** calls that change the document, in the order they must be repeated */
const CHANGES = new Set(
  (
    "editLines replaceText setOcrResult makeSearchable addObject updateObject removeObject moveImage " +
    "deleteImage replaceImage setFormField rotatePages deletePages reorderPages duplicatePage insertBlankPage " +
    "insertPdf insertImagesAsPages redactAreas addWatermark addPageNumbers undo redo addUserFont"
  ).split(" "),
);

/** calls about one page that only look: the one that broke the engine is not tried again */
const PAGE_READS = new Set(["renderPage", "getPageText", "listImages", "listObjects", "exportPageImage"]);

/** how long a call may run before the engine counts as hung (milliseconds) */
const LIMITS: Record<string, number> = { renderPage: 60_000, getPageText: 90_000, listImages: 90_000, open: 150_000 };
const LIMIT = 300_000;

export const HUNG = "This took too long, so it was stopped. Your earlier changes are kept.";
export const LOST = "The PDF engine stopped and the document could not be restored. Please open the file again.";
export const UNOPENABLE = "This file could not be opened: the PDF engine crashed while reading it.";
export const NOT_DOWNLOADED = "The editor could not be downloaded. Check your connection and try again.";

let announce: () => void = () => {};
/** resolves when the engine has been downloaded and has started for the first time */
export const engineReady: Promise<void> = new Promise((resolve) => (announce = resolve));

let worker: Worker | null = null;
/** the worker only listens once its wasm modules have loaded: hold calls until it says so */
let ready = false;
let queue: Call[] = [];
let active: Call | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
/** how the open document was made, and what has been done to it since */
let journal: DraftJournal | null = null;
/** the same record, kept on the device so that a closed tab does not lose the work */
let drafts: DraftKeeper = createDraftKeeper();
/** the last worker is gone: a new one has to rebuild the document first */
let empty = false;
/** page reads that broke the engine, and why */
const broken = new Map<string, string>();

function start(): void {
  if (worker) return;
  ready = false;
  if (empty && journal) {
    const again = (step: Step, replay: "open" | "change"): Call => ({
      ...step,
      id: nextId++,
      replay,
      resolve: () => {},
      reject: () => {},
    });
    queue = [again(journal.open, "open"), ...journal.steps.map((s) => again(s, "change")), ...queue.filter((c) => !c.replay)];
  }
  empty = false;
  const created = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker = created;
  created.onmessage = (event: MessageEvent<Reply>) => {
    if (worker === created) receive(event.data);
  };
  created.onerror = (event) => {
    if (worker !== created) return;
    event.preventDefault?.();
    if (ready) return crash(event.message || "The PDF engine stopped unexpectedly");
    // it never started (offline, blocked): fail what is waiting and try again with the next call.
    // The browser's own wording ("Uncaught RuntimeError: Aborted(NetworkError ...") helps nobody.
    console.error("engine failed to start", event.message);
    const waiting = [...(active ? [active] : []), ...queue].filter((c) => !c.replay);
    drop();
    queue = [];
    for (const call of waiting) call.reject(new Error(NOT_DOWNLOADED));
  };
}

function drop(): void {
  clearTimeout(timer);
  active = null;
  worker?.terminate();
  worker = null;
  ready = false;
  empty = true;
}

function receive(msg: Reply): void {
  if (msg.id === 0) {
    ready = true;
    announce();
    pump();
    return;
  }
  const call = active;
  if (!call || msg.id !== call.id) return;
  if (!msg.ok && msg.fatal) return crash(msg.error);
  clearTimeout(timer);
  active = null;
  if (call.replay === "open" && !(msg.ok && (msg.result as OpenResult).status === "ok")) return lose();
  if (msg.ok) {
    if (!call.replay) record(call, msg.result);
    call.resolve(msg.result);
  } else call.reject(Object.assign(new Error(msg.error), { stack: msg.stack }));
  pump();
}

/** the worker is unusable: fail the running call, throw the worker away and rebuild the document */
function crash(message: string): void {
  const call = active;
  drop();
  if (call?.replay) return lose();
  if (call) {
    if (PAGE_READS.has(call.method)) broken.set(`${call.method}:${String(call.args[0])}`, message);
    const opening = call.method === "open" || call.method === "createFromImages";
    call.reject(new Error(opening && message !== HUNG && !/not enough memory/.test(message) ? UNOPENABLE : message));
  }
  // rebuild straight away, so the document is back before the next action
  if (journal || queue.length) start();
}

/** rebuilding failed as well: give the document up instead of going round in circles */
function lose(): void {
  drop();
  journal = null;
  const waiting = queue.filter((c) => !c.replay);
  queue = [];
  for (const call of waiting) call.reject(new Error(LOST));
}

function record(call: Call, result: unknown): void {
  const step: Step = { method: call.method, args: call.args };
  if (call.method === "open" || call.method === "createFromImages") {
    if ((result as OpenResult).status !== "ok") return;
    // fonts the user added stay available in every document opened later
    journal = {
      open: step,
      steps: journal?.steps.filter((s) => s.method === "addUserFont") ?? [],
      protected: !!(result as { doc?: DocInfo }).doc?.encrypted,
    };
    broken.clear();
  } else if (call.method === "close") {
    journal = null;
    broken.clear();
  } else if (CHANGES.has(call.method)) {
    journal?.steps.push(step);
    // the page may be different now
    if (call.method !== "addUserFont") broken.clear();
    if (journal) drafts.record(journal);
  }
}

function pump(): void {
  if (!worker || !ready || active) return;
  const call = queue.shift();
  if (!call) return;
  active = call;
  try {
    worker.postMessage({ id: call.id, method: call.method, args: call.args } as EngineRequest);
  } catch (e) {
    active = null;
    call.reject(e instanceof Error ? e : new Error(String(e)));
    pump();
    return;
  }
  watch(LIMITS[call.method] ?? LIMIT);
}

function watch(limit: number): void {
  const since = Date.now();
  timer = setTimeout(() => {
    // timers of a sleeping or hidden tab fire late: that says nothing about the engine
    const asleep = Date.now() - since > limit * 1.5 || (typeof document !== "undefined" && document.hidden);
    if (asleep) watch(limit);
    else crash(HUNG);
  }, limit);
}

export const engine = new Proxy({} as EngineAPI, {
  get(_target, method: string) {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const refused = PAGE_READS.has(method) ? broken.get(`${method}:${String(args[0])}`) : undefined;
        if (refused) return reject(new Error(refused));
        queue.push({ id: nextId++, method, args, resolve, reject });
        start();
        pump();
      });
  },
});

/* ---------- draft recovery ---------- */

export interface RestoredDraft {
  fileName: string;
  doc: DocInfo;
  canUndo: boolean;
  canRedo: boolean;
  /** changes that could not be repeated (a font that cannot be downloaded offline, for example) */
  failed: number;
}

/** the unsaved work found on this device, if any (kept for seven days) */
export function loadDraft(): Promise<DraftInfo | null> {
  return drafts.info();
}

/**
 * Opens the draft's file in the engine and repeats its changes. The caller then shows `doc` as it would
 * a freshly opened file. Null when there is nothing to restore.
 */
export async function restoreDraft(): Promise<RestoredDraft | null> {
  const saved = await drafts.read();
  if (!saved) return null;
  const call = (step: Step) => (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[step.method]!(...step.args);
  drafts.pause();
  let restored = false;
  try {
    const opened = (await call(saved.open)) as OpenResult;
    if (opened.status !== "ok") return null;
    const out: RestoredDraft = { fileName: opened.doc.fileName, doc: opened.doc, canUndo: false, canRedo: false, failed: 0 };
    for (const step of saved.steps) {
      try {
        const result = (await call(step)) as Partial<MutationResult>;
        if (result.doc) Object.assign(out, { doc: result.doc, canUndo: !!result.canUndo, canRedo: !!result.canRedo });
      } catch (e) {
        console.warn(`A change could not be restored (${step.method})`, e);
        out.failed++;
      }
    }
    restored = true;
    return out;
  } finally {
    // after a failure the stored draft stays as it was, to be tried again
    drafts.resume(restored ? (journal ?? undefined) : undefined);
  }
}

/** forget the draft: after the file was saved, or when the user does not want it */
export function clearDraft(): Promise<void> {
  return drafts.clear();
}

/** switching drafts off also deletes the stored one */
export function setDraftsEnabled(on: boolean): Promise<void> {
  return drafts.setEnabled(on);
}

/** for tests: keep drafts somewhere else */
export function useDraftKeeper(keeper: DraftKeeper): void {
  drafts = keeper;
}

/** load the worker and wasm before the user picks a file */
export function warmUpEngine(): void {
  start();
}
