/**
 * Pixel work on a scanned line: find the ink (and only the ink of this line), keep ruled lines and
 * neighbouring text, and rebuild the paper behind the removed letters including its grain.
 *
 * Geometry is expressed in the line's own frame so that tilted and rotated lines need no special cases:
 * a runs along the baseline, b runs downwards from it, both in pixels.
 */
import type { RGB } from "../types";

export interface Raster {
  width: number;
  height: number;
  /** 1 = grey, 3 = RGB */
  n: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Box {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

export interface LineShape extends Box {
  /** pixel position of the baseline origin */
  ox: number;
  oy: number;
  /** unit vectors in pixel space: along the line, and downwards */
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  words: Box[];
}

export interface InkMetrics {
  aFrom: number;
  aTo: number;
  /** b of the highest and lowest ink, ignoring stray pixels */
  top: number;
  bottom: number;
  /** b below which 1%, 50% and 99% of the ink lies */
  p1: number;
  p50: number;
  p99: number;
  /** average stroke thickness in pixels */
  stroke: number;
  /** ink density resampled to GRID_ROWS rows, for comparing shapes */
  grid: { width: number; rows: number; data: Float32Array };
}

export interface Ink {
  /** every pixel that looks like ink, rules included */
  all: Uint8Array;
  rules: Uint8Array;
  /** core pixels of the letters of this line */
  letters: Uint8Array;
  /** letters plus their soft edges: what the patch replaces */
  mask: Uint8Array;
  color: RGB;
  paper: RGB;
  /** light letters on a dark ground */
  inverted: boolean;
  /** the line is underlined (the underline counts as part of its ink) */
  underline: boolean;
  metrics: InkMetrics | null;
}

export const GRID_ROWS = 28;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function analyzeInk(raster: Raster, line: LineShape): Ink {
  const { width: w, height: h, n } = raster;
  const size = w * h;
  const H = Math.max(6, line.b1 - line.b0);

  const along = new Float32Array(size);
  const below = new Float32Array(size);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const dx = x + 0.5 - line.ox;
      const dy = y + 0.5 - line.oy;
      along[i] = dx * line.ux + dy * line.uy;
      below[i] = dx * line.vx + dy * line.vy;
    }
  }

