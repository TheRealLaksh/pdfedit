/** Groups the interpreted glyphs into visual lines with logical-order text. */
import { quadToRect } from "../geom";
import type { Align, Point, Quad, TextLine, TextSpan, TextStyle } from "../types";
import { glyphColor, type Decoration, type Glyph, type Interpretation, type MarkedContent } from "./interpret";
import {
  CJK,
  countBadChars,
  directionOf,
  invalidIndicSequences,
  isLegacyFont,
  isMarkOnly,
  NOSPACE_SCRIPT,
  isComplex,
  hasRtl,
  normalizeGlyphText,
  reorderIndic,
  visualToLogical,
} from "./unicode";

export interface Unit {
  /** logical order text; may be several characters (ligature, cluster, ActualText) */
  text: string;
  /** primary glyphs, content order. Empty for a space implied by a gap */
  glyphs: Glyph[];
  /** extent along the baseline, line frame */
  u0: number;
  u1: number;
  /** baseline offset, line frame */
  v: number;
  size: number;
  /** length of one em along the baseline (differs from size under horizontal scaling) */
  em: number;
  /** position in visual order */
  vis: number;
  start: number;
  end: number;
  actual: boolean;
}

export interface Rule {
  decoration: Decoration;
  kind: "underline" | "strike";
  /** units it covers */
  units: Unit[];
  /** how far the rule overshoots the covered units */
  before: number;
  after: number;
}

export interface LineModel {
  line: TextLine;
  /** logical order */
  units: Unit[];
  visual: Unit[];
  /** unit vectors of the line frame in page space: along the baseline and downwards */
  ex: Point;
  ey: Point;
  baseline: number;
  u0: number;
  u1: number;
  size: number;
  rtl: boolean;
  vertical: boolean;
  /** blank glyphs around the text that belong to this line */
  padding: Glyph[];
  /** extra copies drawn at an offset (fake bold, shadows) */
  shadows: Map<Glyph, Glyph[]>;
  rules: Rule[];
  /** extent of the paragraph the line sits in, along the baseline */
  block: { left: number; right: number };
  /** upright characters stacked into a column: where a glyph's origin lies inside its cell, along the line */
  stacked?: number;
  /** extra space after every letter of a tracked line, as a fraction of the font size */
  tracking: number;
  /** letters step down along each word (Nastaliq): new text goes on the line's baseline, not beside them */
  cascade?: boolean;
  /** cut from an extremely long line */
  tooLong?: boolean;
}

interface Entry {
  g: Glyph;
  u: number;
  v: number;
  w: number;
  size: number;
  /** one em along the baseline */
  em: number;
}

interface Segment {
  entries: Entry[];
  v: number;
  size: number;
  /** a piece of a line too long to be one editable line */
  long?: boolean;
  /** begins where a line is known to begin: it is nobody's superscript */
  own?: boolean;
}

/**
 * No real line of text comes near this many glyphs. Longer ones (generated or hostile files) are cut into
 * pieces, which keeps reading a page close to linear, and are not offered for editing.
 */
const MAX_LINE = 1500;
/** how far the alignment and overlap searches look along their sorted lists */
const NEIGHBOURS = 200;

export const toFrame = (p: Point, ex: Point, ey: Point): Point => [p[0] * ex[0] + p[1] * ex[1], p[0] * ey[0] + p[1] * ey[1]];
export const fromFrame = (u: number, v: number, ex: Point, ey: Point): Point => [u * ex[0] + v * ey[0], u * ex[1] + v * ey[1]];

/** largest size, relative to its host, of a superscript or subscript (browsers use 1/1.2) */
const SCRIPT_SIZE = 0.845;

const isBlank = (g: Glyph) => !g.actual && g.unicode !== "" && g.unicode.trim() === "";
/**
 * Word processors write some Arabic ligatures as one wide glyph for the first letter and an empty one,
 * placed inside it and often off the baseline, for the second: that one belongs to its carrier.
 */
const tails = new WeakMap<Glyph, Glyph>();
function findTails(glyphs: Glyph[]): void {
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!;
    if (Math.abs(g.width) >= 0.06 * g.size || !/[\u0620-\u06FF]/.test(g.unicode) || !/\p{L}/u.test(g.unicode)) continue;
    // the carrier is a neighbour in the content, possibly with a space written in between
    for (const step of [-1, -2, 1, 2, -3, 3]) {
      const carrier = glyphs[i + step];
      if (!carrier || !carrier.unicode.trim() || carrier.width < 0.15 * g.size) continue;
      const dx = g.origin[0] - carrier.origin[0];
      const dy = g.origin[1] - carrier.origin[1];
      const along = dx * g.dir[0] + dy * g.dir[1];
      const across = Math.abs(dy * g.dir[0] - dx * g.dir[1]);
      // on the baseline such a letter has its own place in the order; only displaced ones need a carrier
      if (along > -0.05 * g.size && along < carrier.width + 0.05 * g.size && across > 0.06 * g.size && across < 0.5 * g.size) {
        tails.set(g, carrier);
        break;
      }
    }
  }
}

const isMark = (g: Glyph) =>
  tails.has(g) ||
  !/^.\u094D$|^.\u09CD$|^.\u0ACD$|^.\u0B4D$/.test(g.unicode) &&
  // zero width letters (the second half of a split ligature) keep their own place in the order
  ((Math.abs(g.w) < 0.06 && !/\p{L}/u.test(g.unicode)) || (g.unicode !== "" && isMarkOnly(g.unicode) && Math.abs(g.w) < 0.35));
/** the room the producer asked for after every letter (character spacing), page units */
const spacingOf = (g: Glyph) => (g.show.font.vertical ? 0 : Math.max(0, g.show.tc * Math.abs(g.show.th) * g.unit));
const emOf = (g: Glyph) => g.unit * Math.abs(g.show.size * g.show.th * g.show.font.emScale) || g.size || 1;

/** vowel signs that are painted before the consonant they follow */
const PRE_BASE = /^[\u093F\u09BF\u09C7\u09C8\u0A3F\u0ABF\u0B47\u0BC6-\u0BC8\u0D46-\u0D48\u0DD9\u0DDB\u17C1-\u17C3]/;
/** scripts of India and Southeast Asia */
const SHAPED = /[\u0900-\u0EFF\u1000-\u109F\u1780-\u17FF]/;

/** the Unicode block (of 128) of a shaped script's character, -1 for anything else */
const blockOf = (text: string) => {
  const at = text.search(SHAPED);
  return at < 0 ? -1 : text.charCodeAt(at) >> 7;
};

/**
 * Where lines are known to begin and end: recorded when a page is edited, because longer text that reaches
 * the next column would otherwise be read as one line with it, and a table border it now crosses would cut
 * it in two.
 */
export type LineStart = [x: number, y: number, first: string, endX?: number, endY?: number, rtl?: boolean];

