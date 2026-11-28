/**
 * Rebuilding the background behind removed letters. Flat colour and gradients are rebuilt exactly from a
 * fitted surface; anything with texture or structure (paper, wood, photographs, edges) is rebuilt from
 * patches of the surroundings (PatchMatch), so the grain and the lines carry on.
 */
import { clamp, dilate, quantile, random } from "./raster";

/** fill the dirty pixels from clean ones with an image pyramid: smooth, and follows gradients */
export function pushPull(rgb: Float32Array, width: number, height: number, dirty: Uint8Array): Float32Array<ArrayBuffer> {
  interface Level {
    w: number;
    h: number;
    value: Float32Array<ArrayBuffer>;
    weight: Float32Array<ArrayBuffer>;
  }
  const first: Level = { w: width, h: height, value: new Float32Array(width * height * 3), weight: new Float32Array(width * height) };
  for (let i = 0; i < width * height; i++) {
    if (dirty[i]) continue;
    first.weight[i] = 1;
    for (let c = 0; c < 3; c++) first.value[i * 3 + c] = rgb[i * 3 + c]!;
  }
  const levels = [first];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const p = levels.at(-1)!;
    const w = Math.max(1, Math.ceil(p.w / 2));
    const h = Math.max(1, Math.ceil(p.h / 2));
    const l: Level = { w, h, value: new Float32Array(w * h * 3), weight: new Float32Array(w * h) };
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const i = y * p.w + x;
        const weight = p.weight[i]!;
        if (!weight) continue;
        const j = (y >> 1) * w + (x >> 1);
        l.weight[j]! += weight;
        for (let c = 0; c < 3; c++) l.value[j * 3 + c]! += p.value[i * 3 + c]! * weight;
      }
    }
    for (let j = 0; j < w * h; j++) {
      const weight = l.weight[j]!;
      if (!weight) continue;
      for (let c = 0; c < 3; c++) l.value[j * 3 + c]! /= weight;
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
        for (let c = 0; c < 3; c++) {
          const top = up.value[(y0 * up.w + x0) * 3 + c]! * (1 - fx) + up.value[(y0 * up.w + x1) * 3 + c]! * fx;
          const bottom = up.value[(y1 * up.w + x0) * 3 + c]! * (1 - fx) + up.value[(y1 * up.w + x1) * 3 + c]! * fx;
          l.value[i * 3 + c] = l.value[i * 3 + c]! * weight + (top * (1 - fy) + bottom * fy) * (1 - weight);
        }
      }
    }
  }
  return first.value;
}

/* ---------- smooth surfaces ---------- */

const TERMS = 6;
const basis = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const f = m[r]![c]! / d;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * out[k]!;
    out[r] = s / (m[r]![r]! || 1e-9);
  }
  return out;
}

interface Surface {
  at(i: number, c: number): number;
  /** spread of the clean pixels about the surface (75th percentile) */
  spread: number;
  /** share of clean pixels far from it */
  outliers: number;
}

