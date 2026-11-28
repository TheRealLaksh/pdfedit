/**
 * Finds the lines of text in a picture: OCR passes, cut into separate pieces, as quads in picture pixels,
 * then every line grown to its full length and read once more on its own.
 */
import { joinWords, weightedConfidence } from "../ocr/convert";
import { OCR_LANGUAGES } from "../ocr/languages";
import type { OcrLine, OcrPageResult, RenderedPage } from "../engine/types";
import { angleOf, bounds, quadSize, rectQuad, rotateQuad } from "./geometry";
import { grow, lineImage } from "./lines";
import { textRegions, type Region } from "./segment";
import type { Align, Picture, Quad4, TextBox } from "./types";

export type Recognise = (
  image: RenderedPage,
  options: { languages: string[]; scale: number; line?: boolean; signal?: AbortSignal; onProgress?: (p: { status: string; progress: number }) => void },
) => Promise<OcrPageResult>;

/** pixels per point told to the recogniser (it assumes about 300 dpi) */
const SCALE = 300 / 72;

/** small text is read much better enlarged; huge pictures are shrunk to save time */
export const readingScale = (width: number, height: number) => {
  const longest = Math.max(width, height);
  return longest < 1100 ? 2.5 : longest < 1800 ? 2 : longest > 3800 ? 3800 / longest : 1;
};

export function resize(p: Picture, factor: number): Picture {
  if (factor === 1) return p;
  const width = Math.max(1, Math.round(p.width * factor));
  const height = Math.max(1, Math.round(p.height * factor));
  const data = new Uint8ClampedArray(width * height * 4);
  const n = factor < 1 ? Math.ceil(1 / factor) : 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (n > 1) {
        // average of the covered pixels
        const sum = [0, 0, 0, 0];
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) {
            const sx = Math.min(p.width - 1, Math.floor((x + (i + 0.5) / n) / factor));
            const sy = Math.min(p.height - 1, Math.floor((y + (j + 0.5) / n) / factor));
            for (let c = 0; c < 4; c++) sum[c]! += p.data[(sy * p.width + sx) * 4 + c]!;
          }
        for (let c = 0; c < 4; c++) data[at + c] = sum[c]! / (n * n);
        continue;
      }
      const fx = Math.max(0, Math.min(p.width - 1, (x + 0.5) / factor - 0.5));
      const fy = Math.max(0, Math.min(p.height - 1, (y + 0.5) / factor - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(p.width - 1, x0 + 1);
      const y1 = Math.min(p.height - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      for (let c = 0; c < 4; c++) {
        const top = p.data[(y0 * p.width + x0) * 4 + c]! * (1 - ax) + p.data[(y0 * p.width + x1) * 4 + c]! * ax;
        const bottom = p.data[(y1 * p.width + x0) * 4 + c]! * (1 - ax) + p.data[(y1 * p.width + x1) * 4 + c]! * ax;
        data[at + c] = top * (1 - ay) + bottom * ay;
      }
    }
  }
  return { width, height, data };
}

/**
 * The dark parts of a picture turned negative (light parts blanked), so that light lettering on dark
 * ground is read too. Null when hardly anything is dark.
 */
export function darkParts(p: Picture): Picture | null {
  const tile = Math.max(16, Math.round(Math.max(p.width, p.height) / 60));
  const cols = Math.ceil(p.width / tile);
  const rows = Math.ceil(p.height / tile);
  const dark = new Uint8Array(cols * rows);
  const lum = (i: number) => (p.data[i]! * 77 + p.data[i + 1]! * 150 + p.data[i + 2]! * 29) >> 8;
  let count = 0;
  const hist = new Uint32Array(256);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      hist.fill(0);
      let n = 0;
      for (let y = r * tile; y < Math.min(p.height, (r + 1) * tile); y += 2)
        for (let x = c * tile; x < Math.min(p.width, (c + 1) * tile); x += 2) {
          hist[lum((y * p.width + x) * 4)]!++;
          n++;
        }
      let acc = 0;
      let median = 0;
      for (; median < 255; median++) if ((acc += hist[median]!) * 2 >= n) break;
      if (median < 140) {
        dark[r * cols + c] = 1;
        count++;
      }
    }
  if (count < Math.max(2, cols * rows * 0.01)) return null;
  const data = new Uint8ClampedArray(p.data.length).fill(255);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      if (!dark[Math.floor(y / tile) * cols + Math.floor(x / tile)]) continue;
      const at = (y * p.width + x) * 4;
      const v = 255 - lum(at);
      data[at] = data[at + 1] = data[at + 2] = v;
    }
  return { width: p.width, height: p.height, data };
}