export function buildLines(page: number, interp: Interpretation, glyphs: Glyph[], typed = false, starts: LineStart[] = []): LineModel[] {
  let models: LineModel[] = [];
  const spanCount = new Map<MarkedContent, number>();
  for (const g of interp.glyphs) if (g.actual) spanCount.set(g.actual, (spanCount.get(g.actual) ?? 0) + 1);

  findTails(interp.glyphs);
  // a word starting with such a sign shows that this script's glyphs are labelled in painting order
  const painted = new Set(
    interp.glyphs
      .filter((g, i) => PRE_BASE.test(g.unicode) && g.width > 0 && (i === 0 || !interp.glyphs[i - 1]!.unicode.trim()))
      .map((g) => blockOf(g.unicode)),
  );
  // text with a replacement string (such as text written by this editor) says its own order
  const typingOrder = (entries: Entry[]) =>
    typed &&
    entries.some((e) => !e.g.actual && SHAPED.test(e.g.unicode)) &&
    !entries.some((e) => !e.g.actual && painted.has(blockOf(e.g.unicode)));
  // the page's own reading direction settles lines that could be read either way
  let rtl = 0;
  let ltr = 0;
  for (const g of glyphs) {
    const d = directionOf(g.unicode);
    if (d === "R") rtl++;
    else if (d === "L") ltr++;
  }
  const prior = rtl > ltr;

  for (const group of byAngle(glyphs)) {
    const angle = group.angle;
    const ex: Point = [Math.cos(angle), Math.sin(angle)];
    const ey: Point = [-ex[1], ex[0]];
    let entries: Entry[] = group.glyphs.map((g) => {
      const [u, v] = toFrame(g.origin, ex, ey);
      return { g, u, v, w: g.width, size: g.size || 1, em: emOf(g) };
    });
    const shadows = new Map<Glyph, Glyph[]>();
    entries = removeShadows(entries, shadows, starts);
    if (Math.abs(angle) < 0.01) {
      const columns = stackedColumns(entries);
      if (columns.length) {
        const used = new Set(columns.flat());
        entries = entries.filter((e) => !used.has(e));
        for (const column of columns) {
          const model = buildColumn(page, column, shadows);
          if (model) models.push(model);
        }
      }
    }
    const cascading = cascades(entries);
    if (cascading.length) {
      const used = new Set(cascading.flatMap((runs) => runs.flatMap((r) => r.visual)));
      entries = entries.filter((e) => !used.has(e));
      for (const runs of cascading) {
        const model = buildCascade(page, runs, ex, ey, angle, shadows);
        if (model) models.push(model);
      }
    }
    for (const segment of segments(entries, interp, ex, ey, starts)) {
      const model = buildLine(page, segment, ex, ey, angle, shadows, spanCount, prior, typingOrder, starts);
      if (model) models.push(model);
    }
  }
  models = foldShadows(models);
  attachRules(models, interp.rules);
  models.sort((a, b) => a.line.origin[1] - b.line.origin[1] || a.line.origin[0] - b.line.origin[0]);
  detectAlignment(models, interp);
  const seen = new Map<string, number>();
  for (const m of models) {
    const key = hash(`${m.line.text}|${m.line.origin[0].toFixed(1)}|${m.line.origin[1].toFixed(1)}`);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    m.line.id = `t${page}.${key}${n ? `.${n}` : ""}`;
  }
  return models;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function byAngle(glyphs: Glyph[]): { angle: number; glyphs: Glyph[] }[] {
  const buckets = new Map<number, Glyph[]>();
  for (const g of glyphs) {
    const deg = (Math.atan2(g.dir[1], g.dir[0]) * 180) / Math.PI;
    const key = Math.round(deg * 2);
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(g);
  }
  const keys = [...buckets.keys()].sort((a, b) => buckets.get(b)!.length - buckets.get(a)!.length);
  const out: { key: number; angle: number; glyphs: Glyph[] }[] = [];
  for (const k of keys) {
    const home = out.find((o) => Math.abs(o.key - k) <= 2);
    const list = buckets.get(k)!;
    if (home) for (const g of list) home.glyphs.push(g);
    else out.push({ key: k, angle: Math.atan2(list[0]!.dir[1], list[0]!.dir[0]), glyphs: list.slice() });
  }
  for (const o of out) o.glyphs.sort((a, b) => a.seq - b.seq);
  return out;
}

/** the same glyph painted again at (almost) the same spot: keep the topmost as the real one */
function removeShadows(entries: Entry[], shadows: Map<Glyph, Glyph[]>, starts: LineStart[]): Entry[] {
  const grid = new Map<string, Entry[]>();
  /** the later copy of a glyph and the one it covers */
  const pairs: [top: Entry, under: Entry][] = [];
  for (const e of entries) {
    // microscopic text needs finer cells, or thousands of glyphs share one
    const step = e.size < 1 ? Math.max(e.size, 1e-4) : 4;
    const cell = (du: number, dv: number) => `${Math.round(e.u / step) + du},${Math.round(e.v / step) + dv}`;
    let twin: Entry | null = null;
    // large lettering is overprinted further apart than one cell
    const reach = Math.min(8, Math.max(1, Math.ceil((0.11 * e.size) / step)));
    for (let du = -reach; du <= reach && !twin; du++)
      for (let dv = -reach; dv <= reach && !twin; dv++)
        for (const [index, o] of (grid.get(cell(du, dv)) ?? []).entries()) {
          // browsers outline text by painting the same letters again from a second font
          const exact =
            !!e.g.unicode.trim() &&
            o.g.unicode === e.g.unicode &&
            o.g.invisible === e.g.invisible &&
            Math.abs(o.u - e.u) < 0.02 * e.size &&
            Math.abs(o.v - e.v) < 0.02 * e.size;
          if (
            (exact || (o.g.code.code === e.g.code.code && o.g.show.font === e.g.show.font)) &&
            o.g.show !== e.g.show &&
            Math.abs(o.size - e.size) < 0.08 * e.size &&
            Math.abs(o.u - e.u) < 0.11 * e.size &&
            Math.abs(o.v - e.v) < 0.11 * e.size &&
            Math.abs(o.w - e.w) < 0.15 * e.size
          ) {
            twin = o;
            // it can never be matched again: drop it so that heavily overprinted spots stay cheap
            grid.get(cell(du, dv))!.splice(index, 1);
            break;
          }
        }
    if (twin) pairs.push([e, twin]);
    const key = cell(0, 0);
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(e);
  }
  if (!pairs.length) return entries;

  // a copy covers a good part of what was written with it: one letter of a longer line landing on the
  // same letter of another line (lines of an edited page can cross) is chance
  const run = new Map<Entry, Run>();
  for (const r of runsOf(entries, starts)) for (const e of r.entries) run.set(e, r);
  const inked = new Map<Run, number>();
  for (const e of entries) if (!isBlank(e.g)) inked.set(run.get(e)!, (inked.get(run.get(e)!) ?? 0) + 1);
  const together = new Map<Run, Map<Run, number>>();
  for (const [top, under] of pairs) {
    if (isBlank(top.g)) continue;
    const [a, b] = [run.get(top)!, run.get(under)!];
    let row = together.get(a);
    if (!row) together.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + 1);
  }
  const dropped = new Set<Entry>();
  for (const [top, under] of pairs) {
    const [a, b] = [run.get(top)!, run.get(under)!];
    const smaller = Math.min(inked.get(a) ?? 1, inked.get(b) ?? 1);
    if (!isBlank(top.g) && a !== b && (together.get(a)?.get(b) ?? 0) < 0.4 * smaller) continue;
    dropped.add(under);
    // the list is handed on rather than copied, however often a glyph is painted over
    const copies = shadows.get(under.g) ?? [];
    copies.push(under.g);
    shadows.set(top.g, copies);
    shadows.delete(under.g);
  }
  return dropped.size ? entries.filter((e) => !dropped.has(e)) : entries;
}

/** columns of upright East Asian characters: no neighbour on the same row, close neighbours above or below */
function stackedColumns(entries: Entry[]): Entry[][] {
  const wide = entries.filter((e) => CJK.test(e.g.unicode));
  if (wide.length < 3) return [];
  const rows = entries.slice().sort((a, b) => a.v - b.v || a.u - b.u);
  const alone = new Set<Entry>();
  for (let i = 0; i < rows.length; ) {
    let j = i + 1;
    while (j < rows.length && rows[j]!.v - rows[i]!.v < 0.2 * rows[i]!.size) j++;
    const row = rows.slice(i, j).sort((a, b) => a.u - b.u);
    row.forEach((e, k) => {
      const before = k ? e.u - (row[k - 1]!.u + row[k - 1]!.w) : Infinity;
      const after = k + 1 < row.length ? row[k + 1]!.u - (e.u + e.w) : Infinity;
      if (before > 0.45 * e.size && after > 0.45 * e.size) alone.add(e);
    });
    i = j;
  }
  const candidates = [...alone].filter((e) => !isBlank(e.g)).sort((a, b) => a.u - b.u || a.v - b.v);
  const out: Entry[][] = [];
  let column: Entry[] = [];
  const flush = () => {
    const eastAsian = column.filter((e) => CJK.test(e.g.unicode)).length;
    if (eastAsian >= 3 && eastAsian * 2 > column.length && column.length <= MAX_LINE) out.push(column);
    column = [];
  };
  let i = 0;
  while (i < candidates.length) {
    let j = i + 1;
    while (j < candidates.length && candidates[j]!.u - candidates[i]!.u < 0.25 * candidates[i]!.size) j++;
    for (const e of candidates.slice(i, j).sort((a, b) => a.v - b.v)) {
      const last = column[column.length - 1];
      if (last && (e.v - last.v > 1.7 * e.size || e.v - last.v < 0.7 * e.size || Math.abs(e.size - last.size) > 0.1 * e.size)) flush();
      column.push(e);
    }
    flush();
    i = j;
  }
  // vertical punctuation sits off the centre of its cell
  const used = new Set(out.flat());
  for (const column of out)
    for (let grown = true; grown; ) {
      grown = false;
      const end = column[column.length - 1]!;
      const next = candidates.find(
        (e) => !used.has(e) && Math.abs(e.u - column[0]!.u) < 0.9 * e.size && e.v - end.v > 0.3 * e.size && e.v - end.v < 1.9 * e.size,
      );
      if (next) {
        column.push(next);
        used.add(next);
        grown = true;
      }
    }
  return out;
}

function buildColumn(page: number, column: Entry[], shadows: Map<Glyph, Glyph[]>): LineModel | null {
  const ex: Point = [0, 1];
  const ey: Point = [-1, 0];
  const size = column[0]!.size;
  const lift = 0.88 * size;
  const entries: Entry[] = column.map((e) => {
    const [u, v] = toFrame(e.g.origin, ex, ey);
    return { g: e.g, u: u - lift, v, w: size, size, em: size };
  });
  const units = entries.map((e, i) => {
    const unit = unitOf([e], textOfGlyphs([e.g]), false);
    const next = entries[i + 1];
    unit.u1 = next ? next.u : e.u + size;
    return unit;
  });
  const model = assemble(page, units, [], { entries, v: entries[0]!.v, size }, ex, ey, Math.PI / 2, shadows);
  if (model) model.stacked = lift;
  return model;
}

/** a marked right to left run; its content order is the reading order, forwards or backwards */
interface Cascade {
  /** left to right */
  visual: Entry[];
  segment: Segment;
  left: number;
  right: number;
}

/**
 * Right to left runs whose letters sit at very different heights (Nastaliq) and that are marked as runs:
 * by browsers (ReversedChars, content order backwards) or by this editor (content order forwards). Their
 * baselines and positions do not say where a line or a letter belongs, but the content order does.
 * Runs that continue one another on a baseline are one line.
 */
function cascades(entries: Entry[]): Cascade[][] {
  const runs = new Map<MarkedContent, Entry[]>();
  for (const e of entries) {
    const show = e.g.show;
    // only a mark opened inside the glyph's own text object: text inserted later has its own
    const mark = show.marked.find(
      (m) => (m.tag === "ReversedChars" || m.tag === "PEOrder") && m.node === show.node && m.begin > (show.textObject?.bt ?? Infinity),
    );
    if (!mark) continue;
    let list = runs.get(mark);
    if (!list) runs.set(mark, (list = []));
    list.push(e);
  }
  const found: (Cascade & { stepped: boolean })[] = [];
  for (const [mark, run] of runs) {
    const segment = segmentOf(run);
    const spread = Math.max(...run.map((e) => e.v)) - Math.min(...run.map((e) => e.v));
    if (run.length > MAX_LINE || spread >= 2.2 * segment.size || !/[؀-ࣿ]/.test(run.map((e) => e.g.actual?.actualText ?? e.g.unicode).join(""))) continue;
    const visual = run.slice().sort((a, b) => (mark.tag === "PEOrder" ? b.g.seq - a.g.seq : a.g.seq - b.g.seq));
    const stepped = run.filter((e) => Math.abs(e.v - segment.v) > 0.15 * segment.size).length >= 3;
    found.push({ visual, segment, stepped, left: Math.min(...run.map((e) => e.u)), right: Math.max(...run.map((e) => e.u + e.w)) });
  }
  // long runs first: later ones fill their holes or continue them
  found.sort((a, b) => b.visual.length - a.visual.length);
  const lines: (typeof found)[] = [];
  const pending = found.slice();
  while (pending.length) {
    const run = pending.shift()!;
    const line = lines.find((list) => {
      const size = Math.max(list[0]!.segment.size, run.segment.size);
      if (Math.abs(list[0]!.segment.v - run.segment.v) >= 0.5 * size) return false;
      const left = Math.min(...list.map((r) => r.left));
      const right = Math.max(...list.map((r) => r.right));
      if (run.left - right > 1.1 * size || left - run.right > 1.1 * size) return false;
      // it must not be printed on top of what the line already has
      let covered = 0;
      for (const r of list) for (const e of r.visual) covered += Math.max(0, Math.min(run.right, e.u + e.w) - Math.max(run.left, e.u));
      return covered < 0.5 * (run.right - run.left);
    });
    if (line) line.push(run);
    else lines.push([run]);
  }
  // flat runs (Naskh and the like) are read well enough from their positions, and so is a line that
  // also holds letters outside such runs (another script, or Arabic that is not marked)
  const inRuns = new Set(found.flatMap((r) => r.visual));
  const foreign = entries.filter((e) => !inRuns.has(e) && /\p{L}/u.test(e.g.unicode));
  return lines.filter(
    (list) =>
      list.some((r) => r.stepped) &&
      !foreign.some((e) =>
        list.some((r) => Math.abs(e.v - r.segment.v) < 0.3 * r.segment.size && e.u < r.right + 1.5 * r.segment.size && e.u + e.w > r.left - 1.5 * r.segment.size),
      ),
  );
}

