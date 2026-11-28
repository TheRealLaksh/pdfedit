/**
 * Finds the face, size, weight, width, spacing, softness and position that make the recognised text look
 * like the pixels in the picture: candidates are typeset, rendered and compared with the letters found.
 */
import { project } from "../geometry";
import { familiesFor, familyByKey, FAMILIES, nearestWeight, scriptOfText } from "../fonts/catalog";
import { METRICS, type FaceMetrics } from "../fonts/metrics.data";
import { clusterSpan, outlines, type FaceRef, type Fonts, type Placement, type Shaped } from "../fonts/shape";
import { coveragePlanes } from "../outline";
import { blur, clamp, sample } from "../raster";
import type { Candidate } from "../types";
import { edgeWidth, slant, strokeWidth } from "./measure";
import type { Segmentation } from "./segment";

export interface InkBox {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** the line's letters on an upright grid */
export interface Observed {
  data: Float32Array;
  w: number;
  h: number;
  /** grid pixels per frame pixel */
  k: number;
  /** frame margin around the box included in the grid */
  margin: number;
  ink: InkBox;
  stroke: number;
  edge: number;
  slant: number;
  subpixel: boolean;
}

export interface Look {
  placement: Placement;
  thickness: number;
  gamma: number;
  blur: number;
  /** rendered as screen text with coloured edges (compared as the average of the three colours) */
  subpixel?: boolean;
}

export interface Match extends Look {
  ref: FaceRef;
  /** 0..1 overlap with the original letters */
  score: number;
  candidates: Candidate[];
}

export function inkBox(a: Float32Array, w: number, h: number): InkBox | null {
  const col = new Float32Array(w);
  const row = new Float32Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = a[y * w + x]!;
      if (v > col[x]!) col[x] = v;
      if (v > row[y]!) row[y] = v;
    }
  /** where the profile first reaches half, refined by how full the pixels at the edge are */
  const first = (p: Float32Array, step: 1 | -1): number | null => {
    for (let i = step > 0 ? 0 : p.length - 1; i >= 0 && i < p.length; i += step) {
      if (p[i]! < 0.45) continue;
      const before = p[i - step] ?? 0;
      const inset = 1 - Math.min(1, p[i]!) - Math.min(0.45, before);
      return step > 0 ? i + inset : i + 1 - inset;
    }
    return null;
  };
  const u0 = first(col, 1);
  const u1 = first(col, -1);
  const v0 = first(row, 1);
  const v1 = first(row, -1);
  if (u0 === null || u1 === null || v0 === null || v1 === null || u1 - u0 < 1 || v1 - v0 < 1) return null;
  return { u0, u1, v0, v1 };
}

export function observe(s: Segmentation, tallest = 60): Observed | null {
  const margin = Math.ceil(s.height * 0.22) + 3;
  const k = Math.min(1, tallest / s.height);
  const w = Math.ceil((s.width + margin * 2) * k);
  const h = Math.ceil((s.height + margin * 2) * k);
  const alpha = new Float32Array(s.w * s.h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = s.alpha[i]!;
  const data = new Float32Array(w * h);
  const n = k < 0.99 ? Math.min(4, Math.ceil(1 / k)) : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const [px, py] = project(s.toImage, (x + (i + 0.5) / n) / k - margin, (y + (j + 0.5) / n) / k - margin);
          const rx = px - s.x;
          const ry = py - s.y;
          if (rx >= 0 && ry >= 0 && rx <= s.w && ry <= s.h) sum += sample(alpha, s.w, s.h, rx, ry);
        }
      }
      data[y * w + x] = sum / (n * n);
    }
  }
  const ink = inkBox(data, w, h);
  if (!ink) return null;
  return { data, w, h, k, margin, ink, stroke: strokeWidth(data, w, h), edge: edgeWidth(data, w, h), slant: slant(data, w, h), subpixel: s.subpixel && k === 1 };
}

/** coverage of placed text on a grid of the given size */
export function renderGrid(shaped: Shaped, look: Look, w: number, h: number): Float32Array {
  const out = coveragePlanes(outlines(shaped, look.placement, look.thickness, (u, v) => [u, v]), 0, 0, w, h, !!look.subpixel, true)[0]!;
  if (Math.abs(look.gamma - 1) > 0.01) for (let i = 0; i < out.length; i++) if (out[i]! > 0) out[i] = Math.pow(out[i]!, look.gamma);
  return look.blur >= 0.12 ? blur(out, w, h, look.blur) : out;
}

