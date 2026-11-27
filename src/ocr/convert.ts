/** tesseract.js block tree (image pixels) -> OcrLine list (page space) */
import { apply, rectFromPoints } from "../engine/geom";
import type { Matrix, OcrLine, OcrWord, Point, Rect } from "../engine/types";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface RawWord {
  text: string;
  confidence: number;
  bbox: Box;
}
export interface RawLine {
  words: RawWord[];
  bbox: Box;
  baseline?: Box & { has_baseline?: boolean };
}
export interface RawBlock {
  paragraphs: { lines: RawLine[] }[];
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/g;
const LTR = /[A-Za-zÀ-ɏͰ-֏ऀ-႟ᄀ-ᇿ぀-ヿ一-鿿가-힯]/g;
/** scripts written without spaces between words */
const CJK = /[⺀-〿぀-ヿ㄀-ㄯ㐀-鿿豈-﫿＀-｠]/;
const NO_SPACE = /[฀-໿ក-៿က-႟]/;
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

export function directionOf(text: string): "ltr" | "rtl" {
  const r = text.match(RTL)?.length ?? 0;
  const l = text.match(LTR)?.length ?? 0;
  return r > l ? "rtl" : "ltr";
}

/** join recognised words, leaving out the spaces tesseract invents inside Chinese, Japanese and Thai */
export function joinWords(words: { text: string; bbox: Box }[], rtl: boolean): string {
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (i > 0) {
      const prev = words[i - 1]!;
      const gap = rtl ? prev.bbox.x0 - w.bbox.x1 : w.bbox.x0 - prev.bbox.x1;
      // the taller of the two: punctuation and flat characters are tiny on their own
      const height = Math.max(1, prev.bbox.y1 - prev.bbox.y0, w.bbox.y1 - w.bbox.y0);
      const a = prev.text.slice(-1);
      const b = w.text.charAt(0);
      const glued =
        (CJK.test(a) && CJK.test(b) && gap < height * 0.9) || (NO_SPACE.test(a) && NO_SPACE.test(b) && gap < height * 0.3);
      if (!glued) out += " ";
    }
    out += w.text;
  }
  return out;
}

const isJunk = (w: RawWord) =>
  !w.text.trim() ||
  (w.confidence < 10 && !/[\p{L}\p{N}]{2}/u.test(w.text)) ||
  (w.confidence < 55 && /^[|_\-~=^`'".,:;·—–\\/()[\]{}<>*!¦]+$/u.test(w.text));

export function convertBlocks(blocks: RawBlock[] | null | undefined, toPage: Matrix): OcrLine[] {
  const lines: OcrLine[] = [];
  const rectOf = (b: Box): Rect =>
    round(
      rectFromPoints([
        apply(toPage, [b.x0, b.y0]),
        apply(toPage, [b.x1, b.y0]),
        apply(toPage, [b.x0, b.y1]),
        apply(toPage, [b.x1, b.y1]),
      ]),
    );
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const raw of paragraph.lines ?? []) {
        const words = raw.words
          .map((w) => ({ ...w, text: w.text.replace(BIDI_MARKS, "").normalize("NFC") }))
          .filter((w) => !isJunk(w));
        if (!words.length) continue;
        const dir = directionOf(words.map((w) => w.text).join(""));
        // logical order: right to left lines start with the rightmost word
        if (dir === "rtl" && words.length > 1) {
          const first = words[0]!;
          const last = words[words.length - 1]!;
          if (first.bbox.x0 < last.bbox.x0) words.reverse();
        }
        const text = joinWords(words, dir === "rtl").trim();
        const letters = text.replace(/[^\p{L}\p{N}]/gu, "").length;
        const confidence = weightedConfidence(words);
        // specks, folds and pictures show up as short unsure "lines"
        if (confidence < 35 && letters <= 3) continue;
        if (confidence < 20) continue;
        const bbox: Box = {
          x0: Math.min(...words.map((w) => w.bbox.x0)),
          y0: Math.min(...words.map((w) => w.bbox.y0)),
          x1: Math.max(...words.map((w) => w.bbox.x1)),
          y1: Math.max(...words.map((w) => w.bbox.y1)),
        };
        const outWords: OcrWord[] = words.map((w) => ({
          text: w.text,
          rect: rectOf(w.bbox),
          confidence: Math.round(w.confidence),
        }));
        lines.push({
          text,
          rect: rectOf(bbox),
          baseline: baselineOf(raw, bbox, toPage),
          confidence: Math.round(confidence),
          words: outWords,
          dir,
        });
      }
    }
  }
  return lines;
}

/** baseline end points, left to right in the upright image, spanning the kept words */
function baselineOf(raw: RawLine, kept: Box, toPage: Matrix): [Point, Point] {
  const b = raw.baseline;
  let y0 = kept.y1;
  let y1 = kept.y1;
  if (b && b.x1 !== b.x0) {
    const slope = (b.y1 - b.y0) / (b.x1 - b.x0);
    if (Math.abs(slope) < 0.2) {
      const at = (x: number) => b.y0 + slope * (x - b.x0);
      const height = kept.y1 - kept.y0;
      const a = at(kept.x0);
      const z = at(kept.x1);
      // a baseline far outside the lower part of the line is a mistake of the recogniser
      const mid = (a + z) / 2;
      if (mid > kept.y0 + height * 0.35 && mid < kept.y1 + height * 0.15) {
        y0 = a;
        y1 = z;
      }
    }
  }
  const p = apply(toPage, [kept.x0, y0]);
  const q = apply(toPage, [kept.x1, y1]);
  return [
    [round1(p[0]), round1(p[1])],
    [round1(q[0]), round1(q[1])],
  ];
}

export function weightedConfidence(words: { text: string; confidence: number }[]): number {
  let sum = 0;
  let weight = 0;
  for (const w of words) {
    const n = Math.max(1, w.text.length);
    sum += w.confidence * n;
    weight += n;
  }
  return weight ? sum / weight : 0;
}

const round1 = (n: number) => Math.round(n * 100) / 100;
const round = (r: Rect): Rect => [round1(r[0]), round1(r[1]), round1(r[2]), round1(r[3])];