interface Found {
  quad: Quad4;
  text: string;
  confidence: number;
  /** the least sure word */
  weakest?: number;
}

/** one recognised line, cut where a wide gap separates unrelated pieces (label and value, columns) */
export function pieces(line: OcrLine, toPixels: number, limit: { width: number; height: number }): Found[] {
  const base = line.baseline;
  let angle = base ? Math.atan2(base[1][1] - base[0][1], base[1][0] - base[0][0]) : 0;
  if (Math.abs(angle) < 0.009 || Math.abs(angle) > 0.6) angle = 0;
  const words = [...line.words].filter((w) => w.text.trim()).sort((a, b) => a.rect[0] - b.rect[0]);
  if (!words.length) return [];
  const heights = words.map((w) => (w.rect[3] - w.rect[1] - (w.rect[2] - w.rect[0]) * Math.abs(Math.sin(angle))) * toPixels).sort((a, b) => a - b);
  const typical = Math.max(6, heights[Math.floor(heights.length * 0.75)]!);
  const groups: (typeof words)[] = [[]];
  for (const word of words) {
    const group = groups.at(-1)!;
    const last = group.at(-1);
    if (last && (word.rect[0] - last.rect[2]) * toPixels > typical * 1.5) groups.push([word]);
    else group.push(word);
  }
  const out: Found[] = [];
  for (const group of groups) {
    const ordered = line.dir === "rtl" ? [...group].reverse() : group;
    const text = joinWords(
      ordered.map((w) => ({ text: w.text, bbox: { x0: w.rect[0], y0: w.rect[1], x1: w.rect[2], y1: w.rect[3] } })),
      line.dir === "rtl",
    ).trim();
    const confidence = Math.round(group.reduce((s, w) => s + w.confidence * w.text.length, 0) / Math.max(1, group.reduce((s, w) => s + w.text.length, 0)));
    const letters = text.replace(/[^\p{L}\p{N}]/gu, "").length;
    // specks and texture show up as short or very unsure "words"
    if (!letters || confidence < 40 || (letters < 6 && confidence < 52) || (letters <= 1 && confidence < 70)) continue;
    const x0 = Math.min(...group.map((w) => w.rect[0])) * toPixels;
    const x1 = Math.max(...group.map((w) => w.rect[2])) * toPixels;
    const y0 = Math.min(...group.map((w) => w.rect[1])) * toPixels;
    const y1 = Math.max(...group.map((w) => w.rect[3])) * toPixels;
    let quad: Quad4;
    if (angle) {
      // the upright box of a tilted line is taller than the line: take the slope out again
      const width = (x1 - x0) / Math.cos(angle);
      const height = Math.max(typical * 0.7, y1 - y0 - (x1 - x0) * Math.abs(Math.tan(angle)));
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      quad = rotateQuad(rectQuad(cx - width / 2 - 2, cy - height / 2 - 2, cx + width / 2 + 2, cy + height / 2 + 2), angle);
    } else quad = rectQuad(Math.max(0, Math.floor(x0 - 1)), Math.max(0, Math.floor(y0 - 1)), Math.min(limit.width, Math.ceil(x1 + 1)), Math.min(limit.height, Math.ceil(y1 + 1)));
    const size = quadSize(quad);
    if (size.height < 6 || size.height > limit.height * 0.6) continue;
    out.push({ quad, text, confidence, weakest: Math.min(...group.map((w) => w.confidence)) });
  }
  return out;
}

function overlaps(a: Quad4, b: Quad4): boolean {
  const [ax0, ay0, ax1, ay1] = bounds(a);
  const [bx0, by0, bx1, by1] = bounds(b);
  const shared = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) * Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  return shared > Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0)) * 0.35;
}

/** adds the lines of a further pass, keeping the surer reading where two overlap */
export function merge(first: Found[], second: Found[]): Found[] {
  const out = [...first];
  for (const found of second) {
    if (found.confidence < 50) continue;
    const clash = out.filter((o) => overlaps(o.quad, found.quad));
    if (clash.length && worth(found) <= clash.reduce((s, c) => s + worth(c), 0) * 1.15) continue;
    for (const c of clash) out.splice(out.indexOf(c), 1);
    out.push(found);
  }
  return out;
}