  const pad = H * 0.14;
  // the whole line counts as well as its words: a character the recogniser missed still has to go
  const boxes: Box[] = [line, ...line.words];
  /** 1 = inside a word box (padded), 2 = in its middle */
  const zone = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const a = along[i]!;
    const b = below[i]!;
    for (const box of boxes) {
      if (a >= box.a0 - pad && a <= box.a1 + pad && b >= box.b0 - pad && b <= box.b1 + pad) {
        const trim = (box.b1 - box.b0) * 0.2;
        const mid = a >= box.a0 && a <= box.a1 && b >= box.b0 + trim && b <= box.b1 - trim;
        if (mid) {
          zone[i] = 2;
          break;
        }
        zone[i] = 1;
      }
    }
  }

  // polarity: compare what is inside the boxes with the surroundings
  const lum = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    lum[i] = n === 1 ? raster.data[i]! : (raster.data[i * 3]! * 77 + raster.data[i * 3 + 1]! * 150 + raster.data[i * 3 + 2]! * 29) >> 8;
  }
  const inside = new Uint32Array(256);
  const outside = new Uint32Array(256);
  for (let i = 0; i < size; i++) (zone[i] ? inside : outside)[lum[i]!]!++;
  const split = otsuThreshold(inside);
  const low = classMean(inside, 0, split);
  const high = classMean(inside, split + 1, 255);
  const surround = medianOf(outside, medianOf(inside, high.mean));
  // the ground is the class that looks like the surroundings
  const inverted = low.count > 0 && high.count > 0 && Math.abs(surround - low.mean) < Math.abs(surround - high.mean);
  const contrast = Math.max(0, high.mean - low.mean);

  // local paper colour per channel
  const sign = inverted ? -1 : 1;
  const channels: Float32Array[] = [];
  for (let c = 0; c < n; c++) channels.push(localPaper(raster, c, Math.max(10, Math.round(H * 0.7)), inverted));
  const darkness = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    let d = 0;
    for (let c = 0; c < n; c++) d = Math.max(d, sign * (channels[c]![i]! - raster.data[i * n + c]!));
    darkness[i] = d;
  }

  // grain of the paper, measured where nothing is dark
  const grainHist = new Uint32Array(256);
  for (let i = 0; i < size; i++) if (!zone[i]) grainHist[clamp(Math.round(darkness[i]!), 0, 255)]!++;
  const grain = medianOf(grainHist, 0);
  const strong = clamp(contrast * 0.42, Math.max(26, grain * 4), 110);
  const weak = Math.max(14, grain * 2.2, strong * 0.42);

  const all = hysteresis(darkness, w, h, strong, weak, Math.max(2, Math.round(H * 0.06)));
  const { rules, underline } = findRules(all, along, below, line, H);

  // connected components of the remaining ink: take those that belong to this line
  const letters = new Uint8Array(size);
  const label = new Int32Array(size);
  const stack: number[] = [];
  const members: number[] = [];
  let next = 0;
  for (let s = 0; s < size; s++) {
    if (!all[s] || rules[s] || label[s]) continue;
    next++;
    label[s] = next;
    stack.push(s);
    members.length = 0;
    let core = 0;
    let middle = 0;
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    let border = false;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      if (zone[i]) core++;
      if (zone[i] === 2) middle++;
      const a = along[i]!;
      const b = below[i]!;
      if (a < a0) a0 = a;
      if (a > a1) a1 = a;
      if (b < b0) b0 = b;
      if (b > b1) b1 = b;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (all[j] && !rules[j] && !label[j]) {
            label[j] = next;
            stack.push(j);
          }
        }
      }
    }
    const mostlyInside = core >= members.length * 0.6;
    // ascenders, matras and descenders may poke out of the recognised box
    const attached =
      middle > 0 &&
      !border &&
      b0 >= line.b0 - H * 0.45 &&
      b1 <= line.b1 + H * 0.45 &&
      a0 >= line.a0 - H * 0.6 &&
      a1 <= line.a1 + H * 0.6;
    if (mostlyInside || attached) for (const i of members) letters[i] = 1;
    // a component that is mostly elsewhere still loses the part that lies inside a word
    else if (middle > members.length * 0.25) for (const i of members) if (zone[i]) letters[i] = 1;
  }
  // faint remains inside the words (broken strokes, bleed-through of the same print) go as well
  const faint = Math.max(10, grain * 2, strong * 0.3);
  for (let i = 0; i < size; i++) if (zone[i] === 2 && darkness[i]! > faint && !rules[i] && !all[i]) letters[i] = 1;
  let underlined = false;
  for (let i = 0; i < size; i++) {
    if (!underline[i]) continue;
    letters[i] = 1;
    underlined = true;
  }

  // soften: grow by a few pixels, never over rules or other people's ink
  const radius = clamp(Math.round(H * 0.075), 2, 7);
  const mask = dilate(letters, w, h, radius);
  // swallow the little islands of paper between strokes: their ringing would ghost the old letters
  const close = radius + 1;
  const far = dilate(mask, w, h, close);
  for (let i = 0; i < size; i++) far[i] = far[i] ? 0 : 1;
  const open = dilate(far, w, h, close);
  for (let i = 0; i < size; i++) if (!open[i]) mask[i] = 1;
  const keep = dilate(rules, w, h, 1);
  const others = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (all[i] && !letters[i] && !rules[i]) others[i] = 1;
  for (let i = 0; i < size; i++) if ((keep[i] && !letters[i]) || rules[i] || others[i]) mask[i] = 0;

  const color = inkColor(raster, letters, darkness, inverted);
  const paper = paperColor(raster, all, mask);
  const solid = new Uint8Array(size);
  const half = Math.max(weak, contrast * 0.5);
  // the underline would distort the measurements of the type
  for (let i = 0; i < size; i++) if (letters[i] && !underline[i] && darkness[i]! >= half) solid[i] = 1;
  return { all, rules, letters, mask, color, paper, inverted, underline: underlined, metrics: measure(solid, w, h, along, below) };
}