function compare(a: Float32Array, b: Float32Array) {
  let diff = 0;
  let low = 0;
  let high = 0;
  let total = 0;
  let drawn = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    diff += Math.abs(x - y);
    total += y;
    drawn += x;
    if (x < y) {
      low += x;
      high += y;
    } else {
      low += y;
      high += x;
    }
  }
  // as much ink as in the picture: where shapes differ, thinner letters would otherwise win and look pale
  const mass = Math.abs(drawn - total) / Math.max(1, total);
  return { loss: diff / Math.max(1, total) + mass * 0.45, overlap: high ? low / high : 0 };
}

/** moves every word sideways to where it sits in the picture (spacing between words is rarely exact) */
export function alignWords(shaped: Shaped, look: Look, obs: Observed): number[] {
  const base: Placement = { ...look.placement, wordShift: undefined };
  const rendered = renderGrid(shaped, { ...look, placement: base }, obs.w, obs.h);
  const shifts: number[] = [];
  const reach = Math.max(2, Math.round((obs.ink.v1 - obs.ink.v0) * 0.22));
  const { w, h } = obs;
  // only the rows with lettering matter
  const top = Math.max(0, Math.floor(obs.ink.v0) - 3);
  const bottom = Math.min(h, Math.ceil(obs.ink.v1) + 3);
  let previous = 0;
  for (let word = 0; word < shaped.words; word++) {
    let x0 = Infinity;
    let x1 = -Infinity;
    shaped.clusters.forEach((c, i) => {
      if (c.word !== word || c.space) return;
      const span = clusterSpan(shaped, base, i);
      x0 = Math.min(x0, span[0]);
      x1 = Math.max(x1, span[1]);
    });
    if (x1 < x0) {
      shifts.push(previous);
      continue;
    }
    const from = Math.max(0, Math.floor(x0) - 1);
    const to = Math.min(w - 1, Math.ceil(x1) + 1);
    const cost = (d: number, limit = Infinity) => {
      let s = 0;
      const lo = Math.max(0, from + d);
      const hi = Math.min(w - 1, to + d);
      // ink of the picture that the word would slide away from counts as well
      const first = Math.max(0, Math.round(from + previous) - 1);
      const last = Math.min(w - 1, Math.round(to + previous) + 1);
      for (let y = top; y < bottom && s < limit; y++) {
        const row = y * w;
        for (let x = lo; x <= hi; x++) s += Math.abs(rendered[row + x - d]! - obs.data[row + x]!);
        for (let x = first; x < lo; x++) s += obs.data[row + x]!;
        for (let x = hi + 1; x <= last; x++) s += obs.data[row + x]!;
      }
      return s;
    };
    const start = Math.round(previous);
    let best = start;
    let value = cost(start);
    const wide = word === 0 ? Math.ceil(reach * 0.6) : reach;
    for (let d = start - wide; d <= start + wide; d++) {
      if (d === start) continue;
      const c = cost(d, value);
      if (c < value) {
        value = c;
        best = d;
      }
    }
    // a parabola through the neighbours gives the fraction of a pixel
    const a = cost(best - 1);
    const b = cost(best + 1);
    const curve = a + b - 2 * value;
    const fine = curve > 0 ? clamp((a - b) / (2 * curve), -0.5, 0.5) : 0;
    previous = best + fine;
    shifts.push(previous);
  }
  return shifts;
}

interface Trial extends Look {
  ref: FaceRef;
  shaped: Shaped;
  loss: number;
  score: number;
}

function evaluate(trial: Trial, obs: Observed): Trial {
  const shifted = { ...trial, placement: { ...trial.placement, wordShift: alignWords(trial.shaped, trial, obs) } };
  const { loss, overlap } = compare(renderGrid(trial.shaped, shifted, obs.w, obs.h), obs.data);
  const p = shifted.placement;
  // distorting a face to fit counts against it
  const distortion = Math.abs(Math.log(p.stretch)) * 0.55 + Math.abs(p.spacing / p.size) * 0.7;
  shifted.loss = loss + distortion * 0.4;
  shifted.score = Math.max(0, overlap - distortion * 0.18);
  return shifted;
}

