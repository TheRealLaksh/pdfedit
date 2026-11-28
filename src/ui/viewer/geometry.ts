/** Pure geometry: page layout, line frames, hit testing and object transforms. All page maths in points. */
import type { PageInfo, PageObject, Point, Quad, Rect, RGB, TextLine } from "../../engine/types";

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 8;
/** "fit" never enlarges a page beyond this (CSS px per point) */
export const MAX_FIT_SCALE = 2;
/** minimum touch target, CSS px */
export const TAP = 44;

/* ---------- document layout ---------- */

export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** CSS px per point for this page */
  scale: number;
}

export interface Layout {
  boxes: PageBox[];
  width: number;
  height: number;
}

export function fitScale(page: Pick<PageInfo, "width">, containerWidth: number, pad: number): number {
  return Math.min(MAX_FIT_SCALE, Math.max(0.05, (containerWidth - pad * 2) / Math.max(1, page.width)));
}

export function computeLayout(
  pages: PageInfo[],
  zoom: number | "fit",
  containerWidth: number,
  pad: number,
  gap: number,
): Layout {
  const sizes = pages.map((p) => {
    const scale = zoom === "fit" ? fitScale(p, containerWidth, pad) : zoom;
    return { scale, width: Math.max(1, Math.round(p.width * scale)), height: Math.max(1, Math.round(p.height * scale)) };
  });
  let widest = 0;
  for (const s of sizes) widest = Math.max(widest, s.width);
  const width = Math.max(containerWidth, widest + pad * 2);
  let top = pad;
  const boxes = sizes.map((s) => {
    const box: PageBox = { ...s, top, left: Math.round((width - s.width) / 2) };
    top += s.height + gap;
    return box;
  });
  return { boxes, width, height: boxes.length ? top - gap + pad : 0 };
}