function otsuThreshold(hist: Uint32Array): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i]!;
    sum += i * hist[i]!;
  }
  let wl = 0;
  let sl = 0;
  let best = -1;
  let at = 127;
  for (let i = 0; i < 256; i++) {
    wl += hist[i]!;
    if (!wl || wl === total) {
      sl += i * hist[i]!;
      continue;
    }
    sl += i * hist[i]!;
    const d = sl / wl - (sum - sl) / (total - wl);
    const v = wl * (total - wl) * d * d;
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

function classMean(hist: Uint32Array, from: number, to: number) {
  let count = 0;
  let sum = 0;
  for (let i = from; i <= to; i++) {
    count += hist[i]!;
    sum += i * hist[i]!;
  }
  return { count, mean: count ? sum / count : from };
}

function medianOf(hist: Uint32Array, fallback: number): number {
  let total = 0;
  for (const v of hist) total += v;
  if (!total) return fallback;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc * 2 >= total) return i;
  }
  return 255;
}

/** per cell, the brightness of the paper (a high percentile; low for light-on-dark), interpolated */
function localPaper(raster: Raster, channel: number, cell: number, inverted: boolean): Float32Array {
  const { width: w, height: h, n, data } = raster;
  const cols = Math.max(1, Math.round(w / cell));
  const rows = Math.max(1, Math.round(h / cell));
  const grid = new Float32Array(cols * rows);
  const hist = new Uint32Array(256);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      hist.fill(0);
      const x0 = Math.floor((c * w) / cols);
      const x1 = Math.floor(((c + 1) * w) / cols);
      const y0 = Math.floor((r * h) / rows);
      const y1 = Math.floor(((r + 1) * h) / rows);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          hist[data[(y * w + x) * n + channel]!]!++;
          count++;
        }
      }
      const target = count * (inverted ? 0.2 : 0.8);
      let acc = 0;
      let v = 0;
      for (; v < 255; v++) {
        acc += hist[v]!;
        if (acc >= target) break;
      }
      grid[r * cols + c] = v;
    }
  }
  // a cell filled with ink borrows from its neighbours
  const fixed = new Float32Array(grid.length);
  const near: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      near.length = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) near.push(grid[rr * cols + cc]!);
        }
      near.sort((a, b) => a - b);
      const median = near[near.length >> 1]!;
      const own = grid[r * cols + c]!;
      fixed[r * cols + c] = inverted ? Math.min(own, median + 12) : Math.max(own, median - 12);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = clamp(((y + 0.5) * rows) / h - 0.5, 0, rows - 1);
    const r0 = Math.floor(gy);
    const r1 = Math.min(rows - 1, r0 + 1);
    const fy = gy - r0;
    for (let x = 0; x < w; x++) {
      const gx = clamp(((x + 0.5) * cols) / w - 0.5, 0, cols - 1);
      const c0 = Math.floor(gx);
      const c1 = Math.min(cols - 1, c0 + 1);
      const fx = gx - c0;
      const top = fixed[r0 * cols + c0]! * (1 - fx) + fixed[r0 * cols + c1]! * fx;
      const bottom = fixed[r1 * cols + c0]! * (1 - fx) + fixed[r1 * cols + c1]! * fx;
      out[y * w + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/** strong pixels plus the weaker ones touching them (anti-aliased edges), up to `reach` pixels away */
function hysteresis(d: Float32Array, w: number, h: number, strong: number, weak: number, reach: number): Uint8Array {
  const out = new Uint8Array(w * h);
  let front: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (d[i]! >= strong) {
      out[i] = 1;
      front.push(i);
    }
  }
  for (let step = 0; step < reach && front.length; step++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < out.length && !out[j] && d[j]! >= weak) {
          out[j] = 1;
          next.push(j);
        }
      }
    }
    front = next;
  }
  return out;
}

