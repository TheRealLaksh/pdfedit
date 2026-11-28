/** Quadrilaterals and the perspective transform between a line's upright frame and the picture. */
import type { Pt, Quad4 } from "./types";

/** row major 3x3 */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export const quadSize = (q: Quad4) => ({
  width: Math.max(1, (dist(q[0], q[1]) + dist(q[3], q[2])) / 2),
  height: Math.max(1, (dist(q[0], q[3]) + dist(q[1], q[2])) / 2),
});

export const rectQuad = (x0: number, y0: number, x1: number, y1: number): Quad4 => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

export const centre = (q: Quad4): Pt => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];

/** direction of the reading axis, radians */
export const angleOf = (q: Quad4) => Math.atan2(q[1][1] + q[2][1] - q[0][1] - q[3][1], q[1][0] + q[2][0] - q[0][0] - q[3][0]);

export function bounds(points: readonly Pt[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function rotateQuad(q: Quad4, radians: number, about: Pt = centre(q)): Quad4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return q.map(([x, y]) => [about[0] + (x - about[0]) * c - (y - about[1]) * s, about[1] + (x - about[0]) * s + (y - about[1]) * c]) as Quad4;
}

/** maps the rectangle [0,width] x [0,height] onto the quad */
export function homography(width: number, height: number, q: Quad4): Mat3 {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1[0] - p2[0];
  const dx2 = p3[0] - p2[0];
  const dy1 = p1[1] - p2[1];
  const dy2 = p3[1] - p2[1];
  const sx = p0[0] - p1[0] + p2[0] - p3[0];
  const sy = p0[1] - p1[1] + p2[1] - p3[1];
  const det = dx1 * dy2 - dx2 * dy1;
  let g = 0;
  let h = 0;
  if (Math.abs(det) > 1e-9 && (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9)) {
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  // unit square -> quad, then scaled to width x height
  return [
    (p1[0] - p0[0] + g * p1[0]) / width,
    (p3[0] - p0[0] + h * p3[0]) / height,
    p0[0],
    (p1[1] - p0[1] + g * p1[1]) / width,
    (p3[1] - p0[1] + h * p3[1]) / height,
    p0[1],
    g / width,
    h / height,
    1,
  ];
}

export function project(m: Mat3, x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [
    A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

/** a quad the editor can work with: convex, in order, not degenerate */
export function isUsableQuad(q: Quad4): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  const { width, height } = quadSize(q);
  return width >= 4 && height >= 4;
}

export function insideQuad(q: Quad4, [x, y]: Pt): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** distance from a point to the quad, 0 inside */
export function quadDistance(q: Quad4, p: Pt): number {
  if (insideQuad(q, p)) return 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}