function buildCascade(page: number, runs: Cascade[], ex: Point, ey: Point, angle: number, shadows: Map<Glyph, Glyph[]>): LineModel | null {
  const units: Unit[] = [];
  for (const run of runs) {
    // one unit per marked letter; glyphs without text (dots) stay with the letter beside them
    const groups: Entry[][] = [];
    for (const e of run.visual) {
      const last = groups[groups.length - 1];
      if (last && ((e.g.actual && last[0]!.g.actual === e.g.actual) || (!e.g.actual && !e.g.unicode))) last.push(e);
      else groups.push([e]);
    }
    const own = groups.map((g) => {
      const actual = g.find((e) => e.g.actual)?.g.actual?.actualText;
      return unitOf(g, actual ?? textOfGlyphs(g.map((e) => e.g)), actual !== undefined);
    });
    // the run goes where it sits: before the first unit lying to the right of its middle
    const middle = (run.left + run.right) / 2;
    let at = units.findIndex((u) => (u.u0 + u.u1) / 2 > middle);
    if (at < 0) at = units.length;
    units.splice(at, 0, ...own);
  }
  // gaps between runs that no space glyph fills
  for (let i = units.length - 1; i > 0; i--) {
    const a = units[i - 1]!;
    const b = units[i]!;
    if (a.text.trim() && b.text.trim() && b.u0 - a.u1 > 0.15 * b.em && !runs.some((r) => r.visual.some((e) => e.g === a.glyphs[0]) && r.visual.some((e) => e.g === b.glyphs[0])))
      units.splice(i, 0, { ...b, text: " ", glyphs: [], u0: a.u1, u1: b.u0, actual: false });
  }
  const blank = (u: Unit) => !u.text.trim();
  const padding: Glyph[] = [];
  while (units.length && blank(units[0]!)) padding.push(...units.shift()!.glyphs);
  while (units.length && blank(units[units.length - 1]!)) padding.push(...units.pop()!.glyphs);
  if (!units.length) return null;
  const main = runs.reduce((a, b) => (b.visual.length > a.visual.length ? b : a)).segment;
  const model = assemble(page, units, padding, { ...main, entries: runs.flatMap((r) => r.visual) }, ex, ey, angle, shadows, true);
  if (model) model.cascade = true;
  return model;
}

/** glyphs painted one right after the other along one baseline, as producers write a piece of text */
/** a vertical rule, line frame */
interface Wall {
  u: number;
  v0: number;
  v1: number;
}

/** a stretch that is known to be one line, line frame */
interface Span {
  u0: number;
  u1: number;
  v: number;
}

interface Run {
  entries: Entry[];
  from: number;
  /** begins where a line is known to begin */
  start: boolean;
}

function runsOf(entries: Entry[], starts: LineStart[]): Run[] {
  const near = new Map<number, LineStart[]>();
  for (const s of starts) {
    const k = Math.round(s[0]);
    for (const d of [-1, 0, 1]) {
      let list = near.get(k + d);
      if (!list) near.set(k + d, (list = []));
      list.push(s);
    }
  }
  const begins = (g: Glyph) =>
    !!near.get(Math.round(g.origin[0]))?.some((s) => Math.abs(s[0] - g.origin[0]) < 0.25 && Math.abs(s[1] - g.origin[1]) < 0.25 && g.unicode.startsWith(s[2]));
  const out: Run[] = [];
  let run: Run | null = null;
  let end = 0;
  let v = 0;
  for (const e of entries.slice().sort((a, b) => a.g.seq - b.g.seq)) {
    const start = near.size > 0 && !isBlank(e.g) && begins(e.g);
    if (!run || start || Math.abs(e.v - v) > 0.3 * e.size || e.u < end - 0.5 * e.em || e.u > end + 1.1 * e.em) {
      out.push((run = { entries: [], from: e.u, start }));
    }
    run.entries.push(e);
    run.from = Math.min(run.from, e.u);
    end = e.u + e.w + spacingOf(e.g);
    v = e.v;
  }
  return out;
}

/**
 * Splits a row into layers of text that does not run into itself. Two pieces printed across each other
 * (text typed over a dotted leader, or a lengthened line reaching into the next column) are two lines.
 */
function layersOf(row: Entry[], run: Map<Entry, Run>): Entry[][] {
  const pieces = new Map<Run, Entry[]>();
  for (const e of row) {
    const r = run.get(e)!;
    let list = pieces.get(r);
    if (!list) pieces.set(r, (list = []));
    list.push(e);
  }
  interface Layer {
    entries: Entry[];
    /** ink painted so far, by position */
    ink: Entry[];
    end: number;
    /** pieces of several letters reach up to here */
    words: number;
  }
  const layers: Layer[] = [];
  const ordered = [...pieces].sort((a, b) => a[0].from - b[0].from || a[1][0]!.g.seq - b[1][0]!.g.seq);
  const solid = (e: Entry) => !isBlank(e.g) && e.w > 0.25 * e.em;
  const simple = (e: Entry) => !e.g.actual && !isComplex(e.g.unicode) && !hasRtl(e.g.unicode);
  for (const [r, list] of ordered) {
    const ink = list.filter(solid);
    const conflicts = (l: Layer) => {
      if (r.start && ink.length && ink[0]!.u < l.end - 0.03 * ink[0]!.em) return true;
      let crossed = 0;
      for (const e of ink) {
        // only neighbours matter, and painted ink is sorted by where it begins
        for (let i = l.ink.length - 1; i >= 0; i--) {
          const o = l.ink[i]!;
          if (o.u + 4 * o.em < e.u) break;
          const overlap = Math.min(o.u + o.w, e.u + e.w) - Math.max(o.u, e.u);
          if (overlap <= 0) continue;
          // the same spot painted twice from two places in the file
          if (overlap > 0.7 * Math.min(e.w, o.w) && Math.abs(e.g.seq - o.g.seq) > 3 && e.g.show !== o.g.show && !e.g.actual) return true;
          // the letters of joined and stacked scripts overlap as part of their shape
          if (ink.length > 1 && e.u < l.words && simple(e) && simple(o)) crossed += overlap;
        }
        if (crossed > 0.45 * e.em) return true;
      }
      return false;
    };
    let layer = layers.find((l) => !conflicts(l));
    if (!layer && layers.length >= 16) layer = layers[layers.length - 1]!;
    if (!layer) layers.push((layer = { entries: [], ink: [], end: -Infinity, words: -Infinity }));
    for (const e of list) layer.entries.push(e);
    for (const e of ink) {
      let i = layer.ink.length;
      while (i > 0 && layer.ink[i - 1]!.u > e.u) i--;
      layer.ink.splice(i, 0, e);
      layer.end = Math.max(layer.end, e.u + e.w);
      if (ink.length > 1) layer.words = Math.max(layer.words, e.u + e.w);
    }
  }
  return layers.map((l) => l.entries.sort((a, b) => a.u - b.u || a.g.seq - b.g.seq));
}

