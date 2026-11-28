/** Exporting under a size limit: pictures get smaller step by step, text stays text. */
import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { Engine } from "../../src/engine/engine";
import { label, makePdf, open, pageText, savePng } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

/** a photo-like picture: smooth shapes with grain, so that it does not compress away to nothing */
function photo(width: number, height: number, alpha = false, gray = false): mupdf.Pixmap {
  const space = gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const pixmap = new mupdf.Pixmap(space, [0, 0, width, height], alpha);
  const data = pixmap.getPixels();
  const n = pixmap.getNumberOfComponents();
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * n;
      const base = [128 + 100 * Math.sin(x / 90), 128 + 100 * Math.cos(y / 70), 128 + 100 * Math.sin((x + y) / 150)];
      const grain = (random() - 0.5) * 50;
      for (let k = 0; k < (gray ? 1 : 3); k++) data[at + k] = Math.max(0, Math.min(255, base[k]! + grain));
      if (alpha) {
        const on = Math.hypot(x - width / 2, y - height / 2) < Math.min(width, height) / 2.2;
        data[at + n - 1] = on ? 255 : 0;
        if (!on) for (let k = 0; k < n - 1; k++) data[at + k] = 0;
      }
    }
  return pixmap;
}

async function scanned(): Promise<Engine> {
  const engine = await open(makePdf([{ size: [595, 842], content: label("Receipt number 4821", 40, 780) }]));
  const jpeg = photo(1600, 2000).asJPEG(94, false).slice();
  await engine.addObject({ kind: "image", page: 0, rect: [40, 90, 555, 730], data: jpeg });
  await engine.addObject({ kind: "image", page: 0, rect: [420, 20, 540, 80], data: photo(600, 300, true).asPNG().slice() });
  await engine.insertImagesAsPages([photo(1200, 900, false, true).asPNG().slice()], 1);
  return engine;
}

const picture = (bytes: Uint8Array, page = 0) => {
  const doc = new mupdf.PDFDocument(bytes.slice());
  const pix = doc.loadPage(page).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  return { pixels: pix.getPixels().slice(), width: pix.getWidth(), doc };
};

describe("export under a size limit", () => {
  it("reaches the limit step by step and keeps text, transparency and colours", async () => {
    const engine = await scanned();
    const full = await engine.exportPdf({ compress: true });
    expect(await engine.lastExportInfo()).toEqual({ bytes: full.length, reached: true, images: 0 });
    expect(full.length).toBeGreaterThan(900_000);
    const sizes: number[] = [];
    for (const maxBytes of [500_000, 200_000, 100_000]) {
      const out = await engine.exportPdf({ maxBytes });
      const info = (await engine.lastExportInfo())!;
      expect(info).toMatchObject({ bytes: out.length, maxBytes, reached: true });
      expect(out.length).toBeLessThanOrEqual(maxBytes);
      expect(info.images).toBeGreaterThan(0);
      sizes.push(info.dpi!);
      const result = picture(out);
      expect(result.doc.countPages()).toBe(2);
      expect(result.doc.loadPage(0).toStructuredText("").asText()).toContain("Receipt number 4821");
      // the picture still looks like the original, roughly
      const before = picture(full);
      let sum = 0;
      for (let i = 0; i < before.pixels.length; i++) sum += Math.abs(before.pixels[i]! - result.pixels[i]!);
      expect(sum / before.pixels.length).toBeLessThan(14);
      // the corner of the round transparent picture is still see-through
      const at = (22 * result.width + 423) * 3;
      expect([...result.pixels.subarray(at, at + 3)]).toEqual([255, 255, 255]);
      savePng(out, 0, `shrink-${maxBytes / 1000}k`);
    }
    // a tighter limit costs more resolution
    expect(sizes[0]!).toBeGreaterThan(sizes[2]!);
    // the open document is untouched
    expect((await engine.exportPdf({ compress: true })).length).toBe(full.length);
    expect(pageText(engine)).toContain("Receipt number 4821");
  });

  it("says so honestly when the limit cannot be reached, and leaves small files alone", async () => {
    const engine = await scanned();
    const out = await engine.exportPdf({ maxBytes: 4000 });
    const info = (await engine.lastExportInfo())!;
    expect(info.reached).toBe(false);
    expect(out.length).toBeGreaterThan(4000);
    expect(info.bytes).toBe(out.length);
    expect(out.length).toBeLessThan(120_000);

    await engine.exportPdf({ maxBytes: 50_000_000 });
    expect(await engine.lastExportInfo()).toMatchObject({ reached: true, images: 0 });

    const text = await open(makePdf());
    const small = await text.exportPdf({ maxBytes: 10 });
    expect(await text.lastExportInfo()).toMatchObject({ reached: false, images: 0, bytes: small.length });
  });

  it("keeps the password and page selection", async () => {
    const engine = await scanned();
    const out = await engine.exportPdf({ maxBytes: 250_000, password: "open sesame", pages: [0] });
    expect(out.length).toBeLessThanOrEqual(250_000);
    const doc = new mupdf.PDFDocument(out.slice());
    expect(doc.needsPassword()).toBe(true);
    expect(doc.authenticatePassword("open sesame")).toBeTruthy();
    expect(doc.countPages()).toBe(1);
  });
});