function fitSurface(rgb: Float32Array, w: number, h: number, pixels: number[]): Surface {
  const scale = 2 / Math.max(w, h);
  const coords = (i: number) => basis(((i % w) - w / 2) * scale, (Math.floor(i / w) - h / 2) * scale);
  const step = Math.max(1, Math.floor(pixels.length / 3000));
  const sample = pixels.filter((_, k) => k % step === 0);
  // start from the median colour so that a minority of other things cannot take over
  const median = [0, 1, 2].map((c) => quantile(sample.map((i) => rgb[i * 3 + c]!), 0.5));
  let model = median.map((m) => [m, 0, 0, 0, 0, 0]);
  const miss = (i: number) => {
    const row = coords(i);
    let d = 0;
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let k = 0; k < TERMS; k++) v += model[c]![k]! * row[k]!;
      d = Math.max(d, Math.abs(rgb[i * 3 + c]! - v));
    }
    return d;
  };
  for (let round = 0; round < 6; round++) {
    const misses = sample.map(miss);
    const limit = Math.max(2.5, quantile(misses, [0.6, 0.7, 0.8, 0.85, 0.9, 0.9][round]!) * 1.25);
    const a = Array.from({ length: TERMS }, () => new Array<number>(TERMS).fill(0));
    const b = [0, 1, 2].map(() => new Array<number>(TERMS).fill(0));
    sample.forEach((i, k) => {
      if (misses[k]! > limit) return;
      const row = coords(i);
      for (let r = 0; r < TERMS; r++) {
        for (let q = 0; q < TERMS; q++) a[r]![q]! += row[r]! * row[q]!;
        for (let c = 0; c < 3; c++) b[c]![r]! += row[r]! * rgb[i * 3 + c]!;
      }
    });
    if (a[0]![0]! < TERMS * 3) break;
    for (let r = 1; r < TERMS; r++) a[r]![r]! += a[0]![0]! * (r > 2 ? 0.002 : 0.0002);
    model = b.map((rhs) => solve(a, rhs));
  }
  const final = sample.map(miss);
  const spread = quantile(final, 0.75);
  let far = 0;
  for (const d of final) if (d > Math.max(7, spread * 3.5)) far++;
  return {
    at(i, c) {
      const row = coords(i);
      let v = 0;
      for (let k = 0; k < TERMS; k++) v += model[c]![k]! * row[k]!;
      return v;
    },
    spread,
    outliers: far / Math.max(1, final.length),
  };
}

/* ---------- patch based filling ---------- */

interface Level {
  w: number;
  h: number;
  rgb: Float32Array;
  hole: Uint8Array;
  /** never copied from */
  banned: Uint8Array;
}

function half(l: Level): Level {
  const w = Math.ceil(l.w / 2);
  const h = Math.ceil(l.h / 2);
  const rgb = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  const banned = new Uint8Array(w * h);
  const count = new Float32Array(w * h);
  for (let y = 0; y < l.h; y++) {
    for (let x = 0; x < l.w; x++) {
      const i = y * l.w + x;
      const j = (y >> 1) * w + (x >> 1);
      if (l.banned[i]) banned[j] = 1;
      if (l.hole[i]) {
        hole[j] = 1;
        continue;
      }
      count[j]!++;
      for (let c = 0; c < 3; c++) rgb[j * 3 + c]! += l.rgb[i * 3 + c]!;
    }
  }
  for (let j = 0; j < w * h; j++) {
    if (!count[j]) continue;
    for (let c = 0; c < 3; c++) rgb[j * 3 + c]! /= count[j]!;
  }
  return { w, h, rgb, hole, banned };
}

const R = 3;