function segments(entries: Entry[], interp: Interpretation, ex: Point, ey: Point, starts: LineStart[]): Segment[] {
  // marks may be raised or lowered: they follow their base rather than forming their own baseline
  const bases: Entry[] = [];
  const marks: Entry[] = [];
  for (const e of entries) (isMark(e.g) ? marks : bases).push(e);
  if (!bases.length) bases.push(...marks.splice(0));

  const sorted = bases.slice().sort((a, b) => a.v - b.v);
  const rows: Entry[][] = [];
  let row: Entry[] = [];
  let rowStart = 0;
  let previous = 0;
  for (const e of sorted) {
    if (row.length && (e.v - previous > 0.14 * e.size || e.v - rowStart > 0.3 * e.size)) {
      rows.push(row);
      row = [];
    }
    if (!row.length) rowStart = e.v;
    previous = e.v;
    row.push(e);
  }
  if (row.length) rows.push(row);

  // vertical rules (table cell borders) always separate text
  const walls: Wall[] = [];
  for (const r of interp.rules) {
    const a = toFrame(r.a, ex, ey);
    const b = toFrame(r.b, ex, ey);
    if (Math.abs(a[0] - b[0]) < 1.5 && Math.abs(a[1] - b[1]) > 6) walls.push({ u: (a[0] + b[0]) / 2, v0: Math.min(a[1], b[1]), v1: Math.max(a[1], b[1]) });
  }

  // stretches that are known to be one line, whatever now lies across them
  const whole: Span[] = starts.flatMap((s) => {
    if (s[3] === undefined) return [];
    const [u0, v] = toFrame([s[0], s[1]], ex, ey);
    const [u1] = toFrame([s[3], s[4]!], ex, ey);
    return [{ u0, u1, v }];
  });

  const out: Segment[] = [];
  const run = new Map<Entry, Run>();
  const begins = new Set<Entry>();
  for (const r of runsOf(bases, starts)) {
    for (const e of r.entries) run.set(e, r);
    if (r.start) begins.add(r.entries[0]!);
  }
  for (const r of rows) {
    r.sort((a, b) => a.u - b.u || a.g.seq - b.g.seq);
    // two unrelated texts printed over each other stay separate
    for (const layer of layersOf(r, run)) {
      let seg: Entry[] = [];
      let end = -Infinity;
      let inkEnd = -Infinity;
      let spaces = 0;
      let size = 0;
      let across = 0;
      let spaced = 0;
      const flush = () => {
        if (seg.length > MAX_LINE) for (const part of pieces(seg)) out.push({ ...segmentOf(part), long: true });
        else if (seg.length) out.push({ ...segmentOf(seg), own: seg.some((e) => begins.has(e)) });
        seg = [];
        end = inkEnd = -Infinity;
        spaces = 0;
        size = 0;
        across = 0;
        spaced = 0;
      };
      for (const e of layer) {
        const blank = isBlank(e.g);
        if (seg.length && begins.has(e)) flush();
        if (seg.length) {
          const em = Math.max(e.em, across);
          // spacing that is part of the text itself separates nothing
          const gap = e.u - end - spaced;
          if (!blank) {
            const inkGap = e.u - inkEnd - spaced;
            const wall =
              inkEnd > -Infinity &&
              walls.some((w) => w.u > inkEnd - 0.5 && w.u < e.u + 0.5 && w.v0 < e.v - 0.2 * e.size && w.v1 > e.v - 0.4 * e.size);
            const ratio = Math.max(e.size, size) / Math.max(0.1, Math.min(e.size, size));
            const track = inkGap > 0.9 * em ? trackedBy(seg) : 0;
            if (
              (wall || gap > (spaces ? 1.6 : 1.1) * em + track || inkGap > 4.5 * em || (ratio > 2.2 && size > 0 && inkGap > 0.25 * em)) &&
              !whole.some((w) => Math.abs(w.v - e.v) < 0.3 * e.size && inkEnd > w.u0 - 0.5 && e.u < w.u1 - 0.5)
            )
              flush();
          }
        }
        seg.push(e);
        // a blank that jumps far ahead must not bridge the gap to the next column
        if (!blank || end === -Infinity || e.u - end - spaced < 1.1 * e.em) end = Math.max(end, e.u + Math.max(e.w, blank ? e.g.advance : 0));
        if (blank) spaces++;
        else {
          inkEnd = Math.max(inkEnd, e.u + e.w);
          spaced = spacingOf(e.g);
          spaces = 0;
          size = Math.max(size, e.size);
          across = Math.max(across, e.em);
        }
      }
      flush();
    }
  }

  joinJustified(out, walls);
  splitColumns(out, whole);

  // superscripts and subscripts join the text they annotate
  out.sort((a, b) => b.size - a.size);
  const bounds = (s: Segment) => {
    let a = Infinity;
    let b = -Infinity;
    for (const e of s.entries) {
      a = Math.min(a, e.u);
      b = Math.max(b, e.u + e.w);
    }
    return [a, b] as const;
  };
  const merged = new Set<Segment>();
  const boxes = out.map(bounds);
  const byV = out.map((_, i) => i).sort((a, b) => out[a]!.v - out[b]!.v);
  const position = new Map(byV.map((i, k) => [i, k]));
  const largest = out[0]?.size ?? 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const small = out[i]!;
    if (small.size > SCRIPT_SIZE * largest) continue;
    const [a0, a1] = boxes[i]!;
    const k = position.get(i)!;
    search: for (const step of [-1, 1]) {
      for (let j = k + step; j >= 0 && j < byV.length; j += step) {
        const big = out[byV[j]!]!;
        if (Math.abs(big.v - small.v) > 3 * small.size + 40) break;
        // two lines that are known to be separate stay so
        if (big === small || merged.has(big) || small.size > SCRIPT_SIZE * big.size || (small.own && big.own)) continue;
        const dv = small.v - big.v;
        if (dv < -0.65 * big.size || dv > 0.35 * big.size) continue;
        const [b0, b1] = boxes[byV[j]!]!;
        const gap = Math.max(a0 - b1, b0 - a1);
        // it sits right beside letters of the host, or in a hole of it, never on top of them
        if (gap > 0.3 * big.size || !tucksInto(big, a0, a1, small.size)) continue;
        for (const e of small.entries) big.entries.push(e);
        boxes[byV[j]!] = [Math.min(a0, b0), Math.max(a1, b1)];
        merged.add(small);
        break search;
      }
    }
  }
  const result = out.filter((s) => !merged.has(s));

  // attach marks to the segment holding the nearest base glyph
  if (marks.length) {
    const owner = new Map<Glyph, Segment>();
    for (const s of result) for (const e of s.entries) owner.set(e.g, s);
    const index = new Map<number, Entry[]>();
    for (const s of result)
      for (const e of s.entries) {
        const k = Math.floor(e.u / 24);
        let list = index.get(k);
        if (!list) index.set(k, (list = []));
        list.push(e);
      }
    const all = entries;
    const at = new Map(all.map((e, i) => [e, i]));
    for (const m of marks) {
      let best: Entry | null = null;
      let score = Infinity;
      const consider = (b: Entry, bonus: number) => {
        if (!owner.has(b.g)) return;
        const dv = Math.abs(m.v - b.v);
        if (dv > 1.1 * b.size) return;
        const du = m.u < b.u ? b.u - m.u : m.u > b.u + b.w ? m.u - b.u - b.w : 0;
        if (du > 0.8 * b.size) return;
        const s = du + dv * 0.5 - bonus * b.size;
        if (s < score) {
          score = s;
          best = b;
        }
      };
      const i = at.get(m)!;
      for (const d of [-2, -1, 1, 2]) if (all[i + d]) consider(all[i + d]!, Math.abs(d) === 1 ? 0.3 : 0.15);
      const k = Math.floor(m.u / 24);
      for (let c = k - 2; c <= k + 1; c++) for (const b of index.get(c) ?? []) consider(b, b.g.actual && b.g.actual === m.g.actual ? 2 : 0);
      if (best) {
        const s = owner.get((best as Entry).g)!;
        s.entries.push(m);
        owner.set(m.g, s);
      } else {
        const s = segmentOf([m]);
        result.push(s);
        owner.set(m.g, s);
      }
    }
  }
  return result;
}

/**
 * The extra room between the letters of widely tracked text, from the latest letters of a piece: a word
 * gap there is a space plus twice that. 0 for ordinary text.
 */
function trackedBy(entries: Entry[]): number {
  const gaps: number[] = [];
  let next: Entry | null = null;
  for (let i = entries.length - 1; i >= 0 && gaps.length < 6; i--) {
    const e = entries[i]!;
    if (isBlank(e.g)) {
      next = null;
      continue;
    }
    if (next) gaps.push(next.u - (e.u + e.w));
    next = e;
  }
  if (gaps.length < 2) return 0;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1]!;
  const size = entries[entries.length - 1]!.em;
  const even = gaps.filter((g) => Math.abs(g - median) < 0.12 * size).length;
  return median > 0.15 * size && even >= 0.75 * gaps.length ? Math.min(2.2 * median, 1.6 * size) : 0;
}

/**
 * Justified text in a narrow column can open holes wider than the gap between two columns. Pieces joined
 * by a real space are one line again when together they span exactly what the lines around them span.
 */
function joinJustified(segments: Segment[], walls: Wall[]): void {
  const info = segments.map((s) => {
    let left = Infinity;
    let right = -Infinity;
    let first: Entry | null = null;
    let last: Entry | null = null;
    let spaces = 0;
    for (const e of s.entries) {
      if (!first || e.g.seq < first.g.seq) first = e;
      if (!last || e.g.seq > last.g.seq) last = e;
      if (isBlank(e.g)) {
        spaces++;
        continue;
      }
      left = Math.min(left, e.u);
      right = Math.max(right, e.u + e.w);
    }
    return { s, left, right, first: first!, last: last!, spaces };
  });
  const byFirst = new Map(info.map((i) => [i.first.g.seq, i]));
  /** pieces that follow one another on a row, joined by a real space; every piece belongs to one */
  const chains: (typeof info)[] = [];
  const taken = new Set<Segment>();
  for (const head of info.slice().sort((a, b) => a.left - b.left)) {
    if (taken.has(head.s)) continue;
    const chain = [head];
    taken.add(head.s);
    for (let tail = head; ; ) {
      const next = byFirst.get(tail.last.g.seq + 1);
      const em = tail.last.em;
      if (!next || taken.has(next.s) || !isBlank(tail.last.g)) break;
      if (Math.abs(next.s.v - head.s.v) > 0.05 * em || Math.abs(next.s.size - head.s.size) > 0.05 * em) break;
      if (next.left < tail.right || next.left - tail.right > 9 * em) break;
      // cells of a table are written with spaces after them too
      if (walls.some((w) => w.u > tail.right - 0.5 && w.u < next.left + 0.5 && w.v0 < next.s.v - 0.2 * em && w.v1 > next.s.v - 0.4 * em)) break;
      chain.push(next);
      taken.add(next.s);
      tail = next;
    }
    chains.push(chain);
  }
  const extents = chains.map((c) => ({
    plain: c.length === 1,
    v: c[0]!.s.v,
    left: c[0]!.left,
    right: c[c.length - 1]!.right,
    spaced: c.some((i) => i.spaces >= 1),
  }));
  const gone = new Set<Segment>();
  const join = (chain: typeof info, index: number) => {
    if (chain.length < 2 || extents[index]!.plain) return;
    const own = extents[index]!;
    const size = chain[0]!.s.size;
    const column = extents.filter(
      (o) =>
        o !== own &&
        o.spaced &&
        Math.abs(o.v - own.v) > 0.5 * size &&
        Math.abs(o.v - own.v) < 7 * size &&
        Math.abs(o.right - own.right) < 0.6 &&
        // the first line of a paragraph starts a little further in
        own.left - o.left > -0.6 &&
        own.left - o.left < 4 * size,
    );
    // justified prose has lines that needed no joining; the rows of a table are all in pieces
    if (column.filter((o) => o.plain).length < 2 || !column.some((o) => Math.abs(o.left - own.left) < 0.6)) return;
    for (const part of chain.slice(1)) {
      chain[0]!.s.entries.push(...part.s.entries);
      gone.add(part.s);
    }
    own.plain = true;
  };
  // a line that was joined shows the column as well as one that never was apart
  for (let pass = 0; pass < 3; pass++) chains.forEach(join);
  for (let i = segments.length - 1; i >= 0; i--) if (gone.has(segments[i]!)) segments.splice(i, 1);
}

/** what a list item starts with: it stays with its text */
const LIST_MARK = /^(?:[•‣◦▪●○·–—*>o-]|\(?[\p{N}ivxa-z]{1,3}[.)])$/iu;

/**
 * Columns of a table without borders can sit closer than the gap that separates unrelated text. They give
 * themselves away: a gap with no space in it, the next piece written separately, and the same starting
 * place on several rows nearby.
 */
