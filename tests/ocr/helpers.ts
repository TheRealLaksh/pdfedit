/** Test material: text pages typeset by Chromium (correct shaping in every script), then "scanned". */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { chromium, type Browser } from "playwright";
import type { RenderedPage } from "../../src/engine/types";

export const OUT = join(process.cwd(), ".tmp", "ocr");
export const TESSDATA = join(OUT, "tessdata");
mkdirSync(TESSDATA, { recursive: true });
mkdirSync(join(OUT, "scans"), { recursive: true });

export interface Sample {
  lang: string;
  dir?: "rtl";
  font: string;
  lines: string[];
}

export const SAMPLES: Record<string, Sample> = {
  eng: {
    lang: "en",
    font: "'Times New Roman', serif",
    lines: [
      "Quarterly Report of the Harbour Committee",
      "The committee met on 14 March and approved the budget.",
      "Total spending was 48,250 pounds, which is 7% below plan.",
      "Repairs to the northern pier will begin early next summer.",
      "Please send written comments to the secretary by Friday.",
    ],
  },
  hin: {
    lang: "hi",
    font: "'Nirmala UI', 'Mangal', sans-serif",
    lines: [
      "भारत एक विशाल देश है",
      "यहाँ अनेक भाषाएँ बोली जाती हैं और लोग मिलकर रहते हैं।",
      "विद्यालय सुबह आठ बजे खुलता है।",
      "कृपया अपना आवेदन शुक्रवार तक जमा करें।",
      "किसान खेत में गेहूँ की फसल काट रहा है।",
    ],
  },
  ara: {
    lang: "ar",
    dir: "rtl",
    font: "'Arial', 'Segoe UI', sans-serif",
    lines: [
      "التقرير السنوي للمكتبة العامة",
      "تفتح المكتبة أبوابها كل يوم من الساعة الثامنة صباحا.",
      "يمكن للطلاب استعارة خمسة كتب لمدة أسبوعين.",
      "نرجو من الزوار المحافظة على الهدوء داخل القاعة.",
      "شكرا لكم على تعاونكم الدائم معنا.",
    ],
  },
  chi_sim: {
    lang: "zh-CN",
    font: "'Microsoft YaHei', 'SimSun', sans-serif",
    lines: [
      "城市图书馆年度报告",
      "图书馆每天上午八点开门，晚上九点关门。",
      "学生可以借阅五本书，借期为两个星期。",
      "请读者在阅览室内保持安静。",
      "感谢大家一直以来的支持与合作。",
    ],
  },
  tam: {
    lang: "ta",
    font: "'Nirmala UI', 'Latha', sans-serif",
    lines: [
      "தமிழ் ஒரு பழமையான மொழி",
      "நூலகம் காலை எட்டு மணிக்கு திறக்கப்படும்.",
      "மாணவர்கள் ஐந்து புத்தகங்களை எடுக்கலாம்.",
      "தயவுசெய்து அமைதியைக் கடைப்பிடிக்கவும்.",
      "உங்கள் ஒத்துழைப்புக்கு மிக்க நன்றி.",
    ],
  },
  rus: {
    lang: "ru",
    font: "'Times New Roman', serif",
    lines: [
      "Годовой отчёт городской библиотеки",
      "Библиотека открывается каждый день в восемь часов утра.",
      "Студенты могут взять пять книг на две недели.",
      "Просим посетителей соблюдать тишину в читальном зале.",
      "Благодарим вас за постоянную поддержку.",
    ],
  },
};

let browser: Promise<Browser> | null = null;
export function launch(): Promise<Browser> {
  return (browser ??= chromium.launch());
}
export async function closeBrowser(): Promise<void> {
  if (browser) await (await browser).close();
  browser = null;
}

export const PAGE_W = 420;
export const PAGE_H = 300;

export interface Bitmap {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel */
  data: Uint8Array;
}

