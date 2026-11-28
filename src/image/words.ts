/**
 * The safety net for lines whose reading cannot be trusted. Nothing is typeset from such a reading: the
 * words are told apart in the picture itself, only those the user changed are replaced, and when they
 * cannot be told apart nothing is drawn.
 */
import type { Observed } from "./analyze/match";
import type { TextBox } from "./types";

/** how a reading compares with the ink: below this it is not what the picture says */
const BAD_FIT = 0.5;
const FAIR_FIT = 0.65;

/** whether the reading of a box may be wrong; a reading the user has typed or confirmed is taken as right */
export function doubtful(box: Pick<TextBox, "checked" | "confidence" | "weakest">, fit: number | undefined): boolean {
  if (box.checked) return false;
  if (box.confidence !== undefined && box.confidence < 65) return true;
  if (fit === undefined) return false;
  return fit < BAD_FIT || (box.weakest !== undefined && box.weakest < 40 && fit < FAIR_FIT);
}

/** one word as it stands in the picture, in frame coordinates */
export interface InkWord {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** a gap at least this wide, in line heights, parts two words */
const WORD_GAP = 0.17;

/**
 * The words of a line as the picture shows them. With `count`, that many, parted at the widest gaps, or
 * null when the gaps do not say clearly where words end: fewer of them than needed, narrow ones, or
 * others about as wide. Without, parted at every gap as wide as a word space.
 */
export function inkWords(obs: Observed, count?: number): { words: InkWord[]; baseline: number } | null {
  const { w, h, k, margin, data } = obs;
  if (count !== undefined && count < 1) return null;
  const columns: boolean[] = [];
  const lowest: number[] = [];
  let top = h;
  let bottom = 0;
  for (let x = 0; x < w; x++) {
    let low = -1;
    for (let y = 0; y < h; y++)
      if (data[y * w + x]! > 0.3) {
        low = y;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + 1);
      }
    columns.push(low >= 0);
    if (low >= 0) lowest.push(low + 1);
  }
  const first = columns.indexOf(true);
  const last = columns.lastIndexOf(true);
  if (first < 0) return null;
  const gaps: [number, number][] = [];
  for (let x = first, from = -1; x <= last; x++) {
    if (!columns[x]) {
      if (from < 0) from = x;
    } else if (from >= 0) {
      gaps.push([from, x]);
      from = -1;
    }
  }
  const wide = [...gaps].sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  const chosen = count === undefined ? wide.filter((g) => g[1] - g[0] >= (bottom - top) * WORD_GAP) : wide.slice(0, count - 1);
  if (count !== undefined && chosen.length < count - 1) return null;
  if (count !== undefined && chosen.length) {
    const narrowest = chosen.at(-1)![1] - chosen.at(-1)![0];
    const next = wide[count - 1];
    if (narrowest < (bottom - top) * 0.16 || (next && next[1] - next[0] > narrowest * 0.75)) return null;
  }
  const ends = [first, ...chosen.sort((a, b) => a[0] - b[0]).flat(), last + 1];
  const frame = (g: number) => g / k - margin;
  const words: InkWord[] = [];
  for (let i = 0; i < ends.length; i += 2) {
    let v0 = h;
    let v1 = 0;
    for (let x = ends[i]!; x < ends[i + 1]!; x++)
      for (let y = 0; y < h; y++)
        if (data[y * w + x]! > 0.3) {
          v0 = Math.min(v0, y);
          v1 = Math.max(v1, y + 1);
        }
    words.push({ u0: frame(ends[i]!), u1: frame(ends[i + 1]!), v0: frame(v0), v1: frame(v1) });
  }
  // most letters stand on the baseline
  lowest.sort((a, b) => a - b);
  return { words, baseline: frame(lowest[lowest.length >> 1]!) };
}

/**
 * Where a change falls among the words of the picture when their number differs from the reading's (part
 * of the line was read as nonsense): counted from the start or from the end of the line, and accepted only
 * if the words there are as wide, one to another, as the words of the reading. `expected` = the widths the
 * reading's words would have when set; returns the number to add to a reading index.
 */
export function alignWords(ink: readonly InkWord[], expected: readonly number[], change: Pick<Change, "from" | "to">): number | null {
  const n = expected.length;
  const from = Math.max(0, change.from - 1);
  const to = Math.min(n, change.to + 1);
  let best: number | null = null;
  let spread = 1.25;
  for (const offset of new Set([ink.length - n, 0])) {
    if (to - from < 2 || from + offset < 0 || to + offset > ink.length) continue;
    // a change at an end of the reading has to be at that end of the line
    if ((change.to === n && offset !== ink.length - n) || (change.from === 0 && offset !== 0)) continue;
    const ratios = expected.slice(from, to).map((width, i) => (ink[from + offset + i]!.u1 - ink[from + offset + i]!.u0) / Math.max(1e-6, width));
    const worst = Math.max(...ratios) / Math.min(...ratios);
    if (worst < spread) {
      spread = worst;
      best = offset;
    }
  }
  return best;
}

export interface Change {
  /** the words of the picture that go: from..to (to excluded; equal when words are only added) */
  from: number;
  to: number;
  /** what takes their place */
  text: string;
}

/** which words the user changed */
export function changedWords(before: string, after: string): Change {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { from: head, to: a.length - tail, text: b.slice(head, b.length - tail).join(" ") };
}
