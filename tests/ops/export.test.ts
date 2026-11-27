import { writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { imagePageSize } from "../../src/engine/ops/pages";
import { readingOrder } from "../../src/engine/ops/readingOrder";
import { breakUnits } from "../../src/engine/ops/textLayout";
import type { PageNumberOptions, Rect, TextStyle } from "../../src/engine/types";
import { label, load, makePdf, open, OUT, pageText, savePng, shot, undoable } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

const style: TextStyle = { family: "Helvetica", bold: false, italic: false, serif: false, mono: false, size: 12, color: [0, 0, 0] };
const mixed = () =>
  makePdf([{ content: "" }, { content: "", rotate: 90 }, { content: "", size: [600, 200] }, { content: "", rotate: 270, crop: [10, 10, 250, 330] }]);

describe("stamps", () => {
  it("draws a watermark across pages of any shape, shrinking it to fit", async () => {
    const engine = await open(mixed());
    await undoable(engine, () =>
      engine.addWatermark({
        text: "CONFIDENTIAL DRAFT", style: { ...style, size: 72, color: [1, 0, 0] }, opacity: 0.4, angle: 45,
      }),
    );
    for (let i = 0; i < 4; i++) {
      const s = await shot(engine, i, `watermark-${i}`);
      let n = 0;
      let outside = 0;
      let rising = 0;
      for (let y = 0; y < s.height; y += 2)
        for (let x = 0; x < s.width; x += 2) {
          const [r, g] = s.at(x, y);
          if (r! > 240 && g! < 200) {
            n++;
            expect(g).toBeGreaterThan(130); // 40 % red over white
            if (x < 2 || y < 2 || x > s.width - 3 || y > s.height - 3) outside++;
            rising += (x - s.width / 2) * (y - s.height / 2);
          }
        }
      expect(n).toBeGreaterThan(50);
      expect(outside).toBe(0);
      expect(rising, "counter clockwise: up to the right").toBeLessThan(0);
      expect(pageText(engine, i).replace(/\s/g, "")).toContain("CONFIDENTIAL");
    }
  });

  it("numbers pages in the chosen corner", async () => {
    const engine = await open(mixed());
    const options: PageNumberOptions = {
      format: "{n} / {total}", position: "bottom-right", style, margin: 20, startAt: 1, pages: [1, 2, 3],
    };
    await undoable(engine, () => engine.addPageNumbers(options));
    expect(pageText(engine, 0)).toBe("");
    expect([1, 2, 3].map((i) => pageText(engine, i))).toEqual(["1 / 3", "2 / 3", "3 / 3"]);
    for (const i of [1, 2, 3]) {
      const s = await shot(engine, i, i === 3 ? "numbers" : undefined);
      expect(s.ink([s.width - 60, s.height - 35, s.width - 18, s.height - 18])).toBeGreaterThan(0.03);
      expect(s.ink([0, 0, s.width - 80, s.height])).toBe(0);
    }
    await engine.addPageNumbers({ ...options, position: "top-center", startAt: 5, pages: [0], format: "Page {n}" });
    expect(pageText(engine, 0)).toBe("Page 5");
    const s = await shot(engine, 0);
    expect(s.ink([130, 20, 170, 34])).toBeGreaterThan(0.05);
  });
});

describe("export", () => {
  it("sets the modification date and leaves producer and creation date alone", async () => {
    const source = (() => {
      const d = new mupdf.PDFDocument(makePdf([{}]));
      d.setMetaData("info:Producer", "Original Producer");
      d.setMetaData("info:CreationDate", "D:20200101000000Z");
      d.setMetaData("info:ModDate", "D:20200101000000Z");
      const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description xmp:CreateDate="2020-01-01T00:00:00Z"><xmp:ModifyDate>2020-01-01T00:00:00Z</xmp:ModifyDate><xmp:MetadataDate>2020-01-01T00:00:00Z</xmp:MetadataDate><dc:title>सामग्री</dc:title></rdf:Description></x:xmpmeta>`;
      d.getTrailer().get("Root").put("Metadata", d.addRawStream(Buffer.from(xmp, "utf8"), { Type: "Metadata", Subtype: "XML" }));
      return d.saveToBuffer("").asUint8Array().slice();
    })();
    const engine = await open(source);
    const out = load(await engine.exportPdf());
    const year = String(new Date().getFullYear());
    expect(out.getMetaData("info:ModDate")).toMatch(new RegExp(`^D:${year}\\d{10}[+-]\\d\\d'\\d\\d'$`));
    expect(out.getMetaData("info:Producer")).toBe("Original Producer");
    expect(out.getMetaData("info:CreationDate")).toBe("D:20200101000000Z");
    const xmp = Buffer.from(out.getTrailer().get("Root", "Metadata").readStream().asUint8Array()).toString("utf8");
    expect(xmp).toContain(`<xmp:ModifyDate>${year}-`);
    expect(xmp).toContain(`<xmp:MetadataDate>${year}-`);
    expect(xmp).toContain('xmp:CreateDate="2020-01-01T00:00:00Z"');
    expect(xmp).toContain("सामग्री");
    // exporting changes nothing in the open document
    expect(engine.context.doc.getMetaData("info:ModDate")).toBe("D:20200101000000Z");
    expect(engine.context.doc.canUndo()).toBe(false);
  });

  it("protects with a password, including awkward ones", async () => {
    const engine = await open(makePdf([{}]));
    for (const password of ["test1234", 'co,mma "quote" =sign', "पासवर्ड 密码"]) {
      const bytes = await engine.exportPdf({ password });
      const doc = mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
      expect(doc.needsPassword()).toBe(true);
      expect(doc.authenticatePassword("wrong")).toBe(0);
      expect(doc.authenticatePassword(password.split(",")[0]! + "x")).toBe(0);
      expect(doc.authenticatePassword(password)).toBeGreaterThan(0);
      expect(pageText(doc)).toBe("Page 1");
      expect(doc.getTrailer().get("Encrypt", "V").asNumber()).toBe(5);
    }
    await expect(engine.exportPdf({ password: "x".repeat(200) })).rejects.toThrow(/too long/);
    expect(load(await engine.exportPdf({ password: "" })).needsPassword()).toBe(false);
  });

  it("compresses, selects pages and flattens", async () => {
    const engine = await open(makePdf([{}, {}, {}]));
    await engine.addObject({ kind: "rect", page: 2, rect: [10, 10, 60, 60], fill: [1, 0, 0], stroke: null });
    const plain = await engine.exportPdf();
    const small = await engine.exportPdf({ compress: true });
    expect(small.length).toBeLessThanOrEqual(plain.length);
    const some = load(await engine.exportPdf({ pages: [2, 0], compress: true, flatten: true }));
    expect(some.countPages()).toBe(2);
    expect(pageText(some, 0)).toBe("Page 3");
    expect(pageText(some, 1)).toBe("Page 1");
    savePng(some, 0, "export-subset");
    await expect(engine.exportPdf({ pages: [9] })).rejects.toThrow();
    await expect(engine.exportPdf({ pages: [] })).rejects.toThrow();
    expect(engine.context.doc.countPages()).toBe(3);
  });

  it("flattens comments into the page", async () => {
    const engine = await open(makePdf([{ content: "" }], (doc) => {
      const page = doc.loadPage(0);
      const a = page.createAnnotation("Square");
      a.setRect([50, 50, 100, 100]);
      a.setInteriorColor([0, 0, 1]);
      a.update();
    }));
    const out = load(await engine.exportPdf({ flatten: true }));
    const p = out.loadPage(0);
    expect(p.getAnnotations()).toHaveLength(0);
    const pm = p.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
    expect([...pm.getPixels().slice(75 * pm.getStride() + 75 * 3, 75 * pm.getStride() + 75 * 3 + 3)]).toEqual([0, 0, 255]);
  });

  it("exports page images", async () => {
    const engine = await open(makePdf([{ rotate: 90 }]));
    const png = await engine.exportPageImage(0, 144, "png");
    const jpeg = await engine.exportPageImage(0, 72, "jpeg");
    expect([...png.slice(1, 4)]).toEqual([80, 78, 71]);
    expect([...jpeg.slice(0, 2)]).toEqual([0xff, 0xd8]);
    const a = new mupdf.Image(png);
    expect([a.getWidth(), a.getHeight(), a.getXResolution()]).toEqual([800, 600, 144]);
    expect(new mupdf.Image(jpeg).getWidth()).toBe(400);
    const huge = new mupdf.Image(await engine.exportPageImage(0, 100000, "jpeg"));
    expect(huge.getWidth() * huge.getHeight()).toBeLessThan(49_000_000);
    writeFileSync(`${OUT}/export-page.png`, png);
  });

  it("exports text in reading order: columns apart, table rows together", async () => {
    const line = (t: string, x: number, y: number) => label(t, x, y, 10);
    const content = [
      line("Title across both columns of this page", 60, 380),
      // two columns, drawn row by row as many producers do
      ...[0, 1, 2].flatMap((i) => [
        line(`left column line number ${i + 1} text`, 20, 340 - i * 14),
        line(`right column line number ${i + 1} text`, 200, 340 - i * 14),
      ]),
      line("Total", 200, 200), line("Item", 20, 220), line("Qty", 200, 220), line("Sum", 20, 200),
    ].join("\n");
    const engine = await open(makePdf([{ content, size: [420, 400] }, { content: line("second page", 20, 300) }]));
    const lines = (await engine.exportText()).split("\n").map((l) => l.trim());
    expect(lines).toEqual([
      "Title across both columns of this page",
      "left column line number 1 text", "left column line number 2 text", "left column line number 3 text",
      "right column line number 1 text", "right column line number 2 text", "right column line number 3 text",
      "Item\tQty", "Sum\tTotal", "", "second page",
    ]);
    expect(await engine.exportText([1])).toBe("second page");
  });
});

describe("helpers", () => {
  const box = (x: number, y: number, w = 20): Rect => [x, y, x + w, y + 10];

  it("orders right to left rows and columns", () => {
    expect(
      readingOrder([
        { text: "ב", rect: box(0, 0), dir: "rtl" },
        { text: "א", rect: box(200, 0), dir: "rtl" },
      ]),
    ).toEqual(["א\tב"]);
    const columns = [0, 1].flatMap((i) => [
      { text: `L${i}`, rect: box(0, i * 14, 150), dir: "rtl" as const },
      { text: `R${i}`, rect: box(200, i * 14, 150), dir: "rtl" as const },
    ]);
    expect(readingOrder(columns)).toEqual(["R0", "R1", "L0", "L1"]);
  });

  it("breaks lines where each script allows", () => {
    expect(breakUnits("Hello, world (again) e.g. -5")).toEqual(["Hello, ", "world ", "(again) ", "e.g. ", "-5"]);
    expect(breakUnits("well-known")).toEqual(["well-", "known"]);
    expect(breakUnits("这是中文。好的")).toEqual(["这", "是", "中", "文。", "好", "的"]);
    expect(breakUnits("ภาษาไทยง่าย").length).toBeGreaterThan(1);
    expect(breakUnits("हिन्दी भाषा")).toEqual(["हिन्दी ", "भाषा"]);
  });

  it("sizes pages made from images", () => {
    expect(imagePageSize(2480, 3508, 300).map(Math.round)).toEqual([595, 842]);
    expect(imagePageSize(4000, 3000, 72)).toEqual([842, 631.5]);
  });
});