/**
 * Ruled lines, table borders and boxes: long straight runs that carry on beyond the text. Found in the
 * line frame, so a tilted scan with tilted rules works too. A run just under the baseline that spans the
 * text and stops with it is the text's underline instead.
 */
function findRules(ink: Uint8Array, along: Float32Array, below: Float32Array, line: LineShape, H: number) {
  let aMin = Infinity;
  let aMax = -Infinity;
  let bMin = Infinity;
  let bMax = -Infinity;
  for (let i = 0; i < ink.length; i++) {
    if (along[i]! < aMin) aMin = along[i]!;
    if (along[i]! > aMax) aMax = along[i]!;
    if (below[i]! < bMin) bMin = below[i]!;
    if (below[i]! > bMax) bMax = below[i]!;
  }
  const cols = Math.ceil(aMax - aMin) + 2;
  const rows = Math.ceil(bMax - bMin) + 2;
  const grid = new Uint8Array(cols * rows);
  for (let i = 0; i < ink.length; i++) {
    if (ink[i]) grid[Math.round(below[i]! - bMin) * cols + Math.round(along[i]! - aMin)] = 1;
  }
  const found = new Uint8Array(cols * rows);
  const under = new Uint8Array(cols * rows);

  /** scan lines of `length` cells; `at(k, t)` addresses cell t of line k */
  const sweep = (
    lines: number,
    length: number,
    at: (k: number, t: number) => number,
    classify: (from: number, to: number, k: number) => Uint8Array | null,
  ) => {
    const on = (k: number, t: number) =>
      grid[at(k, t)] || (k > 0 && grid[at(k - 1, t)]) || (k < lines - 1 && grid[at(k + 1, t)]);
    for (let k = 0; k < lines; k++) {
      let start = -1;
      let last = -1;
      for (let t = 0; t <= length; t++) {
        if (t < length && on(k, t)) {
          if (start < 0) start = t;
          last = t;
        } else if (start >= 0 && (t - last > 2 || t === length)) {
          const target = classify(start, last, k);
          if (target) for (let q = start; q <= last; q++) target[at(k, q)] = 1;
          start = -1;
        }
      }
    }
  };

  // horizontal: longer than a few letters and sticking out past the first or last letter
  sweep(
    rows,
    cols,
    (k, t) => k * cols + t,
    (from, to, k) => {
      const a = from + aMin;
      const b = to + aMin;
      if (b - a > H * 2.2 && (a < line.a0 - H * 0.7 || b > line.a1 + H * 0.7)) return found;
      const depth = k + bMin;
      const spans = b - a > Math.max(H * 2.5, (line.a1 - line.a0) * 0.8);
      return spans && depth > Math.max(2, H * 0.09) && depth < line.b1 + H * 0.4 ? under : null;
    },
  );
  // vertical: taller than the line and sticking out above or below it
  sweep(
    cols,
    rows,
    (k, t) => t * cols + k,
    (from, to) => {
      const a = from + bMin;
      const b = to + bMin;
      return b - a > H * 1.55 && (a < line.b0 - H * 0.35 || b > line.b1 + H * 0.35) ? found : null;
    },
  );

  const rules = new Uint8Array(ink.length);
  const underline = new Uint8Array(ink.length);
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue;
    const at = Math.round(below[i]! - bMin) * cols + Math.round(along[i]! - aMin);
    if (found[at]) rules[i] = 1;
    else if (under[at]) underline[i] = 1;
  }
  return { rules, underline };
}

