/**
 * Draws one box edit: removes the old lettering (only where it changes), moves untouched letters when the
 * text before or after them grows or shrinks, sets the new lettering in the matched look, and returns just
 * the pixels that differ from the original.
 */
import { project } from "./geometry";
import { familiesFor, nearestWeight, scriptOfText } from "./fonts/catalog";
import { clusterPen, clusterSpan, outlines, type Fonts, type Placement, type Shaped } from "./fonts/shape";
import { matchLine, observe, type Match, type Observed } from "./analyze/match";
import { segment, type Segmentation } from "./analyze/segment";
import { rebuild, type Fill } from "./erase";
import { coveragePlanes } from "./outline";
import { blur, clamp, dilate, gaussianNoise, sample } from "./raster";
import { alignWords, changedWords, inkWords } from "./words";
import type { Align, BoxEdit, LineStyle, Picture, Pt, Quad4, RenderResult } from "./types";

/** everything known about one box after analysis */
export interface Prepared {
  text: string;
  seg: Segmentation;
  obs: Observed | null;
  match: Match | null;
  /** the matched look; edits override single fields of it */
  style: LineStyle;
  align: Align;
  /** the reading may be wrong: nothing the user did not change is typeset from it */
  unsure?: boolean;
  /** background rebuilt under all letters, made when first needed */
  fill?: { fill: Fill; hole: Uint8Array; radius: number };
}

const SLANT = 0.21;

/** ink of the original in frame coordinates */
function originalInk(p: Prepared) {
  const { obs, seg } = p;
  if (obs) {
    const { k, margin, ink } = obs;
    return { u0: ink.u0 / k - margin, u1: ink.u1 / k - margin, v0: ink.v0 / k - margin, v1: ink.v1 / k - margin };
  }
  return { u0: seg.width * 0.04, u1: seg.width * 0.96, v0: seg.height * 0.18, v1: seg.height * 0.82 };
}

const changedLook = (base: LineStyle, next: LineStyle) =>
  (Object.keys(base) as (keyof LineStyle)[]).some((k) => (k === "color" ? base.color.some((c, i) => c !== next.color[i]) : base[k] !== next[k]));

/** span of the visible clusters of a text range */
function span(shaped: Shaped, at: Placement, from = 0, to = Infinity): [number, number] {
  let x0 = Infinity;
  let x1 = -Infinity;
  shaped.clusters.forEach((c, i) => {
    if (c.space || c.start < from || c.start >= to) return;
    const s = clusterSpan(shaped, at, i);
    x0 = Math.min(x0, s[0]);
    x1 = Math.max(x1, s[1]);
  });
  return x1 < x0 ? [at.ox, at.ox] : [x0, x1];
}

/** extra space the original puts between words, on average */
function wordExtra(shift: readonly number[] | undefined): number {
  if (!shift || shift.length < 2) return 0;
  return (shift.at(-1)! - shift[0]!) / (shift.length - 1);
}

/** where the new text goes when the whole line is set again */
export async function placeLine(fonts: Fonts, p: Prepared, style: LineStyle, edit: BoxEdit, shaped: Shaped): Promise<Placement> {
  const ink = originalInk(p);
  const match = p.match;
  const sameFace = !!match && style.font === p.style.font && style.weight === p.style.weight && style.italic === p.style.italic;
  const shear = sameFace ? match!.placement.shear : style.italic && !shaped.realItalic ? SLANT : 0;
  let size = style.size;
  let stretch = style.stretch;
  let baseline = match?.placement.oy ?? ink.v1 - (ink.v1 - ink.v0) * 0.2;
  const first = match?.placement.wordShift?.[0] ?? 0;
  if (!sameFace && p.text) {
    // another face: letters of the same height and, unless set by hand, the same width for the old text
    const old = await fonts.shape(style, p.text);
    const [x0, y0, x1, y1] = old.ink;
    if (edit.style?.size === undefined) size = ((ink.v1 - ink.v0) / Math.max(1, y1 - y0)) * 100 * (style.size / p.style.size);
    if (edit.style?.stretch === undefined) stretch = clamp((ink.u1 - ink.u0 - (old.clusters.length - 1) * style.spacing) / (((x1 - x0) * size) / 100), 0.82, 1.2);
    baseline = ink.v0 - (y0 * size) / 100;
  } else if (match && size !== match.placement.size) {
    baseline = match.placement.oy;
  }
  const at: Placement = { ox: match?.placement.ox ?? 0, oy: baseline, size, stretch, spacing: style.spacing, shear };
  const original = p.text ? await fonts.shape(style, p.text) : null;
  if (match && sameFace && original && original.words === shaped.words && shaped.words > 1) at.wordShift = match.placement.wordShift?.map((s) => s - first);
  else {
    const extra = sameFace ? wordExtra(match?.placement.wordShift) : 0;
    if (extra) at.wordShift = Array.from({ length: shaped.words }, (_, i) => i * extra);
  }
  const [from, to] = span(shaped, at);
  const align = edit.align ?? p.align;
  let target = ink.u0;
  if (align === "right") target = ink.u1 - (to - from);
  else if (align === "center") target = (ink.u0 + ink.u1) / 2 - (to - from) / 2;
  at.ox += target - from;
  return at;
}