export function decode(png: Uint8Array): Bitmap {
  const image = new mupdf.Image(png);
  const pix = image.toPixmap();
  const width = pix.getWidth();
  const height = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const stride = pix.getStride();
  const src = pix.getPixels();
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = y * stride + x * n;
      const d = (y * width + x) * 3;
      data[d] = src[s]!;
      data[d + 1] = src[s + (n >= 3 ? 1 : 0)]!;
      data[d + 2] = src[s + (n >= 3 ? 2 : 0)]!;
    }
  }
  pix.destroy();
  image.destroy();
  return { width, height, data };
}

export interface TypesetOptions {
  ppi?: number;
  fontSize?: number;
  extraHtml?: string;
}

/** CSS pixels equal PDF points on the page (420 x 300) */
export async function typeset(sample: Sample, name: string, options: TypesetOptions = {}): Promise<Bitmap> {
  const { ppi = 300, fontSize = 13, extraHtml = "" } = options;
  const cache = join(OUT, "scans", `${name}.src.png`);
  const html = `<!doctype html><html lang="${sample.lang}" dir="${sample.dir ?? "ltr"}"><meta charset="utf-8">
<body style="margin:0;width:${PAGE_W}px;height:${PAGE_H}px;background:#fff;color:#161616;font-family:${sample.font};overflow:hidden">
<div style="position:absolute;left:34px;right:34px;top:28px">
${sample.lines
  .map(
    (l, i) =>
      `<div style="font-size:${i === 0 ? fontSize + 4 : fontSize}px;font-weight:${i === 0 ? 700 : 400};line-height:${i === 0 ? 40 : 32}px;white-space:nowrap">${l}</div>`,
  )
  .join("")}
</div>${extraHtml}</body></html>`;
  const key = `${ppi}|${html}`;
  const keyFile = `${cache}.key`;
  if (existsSync(cache) && existsSync(keyFile) && readFileSync(keyFile, "utf8") === key) return decode(readFileSync(cache));
  const context = await (await launch()).newContext({
    viewport: { width: PAGE_W, height: PAGE_H },
    deviceScaleFactor: ppi / 72,
  });
  const page = await context.newPage();
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: "png" });
  await context.close();
  writeFileSync(cache, png);
  writeFileSync(keyFile, key);
  return decode(png);
}

export interface ScanLook {
  paper?: [number, number, number];
  /** sigma of the grain in grey levels */
  noise?: number;
  /** degrees, clockwise */
  skew?: number;
  /** fraction of darkening from the top-left to the bottom-right corner */
  shade?: number;
  speckle?: number;
}

export function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** make a clean typeset bitmap look like it came out of a scanner */
export function degrade(src: Bitmap, look: ScanLook): Bitmap {
  const { paper = [255, 255, 255], noise = 0, skew = 0, shade = 0, speckle = 0 } = look;
  const { width, height } = src;
  const rnd = random(12345);
  const a = (skew * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const sx = dx * cos + dy * sin + width / 2;
      const sy = -dx * sin + dy * cos + height / 2;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const light = 1 - shade * ((x / width + y / height) / 2);
      const grain = noise ? Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()) * noise : 0;
      const speck = speckle && rnd() < speckle ? 0.25 : 1;
      for (let c = 0; c < 3; c++) {
        const at = (px: number, py: number) =>
          px < 0 || py < 0 || px >= width || py >= height ? 255 : src.data[(py * width + px) * 3 + c]!;
        const v =
          (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
          (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
        data[(y * width + x) * 3 + c] = Math.max(0, Math.min(255, ((v * paper[c]!) / 255) * light * speck + grain));
      }
    }
  }
  return { width, height, data };
}

export function toRendered(bitmap: Bitmap, page = 0): RenderedPage {
  const data = new Uint8ClampedArray(bitmap.width * bitmap.height * 4);
  for (let i = 0, j = 0; j < data.length; i += 3, j += 4) {
    data[j] = bitmap.data[i]!;
    data[j + 1] = bitmap.data[i + 1]!;
    data[j + 2] = bitmap.data[i + 2]!;
    data[j + 3] = 255;
  }
  return { page, revision: 1, width: bitmap.width, height: bitmap.height, data };
}