function splitColumns(segments: Segment[], whole: Span[]): void {
  interface Cut {
    segment: Segment;
    /** where the second piece begins */
    at: Entry;
  }
  const columns = new Map<number, Cut[]>();
  const cuts: Cut[] = [];
  for (const segment of segments) {
    if (segment.long || segment.entries.length < 2) continue;
    const row = segment.entries.slice().sort((a, b) => a.u - b.u || a.g.seq - b.g.seq);
    // the usual room between two letters of this piece: tracked or loosely set text has no columns
    const gaps: number[] = [];
    for (let i = 1, ink = row.filter((e) => !isBlank(e.g)); i < ink.length; i++) gaps.push(ink[i]!.u - (ink[i - 1]!.u + ink[i - 1]!.w + spacingOf(ink[i - 1]!.g)));
    gaps.sort((a, b) => a - b);
    const usual = Math.max(0, gaps[gaps.length >> 1] ?? 0);
    let last: Entry | null = null;
    let blank = false;
    let head = "";
    for (const e of row) {
      if (isBlank(e.g)) {
        blank = true;
        continue;
      }
      if (last && !blank && e.g.show !== last.g.show && e.u - (last.u + last.w + spacingOf(last.g)) > 0.3 * e.em + 2.5 * usual && !LIST_MARK.test(head)) {
        const cut = { segment, at: e };
        cuts.push(cut);
        const k = Math.round(e.u);
        let list = columns.get(k);
        if (!list) columns.set(k, (list = []));
        list.push(cut);
      }
      last = e;
      blank = false;
      head += e.g.unicode;
    }
  }
  if (cuts.length < 3) return;
  const chosen = new Map<Segment, Entry[]>();
  for (const cut of cuts) {
    const rows = new Set<Segment>();
    const k = Math.round(cut.at.u);
    for (const d of [-1, 0, 1])
      for (const o of columns.get(k + d) ?? []) {
        const apart = Math.abs(o.segment.v - cut.segment.v);
        if (o.segment !== cut.segment && Math.abs(o.at.u - cut.at.u) < 0.4 && apart > 0.5 * cut.at.size && apart < 9 * cut.at.size) rows.add(o.segment);
      }
    if (rows.size < 2 || whole.some((w) => Math.abs(w.v - cut.at.v) < 0.3 * cut.at.size && cut.at.u > w.u0 + 0.5 && cut.at.u < w.u1 - 0.5)) continue;
    let list = chosen.get(cut.segment);
    if (!list) chosen.set(cut.segment, (list = []));
    list.push(cut.at);
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    const at = chosen.get(segment);
    if (!at) continue;
    const edges = at.map((e) => e.u).sort((a, b) => a - b);
    const parts: Entry[][] = Array.from({ length: edges.length + 1 }, () => []);
    for (const e of segment.entries) {
      let n = 0;
      while (n < edges.length && e.u >= edges[n]! - 0.01) n++;
      parts[n]!.push(e);
    }
    segments.splice(i, 1, ...parts.filter((p) => p.length).map((p) => ({ ...segmentOf(p), own: segment.own })));
  }
}

/**
 * Display text with a shadow or a second coat painted well off the letters: the same words, from the same
 * glyphs, all moved by one offset. The copy underneath belongs to the line on top, so that both change.
 */
function foldShadows(models: LineModel[]): LineModel[] {
  const byText = new Map<string, LineModel[]>();
  for (const m of models) {
    const key = `${m.line.angle.toFixed(2)}|${m.line.text}`;
    let list = byText.get(key);
    if (!list) byText.set(key, (list = []));
    list.push(m);
  }
  const gone = new Set<LineModel>();
  const painted = (m: LineModel) => m.units.flatMap((u) => u.glyphs).sort((a, b) => a.seq - b.seq);
  for (const list of byText.values()) {
    if (list.length < 2 || list.length > 40) continue;
    // later paint lies on top
    const order = list.map((m) => ({ m, glyphs: painted(m) })).filter((o) => o.glyphs.length);
    order.sort((a, b) => a.glyphs[0]!.seq - b.glyphs[0]!.seq);
    for (let i = 0; i + 1 < order.length; i++) {
      const under = order[i]!;
      for (let j = i + 1; j < order.length; j++) {
        const top = order[j]!;
        if (under.glyphs.length !== top.glyphs.length || Math.abs(under.m.size - top.m.size) > 0.03 * top.m.size) continue;
        const dx = under.glyphs[0]!.origin[0] - top.glyphs[0]!.origin[0];
        const dy = under.glyphs[0]!.origin[1] - top.glyphs[0]!.origin[1];
        const size = top.m.size;
        if (Math.hypot(dx, dy) > 0.6 * size) continue;
        const same = under.glyphs.every((g, k) => {
          const t = top.glyphs[k]!;
          return g.unicode === t.unicode && Math.abs(g.origin[0] - t.origin[0] - dx) < 0.03 * size + 0.1 && Math.abs(g.origin[1] - t.origin[1] - dy) < 0.03 * size + 0.1;
        });
        if (!same) continue;
        under.glyphs.forEach((g, k) => {
          const t = top.glyphs[k]!;
          const copies = top.m.shadows.get(t) ?? [];
          top.m.shadows.set(t, [...(under.m.shadows.get(g) ?? []), g, ...copies]);
        });
        top.m.padding.push(...under.m.padding);
        const [a, b] = [top.m.line.rect, under.m.line.rect];
        top.m.line.rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
        gone.add(under.m);
        break;
      }
    }
  }
  return gone.size ? models.filter((m) => !gone.has(m)) : models;
}

/** cut at blanks where there are any */
function pieces(entries: Entry[]): Entry[][] {
  const out: Entry[][] = [];
  for (let from = 0; from < entries.length; ) {
    let to = Math.min(entries.length, from + MAX_LINE);
    if (to < entries.length)
      for (let i = to; i > from + MAX_LINE / 2; i--)
        if (isBlank(entries[i - 1]!.g)) {
          to = i;
          break;
        }
    out.push(entries.slice(from, to));
    from = to;
  }
  return out;
}

function tucksInto(host: Segment, a0: number, a1: number, size: number): boolean {
  let near = false;
  let covered = 0;
  for (const e of host.entries) {
    if (isBlank(e.g)) continue;
    const overlap = Math.min(a1, e.u + e.w) - Math.max(a0, e.u);
    if (overlap > 0) covered += overlap;
    if (overlap > -0.3 * host.size) near = true;
  }
  return near && covered <= 0.5 * size;
}

function segmentOf(entries: Entry[]): Segment {
  // the baseline is where most of the ink at the largest common size sits
  let size = 0;
  for (const e of entries) if (!isBlank(e.g)) size = Math.max(size, e.size);
  size ||= entries[0]!.size;
  const votes = new Map<number, number>();
  for (const e of entries)
    if (e.size > 0.85 * size) {
      const k = Math.round(e.v * 20) / 20;
      votes.set(k, (votes.get(k) ?? 0) + e.w + 0.01);
    }
  let v = entries[0]!.v;
  let top = -1;
  for (const [k, n] of votes)
    if (n > top) {
      top = n;
      v = k;
    }
  return { entries, v, size };
}

function unitOf(entries: Entry[], text: string, actual: boolean): Unit {
  let u0 = Infinity;
  let u1 = -Infinity;
  let size = 0;
  let main = entries[0]!;
  for (const e of entries) {
    u0 = Math.min(u0, e.u);
    u1 = Math.max(u1, e.u + Math.max(e.g.advance, e.w * 0.5, 0));
    if (e.size > size) {
      size = e.size;
      main = e;
    }
  }
  return {
    text,
    glyphs: entries.map((e) => e.g).sort((a, b) => a.seq - b.seq),
    u0,
    u1,
    v: main.v,
    size,
    em: main.em,
    vis: 0,
    start: 0,
    end: 0,
    actual,
  };
}

function mergeUnits(units: Unit[], text: string): Unit {
  let main = units[0]!;
  for (const u of units) if (u.size > main.size) main = u;
  return {
    text,
    glyphs: units.flatMap((u) => u.glyphs).sort((a, b) => a.seq - b.seq),
    u0: Math.min(...units.map((u) => u.u0)),
    u1: Math.max(...units.map((u) => u.u1)),
    v: main.v,
    size: main.size,
    em: main.em,
    vis: 0,
    start: 0,
    end: 0,
    actual: units.some((u) => u.actual),
  };
}

const textOfGlyphs = (glyphs: Glyph[]) => {
  // marks follow their base, the second half of a ligature follows the first wherever it was written
  const rank = (g: Glyph) => (tails.has(g) ? 1 : isMarkOnly(g.unicode || "x") ? 2 : 0);
  const ordered = glyphs.slice().sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
  return ordered.map((g) => (g.unicode ? normalizeGlyphText(g.unicode) : g.filler ? "" : "\uFFFD")).join("");
};