/** fills l.rgb inside the hole; `field` maps each target pixel to the source it resembles */
function synthesise(l: Level, previous: { field: Int32Array; w: number; h: number } | null, rounds: number, seed: number): Int32Array {
  const { w, h, rgb, hole, banned } = l;
  const size = w * h;
  const rnd = random(seed);
  const blocked = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (hole[i] || banned[i]) blocked[i] = 1;
  const wide = dilate(blocked, w, h, R);
  let sources: number[] = [];
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) if (!wide[y * w + x]) sources.push(y * w + x);
  const valid = new Uint8Array(size);
  if (sources.length < 20) {
    // hardly any clean surroundings: allow any patch whose centre is clean
    sources = [];
    for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) if (!blocked[y * w + x]) sources.push(y * w + x);
  }
  for (const s of sources) valid[s] = 1;
  const field = new Int32Array(size).fill(-1);
  if (!sources.length) return field;
  const area = dilate(hole, w, h, R);
  const targets: number[] = [];
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) if (area[y * w + x]) targets.push(y * w + x);
  const cost = new Float32Array(size);

  const offsets: number[] = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) offsets.push(dy * w + dx);
  const compare = (t: number, s: number, limit: number) => {
    let d = 0;
    for (let k = 0; k < offsets.length; k++) {
      const a = (t + offsets[k]!) * 3;
      const b = (s + offsets[k]!) * 3;
      const r = rgb[a]! - rgb[b]!;
      const g = rgb[a + 1]! - rgb[b + 1]!;
      const bl = rgb[a + 2]! - rgb[b + 2]!;
      d += r * r + g * g + bl * bl;
      if (d >= limit) return d;
    }
    return d;
  };

  // starting guess: from the coarser level, else somewhere near
  const pick = (t: number) => {
    const x = t % w;
    const y = (t - x) / w;
    for (let k = 0; k < 24; k++) {
      const reach = 8 + k * 6;
      const sx = x + Math.round((rnd() - 0.5) * reach * 2);
      const sy = y + Math.round((rnd() - 0.5) * reach);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h && valid[sy * w + sx]) return sy * w + sx;
    }
    return sources[(rnd() * sources.length) | 0]!;
  };
  for (const t of targets) {
    let s = -1;
    if (previous) {
      const x = t % w;
      const y = (t - x) / w;
      const from = previous.field[Math.min(previous.h - 1, y >> 1) * previous.w + Math.min(previous.w - 1, x >> 1)]!;
      if (from >= 0) {
        const sx = (from % previous.w) * 2 + (x & 1);
        const sy = Math.floor(from / previous.w) * 2 + (y & 1);
        if (sx < w && sy < h && valid[sy * w + sx]) s = sy * w + sx;
      }
    }
    field[t] = s >= 0 ? s : pick(t);
  }

  const sum = new Float32Array(size * 3);
  const weight = new Float32Array(size);
  /** repaint the hole as the weighted agreement of all patches that cover each pixel */
  const vote = (sharp: number) => {
    sum.fill(0);
    weight.fill(0);
    const costs = targets.map((t) => cost[t]!);
    const sigma = Math.max(40, quantile(costs, 0.6)) * sharp;
    for (const t of targets) {
      const s = field[t]!;
      const k = Math.exp(-cost[t]! / sigma) + 1e-6;
      for (const o of offsets) {
        const p = t + o;
        if (!hole[p]) continue;
        weight[p]! += k;
        for (let c = 0; c < 3; c++) sum[p * 3 + c]! += rgb[(s + o) * 3 + c]! * k;
      }
    }
    for (let i = 0; i < size; i++) {
      if (!hole[i] || !weight[i]) continue;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = sum[i * 3 + c]! / weight[i]!;
    }
  };
  if (previous) {
    for (const t of targets) cost[t] = compare(t, field[t]!, Infinity);
    vote(0.5);
  }

  for (let round = 0; round < rounds; round++) {
    for (const t of targets) cost[t] = compare(t, field[t]!, Infinity);
    const back = round & 1;
    const n = targets.length;
    for (let k = 0; k < n; k++) {
      const t = targets[back ? n - 1 - k : k]!;
      let s = field[t]!;
      let d = cost[t]!;
      const attempt = (c: number) => {
        if (c < 0 || c >= size || c === s || !valid[c]) return;
        const value = compare(t, c, d);
        if (value < d) {
          d = value;
          s = c;
        }
      };
      const step = back ? 1 : -1;
      const left = field[t + step];
      if (left !== undefined && left >= 0) attempt(left - step);
      const above = field[t + step * w];
      if (above !== undefined && above >= 0) attempt(above - step * w);
      for (let reach = Math.max(w, h); reach >= 1; reach >>= 1) {
        const x = (s % w) + Math.round((rnd() - 0.5) * 2 * reach);
        const y = Math.floor(s / w) + Math.round((rnd() - 0.5) * 2 * reach);
        if (x >= 0 && y >= 0 && x < w && y < h) attempt(y * w + x);
      }
      field[t] = s;
      cost[t] = d;
    }
    // the last pass trusts the best patches most, which keeps texture crisp
    vote(round === rounds - 1 ? 0.15 : 0.6);
  }
  return field;
}