/** the starting fit of one face: size from the height of the letters, width by stretch or spacing */
async function tryFace(fonts: Fonts, ref: FaceRef, text: string, obs: Observed, soft: number): Promise<Trial | null> {
  let shaped: Shaped;
  try {
    shaped = await fonts.shape(ref, text);
  } catch {
    return null;
  }
  const [x0, y0, x1, y1] = shaped.ink;
  if (x1 - x0 < 1 || y1 - y0 < 1 || shaped.missing.length > text.length / 3) return null;
  const shear = obs.slant && !(ref.italic && shaped.realItalic) ? obs.slant : 0;
  const wantW = obs.ink.u1 - obs.ink.u0;
  const wantH = obs.ink.v1 - obs.ink.v0;
  const gaps = Math.max(1, shaped.clusters.length - 1);
  let size = (wantH / (y1 - y0)) * 100;
  // measure the rendering the same way as the picture and correct the size by what that says
  const probe: Look = { subpixel: obs.subpixel, placement: { ox: obs.ink.u0 - (x0 * size) / 100, oy: obs.ink.v0 - (y0 * size) / 100, size, stretch: wantW / (((x1 - x0) * size) / 100), spacing: 0, shear }, thickness: 0, gamma: 1, blur: soft };
  const seen = inkBox(renderGrid(shaped, probe, obs.w, obs.h), obs.w, obs.h);
  let lift = 0;
  if (seen) {
    const ratio = clamp(wantH / (seen.v1 - seen.v0), 0.9, 1.1);
    size *= ratio;
    lift = (seen.v0 - obs.ink.v0) * ratio;
  }
  const natural = ((x1 - x0) * size) / 100;
  const widthOver = wantW / natural;
  if (widthOver < 0.6 || widthOver > 1.9) return null;
  const options: [number, number][] = [[widthOver, 0]];
  if (Math.abs(widthOver - 1) > 0.03 && shaped.clusters.length > 2) {
    options.push([1, (wantW - natural) / gaps]);
    options.push([Math.sqrt(widthOver), (wantW - natural * Math.sqrt(widthOver)) / gaps]);
  }
  let best: Trial | null = null;
  for (const [stretch, spacing] of options) {
    if (spacing / size < -0.09 || spacing / size > 0.8) continue;
    const placement: Placement = {
      ox: obs.ink.u0 - (x0 * size * stretch) / 100,
      oy: obs.ink.v0 - (y0 * size) / 100 - lift,
      size,
      stretch,
      spacing,
      shear,
    };
    const t = evaluate({ ref, shaped, placement, thickness: 0, gamma: 1, blur: soft, subpixel: obs.subpixel, loss: Infinity, score: 0 }, obs);
    if (!best || t.loss < best.loss) best = t;
  }
  return best;
}

/** adjusts one setting at a time, keeping what brings the rendering closer */
function refine(start: Trial, obs: Observed, maxBlur: [number, number]): Trial {
  let best = start;
  const H = obs.ink.v1 - obs.ink.v0;
  const moves: ((t: Trial, s: number) => Trial)[] = [
    (t, s) => ({ ...t, thickness: clamp(t.thickness + s * Math.max(0.12, H * 0.008), -H * 0.04, H * 0.05) }),
    (t, s) => ({ ...t, placement: { ...t.placement, oy: t.placement.oy + s * Math.max(0.3, H * 0.012) } }),
    (t, s) => {
      // size about the baseline, keeping the width
      const size = t.placement.size * (1 + s * 0.016);
      return { ...t, placement: { ...t.placement, size, stretch: (t.placement.stretch * t.placement.size) / size } };
    },
    (t, s) => {
      const stretch = t.placement.stretch * (1 + s * 0.012);
      const ox = obs.ink.u0 - (t.shaped.ink[0] * t.placement.size * stretch) / 100;
      return { ...t, placement: { ...t.placement, stretch, ox } };
    },
    (t, s) => ({ ...t, blur: clamp(t.blur + s * Math.max(0.15, maxBlur[1] * 0.1), maxBlur[0], maxBlur[1]) }),
    (t, s) => ({ ...t, gamma: clamp(t.gamma * (1 + s * 0.14), 0.5, 1.7) }),
  ];
  for (const strength of [1, 0.5, 0.25]) {
    for (const move of moves) {
      for (const sign of [1, -1]) {
        let improved = false;
        for (let i = 0; i < 4; i++) {
          const next = evaluate(move(best, sign * strength), obs);
          if (next.loss >= best.loss - 0.0008) break;
          best = next;
          improved = true;
        }
        if (improved) break;
      }
    }
  }
  return best;
}

