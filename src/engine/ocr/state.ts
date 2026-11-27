/**
 * What the OCR module remembers about a page. All geometry is kept in PDF user space, which does not
 * change when pages are rotated, cropped or reordered. Everything lives inside the page's OcrPageState,
 * so whoever moves or copies that object moves the whole memory with it.
 */
import type { EngineContext, OcrPageState } from "../context";
import { apply, invert, rectFromPoints } from "../geom";
import type { Align, Matrix, Point, Quad, Rect, TextStyle } from "../types";

export interface Vec {
  x: number;
  y: number;
}

/** an oriented text box: baseline start, unit vectors along the line and upwards, extents in points */
export interface Frame {
  o: Point;
  u: Vec;
  up: Vec;
  width: number;
  asc: number;
  desc: number;
}

export interface WordSpan {
  text: string;
  /** distances along the baseline from the frame origin, and the word's own height */
  from: number;
  to: number;
  asc: number;
  desc: number;
}

export interface LineMeta {
  id: string;
  text: string;
  dir: "ltr" | "rtl";
  confidence: number;
  frame: Frame;
  words: WordSpan[];
  style: TextStyle;
  align: Align;
}

export interface PageMeta {
  lines: LineMeta[];
  /** the page is essentially one picture (a scan) */
  scan: boolean;
  next: number;
  /** resource names of the forms this module draws on the page */
  layer?: string;
  searchLayer?: string;
}

/** how new text has to be set to look like the original ink; measured once, when a line is first edited */
export interface Fit {
  size: number;
  /** percent */
  hscale: number;
  /** points the baseline sits below (positive) the recognised baseline */
  drop: number;
  /** along the baseline, from the frame origin: where the original ink starts and ends */
  inkFrom: number;
  inkTo: number;
  /** side bearings of the substitute font per point of size */
  lead: number;
  trail: number;
}

export interface EditState {
  text: string;
  deleted: boolean;
  style: TextStyle;
  align: Align;
  /** accumulated user moves, PDF space */
  moved: Vec;
  fit: Fit;
  /** the measured style of the original print */
  source: TextStyle;
  /** the user picked another font, so the measured stretch no longer applies */
  widthLocked: boolean;
  shrink: boolean;
  /** object numbers: the picture that hides the old ink, and the form holding the new text */
  patch: { object: number; matrix: Matrix } | null;
  textForm: number | null;
  /** where the new text is drawn */
  frame: Frame;
}

const PAGE_KEY = "__page";

export function pageMeta(entry: OcrPageState): PageMeta {
  return entry.edits[PAGE_KEY] as PageMeta;
}
export function setPageMeta(entry: OcrPageState, meta: PageMeta): void {
  entry.edits[PAGE_KEY] = meta;
}
export function editOf(entry: OcrPageState, id: string): EditState | undefined {
  return entry.edits[id] as EditState | undefined;
}

export function pageObjectNumber(ctx: EngineContext, page: number): number {
  const ref = ctx.doc.findPage(page);
  return ref.isIndirect() ? ref.asIndirect() : -1;
}

function pageObjects(ctx: EngineContext): Set<number> {
  let set = ctx.cache.get("ocr.pageObjects") as Set<number> | undefined;
  if (!set) {
    set = new Set();
    const n = ctx.doc.countPages();
    for (let i = 0; i < n; i++) set.add(pageObjectNumber(ctx, i));
    ctx.cache.set("ocr.pageObjects", set);
  }
  return set;
}

/** the stored recognition of a page, even if the keys of state.ocr lag behind a page reorder */
export function findEntry(ctx: EngineContext, page: number): OcrPageState | undefined {
  const entries = ctx.state.ocr;
  if (!Object.keys(entries).length) return undefined;
  const object = pageObjectNumber(ctx, page);
  const here = entries[page];
  if (here && here.pageObject === object) return here.edits[PAGE_KEY] ? here : undefined;
  for (const e of Object.values(entries)) if (e.pageObject === object && e.edits[PAGE_KEY]) return e;
  // a duplicated page: the copy carries the original's page number
  if (here?.edits[PAGE_KEY] && !pageObjects(ctx).has(here.pageObject)) return here;
  if (here?.edits[PAGE_KEY] && here.result.page === page && isCopy(entries, here)) return here;
  return undefined;
}

function isCopy(entries: Record<number, OcrPageState>, entry: OcrPageState): boolean {
  return Object.values(entries).filter((e) => e.pageObject === entry.pageObject).length > 1;
}

/** matrix from PDF user space to displayed page space */
export function pageTransform(ctx: EngineContext, page: number): Matrix {
  const p = ctx.doc.loadPage(page);
  const m = p.getTransform() as Matrix;
  p.destroy();
  return m;
}

export function toPdfMatrix(pageMatrix: Matrix): Matrix {
  return invert(pageMatrix);
}

export function applyVec(m: Matrix, v: Vec): Vec {
  return { x: v.x * m[0] + v.y * m[2], y: v.x * m[1] + v.y * m[3] };
}

/** move a frame from one coordinate system to another (rigid motions and mirrors) */
export function mapFrame(f: Frame, m: Matrix): Frame {
  const u = applyVec(m, f.u);
  const up = applyVec(m, f.up);
  const su = Math.hypot(u.x, u.y) || 1;
  const sv = Math.hypot(up.x, up.y) || 1;
  return {
    o: apply(m, f.o),
    u: { x: u.x / su, y: u.y / su },
    up: { x: up.x / sv, y: up.y / sv },
    width: f.width * su,
    asc: f.asc * sv,
    desc: f.desc * sv,
  };
}

/** point at `along` points on the baseline and `above` points over it */
export function framePoint(f: Frame, along: number, above: number): Point {
  return [f.o[0] + f.u.x * along + f.up.x * above, f.o[1] + f.u.y * along + f.up.y * above];
}

export function frameQuad(f: Frame): Quad {
  const ul = framePoint(f, 0, f.asc);
  const ur = framePoint(f, f.width, f.asc);
  const ll = framePoint(f, 0, -f.desc);
  const lr = framePoint(f, f.width, -f.desc);
  return [...ul, ...ur, ...ll, ...lr];
}

export function frameRect(f: Frame): Rect {
  const q = frameQuad(f);
  return rectFromPoints([
    [q[0], q[1]],
    [q[2], q[3]],
    [q[4], q[5]],
    [q[6], q[7]],
  ]);
}