function patchFill(rgb: Float32Array, w: number, h: number, hole: Uint8Array, banned: Uint8Array): Float32Array {
  const levels: Level[] = [{ w, h, rgb: rgb.slice(), hole, banned }];
  while (levels.length < 4 && Math.min(levels.at(-1)!.w, levels.at(-1)!.h) > 40) levels.push(half(levels.at(-1)!));
  const coarse = levels.at(-1)!;
  const dirty = new Uint8Array(coarse.w * coarse.h);
  for (let i = 0; i < dirty.length; i++) if (coarse.hole[i] || coarse.banned[i]) dirty[i] = 1;
  const start = pushPull(coarse.rgb, coarse.w, coarse.h, dirty);
  for (let i = 0; i < dirty.length; i++) if (coarse.hole[i]) for (let c = 0; c < 3; c++) coarse.rgb[i * 3 + c] = start[i * 3 + c]!;
  let previous: { field: Int32Array; w: number; h: number } | null = null;
  for (let k = levels.length - 1; k >= 0; k--) {
    const l = levels[k]!;
    if (!previous && k !== levels.length - 1) break;
    if (previous) {
      const seeded = pushPull(l.rgb, l.w, l.h, l.hole);
      for (let i = 0; i < l.w * l.h; i++) if (l.hole[i]) for (let c = 0; c < 3; c++) l.rgb[i * 3 + c] = seeded[i * 3 + c]!;
    }
    const field = synthesise(l, previous, k === 0 ? 3 : 5, 11 + k);
    previous = { field, w: l.w, h: l.h };
  }
  return levels[0]!.rgb;
}

export interface Fill {
  /** rebuilt colours over the whole region (outside the hole: the original) */
  rgb: Float32Array;
  method: "surface" | "patches";
}

/**
 * `hole`: pixels to rebuild. `banned`: other ink, neither rebuilt nor copied. `noise`: grain of the
 * background per channel.
 */
