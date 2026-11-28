/**
 * Indian scripts beside English. Script detection mistakes a line such as "समय / Hours 10 to 18" for
 * English, and short Bengali, Gujarati, Telugu or Malayalam for Thai; the first reading then turns half of
 * it into nonsense, sometimes sure nonsense. This picks out the words that may be in another script and
 * says which models are worth trying on them.
 */
import type { Box, RawBlock, RawWord } from "./convert";
import type { Gray } from "./preprocess";

/** scripts whose letters hang from a line along the top of the word */
export const HEADED = ["hin", "ben", "pan"];
export const UNHEADED = ["guj", "tam", "tel", "kan", "mal", "ori"];

export const SCRIPT_OF: Record<string, RegExp> = {
  hin: /\p{Script=Devanagari}/u,
  ben: /\p{Script=Bengali}/u,
  pan: /\p{Script=Gurmukhi}/u,
  guj: /\p{Script=Gujarati}/u,
  tam: /\p{Script=Tamil}/u,
  tel: /\p{Script=Telugu}/u,
  kan: /\p{Script=Kannada}/u,
  mal: /\p{Script=Malayalam}/u,
  ori: /\p{Script=Oriya}/u,
  tha: /\p{Script=Thai}/u,
  eng: /\p{Script=Latin}/u,
};

/**
 * Whether the word in this box has a headline: a stroke running right across it in its upper half, with
 * much less ink in most rows below. Latin words have none (an underline lies underneath).
 */
export function hasHeadline(image: Gray, box: Box): boolean {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(image.width, Math.ceil(box.x1));
  const y1 = Math.min(image.height, Math.ceil(box.y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (h < 8 || w < h * 0.9) return false;
  let lo = 255;
  let hi = 0;
  let sum = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = image.data[y * image.width + x]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
  if (hi - lo < 60) return false;
  const middle = (lo + hi) / 2;
  // the ink is the smaller share
  const darkInk = sum / (w * h) > middle;
  const rows: number[] = [];
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (image.data[y * image.width + x]! < middle === darkInk) n++;
    rows.push(n / w);
  }
  let top = 0;
  for (let i = 1; i < rows.length * 0.55; i++) if (rows[i]! > rows[top]!) top = i;
  const below = rows.slice(Math.floor(h * 0.45), Math.ceil(h * 0.9)).sort((a, b) => a - b);
  const usual = below[below.length >> 1] ?? 0;
  return rows[top]! >= 0.78 && usual < rows[top]! * 0.65 && usual < 0.6;
}

export interface Suspects {
  /** where the words that may be in an Indian script are */
  boxes: Box[];
  /** the models to try on them */
  candidates: string[];
}

/** doubtful words standing next to each other, as one box: a script the model does not know comes out in bits */
function runs(blocks: RawBlock[], odd: (w: RawWord) => boolean): { box: Box; confidence: number }[] {
  const out: { box: Box; confidence: number }[] = [];
  for (const line of blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines))) {
    let open: (typeof out)[number] | null = null;
    for (const w of [...line.words].filter((w) => w.text.trim()).sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      if (!odd(w)) {
        open = null;
        continue;
      }
      const height = line.bbox.y1 - line.bbox.y0;
      if (open && w.bbox.x0 - open.box.x1 < height * 0.7) {
        const b: Box = open.box;
        open.box = { x0: b.x0, y0: Math.min(b.y0, w.bbox.y0), x1: Math.max(b.x1, w.bbox.x1), y1: Math.max(b.y1, w.bbox.y1) };
        open.confidence = Math.min(open.confidence, w.confidence);
      } else out.push((open = { box: { ...w.bbox }, confidence: w.confidence }));
    }
  }
  return out.filter(({ box }) => box.x1 - box.x0 > 4);
}

/**
 * The words of a first reading that may really be in an Indian script. `first` is the leading model of
 * that reading: English, or Thai, which script detection offers for scripts it does not know.
 */
export function suspects(image: Gray, blocks: RawBlock[], first: string): Suspects | null {
  if (first !== "eng" && first !== "tha") return null;
  // English read by the Thai pair is read well; the rest of that reading is open to question
  const odd = (w: RawWord) => (first === "tha" ? SCRIPT_OF.tha!.test(w.text) || w.confidence < 78 : w.confidence < 78);
  // on an English page, only what is about as tall as the words read well: buttons and switches that were
  // taken for words are taller, and not worth fetching models for
  const heights = blocks
    .flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
    .filter((w) => w.confidence >= 85)
    .map((w) => w.bbox.y1 - w.bbox.y0)
    .sort((a, b) => a - b);
  const usual = first === "eng" ? heights[heights.length >> 1] : undefined;
  const sized = (box: Box) => usual === undefined || (box.y1 - box.y0 > usual * 0.6 && box.y1 - box.y0 < usual * 1.8);
  const doubtful = runs(blocks, odd).filter((r) => sized(r.box));
  const headed = doubtful.filter((r) => hasHeadline(image, r.box));
  // the headline of one word can be told even when its run holds more than that
  for (const w of blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))))
    if (w.text.trim() && odd(w) && sized(w.bbox) && !headed.length && hasHeadline(image, w.bbox)) headed.push({ box: w.bbox, confidence: w.confidence });
  const widest = (a: { box: Box }, b: { box: Box }) => b.box.x1 - b.box.x0 - (a.box.x1 - a.box.x0);
  // one odd shape on an English page, such as a filled band, is not worth fetching three models for
  if (headed.length > 1 || (headed.length && first === "eng" && headed[0]!.confidence < 65)) {
    // runs that stand near enough to be words of the same text come along
    const boxes = headed.sort(widest).slice(0, 10).map((r) => r.box);
    return { boxes, candidates: first === "tha" ? [...HEADED, "eng", "tha"] : HEADED };
  }
  // without headlines there is less to go on: only a reading that went badly wrong is worth the downloads
  const wordLike = doubtful.filter(({ box, confidence }) => {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    return height >= 10 && width >= height * 1.3 && (first === "tha" || confidence < 62);
  });
  const all = runs(blocks, () => true).length;
  if (!wordLike.length || (first === "eng" && (wordLike.length < 2 || wordLike.length < all * 0.25))) return null;
  return { boxes: wordLike.sort(widest).slice(0, 10).map((r) => r.box), candidates: first === "tha" ? ["tha", "eng", ...UNHEADED] : UNHEADED };
}

/** how far a trial reading of the doubtful words is to be believed as text of that model's script */
export function belief(lang: string, text: string, confidence: number): number {
  const letters = [...text.replace(/[^\p{L}\p{M}]/gu, "")];
  if (letters.length < 3) return 0;
  const share = letters.filter((c) => SCRIPT_OF[lang]!.test(c)).length / letters.length;
  return share < 0.6 ? 0 : Math.max(0, confidence - 55) * share;
}
