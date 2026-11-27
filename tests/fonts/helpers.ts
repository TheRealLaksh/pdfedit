/** Test helpers: a bare engine context, drawing lines, rendering and extracting text with MuPDF. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { appendPageContent, ownResources } from "../../src/engine/content/page";
import { emptyState, type EngineContext } from "../../src/engine/context";
import { writeText, type WriteTextRequest, type WrittenText } from "../../src/engine/fonts";
import type { TextStyle } from "../../src/engine/types";
import { nodeAssets } from "./nodeAssets";

export const OUT = fileURLToPath(new URL("../../.tmp/fonts/", import.meta.url));

export function makeContext(width = 595, height = 842): EngineContext {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, width, height], 0, doc.newDictionary(), ""));
  let ids = 0;
  return {
    mupdf,
    doc,
    state: emptyState(),
    blobs: new Map(),
    userFonts: new Map(),
    assets: nodeAssets,
    cache: new Map(),
    newId: (p) => `${p}-${ids++}`,
  };
}

export const style = (extra: Partial<TextStyle> = {}): TextStyle => ({
  family: "Arial",
  bold: false,
  italic: false,
  serif: false,
  mono: false,
  size: 18,
  color: [0, 0, 0],
  ...extra,
});

/** draw one line with its baseline at (x, y), measured from the top left of the page */
export async function draw(
  ctx: EngineContext,
  text: string,
  x: number,
  y: number,
  extra: Partial<WriteTextRequest> = {},
  pageIndex = 0,
): Promise<WrittenText> {
  const page = ctx.doc.loadPage(pageIndex);
  const height = page.getBounds()[3];
  const written = await writeText(ctx, {
    text,
    style: style(),
    matrix: [1, 0, 0, 1, x, height - y],
    resources: ownResources(ctx.doc, page),
    ...extra,
  });
  appendPageContent(ctx.doc, page, written.ops);
  page.destroy();
  return written;
}

export function savePng(ctx: EngineContext, name: string, scale = 2, pageIndex = 0): string {
  const page = ctx.doc.loadPage(pageIndex);
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
  mkdirSync(OUT, { recursive: true });
  const file = `${OUT}${name}.png`;
  writeFileSync(file, pixmap.asPNG());
  pixmap.destroy();
  page.destroy();
  return file;
}

/** the lines MuPDF extracts, in content order */
export function extractLines(doc: mupdf.PDFDocument, pageIndex = 0, options = ""): string[] {
  const page = doc.loadPage(pageIndex);
  const stext = page.toStructuredText(options);
  const lines = stext.asText().split("\n").filter((l) => l.length);
  stext.destroy();
  page.destroy();
  return lines;
}

/** save and open again, like a real export */
export function reopen(doc: mupdf.PDFDocument, options = "compress"): mupdf.PDFDocument {
  const bytes = doc.saveToBuffer(options).asUint8Array().slice();
  return new mupdf.PDFDocument(bytes);
}