export function rebuild(rgb: Float32Array, w: number, h: number, hole: Uint8Array, banned: Uint8Array, noise: readonly number[]): Fill {
  const size = w * h;
  const out = rgb.slice();
  let holes = 0;
  for (let i = 0; i < size; i++) holes += hole[i]!;
  if (!holes) return { rgb: out, method: "surface" };
  const rough = dilate(banned, w, h, 2);
  const near = dilate(hole, w, h, Math.max(6, Math.min(24, Math.round(h * 0.18))));
  let clean: number[] = [];
  for (let i = 0; i < size; i++) if (near[i] && !hole[i] && !rough[i]) clean.push(i);
  if (clean.length < 30) for (let i = 0; i < size; i++) if (!hole[i] && !banned[i]) clean.push(i);
  if (clean.length < 8) return { rgb: pushPull(rgb, w, h, hole), method: "surface" };
  // where the ground right round the letters is of one colour (a button, a pill, a chip), what lies
  // beyond the edge of that shape must not tint the fill
  const ring = dilate(hole, w, h, 2);
  const around = clean.filter((i) => ring[i]);
  let plain = false;
  if (around.length >= 30) {
    const middle = [0, 1, 2].map((c) => quantile(around.map((i) => rgb[i * 3 + c]!), 0.5));
    const off = (i: number) => Math.max(...middle.map((m, c) => Math.abs(rgb[i * 3 + c]! - m)));
    // most of it: a ring this far out may already touch the edge of the shape
    const spread = quantile(around.map(off), 0.65);
    if (spread <= (h <= 40 ? 32 : 20)) {
      const limit = Math.max(20, spread * 1.4);
      const alike = clean.filter((i) => off(i) <= limit);
      if (alike.length >= 30) {
        clean = alike;
        // for small lettering a smooth fill beats borrowed patches, which bring the shape's edge along
        plain = h <= 60 && around.filter((i) => off(i) <= limit).length >= around.length * 0.65;
      }
    }
  }

  const surface = fitSurface(rgb, w, h, clean);
  const grain = (noise[0]! + noise[1]! + noise[2]!) / 3;
  // noise averages out over a neighbourhood, texture and edges do not
  const isClean = new Uint8Array(size);
  for (const i of clean) isClean[i] = 1;
  const averages: number[] = [];
  for (let k = 0; k < clean.length; k += Math.max(1, Math.floor(clean.length / 700))) {
    const x = clean[k]! % w;
    const y = Math.floor(clean[k]! / w);
    const sum = [0, 0, 0];
    let n = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const i = (y + dy) * w + x + dx;
        if (x + dx < 0 || x + dx >= w || !isClean[i]) continue;
        for (let c = 0; c < 3; c++) sum[c]! += rgb[i * 3 + c]! - surface.at(i, c);
        n++;
      }
    if (n >= 16) averages.push(Math.max(...sum.map((v) => Math.abs(v / n))));
  }
  const even = averages.length > 20 && quantile(averages, 0.93) <= 2.6 && surface.spread <= 9;
  if (plain || even || (surface.spread <= Math.max(2.4, grain * 1.7) && surface.outliers < 0.04)) {
    // grain is borrowed block by block from real clean pixels, which keeps its strength and its clumps
    const rnd = random(7);
    const limit = Math.max(1, surface.spread * 2.5);
    const quiet = new Uint8Array(size);
    const pool: number[] = [];
    for (const i of clean)
      if ([0, 1, 2].every((c) => Math.abs(rgb[i * 3 + c]! - surface.at(i, c)) <= limit)) {
        quiet[i] = 1;
        pool.push(i);
      }
    const grainy = (even && surface.spread > 1) || grain > 0.7;
    const block = 6;
    const shifts = new Map<number, number>();
    const shiftFor = (i: number) => {
      const key = Math.floor(Math.floor(i / w) / block) * w + Math.floor((i % w) / block);
      let shift = shifts.get(key);
      if (shift !== undefined) return shift;
      let most = -1;
      shift = 0;
      for (let t = 0; t < 12 && most < block * block; t++) {
        const from = pool[(rnd() * pool.length) | 0]!;
        const candidate = from - i;
        let n = 0;
        for (let dy = 0; dy < block; dy++) for (let dx = 0; dx < block; dx++) n += quiet[from + dy * w + dx] ?? 0;
        if (n > most) {
          most = n;
          shift = candidate;
        }
      }
      shifts.set(key, shift);
      return shift;
    };
    for (let i = 0; i < size; i++) {
      if (!hole[i]) continue;
      let from = -1;
      if (grainy && pool.length) {
        from = i + shiftFor(i);
        if (!quiet[from]) from = pool[(rnd() * pool.length) | 0]!;
      }
      for (let c = 0; c < 3; c++) {
        const extra = from >= 0 ? rgb[from * 3 + c]! - surface.at(from, c) : 0;
        out[i * 3 + c] = clamp(surface.at(i, c) + extra, 0, 255);
      }
    }
    return { rgb: out, method: "surface" };
  }

  // the overall shading is taken out first, so that patches from anywhere fit
  const flat = new Float32Array(size * 3);
  const base = new Float32Array(size * 3);
  for (let i = 0; i < size; i++)
    for (let c = 0; c < 3; c++) {
      base[i * 3 + c] = clamp(surface.at(i, c), -64, 320);
      flat[i * 3 + c] = rgb[i * 3 + c]! - base[i * 3 + c]! + 128;
    }
  const filled = patchFill(flat, w, h, hole, banned);
  for (let i = 0; i < size; i++) {
    if (!hole[i]) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = clamp(filled[i * 3 + c]! + base[i * 3 + c]! - 128, 0, 255);
  }
  return { rgb: out, method: "patches" };
}
