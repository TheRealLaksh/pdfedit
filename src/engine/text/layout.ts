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
}

export const toFrame = (p: Point, ex: Point, ey: Point): Point => [p[0] * ex[0] + p[1] * ex[1], p[0] * ey[0] + p[1] * ey[1]];
export const fromFrame = (u: number, v: number, ex: Point, ey: Point): Point => [u * ex[0] + v * ey[0], u * ex[1] + v * ey[1]];

const isBlank = (g: Glyph) => !g.actual && g.unicode !== "" && g.unicode.trim() === "";
const isMark = (g: Glyph) =>
  !/^.\u094D$|^.\u09CD$|^.\u0ACD$|^.\u0B4D$/.test(g.unicode) &&
  // zero width letters (the second half of a split ligature) keep their own place in the order
  ((Math.abs(g.w) < 0.06 && !/\p{L}/u.test(g.unicode)) || (g.unicode !== "" && isMarkOnly(g.unicode) && Math.abs(g.w) < 0.35));
const emOf = (g: Glyph) => g.unit * Math.abs(g.show.size * g.show.th * g.show.font.emScale) || g.size || 1;

export function buildLines(page: number, interp: Interpretation, glyphs: Glyph[]): LineModel[] {
  const models: LineModel[] = [];
  const spanCount = new Map<MarkedContent, number>();
  for (const g of interp.glyphs) if (g.actual) spanCount.set(g.actual, (spanCount.get(g.actual) ?? 0) + 1);

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
    entries = removeShadows(entries, shadows);
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
    for (const segment of segments(entries, interp, ex, ey)) {
      const model = buildLine(page, segment, ex, ey, angle, shadows, spanCount, prior);
      if (model) models.push(model);
    }
  }
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
function removeShadows(entries: Entry[], shadows: Map<Glyph, Glyph[]>): Entry[] {
  const grid = new Map<string, Entry[]>();
  const dropped = new Set<Entry>();
  for (const e of entries) {
    const cell = (du: number, dv: number) => `${Math.round(e.u / 4) + du},${Math.round(e.v / 4) + dv}`;
    let twin: Entry | null = null;
    for (let du = -1; du <= 1 && !twin; du++)
      for (let dv = -1; dv <= 1 && !twin; dv++)
        for (const o of grid.get(cell(du, dv)) ?? []) {
          if (
            !dropped.has(o) &&
            o.g.code.code === e.g.code.code &&
            o.g.show.font === e.g.show.font &&
            o.g.show !== e.g.show &&
            Math.abs(o.size - e.size) < 0.08 * e.size &&
            Math.abs(o.u - e.u) < 0.11 * e.size &&
            Math.abs(o.v - e.v) < 0.11 * e.size &&
            Math.abs(o.w - e.w) < 0.15 * e.size
          ) {
            twin = o;
            break;
          }
        }
    if (twin) {
      dropped.add(twin);
      shadows.set(e.g, [twin.g, ...(shadows.get(twin.g) ?? [])]);
      shadows.delete(twin.g);
    }
    const key = cell(0, 0);
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(e);
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
    if (eastAsian >= 3 && eastAsian * 2 > column.length) out.push(column);
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

function segments(entries: Entry[], interp: Interpretation, ex: Point, ey: Point): Segment[] {
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
  const walls: { u: number; v0: number; v1: number }[] = [];
  for (const r of interp.rules) {
    const a = toFrame(r.a, ex, ey);
    const b = toFrame(r.b, ex, ey);
    if (Math.abs(a[0] - b[0]) < 1.5 && Math.abs(a[1] - b[1]) > 6) walls.push({ u: (a[0] + b[0]) / 2, v0: Math.min(a[1], b[1]), v1: Math.max(a[1], b[1]) });
  }

  const out: Segment[] = [];
  for (const r of rows) {
    r.sort((a, b) => a.u - b.u || a.g.seq - b.g.seq);
    // two unrelated texts printed over each other stay separate
    const layers: { entries: Entry[]; end: number; last: Entry | null }[] = [];
    for (const e of r) {
      let layer = layers.find((l) => {
        const last = l.last;
        if (!last) return true;
        const overlap = Math.min(l.end, e.u + e.w) - e.u;
        return !(
          overlap > 0.7 * Math.min(e.w, last.w) &&
          e.w > 0.25 * e.em &&
          last.w > 0.25 * last.em &&
          Math.abs(e.g.seq - last.g.seq) > 3 &&
          e.g.show !== last.g.show &&
          !e.g.actual
        );
      });
      if (!layer) layers.push((layer = { entries: [], end: -Infinity, last: null }));
      layer.entries.push(e);
      if (!isBlank(e.g)) {
        layer.end = Math.max(layer.end, e.u + e.w);
        layer.last = e;
      }
    }
    for (const layer of layers) {
      let seg: Entry[] = [];
      let end = -Infinity;
      let inkEnd = -Infinity;
      let spaces = 0;
      let size = 0;
      let across = 0;
      const flush = () => {
        if (seg.length) out.push(segmentOf(seg));
        seg = [];
        end = inkEnd = -Infinity;
        spaces = 0;
        size = 0;
        across = 0;
      };
      for (const e of layer.entries) {
        const blank = isBlank(e.g);
        if (seg.length) {
          const em = Math.max(e.em, across);
          const gap = e.u - end;
          if (!blank) {
            const inkGap = e.u - inkEnd;
            const wall =
              inkEnd > -Infinity &&
              walls.some((w) => w.u > inkEnd - 0.5 && w.u < e.u + 0.5 && w.v0 < e.v - 0.2 * e.size && w.v1 > e.v - 0.4 * e.size);
            const ratio = Math.max(e.size, size) / Math.max(0.1, Math.min(e.size, size));
            if (wall || gap > (spaces ? 1.6 : 1.1) * em || inkGap > 4.5 * em || (ratio > 2.2 && size > 0 && inkGap > 0.25 * em)) flush();
          }
        }
        seg.push(e);
        // a blank that jumps far ahead must not bridge the gap to the next column
        if (!blank || end === -Infinity || e.u - end < 1.1 * e.em) end = Math.max(end, e.u + Math.max(e.w, blank ? e.g.advance : 0));
        if (blank) spaces++;
        else {
          inkEnd = Math.max(inkEnd, e.u + e.w);
          spaces = 0;
          size = Math.max(size, e.size);
          across = Math.max(across, e.em);
        }
      }
      flush();
    }
  }

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
    if (small.size > 0.82 * largest) continue;
    const [a0, a1] = boxes[i]!;
    const k = position.get(i)!;
    search: for (const step of [-1, 1]) {
      for (let j = k + step; j >= 0 && j < byV.length; j += step) {
        const big = out[byV[j]!]!;
        if (Math.abs(big.v - small.v) > 3 * small.size + 40) break;
        if (big === small || merged.has(big) || small.size > 0.82 * big.size) continue;
        const dv = small.v - big.v;
        if (dv < -0.65 * big.size || dv > 0.35 * big.size) continue;
        const [b0, b1] = boxes[byV[j]!]!;
        const gap = Math.max(a0 - b1, b0 - a1);
        if (gap > 0.3 * big.size || gap < -0.5 * small.size) continue;
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
  const ordered = glyphs.slice().sort((a, b) => Number(isMarkOnly(a.unicode || "x")) - Number(isMarkOnly(b.unicode || "x")) || a.seq - b.seq);
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
  return Math.abs(a.u0 - b.u0) < 0.05 ? a.u1 - a.u0 - (b.u1 - b.u0) : a.u0 - b.u0;
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
  // tracked-out headings have a wide gap between every letter
  const typical = gaps.length > 3 ? Math.min(0.6, Math.max(0, gaps[Math.floor(gaps.length * 0.4)]!)) : 0;
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
): LineModel | null {
  let units = withSpaces(visualUnits(segment, spanCount));
  const padding: Glyph[] = [];
  const blank = (u: Unit) => !u.text.trim() && !u.actual;
  while (units.length && blank(units[0]!)) padding.push(...units.shift()!.glyphs);
  while (units.length && blank(units[units.length - 1]!)) padding.push(...units.pop()!.glyphs);
  if (!units.length) return null;

  if (units.some((u) => NEEDS_REORDER.test(u.text))) {
    units = reorderIndic(units.map((u) => ({ text: u.text, actual: u.actual }))).map((g) =>
      g.members.length === 1 ? { ...units[g.members[0]!]!, text: g.text } : mergeUnits(g.members.map((i) => units[i]!), g.text),
    );
  }
  return assemble(page, units, padding, segment, ex, ey, angle, shadows, prior);
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
): LineModel | null {
  units.forEach((u, i) => (u.vis = i));
  const visual = units.slice();
  const order = visualToLogical(
    visual.map((u) => ({ text: u.text, actual: u.actual })),
    prior,
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
  const quad: Quad = [
    ...p(u0, baseline - ascent),
    ...p(u1, baseline - ascent),
    ...p(u0, baseline + descent),
    ...p(u1, baseline + descent),
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
  if (note) editable = false;

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
  };
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

function detectAlignment(models: LineModel[], interp: Interpretation) {
  const [px0, , px1] = interp.pageRect;
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
    for (let j = i + 1; j < sorted.length; j++) {
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
      if (list.length >= 3 && full >= 2 && full >= list.length - 2 && Math.abs(m.u0 - left) < tol(m) && Math.abs(m.u1 - right) < tol(m))
        align = "justify";
      else if (l && l >= r) align = "left";
      else if (r) align = "right";
      else if (c) align = "center";
      else if (l) align = "left";
      // first line of an indented paragraph
      else if (list.length >= 3 && Math.abs(m.u1 - right) < tol(m) && full >= 1) align = "left";
      m.line.align = align ?? alone(m);
    }
  }
  // columns of figures are usually spaced further apart than text lines
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    if (!numeric.test(m.line.text)) continue;
    let r = 0;
    let l = 0;
    for (const step of [-1, 1])
      for (let j = i + step; j >= 0 && j < sorted.length; j += step) {
        const o = sorted[j]!;
        if (Math.abs(o.baseline - m.baseline) > 8 * m.size) break;
        if (Math.abs(o.line.angle - m.line.angle) > 0.02) continue;
        if (Math.abs(o.u1 - m.u1) < 1) r++;
        if (Math.abs(o.u0 - m.u0) < 1) l++;
      }
    if (r > l) m.line.align = "right";
  }

  function alone(m: LineModel): Align {
    if (Math.abs(m.line.angle) < 0.01) {
      const centre = m.line.origin[0] + (m.u1 - m.u0) / 2;
      if (Math.abs(centre - (px0 + px1) / 2) < 2 && m.line.origin[0] - px0 > 0.12 * (px1 - px0)) return "center";
    }
    return m.rtl ? "right" : "left";
  }
}
