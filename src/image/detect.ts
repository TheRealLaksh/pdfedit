/** Finds the lines of text in a picture: OCR passes, cut into separate pieces, as quads in picture pixels. */
import { joinWords } from "../ocr/convert";
import type { OcrLine, OcrPageResult, RenderedPage } from "../engine/types";
import { angleOf, bounds, quadSize, rectQuad, rotateQuad } from "./geometry";
import type { Align, Picture, Quad4, TextBox } from "./types";

export type Recognise = (
  image: RenderedPage,
  options: { languages: string[]; scale: number; signal?: AbortSignal; onProgress?: (p: { status: string; progress: number }) => void },
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
    out.push({ quad, text, confidence });
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
    const worth = (f: Found) => f.text.length * Math.max(0, f.confidence - 35);
    if (clash.length && worth(found) <= clash.reduce((s, c) => s + worth(c), 0) * 1.15) continue;
    for (const c of clash) out.splice(out.indexOf(c), 1);
    out.push(found);
  }
  return out;
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
      { languages, scale: SCALE, signal: options.signal, onProgress: (r) => options.onProgress?.(r.status, from + (to - from) * r.progress) },
    );
    return { result, found: result.lines.flatMap((l) => pieces(l, SCALE / by, picture)) };
  };
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
