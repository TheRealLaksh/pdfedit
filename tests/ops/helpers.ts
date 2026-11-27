import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { expect } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { MutationResult, Rect } from "../../src/engine/types";

export const OUT = ".tmp/ops";
mkdirSync(OUT, { recursive: true });

export interface PageSpec {
  content?: string;
  size?: [number, number];
  rotate?: 0 | 90 | 180 | 270;
  crop?: Rect;
}

/** a small document; /F1 is Helvetica on every page */
export function makePdf(pages: PageSpec[] = [{}], extra?: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  pages.forEach((spec, i) => {
    const [w, h] = spec.size ?? [300, 400];
    const resources = doc.addObject({ Font: { F1: font } });
    const page = doc.addPage([0, 0, w, h], spec.rotate ?? 0, resources, spec.content ?? label(`Page ${i + 1}`));
    if (spec.crop) page.put("CropBox", spec.crop);
    doc.insertPage(i, page);
  });
  extra?.(doc);
  const bytes = doc.saveToBuffer("").asUint8Array().slice();
  doc.destroy();
  return bytes;
}

export const label = (text: string, x = 40, y = 340, size = 20) =>
  `BT /F1 ${size} Tf 0 g ${x} ${y} Td (${text}) Tj ET`;

export async function open(bytes: Uint8Array, engine = new Engine(), password?: string): Promise<Engine> {
  const result = await engine.open(bytes, "test.pdf", password);
  expect(result.status).toBe("ok");
  return engine;
}

export interface Shot {
  width: number;
  height: number;
  at(x: number, y: number): number[];
  /** share of pixels in the page space rect that differ clearly from white */
  ink(rect: Rect): number;
}

export async function shot(engine: Engine, page: number, name?: string): Promise<Shot> {
  const r = await engine.renderPage(page, 1);
  if (name) savePng(engine.context.doc, page, name);
  const at = (x: number, y: number) => {
    const i = (Math.floor(y) * r.width + Math.floor(x)) * 4;
    return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!];
  };
  return {
    width: r.width,
    height: r.height,
    at,
    ink([x0, y0, x1, y1]) {
      let n = 0;
      let total = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          total++;
          const [a, b, c] = at(x, y);
          if (a! + b! + c! < 700) n++;
        }
      return n / total;
    },
  };
}

export function savePng(source: mupdf.PDFDocument | Uint8Array, page: number, name: string) {
  const doc = source instanceof Uint8Array ? new mupdf.PDFDocument(source.slice()) : source;
  const p = doc.loadPage(page);
  const pix = p.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  writeFileSync(`${OUT}/${name}.png`, pix.asPNG());
  pix.destroy();
  p.destroy();
}

export function load(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes.slice(), "application/pdf") as mupdf.PDFDocument;
  if (password !== undefined) expect(doc.authenticatePassword(password)).toBeGreaterThan(0);
  return doc;
}

export function pageText(source: Engine | mupdf.PDFDocument | Uint8Array, page = 0): string {
  const doc = source instanceof Engine ? source.context.doc : source instanceof Uint8Array ? load(source) : source;
  const p = doc.loadPage(page);
  const out = p.toStructuredText("preserve-whitespace").asText().trim();
  p.destroy();
  return out;
}

export const pageTexts = (engine: Engine) =>
  Array.from({ length: engine.context.doc.countPages() }, (_, i) => pageText(engine, i));

/** every string and decoded stream of a saved file, to prove that something is really gone */
export function everything(bytes: Uint8Array): string {
  const doc = new mupdf.PDFDocument(bytes.slice());
  const parts: string[] = [Buffer.from(bytes).toString("latin1")];
  const strings = (o: mupdf.PDFObject, depth: number) => {
    if (depth > 12) return;
    if (o.isString()) parts.push(o.asString());
    else if ((o.isArray() || o.isDictionary()) && !(depth > 0 && o.isIndirect()))
      o.forEach((v) => strings(v, depth + 1));
  };
  for (let i = 1; i < doc.countObjects(); i++) {
    const ref = doc.newIndirect(i);
    strings(ref.resolve(), 0);
    if (ref.isStream()) {
      try {
        parts.push(Buffer.from(ref.readStream().asUint8Array()).toString("latin1"));
      } catch {
        /* not decodable */
      }
    }
  }
  return parts.join("\n");
}

/** everything a user could observe about the open document */
async function fingerprint(engine: Engine): Promise<string> {
  const hash = createHash("sha1");
  const doc = engine.context.doc;
  hash.update(String(doc.countPages()));
  for (let i = 0; i < doc.countPages(); i++) {
    const r = await engine.renderPage(i, 0.75);
    hash.update(`${r.width}x${r.height}`);
    hash.update(r.data);
    hash.update(pageText(engine, i));
    const p = doc.loadPage(i);
    hash.update(JSON.stringify(p.getLinks().map((l) => [l.getBounds(), l.getURI()])));
    hash.update(p.getObject().get("Contents").isNull() ? "" : "c");
    p.destroy();
    hash.update(JSON.stringify(await engine.listImages(i)));
  }
  hash.update(JSON.stringify(await engine.listFormFields()));
  hash.update(JSON.stringify(engine.context.state));
  return hash.digest("hex");
}

/** run a mutation and prove that undo restores the old document exactly and redo the new one */
export async function undoable(engine: Engine, mutate: () => Promise<MutationResult>): Promise<MutationResult> {
  const before = await fingerprint(engine);
  const result = await mutate();
  const after = await fingerprint(engine);
  const undone = await engine.undo();
  expect(await fingerprint(engine), "undo restores the previous document").toBe(before);
  expect(undone.canRedo).toBe(true);
  await engine.redo();
  expect(await fingerprint(engine), "redo restores the change").toBe(after);
  return result;
}

export function pngBytes(
  width: number,
  height: number,
  paint: (x: number, y: number) => number[],
  alpha = false,
): Uint8Array {
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], alpha);
  const px = pm.getPixels();
  const n = alpha ? 4 : 3;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set(paint(x, y), (y * width + x) * n);
  const out = pm.asPNG().slice();
  pm.destroy();
  return out;
}