/* ---------- shortlist ---------- */

const LOW = /[gjpqyQ,;()[\]{}|@$_/\\]/;
const ASC = /[bdfhklt()[\]{}|]/;
const CAP = /[A-Z0-9₹$€£%&!?#]/;

/** how wide the text is for its height, and how thick its strokes, as a face would set it */
export function predict(m: FaceMetrics, text: string): { aspect: number; stroke: number } {
  let width = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    width += code >= 32 && code < 127 ? m.advances[code - 32]! : m.advances["n".charCodeAt(0) - 32]!;
  }
  const top = Math.max(ASC.test(text) ? m.ascender : 0, CAP.test(text) ? m.cap : 0, m.xHeight);
  const height = top + (LOW.test(text) ? m.descender : 0);
  return { aspect: width / height, stroke: m.stem / height };
}

export interface MatchOptions {
  /** faces that fitted other lines of this picture */
  hints?: FaceRef[];
  /** keep to this face (the user picked it) */
  only?: FaceRef;
}

function shortlist(fonts: Fonts, text: string, obs: Observed, options: MatchOptions): FaceRef[] {
  const script = scriptOfText(text);
  const italic = obs.slant > 0.1;
  const wantStroke = obs.stroke / Math.max(1, obs.ink.v1 - obs.ink.v0);
  const wantAspect = (obs.ink.u1 - obs.ink.u0) / Math.max(1, obs.ink.v1 - obs.ink.v0);
  const out: FaceRef[] = [];
  const add = (r: FaceRef) => {
    if (!out.some((o) => o.font === r.font && o.weight === r.weight && o.italic === r.italic)) out.push(r);
  };
  if (options.only) return [options.only];
  for (const h of options.hints ?? []) if (familyByKey(h.font)?.scripts.includes(script) || fonts.users.has(h.font)) add(h);
  for (const [key] of fonts.users) add({ font: key, weight: 400, italic: false });

  if (script !== "Latin") {
    const heavy = wantStroke > 0.135;
    for (const f of familiesFor(script).slice(0, 8)) {
      const weights = f.weights.length > 2 ? (heavy ? [600, 800] : [400, 500]) : heavy ? [700] : [400];
      for (const w of weights) add({ font: f.key, weight: nearestWeight(f.weights, w), italic: italic && f.italic });
    }
    return out;
  }

  const scored: { ref: FaceRef; cost: number }[] = [];
  for (const family of FAMILIES) {
    if (!family.scripts.includes("Latin")) continue;
    for (const weight of family.weights) {
      const m = METRICS[`${family.key}:${weight}`];
      if (!m) continue;
      const p = predict(m, text);
      let cost = Math.abs(Math.log(wantAspect / p.aspect)) * 1.3 + Math.abs(Math.log(wantStroke / p.stroke)) * 0.55;
      // handwriting is only a likely answer when nothing upright fits
      if (family.category === "script") cost += 0.12;
      scored.push({ ref: { font: family.key, weight, italic: italic && family.italic }, cost });
    }
  }
  scored.sort((a, b) => a.cost - b.cost);
  const used = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const { ref } of scored) {
    if (out.length >= 18) break;
    const category = familyByKey(ref.font)!.category;
    if ((used.get(ref.font) ?? 0) >= 1 || (kinds.get(category) ?? 0) >= (category === "sans" ? 9 : 5)) continue;
    used.set(ref.font, 1);
    kinds.set(category, (kinds.get(category) ?? 0) + 1);
    add(ref);
  }
  // the faces most text in the world is set in are always worth a look
  for (const key of ["arimo", "tinos", "roboto", "inter", "open-sans", "cousine"]) {
    const best = scored.find((s) => s.ref.font === key);
    if (best) add(best.ref);
  }
  return out;
}

/** how soft the edges are, from the width of their climb: a crisp edge climbs within about a pixel */
const softness = (obs: Observed) =>
  obs.edge > 1.22 ? clamp(Math.sqrt(Math.max(0, obs.edge * obs.edge - 0.85 * 0.85)) / 2.35, 0, (obs.ink.v1 - obs.ink.v0) * 0.16) : 0;