/** share of the progress bar used before the lines are read one by one, and before the labels are */
const PAGE_SHARE = 0.75;
const LINE_SHARE = 0.9;
/** a picture with more lines than this keeps the first reading for the rest */
const MAX_LINE_READS = 200;

const length = (text: string) => text.replace(/\s/g, "").length;

/** the models for one line: Latin letters and digits are read without the other scripts, which confuse digits */
export function lineLanguages(text: string, used: string[]): string[] {
  const latin = used.filter((code) => OCR_LANGUAGES.some((l) => l.code === code && l.script === "Latin"));
  return latin.length && !/(?![0-9\p{Script=Latin}])[\p{L}\p{N}]/u.test(text) ? latin : used;
}

/**
 * The ways one line is read, the usual one first. A line in another script is also tried with English
 * leading: the other model alone loses or misreads the figures in it.
 */
export function lineModels(text: string, used: string[]): string[][] {
  const first = lineLanguages(text, used);
  return first === used && used.indexOf("eng") > 0 ? [used, ["eng", ...used.filter((code) => code !== "eng")]] : [first];
}

/** how much was read, and how surely */
const worth = (f: Found) => f.text.length * Math.max(0, f.confidence - 35);

/** whether the closer reading of a line replaces the first one; `further` = its box now covers more text */
export function preferred(first: Found, second: Found, further: boolean): boolean {
  if (second.confidence < 50) return false;
  if (further) return length(second.text) > length(first.text) && second.confidence >= Math.max(55, first.confidence - 20);
  const gain = second.confidence - first.confidence;
  // as much text and surer is enough; a reading that lost some of it has to be clearly surer
  return length(second.text) >= length(first.text) ? gain > 0 : gain >= 3 && length(second.text) >= length(first.text) * 0.85;
}

/** one line cut out of the picture and read on its own; null when nothing came of it */
async function readLine(picture: Picture, quad: Quad4, languages: string[], recognise: Recognise, signal?: AbortSignal): Promise<Found | null> {
  try {
    const result = await recognise({ page: 0, revision: 0, ...lineImage(picture, quad) }, { languages, scale: SCALE, line: true, signal });
    const text = result.lines.map((l) => l.text).join(" ").trim();
    const weakest = Math.min(...result.lines.flatMap((l) => l.words.map((w) => w.confidence)));
    return text ? { quad, text, confidence: Math.round(weightedConfidence(result.lines)), ...(Number.isFinite(weakest) && { weakest }) } : null;
  } catch (e) {
    if (signal?.aborted || (e as Error).name === "AbortError") throw e;
    // an earlier reading stands
    return null;
  }
}

/** grows every box over the rest of its line and reads each line again on its own, taking the better reading */
export async function wholeLines(
  picture: Picture,
  found: Found[],
  used: string[],
  recognise: Recognise,
  options: { signal?: AbortSignal; onProgress?: (status: string, progress: number) => void },
): Promise<Found[]> {
  const quads = found.map((f) => f.quad);
  const out: (Found | null)[] = [...found];
  const absorbed = new Set<number>();
  let reads = 0;
  const readWith = (quad: Quad4, languages: string[]) => {
    reads++;
    return readLine(picture, quad, languages, recognise, options.signal);
  };
  const read = async (quad: Quad4, ways: string[][]) => {
    let best: Found | null = null;
    for (const languages of ways) {
      const next = await readWith(quad, languages);
      if (next && (!best || worth(next) > worth(best))) best = next;
    }
    return best;
  };
  // lines read with the same models follow each other (changing models is slow); the longest part of a
  // split line goes first and takes in the others
  const models = found.map((f) => lineModels(f.text, used));
  const order = found.map((_, i) => i).sort((a, b) => models[a]!.join().localeCompare(models[b]!.join()) || found[b]!.text.length - found[a]!.text.length);
  for (const [n, i] of order.entries()) {
    if (absorbed.has(i) || reads >= MAX_LINE_READS) continue;
    options.onProgress?.("Reading text", PAGE_SHARE + ((LINE_SHARE - PAGE_SHARE) * n) / order.length);
    const first = out[i]!;
    const grown = grow(picture, quads, i, absorbed);
    const parts = [i, ...grown.absorbed].map((j) => out[j]!);
    const joined: Found = { quad: grown.quad, text: parts.map((p) => p.text).join(" "), confidence: Math.round(weightedConfidence(parts)), weakest: Math.min(...parts.map((p) => p.weakest ?? p.confidence)) };
    const further = grown.added > 0.3 || grown.absorbed.length > 0;
    // an unsure first reading may have mistaken the script: then all the languages get a try as well
    const ways = first.confidence < 60 && !models[i]!.some((m) => m.join() === used.join()) ? [...models[i]!, used] : models[i]!;
    const second = await read(grown.quad, ways);
    if (second && preferred(joined, second, further)) {
      out[i] = second;
      quads[i] = grown.quad;
      for (const j of grown.absorbed) {
        absorbed.add(j);
        out[j] = null;
      }
    } else if (!further) {
      out[i] = { ...first, quad: grown.quad };
      quads[i] = grown.quad;
    } else {
      // what lay beyond the box could not be read as more of the line: the box stays
      const own = await read(first.quad, models[i]!);
      if (own && preferred(first, own, false)) out[i] = own;
    }
  }
  return out.filter((f): f is Found => !!f);
}