/* ---------- keeping unchanged letters ---------- */

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const split = (s: string) => [...graphemes.segment(s)].map((g) => g.segment);
/** letters of these scripts are only separate at spaces */
const JOINED = new Set(["Arabic", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Khmer", "Myanmar", "Thai", "Lao"]);

/** a line with words in an Indian or another joined script beside Latin letters or figures */
const twoScripts = (text: string) => {
  const words = text.split(" ");
  const joined = words.some((w) => JOINED.has(scriptOfText(w)));
  return joined && words.some((w) => /[\p{Script=Latin}0-9]/u.test(w));
};

export interface Keep {
  /** original pixels left of this frame position stay (moved by leftShift); -Infinity when none */
  cutLeft: number;
  /** original pixels from this position on stay (moved by rightShift); Infinity when none */
  cutRight: number;
  leftShift: number;
  rightShift: number;
  /** the part of the new text that has to be drawn */
  from: number;
  to: number;
  placement: Placement;
  /** characters of the original left untouched */
  kept: number;
}

export function planKeep(p: Prepared, next: string, shapedOld: Shaped, shapedNew: Shaped, align: Align, tailToo = true): Keep | null {
  const { match, obs } = p;
  if (!match || !obs || !next || shapedOld.rtl || shapedNew.rtl) return null;
  const old = p.text;
  const a = split(old);
  const b = split(next);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const headChars = a.slice(0, head).join("").length;
  const tailChars = a.slice(a.length - tail).join("").length;
  const joined = JOINED.has(scriptOfText(old + next));
  const { k, margin } = obs;
  const ink = originalInk(p);
  const height = ink.v1 - ink.v0;

  const column = new Float32Array(obs.w);
  for (let y = 0; y < obs.h; y++) for (let x = 0; x < obs.w; x++) column[x] = Math.max(column[x]!, obs.data[y * obs.w + x]!);
  /** the middle of the clear run of columns nearest the expected position, in frame coordinates */
  const gapNear = (u: number): number | null => {
    const at = (u + margin) * k;
    const reach = Math.max(2, height * 0.2 * k);
    let best: number | null = null;
    let from = -1;
    for (let x = Math.max(0, Math.floor(at - reach)); x <= Math.min(obs.w, Math.ceil(at + reach)); x++) {
      const clear = x < Math.min(obs.w, Math.ceil(at + reach)) && column[x]! < 0.26;
      if (clear && from < 0) from = x;
      else if (!clear && from >= 0) {
        const mid = clamp(at, from + 0.5, x - 0.5);
        const centre = x - from > 3 ? mid : (from + x) / 2;
        if (best === null || Math.abs(centre - at) < Math.abs(best - at)) best = centre;
        from = -1;
      }
    }
    return best === null ? null : best / k - margin;
  };
  const oldAt = match.placement;
  const boundary = (shaped: Shaped, at: Placement, offset: number): number | null => {
    const leftOf = shaped.clusters.findIndex((c) => c.end === offset);
    const rightOf = shaped.clusters.findIndex((c) => c.start === offset);
    if (leftOf < 0 || rightOf < 0) return null;
    // across a space the neighbouring letters decide, not the space itself
    let l = leftOf;
    while (l > 0 && shaped.clusters[l]!.space) l--;
    let r = rightOf;
    while (r < shaped.clusters.length - 1 && shaped.clusters[r]!.space) r++;
    return (clusterSpan(shaped, at, l)[1] + clusterSpan(shaped, at, r)[0]) / 2;
  };
  /** where the font puts the letter that starts at a text position */
  const pen = (shaped: Shaped, at: Placement, offset: number): number | null => {
    const index = shaped.clusters.findIndex((cluster) => cluster.start === offset);
    return index < 0 ? null : clusterPen(shaped, at, index);
  };
  const breakable = (text: string, offset: number) => !joined || /\s/.test(text[offset - 1] ?? " ") || /\s/.test(text[offset] ?? " ");

  // the plain placement of the new text, before it is moved into position
  const base: Placement = { ...oldAt, wordShift: undefined };
  let left = 0;
  let cutLeft = -Infinity;
  for (let offset = headChars; offset > 0; offset--) {
    if (!old.slice(0, offset).trim() || !breakable(old, offset) || !breakable(next, offset)) continue;
    const predicted = offset >= old.length ? ink.u1 + height * 0.12 : boundary(shapedOld, oldAt, offset);
    if (predicted === null || (offset < next.length && boundary(shapedNew, base, offset) === null)) continue;
    const gap = offset >= old.length ? predicted : gapNear(predicted);
    if (gap === null) continue;
    left = offset;
    cutLeft = gap;
    break;
  }
  let right = 0;
  let cutRight = Infinity;
  for (let length = tailToo ? Math.min(tailChars, old.length - left, next.length - left) : 0; length > 0; length--) {
    const o = old.length - length;
    const n = next.length - length;
    if (o <= 0 || n <= 0 || !old.slice(o).trim() || !breakable(old, o) || !breakable(next, n) || o < left) continue;
    const predicted = boundary(shapedOld, oldAt, o);
    if (predicted === null || boundary(shapedNew, base, n) === null) continue;
    const gap = gapNear(predicted);
    if (gap === null || gap < cutLeft) continue;
    right = length;
    cutRight = gap;
    break;
  }
  if (!left && !right) return null;

  const from = left;
  const to = next.length - right;
  // every word keeps the offset it had in the picture; words after the change are counted from the end
  const shifts = oldAt.wordShift;
  const anchorWord = shapedNew.clusters.find((c) => c.start >= from && !c.space)?.word ?? shapedNew.words - 1;
  if (shifts?.length) {
    const own = (i: number) => shifts[clamp(i, 0, shifts.length - 1)]!;
    base.wordShift = Array.from({ length: shapedNew.words }, (_, i) => own(i <= anchorWord ? i : i + shapedOld.words - shapedNew.words));
  }
  // positions come from the typeset old and new text, which err alike: the difference between them is exact
  const [oldStart, oldEnd] = span(shapedOld, oldAt);
  let middle = 0;
  if (!left) middle = oldStart - span(shapedNew, base)[0];
  else if (left >= old.length) {
    // text added at the end follows the last kept letter at the font's own distance
    middle = oldEnd - span(shapedNew, base, 0, from)[1];
    cutLeft = ink.u1 + height * 0.05;
  } else if (from < next.length) middle = (pen(shapedOld, oldAt, left) ?? cutLeft) - (pen(shapedNew, base, from) ?? cutLeft);

  let grow: number;
  if (right) {
    const was = pen(shapedOld, oldAt, old.length - right) ?? cutRight;
    const now = pen(shapedNew, base, to) ?? span(shapedNew, base, to)[0];
    grow = left || to > from ? middle + now - was : oldStart - span(shapedOld, oldAt, old.length - right)[0];
  } else if (to > from) grow = middle + span(shapedNew, base, from, to)[1] - oldEnd;
  else grow = span(shapedOld, oldAt, 0, left)[1] - oldEnd;

  let total = align === "right" ? -grow : align === "center" ? -grow / 2 : 0;
  let leftShift = total;
  let rightShift = total + grow;
  if (isUpright(p.seg)) {
    // whole pixels, so that moved letters stay exactly as sharp as they were
    leftShift = Math.round(leftShift);
    rightShift = Math.round(rightShift);
    total += left ? leftShift - total : right ? rightShift - total - grow : 0;
  }
  // less than a pixel is not worth disturbing untouched letters for
  if (Math.abs(leftShift) < 0.8) leftShift = 0;
  if (Math.abs(rightShift) < 0.8) rightShift = 0;
  const kept = split(old.slice(0, left) + old.slice(old.length - right)).filter((c) => c.trim()).length;
  return {
    cutLeft: left ? cutLeft : -Infinity,
    cutRight: right ? cutRight : Infinity,
    leftShift: left ? leftShift : 0,
    rightShift: right ? rightShift : 0,
    from,
    to,
    placement: { ...base, ox: base.ox + middle + total },
    kept,
  };
}

function isUpright(s: Segmentation): boolean {
  const [a, b, , d] = s.quad;
  return Math.abs(a[1] - b[1]) < 0.01 && Math.abs(a[0] - d[0]) < 0.01 && Math.abs(b[0] - a[0] - s.width) < 0.01;
}

/** the face and size of a few words of a line, matched against their own letters; null when nothing fits */
async function matchWords(picture: Picture, fonts: Fonts, p: Prepared, text: string, words: readonly { u0: number; u1: number; v0: number; v1: number }[]) {
  const pad = (Math.max(...words.map((w) => w.v1)) - Math.min(...words.map((w) => w.v0))) * 0.2;
  const u0 = words[0]!.u0 - pad;
  const u1 = words.at(-1)!.u1 + pad;
  const v0 = Math.min(...words.map((w) => w.v0)) - pad;
  const v1 = Math.max(...words.map((w) => w.v1)) + pad;
  const quad = ([[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as Pt[]).map(([u, v]) => project(p.seg.toImage, u, v)) as Quad4;
  const part = segment(picture, quad);
  const obs = part.blank ? null : observe(part);
  const match = obs && (await matchLine(fonts, text, obs));
  return match && match.score > 0.55 ? match : null;
}

/**
 * Replaces only the changed words of a line, cutting between words where the picture shows gaps: for
 * lines whose reading is in doubt, and for lines in two scripts, where typesetting the reading puts the
 * cuts in the wrong places. Null when that cannot be done safely.
 */
export async function planWords(picture: Picture, fonts: Fonts, p: Prepared, style: LineStyle, next: string, align: Align): Promise<{ plan: Keep; shaped: Shaped | null; style: LineStyle } | null> {
  if (!p.obs) return null;
  const read = p.text.split(" ");
  const change = changedWords(p.text, next);
  let found = inkWords(p.obs, read.length);
  if (!found) {
    // the picture shows another number of words: the changed ones have to be found by their widths
    const all = inkWords(p.obs);
    if (!all) return null;
    const widths = await Promise.all(
      read.map(async (word) => {
        const [x0, , x1] = (await fonts.shape(p.style, word)).ink;
        return x1 - x0;
      }),
    );
    const offset = alignWords(all.words, widths, change);
    if (offset === null) return null;
    // the reading's words, with those of the picture that they stand for
    const none = { u0: 0, u1: 0, v0: 0, v1: 0 };
    const words = read.map((_, i) => all.words[i + offset] ?? none);
    // what lies beyond the reading stays where it is, as part of its outermost words
    if (change.from > 0 && all.words[change.from - 1 + offset] === undefined) return null;
    found = { words, baseline: all.baseline };
  }
  const { words, baseline } = found;
  // every word replaced is a new line altogether, which needs no care
  const old = words.slice(change.from, change.to);
  const before = words[change.from - 1];
  const after = words[change.to];
  const real = words.filter((w) => w.u1 > w.u0);
  const height = Math.max(...real.map((w) => w.v1)) - Math.min(...real.map((w) => w.v0));
  const space = real.length > 1 ? Math.max(height * 0.15, Math.min(...real.slice(1).map((w, i) => w.u0 - real[i]!.u1))) : height * 0.3;
  const start = old[0]?.u0 ?? (after ? after.u0 : before!.u1 + space);
  const end = old.at(-1)?.u1 ?? start;
  // letters of the script that is being typed, in a face of its own: the matched one fits a wrong reading
  const script = scriptOfText(change.text);
  const families = familiesFor(script);
  const family = families.find((f) => f.key === style.font) ?? families[0]!;
  let face: LineStyle = { ...style, font: family.key, weight: nearestWeight(family.weights, style.weight), stretch: 1, spacing: 0 };
  // the words being replaced, where they were read in the script now typed, tell the look best
  const was = read.slice(change.from, change.to).join(" ");
  const own = change.text && old.length && old.every((w) => w.u1 > w.u0) && scriptOfText(was) === script ? await matchWords(picture, fonts, p, was, old) : null;
  if (own) face = { ...face, ...own.ref, size: own.placement.size, stretch: own.placement.stretch, spacing: own.placement.spacing, thickness: own.thickness, gamma: own.gamma, blur: own.blur };
  let shaped: Shaped | null = null;
  let placement: Placement = { ox: start, oy: baseline, size: face.size, stretch: face.stretch, spacing: face.spacing, shear: own?.placement.shear ?? 0 };
  let width = 0;
  if (change.text) {
    shaped = await fonts.shape(face, change.text);
    // letters as tall, above the baseline, as those they replace or stand beside
    const like = old.length ? old : real;
    const rise = baseline - Math.min(...like.map((w) => w.v0));
    const ascent = -shaped.ink[1];
    if (!own && ascent > 20 && rise > 3) placement.size = (rise / ascent) * 100;
    const [from, to] = span(shaped, placement);
    placement = { ...placement, ox: start - (from - start) };
    width = to - from;
  }
  // how far what follows has to move; a hair's width is not worth disturbing it
  let grow = !old.length ? (after ? width + space : 0) : !change.text ? (after ? start - after.u0 : 0) : width - (end - start);
  if (Math.abs(grow) < space * 0.25) grow = 0;
  const total = align === "right" ? -grow : align === "center" ? -grow / 2 : 0;
  const upright = isUpright(p.seg);
  const round = (v: number) => (upright ? Math.round(v) : v);
  const cutLeft = before ? (before.u1 + (words[change.from]?.u0 ?? before.u1 + space)) / 2 : -Infinity;
  const cutRight = after ? ((words[change.to - 1]?.u1 ?? after.u0 - space) + after.u0) / 2 : Infinity;
  placement.ox += total;
  const left = round(total);
  const right = round(total + grow);
  const letters = (list: string[]) => list.join("").length;
  const all = read;
  return {
    style: face,
    shaped,
    plan: {
      cutLeft,
      cutRight,
      leftShift: before && Math.abs(left) >= 0.8 ? left : 0,
      rightShift: after && Math.abs(right) >= 0.8 ? right : 0,
      from: 0,
      to: change.text.length,
      placement,
      kept: letters(all.slice(0, change.from)) + letters(all.slice(change.to)),
    },
  };
}

/* ---------- drawing ---------- */

export function backgroundUnder(p: Prepared, softness: number) {
  const { seg } = p;
  const radius = clamp(Math.round(1 + Math.max(p.style.blur, softness) * 1.7 + (p.style.grain > 1 ? 1 : 0) + seg.height * 0.012), 1, 12);
  if (p.fill && p.fill.radius === radius) return p.fill;
  const faint = new Uint8Array(seg.letters.length);
  // faint traces count beside letters only: noise further off is not theirs, and would widen the patch
  const beside = dilate(seg.letters, seg.w, seg.h, clamp(Math.round(seg.height * 0.08), 1, 6));
  for (let i = 0; i < faint.length; i++) faint[i] = seg.letters[i] || (beside[i] && seg.alpha[i]! > 0.06) ? 1 : 0;
  if (seg.shadow) {
    const { dx, dy } = seg.shadow;
    for (let y = 0; y < seg.h; y++)
      for (let x = 0; x < seg.w; x++)
        if (seg.letters[y * seg.w + x] && x + dx >= 0 && x + dx < seg.w && y + dy >= 0 && y + dy < seg.h) faint[(y + dy) * seg.w + x + dx] = 1;
  }
  const hole = dilate(faint, seg.w, seg.h, radius);
  for (let i = 0; i < hole.length; i++) if (seg.other[i]) hole[i] = 0;
  const fill = rebuild(seg.rgb, seg.w, seg.h, hole, seg.other, seg.noise);
  return (p.fill = { fill, hole, radius });
}

/** ink colour of the letters between two frame positions, if that part is clearly a different colour */
function localColour(s: Segmentation, from: number, to: number): [number, number, number] | null {
  // coloured screen edges would pass for a change of colour
  if (s.subpixel) return null;
  const here = [0, 0, 0];
  const all = [0, 0, 0];
  let n = 0;
  let total = 0;
  for (let i = 0; i < s.alpha.length; i++) {
    if (s.alpha[i]! < 0.8 || !s.letters[i]) continue;
    const inside = s.u[i]! >= from && s.u[i]! <= to;
    for (let c = 0; c < 3; c++) {
      all[c]! += s.rgb[i * 3 + c]!;
      if (inside) here[c]! += s.rgb[i * 3 + c]!;
    }
    total++;
    if (inside) n++;
  }
  if (n < 12) return null;
  const off = here.map((v, c) => v / n - all[c]! / total);
  if (Math.hypot(off[0]!, off[1]!, off[2]!) < 45) return null;
  return off.map((d, c) => Math.round(clamp(s.color[c]! + d, 0, 255))) as [number, number, number];
}

export async function renderEdit(picture: Picture, fonts: Fonts, p: Prepared, edit: BoxEdit): Promise<RenderResult> {
  const { seg } = p;
  let style: LineStyle = { ...p.style, ...edit.style };
  const next = (edit.text ?? p.text).replace(/[\r\n]+/g, " ");
  const looks = changedLook(p.style, style) || (edit.align !== undefined && edit.align !== p.align);
  const nothing: RenderResult = { patch: null, quad: seg.quad, missing: [], kept: 0, overflow: false };
  // a dragged line: the same distance along and across its own baseline
  let du = 0;
  let dv = 0;
  if (edit.move) {
    const cx = seg.quad.reduce((s, q) => s + q[0], 0) / 4;
    const cy = seg.quad.reduce((s, q) => s + q[1], 0) / 4;
    const from = project(seg.toFrame, cx, cy);
    const to = project(seg.toFrame, cx + edit.move[0], cy + edit.move[1]);
    du = to[0] - from[0];
    dv = to[1] - from[1];
  }
  const moved = Math.abs(du) + Math.abs(dv) > 0.01;
  if (next === p.text && !looks && !moved) return nothing;
  /** only moved: the original pixels travel, nothing is set again */
  const carried = moved && next === p.text && !looks;

  let shaped: Shaped | null = null;
  let placement: Placement | null = null;
  let plan: Keep | null = null;
  const asIs = !looks && edit.keep !== false;
  let words: Awaited<ReturnType<typeof planWords>> = null;
  if (next.trim() && next !== p.text && asIs && (p.unsure || twoScripts(p.text))) {
    words = await planWords(picture, fonts, p, style, next.replace(/\s+/g, " ").trim(), edit.align ?? p.align);
    // words lifted off a detailed background would drag bits of it along
    if (words && (words.plan.leftShift || words.plan.rightShift) && backgroundUnder(p, style.blur).fill.method === "patches") words = null;
  }
  // a doubtful reading is never set again: only the changed words are, or nothing, and then the line stays
  // as it was, dragged along if it was dragged
  if (p.unsure && !words && next.trim() && (next !== p.text || looks)) return { ...(await renderEdit(picture, fonts, p, { move: edit.move })), unsafe: true };
  if (words) {
    ({ shaped, style } = words);
    plan = words.plan;
    placement = plan.placement;
  } else if (next.trim() && !carried) {
    shaped = await fonts.shape(style, next);
    if (edit.keep !== false && !looks && p.match && !seg.blank) {
      const before = await fonts.shape(style, p.text);
      plan = planKeep(p, next, before, shaped, edit.align ?? p.align);
      // letters lifted off a detailed background drag bits of it along: there they are set again instead
      if (plan && (plan.leftShift || plan.rightShift) && backgroundUnder(p, style.blur).fill.method === "patches") {
        plan = planKeep(p, next, before, shaped, edit.align ?? p.align, false);
        if (plan?.leftShift) plan = null;
      }
    }
    placement = plan?.placement ?? (await placeLine(fonts, p, style, edit, shaped));
  }

  const { fill, hole } = backgroundUnder(p, style.blur);

  // frame -> picture for the new lettering, with the user's nudge and rotation
  const turn = (style.rotate * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const cu = seg.width / 2;
  const cv = seg.height / 2;
  const map = (u: number, v: number): Pt => {
    const x = u - cu;
    const y = v - cv;
    return project(seg.toImage, cu + x * cos - y * sin + style.dx + du, cv + x * sin + y * cos + style.dy + dv);
  };

  const draws = shaped && placement ? (plan ? plan.to > plan.from : true) : false;
  const include = plan ? (i: number) => shaped!.clusters[i]!.start >= plan!.from && shaped!.clusters[i]!.start < plan!.to : undefined;
  const glyphs = draws ? outlines(shaped!, placement!, style.thickness, map, include) : [];

  // the area that can change
  const reach = Math.ceil(style.blur * 3 + 3 + (seg.shadow ? Math.max(Math.abs(seg.shadow.dx), Math.abs(seg.shadow.dy)) : 0));
  let x0 = seg.x;
  let y0 = seg.y;
  let x1 = seg.x + seg.w;
  let y1 = seg.y + seg.h;
  const grow = (x: number, y: number) => {
    x0 = Math.min(x0, Math.floor(x) - reach);
    y0 = Math.min(y0, Math.floor(y) - reach);
    x1 = Math.max(x1, Math.ceil(x) + reach);
    y1 = Math.max(y1, Math.ceil(y) + reach);
  };
  for (const glyph of glyphs) for (const contour of glyph) for (const [x, y] of contour) grow(x, y);
  const parts = plan
    ? [
        { a: -Infinity, b: plan.cutLeft, d: plan.leftShift },
        { a: plan.cutRight, b: Infinity, d: plan.rightShift },
      ]
    : carried
      ? [{ a: -Infinity, b: Infinity, d: 0 }]
      : [];
  const moves = parts.map((m) => ({ ...m, d: m.d + du, e: dv })).filter((m) => (m.d !== 0 || m.e !== 0) && m.b > m.a);
  for (const m of moves) {
    const lo = Math.max(m.a, -seg.height) + m.d;
    const hi = Math.min(m.b, seg.width + seg.height) + m.d;
    const top = m.e - seg.height * 0.4;
    const bottom = m.e + seg.height * 1.4;
    for (const [u, v] of [[lo, top], [hi, top], [lo, bottom], [hi, bottom]] as Pt[]) {
      const q = project(seg.toImage, u, v);
      grow(q[0], q[1]);
    }
  }
  const overflow = glyphs.some((g) => g.some((c) => c.some(([x, y]) => x < -1 || y < -1 || x > picture.width + 1 || y > picture.height + 1)));
  x0 = clamp(x0, 0, picture.width - 1);
  y0 = clamp(y0, 0, picture.height - 1);
  x1 = clamp(x1, x0 + 1, picture.width);
  y1 = clamp(y1, y0 + 1, picture.height);
  const w = x1 - x0;
  const h = y1 - y0;
  const size = w * h;

  const out = new Float32Array(size * 3);
  const opacity = new Float32Array(size);
  const touched = new Uint8Array(size);
  let ground = 0;
  let grounds = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const at = ((y + y0) * picture.width + x + x0) * 4;
      const a = picture.data[at + 3]! / 255;
      opacity[i] = a;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = picture.data[at + c]! * a + 255 * (1 - a);
    }
  }
  // transparent pictures: what the letters stood on
  for (let j = 0; j < seg.h; j++)
    for (let k = 0; k < seg.w; k++) {
      if (hole[j * seg.w + k]) continue;
      ground += picture.data[((j + seg.y) * picture.width + k + seg.x) * 4 + 3]! / 255;
      grounds++;
    }
  ground = grounds ? ground / grounds : 1;

  // 1. remove the old letters that change or move
  const erased = (u: number) => !plan || moved || (u >= plan.cutLeft && u < plan.cutRight) || (u < plan.cutLeft && plan.leftShift !== 0) || (u >= plan.cutRight && plan.rightShift !== 0);
  for (let j = 0; j < seg.h; j++) {
    for (let k = 0; k < seg.w; k++) {
      const s = j * seg.w + k;
      if (!hole[s] || !erased(seg.u[s]!)) continue;
      const x = k + seg.x - x0;
      const y = j + seg.y - y0;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = fill.rgb[s * 3 + c]!;
      touched[i] = 1;
      if (ground < 0.98) opacity[i] = ground;
    }
  }

  // 2. put kept letters in their new place
  if (moves.length) {
    const difference = new Float32Array(seg.w * seg.h * 3);
    for (let s = 0; s < hole.length; s++) if (hole[s]) for (let c = 0; c < 3; c++) difference[s * 3 + c] = seg.rgb[s * 3 + c]! - fill.rgb[s * 3 + c]!;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [u, v] = project(seg.toFrame, x + x0 + 0.5, y + y0 + 0.5);
        for (const m of moves) {
          const su = u - m.d;
          if (su < m.a || su >= m.b || su < -seg.height || su > seg.width + seg.height) continue;
          const [px, py] = project(seg.toImage, su, v - m.e);
          const rx = px - seg.x;
          const ry = py - seg.y;
          if (rx < 0 || ry < 0 || rx > seg.w || ry > seg.h) continue;
          const i = y * w + x;
          for (let c = 0; c < 3; c++) {
            const d = sample(difference, seg.w, seg.h, rx, ry, 3, c);
            if (Math.abs(d) < 0.5) continue;
            out[i * 3 + c]! += d;
            touched[i] = 1;
          }
        }
      }
    }
  }

  // 3. the new lettering, its shadow first
  if (glyphs.length && style.shadow && seg.shadow) {
    const { dx, dy, color } = seg.shadow;
    let shade = coveragePlanes(glyphs.map((g) => g.map((c) => c.map(([x, y]) => [x + dx, y + dy] as Pt))), x0, y0, w, h, false)[0]!;
    if (style.blur >= 0.12) shade = blur(shade, w, h, style.blur);
    for (let i = 0; i < size; i++) {
      const a = shade[i]!;
      if (a <= 0.002) continue;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = out[i * 3 + c]! * (1 - a) + color[c]! * a;
      touched[i] = 1;
      if (opacity[i]! < 1) opacity[i] = opacity[i]! + (1 - opacity[i]!) * a;
    }
  }
  if (glyphs.length) {
    const colour = (plan && localColour(seg, plan.cutLeft, plan.cutRight)) || style.color;
    const planes: Float32Array[] = coveragePlanes(glyphs, x0, y0, w, h, style.subpixel);
    for (let c = 0; c < planes.length; c++) {
      const plane = planes[c]!;
      if (Math.abs(style.gamma - 1) > 0.01) for (let i = 0; i < size; i++) if (plane[i]! > 0) plane[i] = Math.pow(plane[i]!, style.gamma);
      if (style.blur >= 0.12) planes[c] = blur(plane, w, h, style.blur);
    }
    let noise: Float32Array | null = null;
    if (style.grain > 0.5) {
      noise = gaussianNoise(size, 1009 + Math.round(seg.x * 31 + seg.y));
      // sensor and paper grain is a little clumped, not one independent value per pixel
      const soft = blur(noise, w, h, 0.6);
      let power = 0;
      for (let i = 0; i < size; i++) power += soft[i]! * soft[i]!;
      const norm = style.grain / Math.sqrt(power / size || 1);
      for (let i = 0; i < size; i++) noise[i] = soft[i]! * norm;
    }
    for (let i = 0; i < size; i++) {
      let any = 0;
      for (let c = 0; c < 3; c++) {
        const a = planes[planes.length === 3 ? c : 0]![i]!;
        if (a <= 0.002) continue;
        any = Math.max(any, a);
        out[i * 3 + c] = out[i * 3 + c]! * (1 - a) + clamp(colour[c]! + (noise ? noise[i]! : 0), 0, 255) * a;
      }
      if (any) {
        touched[i] = 1;
        if (opacity[i]! < 1) opacity[i] = opacity[i]! + (1 - opacity[i]!) * any;
      }
    }
  }

  // only the pixels that really differ
  let bx0 = w;
  let by0 = h;
  let bx1 = -1;
  let by1 = -1;
  const mask = new Uint8Array(size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!touched[i]) continue;
      const at = ((y + y0) * picture.width + x + x0) * 4;
      const a = picture.data[at + 3]! / 255;
      let differs = Math.abs(opacity[i]! - a) > 0.002;
      for (let c = 0; c < 3; c++) if (Math.abs(Math.round(out[i * 3 + c]!) - (picture.data[at + c]! * a + 255 * (1 - a))) >= 1) differs = true;
      if (!differs) continue;
      mask[i] = 1;
      bx0 = Math.min(bx0, x);
      by0 = Math.min(by0, y);
      bx1 = Math.max(bx1, x);
      by1 = Math.max(by1, y);
    }
  }

  // where the text is now, for the outline on screen
  let quad: Quad4 = seg.quad;
  if (shaped && placement) {
    const ink = originalInk(p);
    const [from, to] = plan ? [Math.min(plan.cutLeft === -Infinity ? Infinity : ink.u0 + plan.leftShift, span(shaped, placement, plan.from, plan.to)[0] || Infinity), Math.max(plan.cutRight === Infinity ? -Infinity : ink.u1 + plan.rightShift, span(shaped, placement, plan.from, plan.to)[1])] : span(shaped, placement);
    const pad = Math.max(2, (ink.v1 - ink.v0) * 0.12);
    const top = Math.min(ink.v0, placement.oy + (shaped.ink[1] * placement.size) / 100) - pad;
    const bottom = Math.max(ink.v1, placement.oy + (shaped.ink[3] * placement.size) / 100) + pad;
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) quad = [map(from - pad, top), map(to + pad, top), map(to + pad, bottom), map(from - pad, bottom)];
  }
  else if (carried) quad = seg.quad.map(([x, y]) => [x + edit.move![0], y + edit.move![1]] as Pt) as Quad4;
  const missing = shaped?.missing ?? [];
  if (bx1 < 0) return { patch: null, quad, missing, kept: plan?.kept ?? 0, overflow };
  const pw = bx1 - bx0 + 1;
  const ph = by1 - by0 + 1;
  const data = new Uint8ClampedArray(pw * ph * 4);
  const changed = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y + by0) * w + x + bx0;
      const j = y * pw + x;
      if (!mask[i]) continue;
      changed[j] = 1;
      for (let c = 0; c < 3; c++) data[j * 4 + c] = Math.round(out[i * 3 + c]!);
      data[j * 4 + 3] = Math.round(opacity[i]! * 255);
    }
  }
  return { patch: { x: x0 + bx0, y: y0 + by0, width: pw, height: ph, data, mask: changed }, quad, missing, kept: plan?.kept ?? 0, overflow };
}


