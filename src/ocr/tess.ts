/**
 * tesseract.js worker management: one recognition worker that is reused and re-initialised when the
 * languages change, plus one small worker for orientation / script detection.
 */
import type Tesseract from "tesseract.js";

export const TESSERACT_VERSION = "7.0.0";
/** version of every @tesseract.js-data language package */
export const LANGUAGE_DATA_VERSION = "1.0.0";

export interface OcrConfig {
  workerPath?: string;
  corePath?: string;
  /** one folder holding every <lang>.traineddata.gz; default = per-language jsdelivr packages */
  langPath?: string;
  /** node: folder used to cache language data. Browser: IndexedDB key prefix */
  cachePath?: string;
}

const inBrowser = typeof window !== "undefined" || typeof (globalThis as { importScripts?: unknown }).importScripts === "function";

/** the page's CSP allows scripts and downloads only from itself and cdn.jsdelivr.net */
const defaults: OcrConfig = inBrowser
  ? {
      workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
      corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`,
    }
  : {};

let config: OcrConfig = { ...defaults };

export function configureOcr(next: OcrConfig): void {
  config = { ...defaults, ...next };
}

/**
 * tesseract.js asks the CDN for language data without a package version, so whatever was published last
 * would be used. This is a small worker that pins those requests and then loads the real one.
 */
export function pinnedWorkerSource(workerPath: string): string {
  const unpinned = String.raw`/^(https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/[A-Za-z_]+)\//`;
  return [
    "const load = self.fetch.bind(self);",
    `self.fetch = (url, init) => load(typeof url === "string" ? url.replace(${unpinned}, "$1@${LANGUAGE_DATA_VERSION}/") : url, init);`,
    `importScripts(${JSON.stringify(workerPath)});`,
  ].join("\n");
}

let shim: { path: string; url: string } | null = null;
function pinnedWorker(path: string): string {
  if (shim?.path !== path)
    shim = { path, url: URL.createObjectURL(new Blob([pinnedWorkerSource(path)], { type: "text/javascript" })) };
  return shim.url;
}

export type Log = (status: string, progress: number) => void;

interface Held {
  worker: Tesseract.Worker;
  langs: string;
}

let main: Held | null = null;
let osd: Tesseract.Worker | null = null;
let log: Log = () => {};
/** rejects the job that is running when the worker reports a failure it does not route to a promise */
let fail: ((e: Error) => void) | null = null;
/** bumped by terminate so that a worker still starting up is thrown away */
let generation = 0;

async function create(langs: string[], oem: 0 | 1): Promise<Tesseract.Worker> {
  const mod = (await import("tesseract.js")) as unknown as { default?: typeof Tesseract } & typeof Tesseract;
  const createWorker = mod.createWorker ?? mod.default!.createWorker;
  const born = generation;
  const options: Record<string, unknown> = {
    logger: (m: { status: string; progress: number }) => log(m.status, m.progress),
    errorHandler: (e: unknown) => fail?.(asError(e)),
  };
  for (const [k, v] of Object.entries(config)) if (v !== undefined) options[k] = v;
  if (oem === 0) Object.assign(options, { legacyCore: true, legacyLang: true });
  if (inBrowser && config.workerPath)
    Object.assign(options, { workerPath: pinnedWorker(config.workerPath), workerBlobURL: false });
  const worker = await guard(createWorker(langs, oem as unknown as Tesseract.OEM, options));
  if (born !== generation) {
    await worker.terminate();
    throw abortError();
  }
  return worker;
}

/** settle with the promise, or reject as soon as the worker reports an error */
function guard<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fail = reject;
    p.then(resolve, (e) => reject(asError(e))).finally(() => {
      if (fail === reject) fail = null;
    });
  });
}

export function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const text = String(e);
  if (/Network error|fetch|importScripts|NetworkError/i.test(text))
    return new Error(`The text recognition files could not be downloaded. Check your connection. (${text})`);
  return new Error(text);
}

export function abortError(): Error {
  const e = new Error("Text recognition was cancelled");
  e.name = "AbortError";
  return e;
}

/** the recognition worker loaded with exactly these languages */
export async function recognizer(langs: string[], onLog: Log): Promise<Tesseract.Worker> {
  log = onLog;
  const key = langs.join("+");
  if (main?.langs === key) return main.worker;
  if (main) {
    const held = main;
    try {
      await guard(held.worker.reinitialize(key));
      await guard(setup(held.worker));
      held.langs = key;
      return held.worker;
    } catch (e) {
      // a failed language download leaves the worker confused: start again
      main = null;
      await held.worker.terminate();
      throw asError(e);
    }
  }
  // tesseract.js keeps and later extends the array it is given: hand it a copy
  const worker = await create([...langs], 1);
  await guard(setup(worker));
  main = { worker, langs: key };
  return worker;
}

async function setup(worker: Tesseract.Worker) {
  // automatic page segmentation: columns, tables, mixed sizes
  return worker.setParameters({ tessedit_pageseg_mode: "3" as Tesseract.PSM, user_defined_dpi: "300" });
}

export interface ScriptGuess {
  script: string | null;
  scriptConfidence: number;
  /** degrees the image must be turned clockwise to be upright */
  turn: 0 | 90 | 180 | 270;
  turnConfidence: number;
}

export async function detectScript(image: Uint8Array, onLog: Log): Promise<ScriptGuess | null> {
  log = onLog;
  try {
    if (!osd) {
      const worker = await create(["osd"], 0);
      await guard(worker.setParameters({ user_defined_dpi: "150" }));
      osd = worker;
    }
    const { data } = await guard(osd.detect(image as unknown as Tesseract.ImageLike));
    if (!data) return null;
    // tesseract reports how far the page IS turned; undo it
    const turned = (data.orientation_degrees ?? 0) as 0 | 90 | 180 | 270;
    return {
      script: data.script,
      scriptConfidence: data.script_confidence ?? 0,
      turn: turned,
      turnConfidence: data.orientation_confidence ?? 0,
    };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // detection is only a shortcut: the caller can probe languages instead
    await osd?.terminate();
    osd = null;
    return null;
  }
}

/** run a job on a worker, turning worker errors into rejections */
export function runJob<T>(job: Promise<T>): Promise<T> {
  return guard(job);
}

export async function terminateWorkers(): Promise<void> {
  generation++;
  const old = [main?.worker, osd];
  main = null;
  osd = null;
  fail = null;
  log = () => {};
  await Promise.all(old.map((w) => w?.terminate()));
}