export function pixmapFrom(bitmap: Bitmap, gray = false): mupdf.Pixmap {
  const pix = new mupdf.Pixmap(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, bitmap.width, bitmap.height], false);
  const out = pix.getPixels();
  const stride = pix.getStride();
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      const s = (y * bitmap.width + x) * 3;
      if (gray) out[y * stride + x] = (bitmap.data[s]! * 77 + bitmap.data[s + 1]! * 150 + bitmap.data[s + 2]! * 29) >> 8;
      else {
        out[y * stride + x * 3] = bitmap.data[s]!;
        out[y * stride + x * 3 + 1] = bitmap.data[s + 1]!;
        out[y * stride + x * 3 + 2] = bitmap.data[s + 2]!;
      }
    }
  }
  return pix;
}

export function savePng(bitmap: Bitmap, name: string): void {
  const pix = pixmapFrom(bitmap);
  writeFileSync(join(OUT, name), pix.asPNG());
  pix.destroy();
}

export interface ScanPdfOptions {
  gray?: boolean;
  jpeg?: number;
  rotate?: 0 | 90 | 180 | 270;
  /** page size in points; default 420 x 300 */
  size?: [number, number];
}

/**
 * A one page image-only PDF. With `rotate` the image is stored turned and the page carries /Rotate, so
 * that it still displays upright (what many scanners produce).
 */
export function scanPdf(bitmap: Bitmap, options: ScanPdfOptions = {}): Uint8Array {
  const { gray = false, jpeg = 82, rotate = 0 } = options;
  const [w, h] = options.size ?? [PAGE_W, PAGE_H];
  const pix = pixmapFrom(bitmap, gray);
  const image = jpeg ? new mupdf.Image(pix.asJPEG(jpeg).slice()) : new mupdf.Image(pix);
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const xobjects = doc.newDictionary();
  xobjects.put("Im0", doc.addImage(image));
  resources.put("XObject", xobjects);
  const swap = rotate === 90 || rotate === 270;
  const [mw, mh] = swap ? [h, w] : [w, h];
  // place the upright picture so that rotating the page clockwise shows it upright
  const cm =
    rotate === 0
      ? `${w} 0 0 ${h} 0 0`
      : rotate === 90
        ? `0 ${w} ${-h} 0 ${h} 0`
        : rotate === 180
          ? `${-w} 0 0 ${-h} ${w} ${h}`
          : `0 ${-w} ${h} 0 0 ${w}`;
  const page = doc.addPage([0, 0, mw, mh], rotate, resources, `q ${cm} cm /Im0 Do Q`);
  doc.insertPage(-1, page);
  const bytes = doc.saveToBuffer("compress").asUint8Array().slice();
  doc.destroy();
  return bytes;
}

export function render(doc: mupdf.PDFDocument, pageIndex = 0, scale = 300 / 72): RenderedPage {
  const page = doc.loadPage(pageIndex);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true);
  const width = pix.getWidth();
  const height = pix.getHeight();
  const data = new Uint8ClampedArray(pix.getPixels()) as Uint8ClampedArray<ArrayBuffer>;
  pix.destroy();
  page.destroy();
  return { page: pageIndex, revision: 1, width, height, data };
}

export function savePage(doc: mupdf.PDFDocument, name: string, pageIndex = 0, scale = 3): void {
  const page = doc.loadPage(pageIndex);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
  writeFileSync(join(OUT, name), pix.asPNG());
  pix.destroy();
  page.destroy();
}

/** Levenshtein distance over code points */
export function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length]!;
}

/** character accuracy ignoring white space and punctuation width differences */
export function accuracy(expected: string, actual: string): number {
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/ё/g, "е");
  const e = norm(expected);
  return e.length ? Math.max(0, 1 - distance(e, norm(actual)) / [...e].length) : 0;
}
