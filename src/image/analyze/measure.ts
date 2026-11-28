/** Measurements taken the same way from the picture and from trial renderings, so that they compare. */
import { quantile } from "../raster";

/** average thickness of the strokes in a coverage plane: twice the area over the outline length */
export function strokeWidth(a: ArrayLike<number>, w: number, h: number): number {
  let area = 0;
  let edge = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (a[i]! < 0.5) continue;
      area++;
      if (x === 0 || a[i - 1]! < 0.5) edge++;
      if (x === w - 1 || a[i + 1]! < 0.5) edge++;
      if (y === 0 || a[i - w]! < 0.5) edge++;
      if (y === h - 1 || a[i + w]! < 0.5) edge++;
    }
  }
  // the staircase outline of slanted edges is longer than the edge itself
  return edge ? (2 * area) / (edge * 0.9) : 0;
}

/**
 * How soft the edges are: the median distance over which coverage climbs from 10% to 90% of the local
 * step, in pixels, measured across upright and level edges. 0 when there are none to measure.
 */
export function edgeWidth(a: ArrayLike<number>, w: number, h: number): number {
  const widths: number[] = [];
  const run = (lines: number, length: number, at: (line: number, t: number) => number) => {
    for (let line = 0; line < lines; line++) {
      for (let t = 1; t < length - 2; t++) {
        const p = a[at(line, t)]!;
        const q = a[at(line, t + 1)]!;
        if ((p - 0.5) * (q - 0.5) > 0 || p === q) continue;
        const up = q > p ? 1 : -1;
        // walk to the ends of the climb
        let from = t;
        while (from > 0 && t - from < 7 && (a[at(line, from)]! - a[at(line, from - 1)]!) * up > 0.025) from--;
        let to = t + 1;
        while (to < length - 1 && to - t < 8 && (a[at(line, to + 1)]! - a[at(line, to)]!) * up > 0.025) to++;
        const lo = Math.min(a[at(line, from)]!, a[at(line, to)]!);
        const hi = Math.max(a[at(line, from)]!, a[at(line, to)]!);
        if (hi - lo < 0.65 || lo > 0.25 || hi < 0.75) continue;
        const cross = (level: number) => {
          for (let k = from; k < to; k++) {
            const m = a[at(line, k)]!;
            const n = a[at(line, k + 1)]!;
            if ((m - level) * (n - level) <= 0 && m !== n) return k + (level - m) / (n - m);
          }
          return null;
        };
        const low = cross(lo + (hi - lo) * 0.1);
        const high = cross(lo + (hi - lo) * 0.9);
        if (low !== null && high !== null) widths.push(Math.abs(high - low));
      }
    }
  };
  run(h, w, (y, x) => y * w + x);
  run(w, h, (x, y) => y * w + x);
  return widths.length >= 6 ? quantile(widths, 0.45) : 0;
}

/**
 * Slant of the lettering as sideways shift per pixel of height (0 = upright): the shear that makes the
 * upright strokes line up best.
 */
export function slant(a: ArrayLike<number>, w: number, h: number): number {
  const pixels: number[] = [];
  for (let i = 0; i < w * h; i++) if (a[i]! > 0.5) pixels.push(i);
  if (pixels.length < 20) return 0;
  const bins = new Float64Array(w + h * 2);
  const score = (k: number) => {
    bins.fill(0);
    for (const i of pixels) {
      const x = i % w;
      const y = (i - x) / w;
      const at = x + k * (y - h / 2) + h;
      const low = Math.floor(at);
      if (low < 0 || low + 1 >= bins.length) continue;
      bins[low]! += 1 - (at - low);
      bins[low + 1]! += at - low;
    }
    let s = 0;
    for (const b of bins) s += b * b;
    return s;
  };
  const upright = score(0);
  let best = upright;
  let at = 0;
  for (let k = -0.35; k <= 0.351; k += 0.05) {
    const s = score(k);
    if (s > best) {
      best = s;
      at = k;
    }
  }
  return best > upright * 1.12 && Math.abs(at) >= 0.1 ? at : 0;
}