function visualUnits(segment: Segment, spanCount: Map<MarkedContent, number>): Unit[] {
  // base glyphs each start a cluster, zero width marks join their neighbour
  const bases: Entry[] = [];
  const marks: Entry[] = [];
  for (const e of segment.entries) (isMark(e.g) && !isBlank(e.g) ? marks : bases).push(e);
  if (!bases.length) bases.push(...marks.splice(0));
  bases.sort((a, b) => a.u + a.w / 2 - (b.u + b.w / 2) || a.g.seq - b.g.seq);
  const clusters: Entry[][] = bases.map((b) => [b]);
  const bySeq = new Map<number, number>();
  clusters.forEach((c, i) => bySeq.set(c[0]!.g.seq, i));
  marks.sort((a, b) => a.g.seq - b.g.seq);
  /** marks sitting on a cluster of another ActualText span: they read after it but are not part of it */
  const followers = new Map<Entry[], Entry[]>();
  for (const m of marks) {
    const carrier = tails.get(m.g);
    const home = carrier ? clusters.findIndex((c) => c[0]!.g === carrier) : -1;
    if (home >= 0) {
      clusters[home]!.push(m);
      bySeq.set(m.g.seq, home);
      continue;
    }
    let best = -1;
    let score = Infinity;
    let other = -1;
    let otherScore = Infinity;
    const consider = (i: number | undefined, bonus: number) => {
      if (i === undefined) return;
      const b = clusters[i]![0]!;
      if (isBlank(b.g)) return;
      const du = m.u < b.u ? b.u - m.u : m.u > b.u + b.w ? m.u - b.u - b.w : 0;
      const centre = Math.abs(m.u + m.w / 2 - (b.u + b.w / 2));
      const s = du * 4 + centre * 0.2 - bonus * m.size;
      if (b.g.actual !== m.g.actual) {
        if (s < otherScore) {
          otherScore = s;
          other = i;
        }
      } else if (s < score) {
        score = s;
        best = i;
      }
    };
    for (let d = 1; d <= 3; d++) {
      consider(bySeq.get(m.g.seq - d), 0.5 / d);
      consider(bySeq.get(m.g.seq + d), 0.4 / d);
    }
    // nearest by position
    let lo = 0;
    let hi = bases.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bases[mid]!.u + bases[mid]!.w < m.u) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 2; i <= lo + 2; i++) if (clusters[i]) consider(i, 0);
    if (!m.g.actual && other >= 0 && otherScore < score) {
      const host = clusters[other]!;
      followers.set(host, [...(followers.get(host) ?? []), m]);
    } else if (best >= 0) {
      clusters[best]!.push(m);
      bySeq.set(m.g.seq, best);
    } else clusters.push([m]);
  }

  // ActualText spans become single units
  let units: Unit[] = [];
  const spans = new Map<MarkedContent, Entry[][]>();
  const order: (Entry[] | MarkedContent)[] = [];
  const inLine = new Map<MarkedContent, number>();
  for (const e of segment.entries) if (e.g.actual) inLine.set(e.g.actual, (inLine.get(e.g.actual) ?? 0) + 1);
  const whole = (m: MarkedContent) => (inLine.get(m) ?? 0) >= (spanCount.get(m) ?? 0);
  // a zero width letter comes before whatever starts at the same place
  clusters.sort((a, b) =>
    Math.abs(a[0]!.u - b[0]!.u) < 0.05 ? a[0]!.w - b[0]!.w || a[0]!.g.seq - b[0]!.g.seq : a[0]!.u - b[0]!.u,
  );
  for (const c of clusters) {
    const span = c.find((e) => e.g.actual)?.g.actual;
    if (span && whole(span)) {
      let list = spans.get(span);
      if (!list) {
        spans.set(span, (list = []));
        order.push(span);
      }
      list.push(c);
    } else order.push(c);
  }
  const trailing = (unit: Unit, cluster: Entry[]) => {
    const extra = followers.get(cluster);
    if (!extra) return unit;
    const text = unit.text + textOfGlyphs(extra.map((e) => e.g));
    return mergeUnits([unit, unitOf(extra, "", false)], text);
  };
  for (const item of order) {
    if (Array.isArray(item)) units.push(trailing(unitOf(item, textOfGlyphs(item.map((e) => e.g)), false), item));
    else {
      const list = spans.get(item)!;
      const made = spanUnits(item.actualText!, list);
      for (const cluster of list) {
        if (!followers.has(cluster)) continue;
        const at = made.findIndex((u) => u.glyphs.includes(cluster[0]!.g));
        if (at >= 0) made[at] = trailing(made[at]!, cluster);
      }
      units.push(...made);
    }
  }
  units = units.sort(leftToRight);
  // glyphs without text of their own travel with their neighbour
  for (let i = 0; i < units.length && units.length > 1; i++) {
    if (units[i]!.text) continue;
    const j = i ? i - 1 : 1;
    const into = units[j]!;
    units.splice(Math.min(i, j), 2, mergeUnits([into, units[i]!], into.text));
    i = Math.min(i, j) - 1;
  }
  return units;
}

/** by position; where two clusters start at the same spot the narrower one (a zero width letter) comes first */
function leftToRight(a: Unit, b: Unit): number {
  return Math.abs(a.u0 - b.u0) < Math.max(0.05, 0.012 * Math.min(a.size, b.size)) ? a.u1 - a.u0 - (b.u1 - b.u0) : a.u0 - b.u0;
}

/** distribute the replacement text of a (possibly large) ActualText span over its glyph clusters */
function spanUnits(actual: string, clusters: Entry[][]): Unit[] {
  const text = actual.normalize("NFC");
  const all = () => [unitOf(clusters.flat(), text, true)];
  if (clusters.length <= 6) return all();
  const own = clusters.map((c) => unitOf(c, textOfGlyphs(c.map((e) => e.g)), false)).sort(leftToRight);
  const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, "");
  const joined = squash(own.map((u) => u.text).join(""));
  const reversed = squash(own.slice().reverse().map((u) => u.text).join(""));
  if (joined === squash(text) || reversed === squash(text)) return own;
  // match word for word using the blank glyphs and gaps
  const words = text.split(/\s+/).filter(Boolean);
  const groups: Unit[][] = [[]];
  let end = -Infinity;
  for (const u of own) {
    if (!u.text.trim()) {
      if (groups[groups.length - 1]!.length) groups.push([]);
      continue;
    }
    if (u.u0 - end > 0.17 * u.em && groups[groups.length - 1]!.length) groups.push([]);
    groups[groups.length - 1]!.push(u);
    end = u.u1;
  }
  const filled = groups.filter((g) => g.length);
  if (words.length > 1 && filled.length === words.length) {
    const rtl = /[\u0590-\u08FF]/.test(text);
    const out: Unit[] = filled.map((g, i) => ({ ...mergeUnits(g, words[rtl ? words.length - 1 - i : i]!), actual: true }));
    for (const u of own) if (!u.text.trim()) out.push(u);
    return out;
  }
  return all();
}

function withSpaces(units: Unit[]): Unit[] {
  const gaps: number[] = [];
  for (let i = 1; i < units.length; i++) {
    const a = units[i - 1]!;
    const b = units[i]!;
    if (a.text.trim() && b.text.trim()) gaps.push((b.u0 - a.u1) / Math.max(a.em, b.em));
  }
  gaps.sort((a, b) => a - b);
  // tracked-out headings have a wide gap between every letter. In a short word that shows only when the
  // gaps are all alike and nothing in it is a real space
  const even =
    (gaps.length === 3 || (gaps.length === 2 && gaps[1]! < 0.3)) && gaps.at(-1)! - gaps[0]! < 0.04 && units.every((u) => u.text.trim());
  const typical = gaps.length > 3 || even ? Math.min(0.6, Math.max(0, gaps[Math.floor(gaps.length * 0.4)]!)) : 0;
  const out: Unit[] = [];
  for (let i = 0; i < units.length; i++) {
    const b = units[i]!;
    const a = out[out.length - 1];
    if (a && a.text.trim() && b.text.trim()) {
      const em = Math.min(a.em, b.em) < 0.8 * Math.max(a.em, b.em) ? Math.min(a.em, b.em) : Math.max(a.em, b.em);
      const gap = b.u0 - a.u1;
      const wide = (CJK.test(a.text) && CJK.test(b.text)) || (NOSPACE_SCRIPT.test(a.text) && NOSPACE_SCRIPT.test(b.text));
      const limit = wide ? Math.max(0.5, typical + 0.3) : typical + 0.16;
      if (gap > limit * em)
        out.push({ text: " ", glyphs: [], u0: a.u1, u1: b.u0, v: a.v, size: a.size, em: a.em, vis: 0, start: 0, end: 0, actual: false });
    }
    out.push(b);
  }
  return out;
}

const NEEDS_REORDER = /[\u0900-\u0DFF\u1000-\u109F\u1780-\u17FF]/;

function buildLine(
  page: number,
  segment: Segment,
  ex: Point,
  ey: Point,
  angle: number,
  shadows: Map<Glyph, Glyph[]>,
  spanCount: Map<MarkedContent, number>,
  prior: boolean,
  typingOrder: (entries: Entry[]) => boolean,
  starts: LineStart[],
): LineModel | null {
  const padding: Glyph[] = [];
  const typed = typingOrder(segment.entries);
  let units = typed ? typedUnits(segment) : visualUnits(segment, spanCount);
  // a space printed on top of letters (the end of a paragraph in right to left documents) separates nothing
  const inked = units.filter((u) => u.text.trim());
  units = units.filter((u) => {
    if (u.text.trim() || u.actual || !u.glyphs.length) return true;
    const width = u.u1 - u.u0;
    const buried = (o: Unit) =>
      width < 0.1 ? u.u0 > o.u0 && u.u0 < o.u1 : Math.min(u.u1, o.u1) - Math.max(u.u0, o.u0) > 0.75 * width;
    if (!inked.some(buried)) return true;
    padding.push(...u.glyphs);
    return false;
  });
  // in typing order words are separated by real spaces, and gaps inside a word are only placement
  if (!typed) units = withSpaces(units);
  const blank = (u: Unit) => !u.text.trim() && !u.actual;
  while (units.length && blank(units[0]!)) padding.push(...units.shift()!.glyphs);
  while (units.length && blank(units[units.length - 1]!)) padding.push(...units.pop()!.glyphs);
  if (!units.length) return null;

  if (!typed && units.some((u) => NEEDS_REORDER.test(u.text))) {
    units = reorderIndic(units.map((u) => ({ text: u.text, actual: u.actual }))).map((g) =>
      g.members.length === 1 ? { ...units[g.members[0]!]!, text: g.text } : mergeUnits(g.members.map((i) => units[i]!), g.text),
    );
  }
  // an edited line keeps the direction it was written in
  const known = starts.length
    ? starts.find(
        (s) => s[5] !== undefined && segment.entries.some((e) => Math.abs(e.g.origin[0] - s[0]) < 0.25 && Math.abs(e.g.origin[1] - s[1]) < 0.25),
      )?.[5]
    : undefined;
  return assemble(page, units, padding, segment, ex, ey, angle, shadows, prior, known);
}

/**
 * Units of a line whose content order is the typing order: shaped scripts are read in that order and
 * cut into words (positions inside a word say nothing about its letters), everything else stays single.
 */
function typedUnits(segment: Segment): Unit[] {
  const entries = segment.entries.slice().sort((a, b) => a.g.seq - b.g.seq);
  // a replacement string (text this editor added) stands for all its glyphs; a "space" without any
  // width is a piece of a split character, not a space
  const said = new Set<MarkedContent>();
  const texts = entries.map((e) => {
    const mark = e.g.actual;
    if (mark) {
      if (said.has(mark)) return "";
      said.add(mark);
      return mark.actualText!.normalize("NFC");
    }
    return isBlank(e.g) ? (e.w < 0.05 * e.size ? "" : " ") : textOfGlyphs([e.g]);
  });
  const cuts = new Set<number>();
  for (const word of new Intl.Segmenter(undefined, { granularity: "word" }).segment(texts.join(""))) cuts.add(word.index);
  const groups: { entries: Entry[]; text: string }[] = [];
  let at = 0;
  entries.forEach((e, i) => {
    const text = texts[i]!;
    const last = groups[groups.length - 1];
    const before = entries[i - 1];
    const joins =
      last &&
      before &&
      (!text ||
        (!cuts.has(at) && SHAPED.test(text) && SHAPED.test(last.text) && Math.abs(e.u - (before.u + before.w)) < 1.8 * e.size));
    if (joins) {
      last.entries.push(e);
      last.text += text;
    } else groups.push({ entries: [e], text });
    at += text.length;
  });
  return groups.map((g) => unitOf(g.entries, g.text, false));
}