/** square dilation by `r` pixels (two running passes) */
export function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const pass = (input: Uint8Array, count: number, length: number, at: (k: number, t: number) => number) => {
    const out = new Uint8Array(input.length);
    for (let k = 0; k < count; k++) {
      let reach = -1;
      for (let t = 0; t < length; t++) if (input[at(k, t)]) for (let q = Math.max(reach + 1, t - r); q <= Math.min(length - 1, t + r); q++) {
        out[at(k, q)] = 1;
        reach = q;
      }
    }
    return out;
  };
  const across = pass(src, h, w, (y, x) => y * w + x);
  return pass(across, w, h, (x, y) => y * w + x);
}

function inkColor(raster: Raster, letters: Uint8Array, darkness: Float32Array, inverted: boolean): RGB {
  const { n, data } = raster;
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < letters.length; i++) {
    if (!letters[i]) continue;
    hist[clamp(Math.round(darkness[i]!), 0, 255)]!++;
    total++;
  }
  if (!total) return inverted ? [1, 1, 1] : [0, 0, 0];
  // the heart of the strokes: the darker half (blurred edges would wash the colour out)
  let acc = 0;
  let from = 255;
  for (; from > 0; from--) {
    acc += hist[from]!;
    if (acc >= total * 0.5) break;
  }
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < letters.length; i++) {
    if (!letters[i] || darkness[i]! < from) continue;
    for (let c = 0; c < 3; c++) sum[c]! += data[i * n + (n === 1 ? 0 : c)]!;
    count++;
  }
  return sum.map((s) => Math.round((s / Math.max(1, count) / 255) * 1000) / 1000) as RGB;
}

function paperColor(raster: Raster, ink: Uint8Array, mask: Uint8Array): RGB {
  const { n, data } = raster;
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < ink.length; i++) {
    if (ink[i] || mask[i]) continue;
    for (let c = 0; c < 3; c++) sum[c]! += data[i * n + (n === 1 ? 0 : c)]!;
    count++;
  }
  return sum.map((s) => (count ? s / count / 255 : 1)) as RGB;
}

function measure(solid: Uint8Array, w: number, h: number, along: Float32Array, below: Float32Array): InkMetrics | null {
  const as: number[] = [];
  const bs: number[] = [];
  let edge = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!solid[i]) continue;
      as.push(along[i]!);
      bs.push(below[i]!);
      if (x === 0 || !solid[i - 1]) edge++;
      if (x === w - 1 || !solid[i + 1]) edge++;
      if (y === 0 || !solid[i - w]) edge++;
      if (y === h - 1 || !solid[i + w]) edge++;
    }
  }
  if (as.length < 12) return null;
  const sortedA = Float32Array.from(as).sort();
  const sortedB = Float32Array.from(bs).sort();
  const q = (s: Float32Array, p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const aFrom = q(sortedA, 0.001);
  const aTo = q(sortedA, 0.999) + 1;
  const p1 = q(sortedB, 0.01);
  const p50 = q(sortedB, 0.5);
  const p99 = q(sortedB, 0.99) + 1;
  const height = Math.max(1, p99 - p1);
  const scale = GRID_ROWS / height;
  const gw = Math.max(1, Math.min(1200, Math.round((aTo - aFrom) * scale)));
  const data = new Float32Array(gw * GRID_ROWS);
  const area = Math.max(1, ((aTo - aFrom) / gw) * (height / GRID_ROWS));
  for (let k = 0; k < as.length; k++) {
    const gx = Math.floor(((as[k]! - aFrom) / (aTo - aFrom)) * gw);
    const gy = Math.floor((bs[k]! - p1) * scale);
    if (gx >= 0 && gx < gw && gy >= 0 && gy < GRID_ROWS) data[gy * gw + gx]! += 1 / area;
  }
  return { aFrom, aTo, top: q(sortedB, 0.002), bottom: q(sortedB, 0.998) + 1, p1, p50, p99, stroke: (2 * solid.reduce((s, v) => s + v, 0)) / Math.max(1, edge), grid: { width: gw, rows: GRID_ROWS, data } };
}

