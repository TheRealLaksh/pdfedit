/**
 * Glyph outlines to anti-aliased coverage. An own rasteriser so that lettering is identical in the worker
 * and in tests, and so that outlines can be warped into perspective and made heavier or lighter exactly.
 */
import type { Pt } from "./types";

/** path commands in font units, y up: [0,x,y] move, [1,x,y] line, [2,cx,cy,x,y] quad, [3,...] cubic, [4] close */
export type Path = number[][];

const OPS: Record<string, number> = { M: 0, L: 1, Q: 2, C: 3, Z: 4 };

export function parsePath(d: string): Path {
  const out: Path = [];
  for (const m of d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const numbers = m[2]!.trim() ? m[2]!.trim().split(/[\s,]+/).map(Number) : [];
    out.push([OPS[m[1]!]!, ...numbers]);
  }
  return out;
}

/** closed polygons of a path after the linear map `at` (into the line frame, in pixels) */
export function flatten(path: Path, at: (x: number, y: number) => Pt): Pt[][] {
  const out: Pt[][] = [];
  let contour: Pt[] = [];
  let current: Pt = [0, 0];
  const close = () => {
    if (contour.length > 2) out.push(contour);
    contour = [];
  };
  const steps = (...points: Pt[]) => {
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    return Math.max(2, Math.min(24, Math.ceil(Math.sqrt(length) * 1.2)));
  };
  for (const c of path) {
    if (c[0] === 0) {
      close();
      current = at(c[1]!, c[2]!);
      contour.push(current);
    } else if (c[0] === 1) {
      current = at(c[1]!, c[2]!);
      contour.push(current);
    } else if (c[0] === 2) {
      const a = current;
      const b = at(c[1]!, c[2]!);
      const e = at(c[3]!, c[4]!);
      const n = steps(a, b, e);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        contour.push([u * u * a[0] + 2 * u * t * b[0] + t * t * e[0], u * u * a[1] + 2 * u * t * b[1] + t * t * e[1]]);
      }
      current = e;
    } else if (c[0] === 3) {
      const a = current;
      const b = at(c[1]!, c[2]!);
      const d = at(c[3]!, c[4]!);
      const e = at(c[5]!, c[6]!);
      const n = steps(a, b, d, e);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        const p = u * u * u;
        const q = 3 * u * u * t;
        const r = 3 * u * t * t;
        const s = t * t * t;
        contour.push([p * a[0] + q * b[0] + r * d[0] + s * e[0], p * a[1] + q * b[1] + r * d[1] + s * e[1]]);
      }
      current = e;
    } else close();
  }
  close();
  return out;
}

const signedArea = (c: Pt[]) => {
  let s = 0;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) s += (c[j]![0] - c[i]![0]) * (c[j]![1] + c[i]![1]);
  return s / 2;
};

/** pushes the outline of one glyph outwards by `by` pixels (inwards when negative) */
export function embolden(contours: Pt[][], by: number): Pt[][] {
  if (!by) return contours;
  const total = contours.reduce((s, c) => s + signedArea(c), 0);
  // which side of an edge is outside follows from the direction of the outer contours
  const side = total >= 0 ? 1 : -1;
  return contours.map((c) => {
    const points = c.filter((p, i) => {
      const q = c[(i + c.length - 1) % c.length]!;
      return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6;
    });
    const normal = (a: Pt, b: Pt): Pt => {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(side * (b[1] - a[1])) / l, (-side * (b[0] - a[0])) / l];
    };
    return points.map((p, i) => {
      const n1 = normal(points[(i + points.length - 1) % points.length]!, p);
      const n2 = normal(p, points[(i + 1) % points.length]!);
      // mitre, limited so that sharp corners do not shoot out
      const k = by / Math.max(0.55, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
      return [p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k] as Pt;
    });
  });
}