/** order the clusters logically and describe the line they form */
function assemble(
  page: number,
  units: Unit[],
  padding: Glyph[],
  segment: Segment,
  ex: Point,
  ey: Point,
  angle: number,
  shadows: Map<Glyph, Glyph[]>,
  prior?: boolean,
  known?: boolean,
): LineModel | null {
  units.forEach((u, i) => (u.vis = i));
  const visual = units.slice();
  const order = visualToLogical(
    visual.map((u) => ({ text: u.text, actual: u.actual })),
    prior,
    known,
  );
  for (const [i, t] of order.mirrored) visual[i]!.text = t;
  let logical = order.order.map((i) => visual[i]!);

  // characters that compose across units (base and a separately drawn accent) become one unit
  for (let i = 0; i + 1 < logical.length; i++) {
    const a = logical[i]!;
    const b = logical[i + 1]!;
    const second = b.text.charCodeAt(0);
    if (second < 0x300) continue;
    const joined = (a.text + b.text).normalize("NFC");
    if (joined !== a.text.normalize("NFC") + b.text.normalize("NFC")) {
      const m = mergeUnits([a, b], joined);
      m.vis = Math.min(a.vis, b.vis);
      logical.splice(i, 2, m);
      i--;
    }
  }
  const visualFinal = logical.slice().sort((a, b) => a.vis - b.vis);
  visualFinal.forEach((u, i) => (u.vis = i));

  let text = "";
  for (const u of logical) {
    u.text = u.text.normalize("NFC");
    u.start = text.length;
    text += u.text;
    u.end = text.length;
  }
  if (!text.trim()) return null;

  const u0 = Math.min(...visualFinal.map((u) => u.u0));
  const u1 = Math.max(...visualFinal.map((u) => u.u1));
  const baseline = segment.v;

  // styles and spans
  const spans: TextSpan[] = [];
  const weight = new Map<string, { n: number; style: TextStyle }>();
  let last: { key: string; style: TextStyle } | null = null;
  let ascent = 0;
  let descent = 0;
  for (const u of logical) {
    const g = u.glyphs[0];
    let current: { key: string; style: TextStyle } | null = last;
    if (g) {
      const style = styleOf(g);
      const key = `${style.family}|${style.bold}|${style.italic}|${style.size.toFixed(1)}|${style.color.map((c) => c.toFixed(2))}|${style.letterSpacing ?? 0}`;
      current = { key, style };
      const lift = baseline - u.v;
      // vertical writing is centred on its baseline
      const upright = g.show.font.vertical;
      ascent = Math.max(ascent, (upright ? 0.5 : g.show.font.ascent) * g.size + lift);
      descent = Math.max(descent, (upright ? 0.5 : -g.show.font.descent) * g.size - lift);
      let w = weight.get(key);
      if (!w) weight.set(key, (w = { n: 0, style }));
      w.n += u.text.trim().length;
    }
    if (!current) {
      const first = logical.find((x) => x.glyphs.length)?.glyphs[0];
      if (!first) return null;
      current = { key: "", style: styleOf(first) };
    }
    const span = spans[spans.length - 1];
    if (span && last && current.key === last.key) span.end = u.end;
    else spans.push({ start: u.start, end: u.end, style: current.style });
    last = current;
  }
  let dominant = spans[0]!.style;
  let heaviest = -1;
  for (const w of weight.values())
    if (w.n > heaviest) {
      heaviest = w.n;
      dominant = w.style;
    }

  const p = (u: number, v: number) => fromFrame(u, v, ex, ey);
  // wide character spacing after the last letter is not part of what is seen
  const end = visualFinal[visualFinal.length - 1]!.glyphs.at(-1);
  const trailing = end && spacingOf(end) > 0.1 * end.size ? spacingOf(end) : 0;
  const quad: Quad = [
    ...p(u0, baseline - ascent),
    ...p(u1 - trailing, baseline - ascent),
    ...p(u0, baseline + descent),
    ...p(u1 - trailing, baseline + descent),
  ] as Quad;
  const vertical = !!units[0]!.glyphs[0]?.show.font.vertical;

  const fonts = new Set(logical.flatMap((u) => u.glyphs.map((g) => g.show.font)));
  const chars = text.replace(/\s/g, "").length;
  const bad = countBadChars(text);
  let note: string | undefined;
  let editable = true;
  const legacy = [...fonts].some((f) => isLegacyFont(f.name)) && !/[\u0900-\u0DFF]/.test(text);
  const invalid = invalidIndicSequences(text);
  if (legacy) note = "This line uses a legacy font encoding, so its letters cannot be read directly. Recognise the page (OCR) to edit it.";
  else if (bad > 0 && (bad >= chars * 0.5 || (bad >= 3 && bad > chars * 0.2)))
    note = "The text encoding of this line is broken. Recognise the page (OCR) to edit it.";
  else if (invalid >= 2 && invalid * 8 > chars) note = "The letters of this line are mapped wrongly in the file. Recognise the page (OCR) to edit it.";
  if (segment.long) note = "This line is too long to edit directly.";
  if (note) editable = false;

  // CSS letter-spacing and the like move every glyph individually: new text must be spaced the same way
  const tracking = trackingOf(visualFinal, ex, ey);
  if (tracking) {
    const spaced = (s: TextStyle): TextStyle => ({ ...s, letterSpacing: Math.round(((s.letterSpacing ?? 0) + tracking * s.size) * 100) / 100 });
    dominant = spaced(dominant);
    for (const span of spans) span.style = spaced(span.style);
  }

  const line: TextLine = {
    id: "",
    page,
    text,
    quad,
    rect: quadToRect(quad),
    origin: p(u0, baseline),
    angle,
    dir: order.rtl ? "rtl" : "ltr",
    style: dominant,
    spans,
    align: order.rtl ? "right" : "left",
    source: "content",
    editable,
    note,
  };
  const lineShadows = new Map<Glyph, Glyph[]>();
  if (shadows.size) for (const u of logical) for (const g of u.glyphs) if (shadows.has(g)) lineShadows.set(g, shadows.get(g)!);
  for (const g of padding) if (shadows.has(g)) lineShadows.set(g, shadows.get(g)!);

  return {
    line,
    units: logical,
    visual: visualFinal,
    ex,
    ey,
    baseline,
    u0,
    u1,
    size: segment.size,
    rtl: order.rtl,
    vertical,
    padding,
    shadows: lineShadows,
    rules: [],
    block: { left: u0, right: u1 },
    tracking,
    tooLong: segment.long,
  };
}

/** the same extra distance between (nearly) all neighbouring glyphs of a line, in ems; 0 when there is none */
function trackingOf(visual: Unit[], ex: Point, ey: Point): number {
  const extra: number[] = [];
  const along = (g: Glyph) => toFrame(g.origin, ex, ey)[0];
  /** the glyph before, while no blank or complex script lies between */
  let before: Glyph | null = null;
  for (const unit of visual) {
    if (!unit.text.trim() || isComplex(unit.text) || (unit.glyphs.length > 1 && !unit.actual)) {
      before = null;
      continue;
    }
    // a replacement string (text this editor drew) covers its letters one by one
    const own = unit.glyphs.length > 1 ? unit.glyphs.slice().sort((a, b) => along(a) - along(b)) : unit.glyphs;
    for (const y of own) {
      const x = before;
      before = y;
      if (!x || x.show.font !== y.show.font || Math.abs(x.size - y.size) > 0.01 || x.show.font.vertical) continue;
      extra.push((along(y) - along(x) - Math.abs(x.advance)) / (x.size || 1));
    }
  }
  if (extra.length < 3) return 0;
  const median = extra.slice().sort((a, b) => a - b)[extra.length >> 1]!;
  // kerning and rounding stay well below this
  if (Math.abs(median) < 0.022 || Math.abs(median) > 1.2) return 0;
  const agreeing = extra.filter((e) => Math.abs(e - median) < 0.018).length;
  return agreeing >= 0.7 * extra.length ? median : 0;
}

export function styleOf(g: Glyph): TextStyle {
  const font = g.show.font;
  const m = g.tm;
  const c = g.show.ctm;
  // shear between the glyph's x and y axes marks synthetic italics
  const x = [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3]];
  const y = [m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3]];
  const cos = (x[0]! * y[0]! + x[1]! * y[1]!) / (Math.hypot(x[0]!, x[1]!) * Math.hypot(y[0]!, y[1]!) || 1);
  const spacing = g.show.tc * g.show.th * g.unit;
  const mode = g.show.tr % 4;
  const style: TextStyle = {
    family: font.name,
    bold: font.flags.bold || (mode === 2 && sameColor(g)),
    italic: font.flags.italic || Math.abs(cos) > 0.12,
    serif: font.flags.serif,
    mono: font.flags.mono,
    size: Math.round(g.size * 100) / 100,
    color: glyphColor(g),
  };
  if (Math.abs(spacing) > 0.05) style.letterSpacing = Math.round(spacing * 100) / 100;
  return style;
}

function sameColor(g: Glyph): boolean {
  const a = g.show.fill.space.toRGB(g.show.fill.comps);
  const b = g.show.stroke.space.toRGB(g.show.stroke.comps);
  return a.every((v, i) => Math.abs(v - b[i]!) < 0.05);
}

function attachRules(models: LineModel[], rules: Decoration[]) {
  if (!rules.length) return;
  for (const m of models) {
    for (const r of rules) {
      const a = toFrame(r.a, m.ex, m.ey);
      const b = toFrame(r.b, m.ex, m.ey);
      if (Math.abs(a[1] - b[1]) > 0.5) continue;
      const dv = (a[1] + b[1]) / 2 - m.baseline;
      const em = m.size;
      const underline = dv > 0.01 * em && dv < 0.36 * em;
      const strike = dv > -0.45 * em && dv < -0.15 * em;
      if (!(underline || strike) || r.thickness > 0.16 * em + 0.6) continue;
      const from = Math.min(a[0], b[0]);
      const to = Math.max(a[0], b[0]);
      // a rule reaching well beyond the text is a border or separator
      if (from < m.u0 - 0.4 * em || to > m.u1 + 0.4 * em || to - from < 0.4 * em) continue;
      const covered = m.units.filter((u) => {
        const c = (u.u0 + u.u1) / 2;
        return c > from && c < to;
      });
      if (!covered.length) continue;
      const first = Math.min(...covered.map((u) => u.u0));
      const end = Math.max(...covered.map((u) => u.u1));
      m.rules.push({ decoration: r, kind: underline ? "underline" : "strike", units: covered, before: first - from, after: to - end });
      if (underline) {
        for (const span of m.line.spans) {
          const inside = covered.filter((u) => u.start >= span.start && u.end <= span.end).reduce((n, u) => n + u.text.length, 0);
          if (inside * 2 > span.end - span.start) span.style = { ...span.style, underline: true };
        }
        if (to - from > 0.6 * (m.u1 - m.u0)) m.line.style = { ...m.line.style, underline: true };
      }
    }
  }
}

