/** How well found boxes match the lettering that is really there. */
import type { TextBox } from "../../src/image/types";
import { bounds } from "./helpers";
import type { Truth } from "./replicas";

export interface Score {
  /** lines of text in the picture */
  total: number;
  /** lines with a box of their own */
  boxed: number;
  /** boxed lines read exactly (spacing aside) */
  exact: number;
  /** share of characters right over all lines, missed ones counting as wrong */
  chars: number;
  boxes: number;
  /** boxes that are one line's own box */
  good: number;
  missed: string[];
  junk: string[];
  misread: string[];
}

const plain = (t: string) => t.normalize("NFC").replace(/\s+/g, "");

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length]!;
}

/** whether a box belongs to exactly this line: it spans it from end to end and not much further */
export function fits(box: TextBox, truth: Truth): boolean {
  const [x0, y0, x1, y1] = bounds(box.quad);
  const [a0, b0, a1, b1] = truth.rect;
  const h = b1 - b0;
  const wide = Math.max(0, Math.min(x1, a1) - Math.max(x0, a0)) / (Math.max(x1, a1) - Math.min(x0, a0));
  const high = Math.max(0, Math.min(y1, b1) - Math.max(y0, b0));
  return wide > 0.72 && high > h * 0.5 && y1 - y0 < h * 2;
}

export function score(boxes: TextBox[], truth: Truth[]): Score {
  const used = new Set<string>();
  const out: Score = { total: truth.length, boxed: 0, exact: 0, chars: 0, boxes: boxes.length, good: 0, missed: [], junk: [], misread: [] };
  let right = 0;
  let all = 0;
  for (const line of truth) {
    const want = plain(line.text);
    all += want.length;
    const box = boxes.find((b) => !used.has(b.id) && fits(b, line));
    if (!box) {
      out.missed.push(line.text);
      continue;
    }
    used.add(box.id);
    out.boxed++;
    const got = plain(box.text);
    right += Math.max(0, want.length - distance(want, got));
    if (got === want) out.exact++;
    else out.misread.push(`${line.text} -> ${box.text}`);
  }
  out.good = used.size;
  out.chars = all ? right / all : 1;
  out.junk = boxes.filter((b) => !used.has(b.id)).map((b) => `${b.text} [${bounds(b.quad).map(Math.round).join()}]`);
  return out;
}