/** a trial carried from one grid to a finer one */
function rescale(t: Trial, from: Observed, to: Observed): Trial {
  const f = to.k / from.k;
  const p = t.placement;
  const shift = to.margin * to.k - from.margin * from.k * f;
  return {
    ...t,
    placement: { ...p, ox: p.ox * f + shift, oy: p.oy * f + shift, size: p.size * f, spacing: p.spacing * f, wordShift: p.wordShift?.map((s) => s * f) },
    thickness: t.thickness * f,
    blur: t.blur * f,
    subpixel: to.subpixel,
  };
}

export async function matchLine(fonts: Fonts, text: string, fine: Observed, options: MatchOptions = {}, rough: Observed = fine): Promise<Match | null> {
  let obs = rough;
  let soft = softness(obs);
  let range: [number, number] = [Math.max(0, soft * 0.65 - 0.1), soft * 1.3 + 0.25];
  const hinted = new Set((options.hints ?? []).map((h) => `${h.font}:${h.weight}`));
  const bonus = (t: Trial) => t.loss - (hinted.has(`${t.ref.font}:${t.ref.weight}`) ? 0.025 : 0);

  const list = shortlist(fonts, text, obs, options);
  // fetch the files together, then compare one by one
  await Promise.all(list.map((r) => fonts.shape(r, text).catch(() => null)));
  let trials: Trial[] = [];
  for (const ref of list) {
    const t = await tryFace(fonts, ref, text, obs, soft);
    if (t) trials.push(t);
  }
  if (!trials.length) {
    const fallback = await tryFace(fonts, { font: "arimo", weight: 400, italic: false }, text, obs, soft);
    if (!fallback) return null;
    trials = [fallback];
  }
  trials.sort((a, b) => bonus(a) - bonus(b));

  // the weights next to the best faces
  if (!options.only) {
    const more: FaceRef[] = [];
    for (const t of trials.slice(0, 5)) {
      const family = familyByKey(t.ref.font);
      if (!family) continue;
      const at = family.weights.indexOf(t.ref.weight);
      for (const k of [-2, -1, 1, 2]) {
        const weight = family.weights[at + k];
        if (weight !== undefined && !list.some((r) => r.font === t.ref.font && r.weight === weight)) more.push({ ...t.ref, weight });
      }
    }
    await Promise.all(more.map((r) => fonts.shape(r, text).catch(() => null)));
    for (const ref of more) {
      const t = await tryFace(fonts, ref, text, obs, soft);
      if (t) trials.push(t);
    }
    trials.sort((a, b) => bonus(a) - bonus(b));
  }

  // fine adjustment of the closest few on the finer grid, then the choice
  const finalists: Trial[] = [];
  const seen = new Map<string, number>();
  for (const t of trials) {
    if ((seen.get(t.ref.font) ?? 0) >= 2) continue;
    seen.set(t.ref.font, (seen.get(t.ref.font) ?? 0) + 1);
    finalists.push(t);
    if (finalists.length >= 3) break;
  }
  if (fine !== rough) {
    obs = fine;
    soft = softness(obs);
    range = [Math.max(0, soft * 0.65 - 0.1), soft * 1.3 + 0.25];
  }
  const refined = finalists.map((t) => refine(fine === rough ? t : evaluate({ ...rescale(t, rough, fine), blur: soft }, fine), obs, range)).sort((a, b) => bonus(a) - bonus(b));
  const best = refined[0]!;

  const candidates: Candidate[] = [];
  for (const t of [...refined, ...trials]) {
    if (candidates.some((c) => c.font === t.ref.font)) continue;
    const family = familyByKey(t.ref.font)?.name ?? fonts.users.get(t.ref.font)?.name ?? t.ref.font;
    candidates.push({ font: t.ref.font, family, weight: t.ref.weight, italic: t.ref.italic, score: Math.round(t.score * 1000) / 1000 });
    if (candidates.length >= 8) break;
  }

  // from the grid back to the frame
  const { k, margin } = obs;
  const p = best.placement;
  return {
    ref: best.ref,
    score: best.score,
    candidates,
    placement: {
      ox: p.ox / k - margin,
      oy: p.oy / k - margin,
      size: p.size / k,
      stretch: p.stretch,
      spacing: p.spacing / k,
      shear: p.shear,
      wordShift: p.wordShift?.map((s) => s / k),
    },
    thickness: best.thickness / k,
    gamma: best.gamma,
    blur: best.blur / k,
  };
}
