/**
 * Page bitmaps. One render is in flight at a time (the engine worker is serial, so queueing more would
 * only delay edits); the most urgent waiting job goes next. Finished bitmaps live in a pixel-budgeted LRU.
 */
import { engine } from "../../engine/client";
import type { Rect } from "../../engine/types";

const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** never exceed this for one canvas (iOS limit is about 16.7M) */
export const MAX_CANVAS_PIXELS = 16_000_000;
export const BASE_PIXELS = coarse ? 5_000_000 : 10_000_000;
export const DETAIL_PIXELS = coarse ? 6_000_000 : 12_000_000;
const CACHE_PIXELS = coarse ? 24_000_000 : 80_000_000;
const MAX_SIDE = 8192;

export interface Bitmap {
  image: ImageBitmap;
  revision: number;
}

/** pixels per point for a whole-page render: the wanted scale, capped to the canvas limits */
export function baseScale(width: number, height: number, wanted: number): number {
  const area = Math.sqrt(BASE_PIXELS / Math.max(1, width * height));
  const side = MAX_SIDE / Math.max(1, width, height);
  return Math.round(Math.min(wanted, area, side) * 1000) / 1000;
}

const cache = new Map<string, Bitmap>();
let cachedPixels = 0;

function remember(key: string, bitmap: Bitmap) {
  forget(key);
  cache.set(key, bitmap);
  cachedPixels += bitmap.image.width * bitmap.image.height;
  for (const oldKey of cache.keys()) {
    if (cachedPixels <= CACHE_PIXELS || oldKey === key) break;
    forget(oldKey);
  }
}

function forget(key: string) {
  const old = cache.get(key);
  if (!old) return;
  cache.delete(key);
  cachedPixels -= old.image.width * old.image.height;
  // canvases keep their own copy of the pixels, so closing is always safe
  old.image.close();
}

export function clearRenderCache() {
  for (const key of cache.keys()) forget(key);
}

export interface RenderSpec {
  session: number;
  page: number;
  revision: number;
  scale: number;
  clip?: Rect;
}

const keyOf = (s: RenderSpec) =>
  `${s.session}:${s.page}:${s.revision}:${s.scale}:${s.clip ? s.clip.map((n) => n.toFixed(1)).join(",") : ""}`;

export function cachedBitmap(spec: RenderSpec): Bitmap | undefined {
  const key = keyOf(spec);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

interface Listener {
  done(bitmap: Bitmap): void;
  fail(error: Error): void;
}

interface Job {
  spec: RenderSpec;
  /** lower runs first; read at dispatch time so it follows scrolling */
  priority: () => number;
  listeners: Set<Listener>;
}

const jobs = new Map<string, Job>();
let busy = false;
let scheduled = false;

export function requestRender(spec: RenderSpec, priority: () => number, listener: Listener): () => void {
  const key = keyOf(spec);
  let job = jobs.get(key);
  if (!job) jobs.set(key, (job = { spec, priority, listeners: new Set() }));
  job.priority = priority;
  job.listeners.add(listener);
  schedule();
  return () => {
    job.listeners.delete(listener);
    if (!job.listeners.size && jobs.get(key) === job) jobs.delete(key);
  };
}

/** wait until every page of this commit has asked, so the most urgent one really goes first */
function schedule() {
  if (scheduled || busy) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void pump();
  });
}

async function pump() {
  if (busy) return;
  let key = "";
  let job: Job | undefined;
  let best = Infinity;
  for (const [k, j] of jobs) {
    const p = j.priority();
    if (p < best) {
      best = p;
      key = k;
      job = j;
    }
  }
  if (!job) return;
  busy = true;
  try {
    const { page, scale, clip, session } = job.spec;
    const out = await engine.renderPage(page, scale, clip);
    const image = await createImageBitmap(new ImageData(out.data, out.width, out.height));
    const bitmap: Bitmap = { image, revision: out.revision };
    const listeners = [...job.listeners];
    // the document may have changed while this waited in the queue: file it under what was rendered
    remember(keyOf({ ...job.spec, session, revision: out.revision }), bitmap);
    for (const l of listeners) l.done(bitmap);
  } catch (e) {
    for (const l of job.listeners) l.fail(e instanceof Error ? e : new Error(String(e)));
  } finally {
    if (jobs.get(key) === job) jobs.delete(key);
    busy = false;
    schedule();
  }
}