/** index of the page at content coordinate y (the next page when y falls in a gap) */
export function pageAtY(layout: Layout, y: number): number {
  let lo = 0;
  let hi = layout.boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const b = layout.boxes[mid]!;
    if (b.top + b.height < y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

/** inclusive page range intersecting [y0, y1] */
export function pagesBetween(layout: Layout, y0: number, y1: number): [number, number] {
  if (!layout.boxes.length) return [0, -1];
  const first = pageAtY(layout, y0);
  let last = first;
  while (last + 1 < layout.boxes.length && layout.boxes[last + 1]!.top <= y1) last++;
  return [first, last];
}

/** the page that occupies most of the viewport */
export function dominantPage(layout: Layout, top: number, height: number): number {
  const [first, last] = pagesBetween(layout, top, top + height);
  let best = first;
  let bestVisible = -1;
  for (let i = first; i <= last; i++) {
    const b = layout.boxes[i]!;
    const visible = Math.min(b.top + b.height, top + height) - Math.max(b.top, top);
    if (visible > bestVisible + 1) {
      best = i;
      bestVisible = visible;
    }
  }
  return best;
}

/** a page point pinned to a viewport position, used to keep the view stable while zooming */
export interface Anchor {
  page: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
}

export function anchorAt(layout: Layout, scrollLeft: number, scrollTop: number, vx: number, vy: number): Anchor {
  const page = pageAtY(layout, scrollTop + vy);
  const b = layout.boxes[page] ?? { left: 0, top: 0, scale: 1 };
  return { page, px: (scrollLeft + vx - b.left) / b.scale, py: (scrollTop + vy - b.top) / b.scale, vx, vy };
}

export function scrollForAnchor(layout: Layout, a: Anchor): { left: number; top: number } {
  const b = layout.boxes[Math.min(a.page, layout.boxes.length - 1)];
  if (!b) return { left: 0, top: 0 };
  return { left: b.left + a.px * b.scale - a.vx, top: b.top + a.py * b.scale - a.vy };
}

/* ---------- text lines ---------- */

/** a line in its own coordinates: origin on the baseline, u along it, v downwards */
export interface LineFrame {
  ox: number;
  oy: number;
  angle: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export function toLocal(f: Pick<LineFrame, "ox" | "oy" | "angle">, p: Point): Point {
  const dx = p[0] - f.ox;
  const dy = p[1] - f.oy;
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  return [dx * c + dy * s, -dx * s + dy * c];
}

export function fromLocal(f: Pick<LineFrame, "ox" | "oy" | "angle">, p: Point): Point {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  return [f.ox + p[0] * c - p[1] * s, f.oy + p[0] * s + p[1] * c];
}

export function quadPoints(q: Quad): Point[] {
  // ul, ur, lr, ll (drawing order)
  return [
    [q[0], q[1]],
    [q[2], q[3]],
    [q[6], q[7]],
    [q[4], q[5]],
  ];
}

export function lineFrame(line: Pick<TextLine, "origin" | "angle" | "quad" | "style">): LineFrame {
  const base = { ox: line.origin[0], oy: line.origin[1], angle: line.angle };
  const pts = quadPoints(line.quad).map((p) => toLocal(base, p));
  const us = pts.map((p) => p[0]);
  const vs = pts.map((p) => p[1]);
  let vMin = Math.min(...vs);
  let vMax = Math.max(...vs);
  // degenerate quads still need a usable box
  if (vMax - vMin < 1) {
    vMin = -line.style.size * 0.8;
    vMax = line.style.size * 0.25;
  }
  return { ...base, uMin: Math.min(...us), uMax: Math.max(...us), vMin, vMax };
}

/**
 * The line a tap at `p` means. Hit boxes are widened to at least 44 CSS px high on touch; when several
 * match, the one whose own box is closest wins.
 */
export function nearestLine(lines: TextLine[], p: Point, scale: number, touch: boolean): TextLine | null {
  let best: TextLine | null = null;
  let bestScore = Infinity;
  const slopX = (touch ? 14 : 3) / scale;
  for (const line of lines) {
    const f = lineFrame(line);
    const [u, v] = toLocal(f, p);
    const dx = Math.max(0, f.uMin - u, u - f.uMax);
    const dy = Math.max(0, f.vMin - v, v - f.vMax);
    const slopY = touch ? Math.max(6 / scale, (TAP / scale - (f.vMax - f.vMin)) / 2) : 2 / scale;
    if (dx > slopX || dy > slopY) continue;
    // distance outside the box dominates; distance to the middle line breaks ties between overlaps
    const centre = Math.abs(v - (f.vMin + f.vMax) / 2);
    const score = (dy + dx) * 1000 + centre;
    if (score < bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Is a finger tap at `p` too coarse to say which line is meant? True when the text is tiny on screen and a
 * second line is about as close to the finger: the view then magnifies the spot instead of guessing.
 */
export function ambiguousTap(lines: TextLine[], p: Point, scale: number): boolean {
  const reach = 14;
  const near: { distance: number; height: number }[] = [];
  for (const line of lines) {
    const f = lineFrame(line);
    const [u, v] = toLocal(f, p);
    const dx = Math.max(0, f.uMin - u, u - f.uMax) * scale;
    const dy = Math.max(0, f.vMin - v, v - f.vMax) * scale;
    if (dx <= reach && dy <= reach) near.push({ distance: Math.hypot(dx, dy), height: (f.vMax - f.vMin) * scale });
  }
  if (near.length < 2) return false;
  near.sort((a, b) => a.distance - b.distance);
  return near[0]!.height < 13 && near[1]!.distance - near[0]!.distance < 12;
}

/**
 * While a line is open: does a tap at `p` still mean that line (to put the caret in it), although it landed
 * beside it? Only when no other line is actually under the finger.
 */
export function meansOpenLine(lines: TextLine[], open: TextLine, p: Point, scale: number): boolean {
  const gap = (line: TextLine) => {
    const f = lineFrame(line);
    const [u, v] = toLocal(f, p);
    return [Math.max(0, f.uMin - u, u - f.uMax) * scale, Math.max(0, f.vMin - v, v - f.vMax) * scale] as const;
  };
  const [dx, dy] = gap(open);
  if (dx > 32 || dy > 14) return false;
  if (dx === 0 && dy === 0) return true;
  return !lines.some((line) => {
    if (line.id === open.id) return false;
    const [x, y] = gap(line);
    return x <= Math.min(dx, 4) && y <= Math.min(dy, 3);
  });
}

/**
 * Lines in the order a reader takes them, for stepping to the previous and next one: columns of running text
 * one after the other, blocks from the top, and tables row by row.
 */
export function readingOrder<T extends Pick<TextLine, "rect" | "dir">>(lines: T[], pageWidth: number): T[] {
  if (lines.length < 2) return [...lines];
  const middle = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!;
  const height = Math.max(1, middle(lines.map((l) => l.rect[3] - l.rect[1])));
  /** groups separated by an empty band of at least `gap` along one axis */
  const split = (items: T[], axis: 0 | 1, gap: number) => {
    const sorted = [...items].sort((a, b) => a.rect[axis] - b.rect[axis]);
    const groups: T[][] = [];
    let end = -Infinity;
    for (const item of sorted) {
      if (item.rect[axis] > end + gap) groups.push([]);
      groups[groups.length - 1]!.push(item);
      end = Math.max(end, item.rect[axis === 0 ? 2 : 3]);
    }
    return groups;
  };
  const order = (items: T[]): T[] => {
    if (items.length < 2) return items;
    const columns = split(items, 0, height * 0.8);
    const running = (c: T[]) => c.length >= 4 && middle(c.map((l) => l.rect[2] - l.rect[0])) > pageWidth * 0.2;
    if (columns.length > 1 && columns.every(running)) return columns.flatMap(order);
    const blocks = split(items, 1, height * 0.6);
    if (blocks.length > 1) return blocks.flatMap(order);
    // one band: rows from the top, each read in its own direction
    const centre = (l: T) => (l.rect[1] + l.rect[3]) / 2;
    const sorted = [...items].sort((a, b) => centre(a) - centre(b));
    const rows: T[][] = [];
    for (const item of sorted) {
      const row = rows[rows.length - 1];
      if (row && centre(item) - centre(row[0]!) < height * 0.5) row.push(item);
      else rows.push([item]);
    }
    return rows.flatMap((row) => {
      const rtl = row.filter((l) => l.dir === "rtl").length * 2 > row.length;
      return row.sort((a, b) => (rtl ? b.rect[0] - a.rect[0] : a.rect[0] - b.rect[0]));
    });
  };
  return order(lines);
}

/* ---------- rects and added objects ---------- */

export function normRect(a: Point, b: Point): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export const rectW = (r: Rect) => r[2] - r[0];
export const rectH = (r: Rect) => r[3] - r[1];
export const rectCentre = (r: Rect): Point => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

export function rotateAround(p: Point, c: Point, degrees: number): Point {
  if (!degrees) return p;
  const a = (degrees * Math.PI) / 180;
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * Math.cos(a) - dy * Math.sin(a), c[1] + dx * Math.sin(a) + dy * Math.cos(a)];
}

export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function insideRect(r: Rect, p: Point, pad = 0): boolean {
  return p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad;
}

export function hitObject(o: PageObject, p: Point, tolerance: number): boolean {
  const q = rotateAround(p, rectCentre(o.rect), -(o.rotation ?? 0));
  if (o.kind === "line" || o.kind === "arrow")
    return segmentDistance(q, o.from, o.to) <= tolerance + o.strokeWidth / 2;
  if (o.kind === "ink")
    return o.paths.some((path) =>
      path.some((pt, i) => segmentDistance(q, pt, path[i + 1] ?? pt) <= tolerance + o.strokeWidth / 2),
    );
  return insideRect(o.rect, q, tolerance);
}

/** map every coordinate an object carries from its rect to `rect` */
export function withRect<T extends PageObject>(o: T, rect: Rect): T {
  const from = o.rect;
  const sx = rectW(from) > 0.01 ? rectW(rect) / rectW(from) : 1;
  const sy = rectH(from) > 0.01 ? rectH(rect) / rectH(from) : 1;
  const map = ([x, y]: Point): Point => [rect[0] + (x - from[0]) * sx, rect[1] + (y - from[1]) * sy];
  const next = { ...o, rect } as PageObject;
  if (next.kind === "line" || next.kind === "arrow") {
    next.from = map(next.from);
    next.to = map(next.to);
  } else if (next.kind === "ink") {
    next.paths = next.paths.map((path) => path.map(map));
  }
  return next as T;
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * Drag a resize handle of a (possibly rotated) rect to page point `p`. The opposite side stays where it
 * is on screen. keepRatio applies to corner handles.
 */
export function resizeRect(rect: Rect, rotation: number, handle: Handle, p: Point, keepRatio: boolean, min = 6): Rect {
  const c = rectCentre(rect);
  const q = rotateAround(p, c, -rotation);
  let [x0, y0, x1, y1] = rect;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.startsWith("n");
  const south = handle.startsWith("s");
  if (west) x0 = Math.min(q[0], x1 - min);
  if (east) x1 = Math.max(q[0], x0 + min);
  if (north) y0 = Math.min(q[1], y1 - min);
  if (south) y1 = Math.max(q[1], y0 + min);
  if (keepRatio && handle.length === 2 && rectW(rect) > 0 && rectH(rect) > 0) {
    const k = Math.max((x1 - x0) / rectW(rect), (y1 - y0) / rectH(rect));
    const w = rectW(rect) * k;
    const h = rectH(rect) * k;
    if (west) x0 = x1 - w;
    else x1 = x0 + w;
    if (north) y0 = y1 - h;
    else y1 = y0 + h;
  }
  if (!rotation) return [x0, y0, x1, y1];
  // keep the fixed side in place although the centre of rotation moved
  const nc = rectCentre([x0, y0, x1, y1]);
  const moved = rotateAround(nc, c, rotation);
  const dx = moved[0] - nc[0];
  const dy = moved[1] - nc[1];
  return [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
}

export function boundsOf(points: Point[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** drop points closer than `eps` to the simplified path (Ramer-Douglas-Peucker) */
export function simplify(points: Point[], eps: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let dist = eps;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i]!, points[a]!, points[b]!);
      if (d > dist) {
        dist = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** SVG path through the points with quadratic midpoints */
export function smoothPath(points: Point[]): string {
  if (!points.length) return "";
  const [first, ...rest] = points;
  if (!rest.length) return `M${first![0]} ${first![1]}l0.01 0`;
  let d = `M${first![0]} ${first![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    d += `Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = points[points.length - 1]!;
  return d + `L${last[0]} ${last[1]}`;
}

/* ---------- colour ---------- */

export function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace("#", ""), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