/* ---------- rebuilding the paper ---------- */

export interface Patch {
  /** position inside the raster */
  x: number;
  y: number;
  width: number;
  height: number;
  /** colour samples, n channels per pixel */
  color: Uint8Array;
  alpha: Uint8Array;
  n: number;
}

export function inpaint(raster: Raster, ink: Ink, seed = 7): Patch | null {
  const { width: w, height: h, n, data } = raster;
  const { mask, all } = ink;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;

  // only untouched paper may feed the reconstruction, and not the ringing close to the letters
  const dirty = dilate(all, w, h, 2);
  const nearMask = dilate(mask, w, h, 2);
  for (let i = 0; i < dirty.length; i++) if (nearMask[i]) dirty[i] = 1;
  const smooth = pushPull(raster, dirty);

  // grain: how clean pixels differ from the local average of the paper
  const base = boxBlur(smooth, w, h, n, 3);
  const filled = smooth.slice();
  for (let i = 0; i < dirty.length; i++) if (!dirty[i]) for (let c = 0; c < n; c++) filled[i * n + c] = data[i * n + c]!;
  const local = boxBlur(filled, w, h, n, 3);
  const pool: number[] = [];
  for (let i = 0; i < dirty.length; i++) if (!dirty[i]) pool.push(i);

  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };

  // copy grain block by block so that its texture (not just its strength) survives
  const block = 7;
  const reach = Math.max(14, Math.round((y1 - y0) * 1.1));
  const offsets = new Map<number, [number, number]>();
  const offsetFor = (bx: number, by: number): [number, number] => {
    const key = by * 100000 + bx;
    let o = offsets.get(key);
    if (o) return o;
    let best: [number, number] = [0, 0];
    let bestClean = -1;
    for (let t = 0; t < 14 && bestClean < block * block; t++) {
      const dx = Math.round((rnd() - 0.5) * reach * 4);
      const dy = Math.round((rnd() - 0.5) * reach * 2);
      let clean = 0;
      for (let y = by * block; y < (by + 1) * block; y++) {
        for (let x = bx * block; x < (bx + 1) * block; x++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && !dirty[yy * w + xx]) clean++;
        }
      }
      if (clean > bestClean) {
        bestClean = clean;
        best = [dx, dy];
      }
    }
    offsets.set(key, (o = best));
    return o;
  };

  x0 = Math.max(0, x0 - 2);
  y0 = Math.max(0, y0 - 2);
  x1 = Math.min(w - 1, x1 + 2);
  y1 = Math.min(h - 1, y1 + 2);
  const pw = x1 - x0 + 1;
  const ph = y1 - y0 + 1;
  const color = new Uint8Array(pw * ph * n);
  const alpha = new Uint8Array(pw * ph);
  const soft = dilate(mask, w, h, 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const p = (y - y0) * pw + (x - x0);
      if (mask[i]) alpha[p] = 255;
      // one pixel of feathering, but never over rules or neighbouring ink
      else if (soft[i] && !all[i]) alpha[p] = 128;
      let source = -1;
      if (alpha[p] && pool.length) {
        const [dx, dy] = offsetFor(Math.floor(x / block), Math.floor(y / block));
        const xx = x + dx;
        const yy = y + dy;
        source = xx >= 0 && yy >= 0 && xx < w && yy < h && !dirty[yy * w + xx] ? yy * w + xx : pool[(rnd() * pool.length) | 0]!;
      }
      for (let c = 0; c < n; c++) {
        let v = base[i * n + c]!;
        if (source >= 0) v += data[source * n + c]! - local[source * n + c]!;
        color[p * n + c] = clamp(Math.round(v), 0, 255);
      }
    }
  }
  return { x: x0, y: y0, width: pw, height: ph, color, alpha, n };
}

