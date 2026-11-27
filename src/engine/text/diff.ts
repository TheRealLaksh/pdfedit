/** Which glyph clusters of a line survive an edit unchanged. */
import { styleOf, type Unit } from "./layout";
import { hasRtl, isComplex, NOSPACE_SCRIPT } from "./unicode";

interface Char {
  c: number;
  at: number;
  length: number;
}

const chars = (s: string): Char[] => {
  const out: Char[] = [];
  let at = 0;
  for (const ch of s) {
    out.push({ c: ch.codePointAt(0)!, at, length: ch.length });
    at += ch.length;
  }
  return out;
};

/**
 * For every UTF-16 offset of `before`, the offset in `after` it survives at, or -1. A longest common
 * subsequence that prefers long contiguous stretches over scattered single letters.
 */
export function matchText(before: string, after: string): Int32Array {
  const a = chars(before);
  const b = chars(after);
  const map = new Int32Array(before.length).fill(-1);
  const take = (i: number, j: number) => {
    for (let k = 0; k < a[i]!.length; k++) map[a[i]!.at + k] = b[j]!.at + k;
  };
  let head = 0;
  while (head < a.length && head < b.length && a[head]!.c === b[head]!.c) take(head, head), head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail]!.c === b[b.length - 1 - tail]!.c) {
    take(a.length - 1 - tail, b.length - 1 - tail);
    tail++;
  }
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n <= 0 || m <= 0 || n * m > 6_000_000) return map;
  // two states: the previous pair matched (a run continues) or not
  const W = m + 1;
  const free = new Int32Array((n + 1) * W);
  const run = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const k = i * W + j;
      const skip = Math.max(free[k + W]!, free[k + 1]!);
      if (a[head + i]!.c === b[head + j]!.c) {
        const diagonal = run[k + W + 1]!;
        free[k] = Math.max(skip, 100 + diagonal);
        run[k] = Math.max(skip, 101 + diagonal);
      } else free[k] = run[k] = skip;
    }
  let i = 0;
  let j = 0;
  let running = false;
  while (i < n && j < m) {
    const k = i * W + j;
    const value = running ? run[k]! : free[k]!;
    if (a[head + i]!.c === b[head + j]!.c && value === (running ? 101 : 100) + run[k + W + 1]!) {
      take(head + i, head + j);
      i++;
      j++;
      running = true;
    } else {
      running = false;
      if (free[k + W]! >= free[k + 1]!) i++;
      else j++;
    }
  }
  return map;
}

const WORD = /[\p{L}\p{M}\p{N}\u200C\u200D]/u;

/** single letters that happen to match somewhere else in a rewritten word are not worth keeping */
function dropStrays(map: Int32Array, before: string, after: string): void {
  const edge = (s: string, at: number) => at <= 0 || at >= s.length || /\s/.test(s[at - 1]!) || /\s/.test(s[at]!);
  for (let i = 0; i < before.length; ) {
    if (map[i]! < 0) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < before.length && map[end] === map[i]! + (end - i)) end++;
    const from = map[i]!;
    const to = from + (end - i);
    const solid =
      end - i >= 3 || /\s/.test(before.slice(i, end)) || (edge(before, i) && edge(after, from)) || (edge(before, end) && edge(after, to));
    if (!solid) map.fill(-1, i, end);
    i = end;
  }
}

const styleKey = (u: Unit) => {
  const s = styleOf(u.glyphs[0]!);
  return `${s.bold}|${s.italic}|${s.size.toFixed(0)}|${s.color.map((c) => c.toFixed(1))}`;
};

/**
 * On a line with several styles, letters that happen to survive inside a new word would give it a
 * patchwork look: such a word keeps old glyphs only if they are most of it and all in one style.
 */
function dropMixed(keep: Set<Unit>, map: Int32Array, units: Unit[], after: string): void {
  const drawn = units.filter((u) => u.glyphs.length && u.text.trim());
  if (new Set(drawn.map(styleKey)).size < 2) return;
  for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(after)) {
    if (!part.isWordLike) continue;
    const from = part.index;
    const to = from + part.segment.length;
    const inside = drawn.filter((u) => keep.has(u) && map[u.start]! >= from && map[u.start]! < to);
    const covered = inside.reduce((n, u) => n + u.end - u.start, 0);
    // untouched words keep all their styles
    if (!inside.length || covered >= part.segment.length) continue;
    if (covered * 2 < part.segment.length || new Set(inside.map(styleKey)).size > 1) for (const u of inside) keep.delete(u);
  }
}

/** map from offset in the new text to the unit that is kept there */
export function diffUnits(units: Unit[], before: string, after: string): Map<number, { unit: Unit; length: number }> {
  const map = matchText(before, after);
  dropStrays(map, before, after);
  const intact = (start: number, end: number) => {
    if (start >= end || map[start]! < 0) return false;
    for (let i = start + 1; i < end; i++) if (map[i] !== map[start]! + (i - start)) return false;
    return true;
  };
  const keep = new Set(units.filter((u) => intact(u.start, u.end)));
  // Thai, Khmer and the like write words without spaces between them: a dictionary finds the words
  const unspaced = NOSPACE_SCRIPT.test(before) || NOSPACE_SCRIPT.test(after);
  const boundaries = (s: string) => new Set([...new Intl.Segmenter(undefined, { granularity: "word" }).segment(s)].map((w) => w.index).concat(s.length));
  const oldWords = unspaced ? boundaries(before) : null;
  const newWords = unspaced ? boundaries(after) : null;
  // scripts whose letters join or reorder are kept or replaced one whole word at a time
  let word: Unit[] = [];
  const settle = () => {
    if (!word.length) return;
    const start = word[0]!.start;
    const end = word[word.length - 1]!.end;
    const text = before.slice(start, end);
    // right to left words are also replaced whole, which keeps their glyphs in reading order
    if (isComplex(text) || hasRtl(text)) {
      let same = intact(start, end);
      if (same) {
        const from = map[start]!;
        const to = from + (end - start);
        const prev = [...after.slice(Math.max(0, from - 2), from)].pop() ?? "";
        const next = after.slice(to, to + 2);
        const startsWord = !WORD.test(prev) || (NOSPACE_SCRIPT.test(text) && !!newWords?.has(from) && !/^\p{M}/u.test(after.slice(from)));
        const endsWord =
          !(next && WORD.test(String.fromCodePoint(next.codePointAt(0)!))) || (NOSPACE_SCRIPT.test(text) && !!newWords?.has(to));
        same = startsWord && endsWord;
      }
      if (!same) for (const u of word) keep.delete(u);
    }
    word = [];
  };
  for (const u of units) {
    if ([...u.text].every((c) => WORD.test(c)) && u.text) {
      if (oldWords?.has(u.start) && NOSPACE_SCRIPT.test(u.text)) settle();
      word.push(u);
    } else settle();
  }
  settle();
  dropMixed(keep, map, units, after);
  const out = new Map<number, { unit: Unit; length: number }>();
  for (const u of units) if (keep.has(u)) out.set(map[u.start]!, { unit: u, length: u.end - u.start });
  return out;
}