/** pieces of plain-ground lettering read on their own, at most */
const MAX_LABEL_READS = 160;

const letters = (text: string) => text.replace(/[^\p{L}\p{M}\p{N}]/gu, "").length;

/** icons next to a label come out as stray signs at either end of it */
export function withoutSigns(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const sign = (w: string) => !/[\p{L}\p{N}\p{Sc}&+%\-–—/#]/u.test(w) && !/^\(.*\)$/.test(w);
  while (words.length > 1 && sign(words[0]!)) words.shift();
  while (words.length > 1 && sign(words.at(-1)!)) words.pop();
  return words.join(" ");
}

/** whether the reading of a piece of plain ground is believable as text, and not a mark or a shape */
export function believable(found: Pick<Found, "text" | "confidence">, region: Pick<Region, "box" | "marks">): boolean {
  const count = letters(found.text);
  const signs = found.text.replace(/\s/g, "").length;
  if (!count || count < signs * 0.6) return false;
  const [x0, y0, x1, y1] = region.box;
  // a single squarish shape is most likely an icon
  const shape = region.marks === 1 && x1 - x0 < (y1 - y0) * 1.6;
  // a lone figure is narrow
  if (count === 1) return found.confidence >= (shape ? 90 : 80) && /\p{N}/u.test(found.text) && x1 - x0 < (y1 - y0) * 0.9;
  if (shape) return found.confidence >= 85;
  // there cannot be many more letters than the width has room for
  if (count > ((x1 - x0) / (y1 - y0)) * 4 + 1) return false;
  return found.confidence >= (count === 2 ? 80 : count === 3 ? 68 : 60);
}

const regionQuad = ({ box: [x0, y0, x1, y1] }: Region, picture: Picture): Quad4 => {
  const pad = Math.max(1, Math.round((y1 - y0) * 0.14));
  return rectQuad(Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(picture.width, x1 + pad), Math.min(picture.height, y1 + pad));
};

/** how much of the first rectangle lies in the second */
function inside([ax0, ay0, ax1, ay1]: readonly number[], [bx0, by0, bx1, by1]: readonly number[]): number {
  const shared = Math.max(0, Math.min(ax1!, bx1!) - Math.max(ax0!, bx0!)) * Math.max(0, Math.min(ay1!, by1!) - Math.max(ay0!, by0!));
  return shared / Math.max(1, (ax1! - ax0!) * (ay1! - ay0!));
}

/** whether two pieces side by side are two different things, and not one line seen in halves */
function apart(picture: Picture, a: Region, b: Region): boolean {
  const height = Math.max(a.box[3] - a.box[1], b.box[3] - b.box[1]);
  const gap = b.box[0] - a.box[2];
  const differ = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
  if (gap <= 0) return false;
  if (differ(a.ground, b.ground) > 40) return true;
  // in one colour the gap must beat a word space, which in typewriter faces is wider than the letters are tall
  if (gap < height * (differ(a.color, b.color) > 55 ? 0.3 : 1.4)) return false;
  // letters that were not made out in between would mean one line
  const y0 = Math.max(a.box[1], b.box[1]);
  const y1 = Math.min(a.box[3], b.box[3]);
  let ink = 0;
  let columns = 0;
  for (let x = Math.ceil(a.box[2]) + 1; x < b.box[0] - 1; x++, columns++)
    for (let y = Math.ceil(y0); y < y1; y++) {
      const i = (y * picture.width + x) * 4;
      if (differ([picture.data[i]!, picture.data[i + 1]!, picture.data[i + 2]!], a.ground) > 60) {
        ink++;
        break;
      }
    }
  return ink <= columns * 0.2;
}

/**
 * Short labels on buttons, pills, chips and tabs: the page reading passes over many of them, runs
 * neighbours together and takes icons for letters. Every piece of lettering on plain ground that has no
 * sure box of its own is read by itself.
 */
export async function labels(
  picture: Picture,
  found: Found[],
  used: string[],
  recognise: Recognise,
  options: { signal?: AbortSignal; onProgress?: (status: string, progress: number) => void },
): Promise<Found[]> {
  const regions = textRegions(picture);
  const all = used.length ? used : ["eng"];
  const latin = lineLanguages("a", all);
  // another script is only worth a look when some of the picture was surely read in it
  const foreign = found.some((f) => f.confidence >= 70 && letters(f.text) >= 3 && lineLanguages(f.text, all).join() !== latin.join());
  const languages = foreign || latin.join() === all.join() ? all : latin;
  let reads = 0;
  const known = new Map<Region, Found | null>();
  const twice = latin.join() !== languages.join();
  const first = new Map<Region, Found | null>();
  const readFirst = async (region: Region) => {
    if (first.has(region)) return first.get(region)!;
    if (reads >= MAX_LABEL_READS) return null;
    options.onProgress?.("Reading text", LINE_SHARE + (1 - LINE_SHARE) * Math.min(1, reads++ / Math.max(1, regions.length)));
    const result = await readLine(picture, regionQuad(region, picture), languages, recognise, options.signal);
    first.set(region, result);
    return result;
  };
  const read = async (region: Region): Promise<Found | null> => {
    if (known.has(region)) return known.get(region)!;
    let best = await readFirst(region);
    // figures and English words are read better without the other script
    if (twice && first.has(region) && (!best || lineLanguages(best.text, languages).join() === latin.join() || best.confidence < 70)) {
      const other = await readLine(picture, regionQuad(region, picture), latin, recognise, options.signal);
      if (other && (!best || worth(other) > worth(best))) best = other;
    }
    const clean = best && { ...best, text: withoutSigns(best.text) };
    const result = clean && believable(clean, region) ? clean : null;
    known.set(region, result);
    return result;
  };
  const covered = (region: Region, boxes: Found[]) => {
    const width = region.box[2] - region.box[0];
    const height = region.box[3] - region.box[1];
    return boxes.some((f) => {
      const b = bounds(f.quad);
      return inside(region.box, b) > 0.75 && b[2] - b[0] > width * 0.8 && (f.confidence >= 85 || (f.confidence >= 78 && b[3] - b[1] < height * 2.2));
    });
  };
  // with two sets of models, everything is read with one and then with the other: changing them is slow
  if (twice) for (const region of regions) if (!covered(region, found)) await readFirst(region);

  let out = [...found];
  // boxes that hold several pieces, or a piece and an icon
  for (const box of found) {
    const own = bounds(box.quad);
    const height = quadSize(box.quad).height;
    if (Math.abs(angleOf(box.quad)) > 0.03) continue;
    const parts = regions
      // a box drawn round a whole button is much taller than its lettering
      .filter((r) => inside(r.box, own) > 0.65 && r.box[3] - r.box[1] > height * 0.25 && r.box[3] - r.box[1] < height * 1.35)
      .sort((a, b) => a.box[0] - b.box[0]);
    if (!parts.length) continue;
    if (parts.length > 1) {
      if (!parts.every((p, i) => !i || apart(picture, parts[i - 1]!, p))) continue;
      const separate: Found[] = [];
      for (const part of parts) {
        const next = await read(part);
        if (next) separate.push(next);
      }
      const kept = separate.reduce((s, f) => s + letters(f.text), 0);
      // a single piece left means the rest of the box was an icon or a picture
      if (separate.length && kept >= letters(box.text) * (separate.length > 1 ? 0.8 : 0.95)) out.splice(out.indexOf(box), 1, ...separate);
      continue;
    }
    const only = parts[0]!;
    const spare = own[2] - own[0] - (only.box[2] - only.box[0]);
    const roomy = height > (only.box[3] - only.box[1]) * 1.7;
    const signs = spare > height * 0.9 && (withoutSigns(box.text) !== box.text || /^\S{1,2}\s|\s\S{1,2}$/u.test(box.text));
    if (roomy || signs) {
      const next = await read(only);
      // a box that only has to be drawn closer must not lose any of its text
      if (next && next.confidence >= box.confidence - 8 && letters(next.text) >= letters(box.text) - (signs ? 2 : 0)) out.splice(out.indexOf(box), 1, next);
    }
  }
  // pieces without a sure box
  for (const region of regions) {
    if (covered(region, out)) continue;
    const next = await read(region);
    if (!next || out.includes(next)) continue;
    const clash = out.filter((o) => overlaps(o.quad, next.quad));
    if (clash.length && worth(next) <= clash.reduce((s, c) => s + worth(c), 0) * 1.05) continue;
    out = out.filter((o) => !clash.includes(o));
    out.push(next);
  }
  // stray signs left from pictures and icons
  return out
    .map((f) => ({ ...f, text: withoutSigns(f.text) }))
    .filter((f) => letters(f.text) >= f.text.replace(/\s/g, "").length * 0.5 || f.confidence >= 75);
}

export async function detectText(
  picture: Picture,
  recognise: Recognise,
  options: { languages: string[]; signal?: AbortSignal; onProgress?: (status: string, progress: number) => void },
): Promise<{ boxes: TextBox[]; languages: string[] }> {
  const factor = readingScale(picture.width, picture.height);
  const large = resize(picture, factor);
  const read = async (p: Picture, by: number, languages: string[], from: number, to: number) => {
    const result = await recognise(
      { page: 0, revision: 0, width: p.width, height: p.height, data: p.data },
      { languages, scale: SCALE, signal: options.signal, onProgress: (r) => options.onProgress?.(r.status, page(from + (to - from) * r.progress)) },
    );
    return { result, found: result.lines.flatMap((l) => pieces(l, SCALE / by, picture)) };
  };
  // the passes over the whole picture; reading line by line fills the rest of the progress
  const page = (progress: number) => progress * PAGE_SHARE;
  let found: Found[] = [];
  let languages = options.languages;
  let done = 0;
  // a photograph or poster is first read small: big lettering is found there, with less noise to mislead
  const longest = Math.max(picture.width, picture.height);
  if (longest >= 1100) {
    const by = 800 / longest;
    const pass = await read(resize(picture, by), by, languages, 0, 0.3);
    found = pass.found;
    done = 0.3;
    // what was read surely there tells the language for the closer reading
    if (!languages.length && found.some((f) => f.confidence >= 70 && f.text.length >= 6)) languages = pass.result.languages;
  }
  const negative = darkParts(large);
  const main = await read(large, factor, languages, done, negative ? 0.75 : 1);
  found = merge(found, main.found);
  if (!found.length) found = main.found;
  const used = languages.length ? languages : main.result.languages;
  if (negative) found = merge(found, (await read(negative, factor, used, 0.75, 1)).found);
  found = await wholeLines(picture, found, used, recognise, options);
  found = await labels(picture, found, used, recognise, options);
  found.sort((a, b) => bounds(a.quad)[1] - bounds(b.quad)[1] || bounds(a.quad)[0] - bounds(b.quad)[0]);
  return { boxes: found.map((f, i) => ({ id: `t${i}`, source: "ocr" as const, ...f })), languages: used };
}

/** how a line sits among the others decides which edge stays put when its length changes */
export function guessAlign(box: TextBox, boxes: readonly TextBox[], width: number): Align {
  if (Math.abs(angleOf(box.quad)) > 0.3) return "left";
  const [x0, y0, x1, y1] = bounds(box.quad);
  const h = y1 - y0;
  const near = boxes.filter((b) => b.id !== box.id).map((b) => bounds(b.quad)).filter((b) => Math.abs(b[1] - y0) < h * 9);
  const tolerance = Math.max(3, h * 0.35);
  const left = near.filter((b) => Math.abs(b[0] - x0) < tolerance).length;
  const right = near.filter((b) => Math.abs(b[2] - x1) < tolerance).length;
  const middle = near.filter((b) => Math.abs(b[0] + b[2] - x0 - x1) < tolerance * 2).length;
  if (right > left && right >= middle && /^[\p{Sc}\p{Nd}\s.,:%()+\-]+$/u.test(box.text)) return "right";
  if (left && left >= right && left >= middle) return "left";
  if (middle && middle >= right) return "center";
  if (right) return "right";
  if (Math.abs((x0 + x1) / 2 - width / 2) < width * 0.025 && x0 > width * 0.1) return "center";
  return "left";
}