/** fill the dirty pixels from clean ones with an image pyramid: smooth, and follows gradients */
function pushPull(raster: Raster, dirty: Uint8Array): Float32Array {
  const { width, height, n, data } = raster;
  interface Level {
    w: number;
    h: number;
    value: Float32Array;
    weight: Float32Array;
  }
  const first: Level = { w: width, h: height, value: new Float32Array(width * height * n), weight: new Float32Array(width * height) };
  for (let i = 0; i < width * height; i++) {
    if (dirty[i]) continue;
    first.weight[i] = 1;
    for (let c = 0; c < n; c++) first.value[i * n + c] = data[i * n + c]!;
  }
  const levels = [first];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const p = levels.at(-1)!;
    const w = Math.max(1, Math.ceil(p.w / 2));
    const h = Math.max(1, Math.ceil(p.h / 2));
    const l: Level = { w, h, value: new Float32Array(w * h * n), weight: new Float32Array(w * h) };
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const i = y * p.w + x;
        const weight = p.weight[i]!;
        if (!weight) continue;
        const j = (y >> 1) * w + (x >> 1);
        l.weight[j]! += weight;
        for (let c = 0; c < n; c++) l.value[j * n + c]! += p.value[i * n + c]! * weight;
      }
    }
    for (let j = 0; j < w * h; j++) {
      const weight = l.weight[j]!;
      if (!weight) continue;
      for (let c = 0; c < n; c++) l.value[j * n + c]! /= weight;
      l.weight[j] = Math.min(1, weight);
    }
    levels.push(l);
  }
  for (let k = levels.length - 2; k >= 0; k--) {
    const l = levels[k]!;
    const up = levels[k + 1]!;
    for (let y = 0; y < l.h; y++) {
      const gy = clamp((y - 0.5) / 2, 0, up.h - 1);
      const y0 = Math.floor(gy);
      const y1 = Math.min(up.h - 1, y0 + 1);
      const fy = gy - y0;
      for (let x = 0; x < l.w; x++) {
        const i = y * l.w + x;
        const weight = l.weight[i]!;
        if (weight >= 1) continue;
        const gx = clamp((x - 0.5) / 2, 0, up.w - 1);
        const x0 = Math.floor(gx);
        const x1 = Math.min(up.w - 1, x0 + 1);
        const fx = gx - x0;
        for (let c = 0; c < n; c++) {
          const top = up.value[(y0 * up.w + x0) * n + c]! * (1 - fx) + up.value[(y0 * up.w + x1) * n + c]! * fx;
          const bottom = up.value[(y1 * up.w + x0) * n + c]! * (1 - fx) + up.value[(y1 * up.w + x1) * n + c]! * fx;
          const from = top * (1 - fy) + bottom * fy;
          l.value[i * n + c] = l.value[i * n + c]! * weight + from * (1 - weight);
        }
      }
    }
  }
  return first.value;
}

function boxBlur(src: Float32Array, w: number, h: number, n: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const run = (input: Float32Array, output: Float32Array, lines: number, length: number, at: (k: number, t: number) => number) => {
    for (let k = 0; k < lines; k++) {
      for (let c = 0; c < n; c++) {
        let sum = 0;
        let count = 0;
        for (let t = 0; t <= r && t < length; t++) {
          sum += input[at(k, t) * n + c]!;
          count++;
        }
        for (let t = 0; t < length; t++) {
          output[at(k, t) * n + c] = sum / count;
          if (t + r + 1 < length) {
            sum += input[at(k, t + r + 1) * n + c]!;
            count++;
          }
          if (t - r >= 0) {
            sum -= input[at(k, t - r) * n + c]!;
            count--;
          }
        }
      }
    }
  };
  run(src, tmp, h, w, (y, x) => y * w + x);
  run(tmp, out, w, h, (x, y) => y * w + x);
  return out;
}
