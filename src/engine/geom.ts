import type { Matrix, Point, Quad, Rect } from "./types";

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** PDF convention: result applies `a` first, then `b` (row vectors: p * a * b). */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [...IDENTITY];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export function apply(m: Matrix, p: Point): Point {
  return [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
}

export function rectFromPoints(points: Point[]): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function transformRect(m: Matrix, r: Rect): Rect {
  return rectFromPoints([
    apply(m, [r[0], r[1]]),
    apply(m, [r[2], r[1]]),
    apply(m, [r[0], r[3]]),
    apply(m, [r[2], r[3]]),
  ]);
}

export function quadToRect(q: Quad): Rect {
  return rectFromPoints([
    [q[0], q[1]],
    [q[2], q[3]],
    [q[4], q[5]],
    [q[6], q[7]],
  ]);
}

export function rectToQuad(r: Rect): Quad {
  return [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]];
}

export function intersects(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** format a number for a content stream */
export function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(5).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

export function matrixOps(m: Matrix): string {
  return m.map(num).join(" ");
}