/** exact area coverage (non-zero winding) of closed polygons on a width x height grid */
export class Coverage {
  private acc: Float32Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.acc = new Float32Array((width + 2) * height);
  }

  add(contours: readonly (readonly Pt[])[]): void {
    for (const c of contours)
      for (let i = 0, j = c.length - 1; i < c.length; j = i++) this.edge(c[j]![0], c[j]![1], c[i]![0], c[i]![1]);
  }

  private edge(x0: number, y0: number, x1: number, y1: number): void {
    if (y0 === y1) return;
    const w = this.width;
    // clip horizontally by clamping: winding to the left of the grid still counts
    if (x0 < 0 || x1 < 0 || x0 > w || x1 > w) {
      const cuts = [0, 1];
      if (x1 !== x0)
        for (const side of [0, w]) {
          const t = (side - x0) / (x1 - x0);
          if (t > 0 && t < 1) cuts.push(t);
        }
      if (cuts.length > 2) {
        cuts.sort((a, b) => a - b);
        for (let i = 1; i < cuts.length; i++) {
          const a = cuts[i - 1]!;
          const b = cuts[i]!;
          const clip = (x: number) => Math.max(0, Math.min(w, x));
          this.edge(clip(x0 + (x1 - x0) * a), y0 + (y1 - y0) * a, clip(x0 + (x1 - x0) * b), y0 + (y1 - y0) * b);
        }
        return;
      }
      x0 = Math.max(0, Math.min(w, x0));
      x1 = Math.max(0, Math.min(w, x1));
    }
    let dir = 1;
    if (y0 > y1) {
      [x0, y0, x1, y1] = [x1, y1, x0, y0];
      dir = -1;
    }
    const slope = (x1 - x0) / (y1 - y0);
    const top = Math.max(0, Math.floor(y0));
    const bottom = Math.min(this.height, Math.ceil(y1));
    const stride = w + 2;
    for (let y = top; y < bottom; y++) {
      const ya = Math.max(y, y0);
      const yb = Math.min(y + 1, y1);
      if (yb <= ya) continue;
      const d = (yb - ya) * dir;
      const xa = x0 + slope * (ya - y0);
      const xb = x0 + slope * (yb - y0);
      const left = Math.max(0, Math.min(xa, xb));
      const right = Math.min(w, Math.max(xa, xb));
      const li = Math.floor(left);
      const ri = Math.ceil(right);
      const row = y * stride;
      if (ri <= li + 1) {
        const mid = (left + right) / 2 - li;
        this.acc[row + li]! += d * (1 - mid);
        this.acc[row + li + 1]! += d * mid;
        continue;
      }
      const inv = 1 / (right - left);
      const lf = left - li;
      const a0 = 0.5 * inv * (1 - lf) * (1 - lf);
      const rf = right - ri + 1;
      const am = 0.5 * inv * rf * rf;
      this.acc[row + li]! += d * a0;
      if (ri === li + 2) this.acc[row + li + 1]! += d * (1 - a0 - am);
      else {
        const a1 = inv * (1.5 - lf);
        this.acc[row + li + 1]! += d * (a1 - a0);
        for (let x = li + 2; x < ri - 1; x++) this.acc[row + x]! += d * inv;
        const a2 = a1 + (ri - li - 3) * inv;
        this.acc[row + ri - 1]! += d * (1 - a2 - am);
      }
      this.acc[row + ri]! += d * am;
    }
  }

  finish(): Float32Array<ArrayBuffer> {
    const { width: w, height: h, acc } = this;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * (w + 2);
      for (let x = 0; x < w; x++) {
        sum += acc[row + x]!;
        const v = Math.abs(sum);
        out[y * w + x] = v > 1 ? 1 : v;
      }
    }
    return out;
  }
}

/** how much each third of a screen pixel takes from its neighbours (the usual screen text filter) */
const LCD = [8, 77, 86, 77, 8].map((v) => v / 256);

/**
 * Coverage of polygons on a width x height grid whose top left corner is at (x, y): one plane, or one per
 * colour for screen text with coloured edges. `gray` asks for the average of the three colours only.
 */
export function coveragePlanes(glyphs: readonly Pt[][][], x: number, y: number, width: number, height: number, subpixel: boolean, gray = false): Float32Array<ArrayBuffer>[] {
  const thirds = subpixel ? 3 : 1;
  const coverage = new Coverage(width * thirds, height);
  for (const glyph of glyphs) coverage.add(glyph.map((c) => c.map(([px, py]) => [(px - x) * thirds, py - y] as Pt)));
  const fine = coverage.finish();
  if (!subpixel) return [fine];
  const wide = width * 3;
  // the filter of each colour, or of their average, as taps from the first third of a pixel
  const kernels = gray
    ? [[0, 1, 2, 3, 4, 5, 6].map((k) => ((LCD[k] ?? 0) + (LCD[k - 1] ?? 0) + (LCD[k - 2] ?? 0)) / 3)]
    : [0, 1, 2].map(() => LCD);
  const starts = gray ? [-2] : [-2, -1, 0];
  const planes = kernels.map(() => new Float32Array(width * height));
  for (let row = 0; row < height; row++) {
    const base = row * wide;
    for (let col = 0; col < width; col++) {
      const lo = Math.max(0, col * 3 - 2);
      const hi = Math.min(wide, col * 3 + 5);
      let any = 0;
      for (let k = lo; k < hi; k++) any += fine[base + k]!;
      if (!any) continue;
      for (let p = 0; p < planes.length; p++) {
        const taps = kernels[p]!;
        const from = col * 3 + starts[p]!;
        let s = 0;
        for (let k = Math.max(from, lo); k < from + taps.length && k < hi; k++) s += fine[base + k]! * taps[k - from]!;
        planes[p]![row * width + col] = s > 1 ? 1 : s;
      }
    }
  }
  return planes;
}
