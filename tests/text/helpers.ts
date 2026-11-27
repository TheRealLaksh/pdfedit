/** Shared helpers for the text engine tests: PDF builders, an Engine, rendering and pixel diffs. */
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { createAssetLoader } from "../../src/engine/context";
import { Engine } from "../../src/engine/engine";
import type { Rect, TextLine } from "../../src/engine/types";

export const OUT = path.resolve(".tmp/text");
fs.mkdirSync(OUT, { recursive: true });

export const noNetwork = createAssetLoader(async (url) => {
  throw new Error(`network disabled in text tests: ${url}`);
});

export async function open(bytes: Uint8Array, assets = noNetwork): Promise<Engine> {
  const engine = new Engine(assets);
  const result = await engine.open(bytes, "test.pdf");
  if (result.status !== "ok") throw new Error("could not open");
  return engine;
}

export interface PageSpec {
  content: string;
  /** font resource name -> factory */
  fonts?: Record<string, (doc: mupdf.PDFDocument) => mupdf.PDFObject>;
  resources?: (doc: mupdf.PDFDocument, resources: mupdf.PDFObject) => void;
  rotate?: 0 | 90 | 180 | 270;
  size?: [number, number];
}

export const standard =
  (name: string, encoding: string | null = "WinAnsiEncoding") =>
  (doc: mupdf.PDFDocument) => {
    const dict = doc.newDictionary();
    dict.put("Type", doc.newName("Font"));
    dict.put("Subtype", doc.newName("Type1"));
    dict.put("BaseFont", doc.newName(name));
    if (encoding) dict.put("Encoding", doc.newName(encoding));
    return doc.addObject(dict);
  };

export function build(...pages: PageSpec[]): Uint8Array {
  const doc = new mupdf.PDFDocument();
  for (const spec of pages) {
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    for (const [name, make] of Object.entries(spec.fonts ?? { F1: standard("Helvetica") })) fonts.put(name, make(doc));
    resources.put("Font", fonts);
    spec.resources?.(doc, resources);
    const [w, h] = spec.size ?? [400, 300];
    const page = doc.addPage([0, 0, w, h], spec.rotate ?? 0, doc.addObject(resources), spec.content);
    doc.insertPage(-1, page);
  }
  return doc.saveToBuffer("").asUint8Array().slice();
}

export interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export const SCALE = 2;

export async function render(engine: Engine, page = 0): Promise<Image> {
  const r = await engine.renderPage(page, SCALE);
  return { width: r.width, height: r.height, data: r.data };
}

export function savePng(engine: Engine, name: string, page = 0, scale = SCALE) {
  const p = engine.context.doc.loadPage(page);
  const pix = p.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
  fs.writeFileSync(path.join(OUT, `${name}.png`), pix.asPNG());
  pix.destroy();
  p.destroy();
}

/** number of differing pixels outside the given page-space rectangles */
export function diffOutside(a: Image, b: Image, rects: Rect[], margin = 1.5): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let n = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) <= 24) continue;
      const px = x / SCALE;
      const py = y / SCALE;
      if (!rects.some((r) => px >= r[0] - margin && px <= r[2] + margin && py >= r[1] - margin && py <= r[3] + margin)) n++;
    }
  return n;
}

export const diffAll = (a: Image, b: Image) => diffOutside(a, b, []);

/** plain text as MuPDF extracts it, whitespace collapsed per line */
export function extract(engine: Engine, page = 0): string {
  const p = engine.context.doc.loadPage(page);
  const text = p.toStructuredText("preserve-whitespace").asText();
  p.destroy();
  return text.replace(/[ \t]+/g, " ").trim();
}

export async function lines(engine: Engine, page = 0): Promise<TextLine[]> {
  return (await engine.getPageText(page)).lines;
}

export async function line(engine: Engine, containing: string, page = 0): Promise<TextLine> {
  const all = await lines(engine, page);
  const found = all.find((l) => l.text.includes(containing));
  if (!found) throw new Error(`no line containing ${containing}: ${JSON.stringify(all.map((l) => l.text))}`);
  return found;
}

/** re-open the exported bytes, as a user would */
export async function reopen(engine: Engine): Promise<Engine> {
  const bytes = engine.context.doc.saveToBuffer("").asUint8Array().slice();
  return open(bytes);
}

/** page content as latin-1 text */
export function content(engine: Engine, page = 0): string {
  const p = engine.context.doc.loadPage(page);
  const c = p.getObject().get("Contents");
  const streams = c.isArray() ? Array.from({ length: c.length }, (_, i) => c.get(i)) : [c];
  return streams.map((s) => Buffer.from(s.readStream().asUint8Array()).toString("latin1")).join("\n");
}

export const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