/**
 * Lines of the same length whose word gaps are all the same ordinary width were not justified: they only
 * happen to be equally long (numbered entries, repeated sentences). Justifying stretches every line by a
 * different amount.
 */
function evenlySet(lines: LineModel[]): boolean {
  let least = Infinity;
  let most = -Infinity;
  let counted = 0;
  for (const m of lines) {
    let end: number | null = null;
    let gap = false;
    for (const unit of m.visual) {
      if (!unit.text.trim()) {
        gap = true;
        continue;
      }
      if (gap && end !== null) {
        const width = (unit.u0 - end) / m.size;
        least = Math.min(least, width);
        most = Math.max(most, width);
        counted++;
      }
      gap = false;
      end = unit.u1;
    }
  }
  return lines.length >= 2 && counted >= 3 * lines.length && most - least < 0.025 && most < 0.4 && least > 0.1;
}

function detectAlignment(models: LineModel[], interp: Interpretation) {
  const [px0, , px1] = interp.pageRect;
  /** the narrowest left margin of the page */
  let margin: number | undefined;
  const sorted = models.slice().sort((a, b) => a.baseline - b.baseline);
  const similar = (a: LineModel, b: LineModel) =>
    Math.abs(a.line.angle - b.line.angle) < 0.02 && Math.max(a.size, b.size) < 1.3 * Math.min(a.size, b.size);
  const overlap = (a: LineModel, b: LineModel) => Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
  const parent = new Map<LineModel, LineModel>();
  const find = (m: LineModel): LineModel => {
    let r = m;
    while (parent.has(r)) r = parent.get(r)!;
    if (r !== m) parent.set(m, r);
    return r;
  };
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length && j - i < NEIGHBOURS; j++) {
      const b = sorted[j]!;
      const dv = b.baseline - a.baseline;
      if (dv > 2.4 * a.size) break;
      if (dv < 0.5 * a.size || !similar(a, b) || overlap(a, b) <= 0) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const blocks = new Map<LineModel, LineModel[]>();
  for (const m of sorted) {
    const r = find(m);
    let list = blocks.get(r);
    if (!list) blocks.set(r, (list = []));
    list.push(m);
  }
  const numeric = /^[\s$\u20AC\u00A3\u20B9(\-+]*[\p{Nd}][\p{Nd}.,\s]*[%)]?$/u;
  const paragraphs: LineModel[][] = [];
  for (const list of blocks.values()) {
    // a wider gap than the usual line spacing starts a new paragraph
    let min = Infinity;
    for (let i = 1; i < list.length; i++) min = Math.min(min, list[i]!.baseline - list[i - 1]!.baseline);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i === list.length || list[i]!.baseline - list[i - 1]!.baseline > 1.4 * min) {
        paragraphs.push(list.slice(start, i));
        start = i;
      }
    }
  }
  for (const list of paragraphs) {
    const left = Math.min(...list.map((m) => m.u0));
    const right = Math.max(...list.map((m) => m.u1));
    const tol = (m: LineModel) => Math.max(1.2, 0.14 * m.size);
    const full = list.filter((m) => Math.abs(m.u0 - left) < tol(m) && Math.abs(m.u1 - right) < tol(m)).length;
    /** decided once per paragraph */
    let unstretched: boolean | undefined;
    for (const m of list) {
      m.block = { left, right };
      let l = 0;
      let r = 0;
      let c = 0;
      for (const o of list) {
        if (o === m) continue;
        if (Math.abs(o.u0 - m.u0) < tol(m)) l++;
        if (Math.abs(o.u1 - m.u1) < tol(m)) r++;
        if (Math.abs(o.u0 + o.u1 - m.u0 - m.u1) < 2 * tol(m)) c++;
      }
      let align: Align | null = null;
      // a menu or list whose entries happen to be equally long is not a justified paragraph
      if (list.length >= 3 && full >= 2 && full >= list.length - 2 && right - left > 9 * m.size && Math.abs(m.u0 - left) < tol(m) && Math.abs(m.u1 - right) < tol(m) && !(unstretched ??= evenlySet(list.filter((o) => Math.abs(o.u0 - left) < tol(o) && Math.abs(o.u1 - right) < tol(o)))))
        align = "justify";
      // right to left text lines up on the right; a single shared left edge is more likely chance
      else if (m.rtl && r && r + 1 >= l) align = "right";
      else if (l && l >= r && !(m.rtl && l < 2)) align = "left";
      else if (r) align = "right";
      else if (c) align = "center";
      else if (l && !(m.rtl && l < 2)) align = "left";
      // first line of an indented paragraph
      else if (list.length >= 3 && Math.abs(m.u1 - right) < tol(m) && full >= 1) align = "left";
      m.line.align = align ?? alone(m);
    }
  }
  // columns of figures are usually spaced further apart than text lines
  const edges = (side: "u0" | "u1") => {
    const map = new Map<number, LineModel[]>();
    for (const m of sorted) {
      const k = Math.round(m[side]);
      let list = map.get(k);
      if (!list) map.set(k, (list = []));
      if (list.length < NEIGHBOURS) list.push(m);
    }
    /** lines sharing this edge of `m` but not the other one: they show which side the column holds to */
    return (m: LineModel) => {
      const other = side === "u0" ? "u1" : "u0";
      let n = 0;
      for (const d of [-1, 0, 1])
        for (const o of map.get(Math.round(m[side]) + d) ?? [])
          if (o !== m && Math.abs(o[side] - m[side]) < 0.6 && Math.abs(o[other] - m[other]) > 1 && Math.abs(o.line.angle - m.line.angle) < 0.02) n++;
      return n;
    };
  };
  const ragged = { left: edges("u0"), right: edges("u1") };
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    // a lone dash stands for "nothing" in a column of figures
    if (!numeric.test(m.line.text) && !/^\s*[-–—]\s*$/.test(m.line.text)) continue;
    let r = 0;
    let l = 0;
    for (const step of [-1, 1])
      for (let j = i + step; j >= 0 && j < sorted.length && Math.abs(j - i) < NEIGHBOURS; j += step) {
        const o = sorted[j]!;
        if (Math.abs(o.baseline - m.baseline) > 8 * m.size) break;
        if (Math.abs(o.line.angle - m.line.angle) > 0.02) continue;
        if (Math.abs(o.u1 - m.u1) < 1) r++;
        if (Math.abs(o.u0 - m.u0) < 1) l++;
      }
    // figures of one width line up on both sides: look further for lines that settle it
    if (r > l || (r > 0 && r === l && ragged.right(m) > ragged.left(m))) m.line.align = "right";
  }

  // two neighbouring long lines that end flush on both sides are justified, even when the paragraph
  // detection lumped them together with the single lines around them
  const long = (m: LineModel) => m.u1 - m.u0 > 16 * m.size && m.units.filter((u) => !u.text.trim()).length >= 3;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (!long(a)) continue;
    for (let j = i + 1; j < sorted.length && j - i < NEIGHBOURS; j++) {
      const b = sorted[j]!;
      const dv = b.baseline - a.baseline;
      if (dv > 2.4 * a.size) break;
      const flush = Math.max(0.8, 0.08 * a.size);
      if (dv < 0.7 * a.size || !similar(a, b) || !long(b) || Math.abs(a.u0 - b.u0) > flush || Math.abs(a.u1 - b.u1) > flush) continue;
      if (evenlySet([a, b])) continue;
      a.line.align = b.line.align = "justify";
      a.block = b.block = { left: Math.min(a.u0, b.u0), right: Math.max(a.u1, b.u1) };
    }
  }

  // the indented first line of a justified paragraph is justified too: it shares only the right edge
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (a.line.align === "justify" || a.units.filter((u) => !u.text.trim()).length < 3) continue;
    for (let j = i + 1; j < sorted.length && j - i < NEIGHBOURS; j++) {
      const b = sorted[j]!;
      const dv = b.baseline - a.baseline;
      if (dv > 2.4 * a.size) break;
      const flush = Math.max(0.8, 0.08 * a.size);
      const indent = a.u0 - b.u0;
      if (dv < 0.7 * a.size || b.line.align !== "justify" || !similar(a, b) || Math.abs(a.u1 - b.u1) > flush || indent < 0.5 * a.size || indent > 5 * a.size) continue;
      a.line.align = "justify";
      a.block = { left: a.u0, right: b.u1 };
      break;
    }
  }

  function mirrored(m: LineModel): boolean {
    if (margin === undefined) {
      margin = Infinity;
      for (const o of models) if (Math.abs(o.line.angle) < 0.01) margin = Math.min(margin, o.u0 - px0);
    }
    return margin > 12 && Math.abs(px1 - m.u1 - margin) < 1.5;
  }

  function alone(m: LineModel): Align {
    if (Math.abs(m.line.angle) < 0.01) {
      const centre = m.line.origin[0] + (m.u1 - m.u0) / 2;
      if (Math.abs(centre - (px0 + px1) / 2) < 2 && m.line.origin[0] - px0 > 0.12 * (px1 - px0)) return "center";
      // a short line pushed against the margin where other lines end is right aligned
      if (!m.rtl && m.u0 > px0 + 0.45 * (px1 - px0) && models.length < 2000) {
        const level = models.filter((o) => o !== m && Math.abs(o.line.angle) < 0.01);
        const ending = level.filter((o) => Math.abs(o.u1 - m.u1) < 0.8).length;
        // headers and footers: even one other line, or the page's own margin mirrored, says as much
        if ((ending >= 2 || mirrored(m)) && !level.some((o) => Math.abs(o.u0 - m.u0) < 1.5)) return "right";
      }
    }
    return m.rtl ? "right" : "left";
  }
}
