import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import type { Engine } from "../../src/engine/engine";
import type { Rect, TextStyle } from "../../src/engine/types";
import { quadToRect } from "../../src/engine/geom";
import { everything, load, makePdf, open, pageText, pngBytes, savePng, shot, undoable } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

const style: TextStyle = { family: "Helvetica", bold: false, italic: false, serif: false, mono: false, size: 14, color: [0, 0, 0] };

/** page space box around the first hit of `needle` */
function find(engine: Engine, needle: string, page = 0): Rect {
  const p = engine.context.doc.loadPage(page);
  const stext = p.toStructuredText("preserve-whitespace");
  const hits = stext.search(needle, {});
  stext.destroy();
  p.destroy();
  expect(hits.length, needle).toBeGreaterThan(0);
  const [x0, y0, x1, y1] = quadToRect(hits[0]![0]!);
  return [x0 + 0.5, y0 + 2, x1 - 0.5, y1 - 2];
}

describe("redaction", () => {
  it("removes text and every copy of it", async () => {
    const source = makePdf([{ content: "" }], (doc) => {
      const font = doc.findPage(0).get("Resources", "Font", "F1");
      const form = doc.addStream(
        "/Span <</ActualText (formSECRET3)>> BDC BT /F1 14 Tf 40 250 Td (formSECRET3) Tj ET EMC BT /F1 14 Tf 200 250 Td (formkeep) Tj ET",
        { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 400], Resources: { Font: { F1: font } } },
      );
      const resources = doc.findPage(0).get("Resources");
      resources.put("XObject", { Fm: form });
      resources.put("Properties", { P1: { MCID: 1, ActualText: doc.newString("propSECRET2") } });
      doc.findPage(0).put(
        "Contents",
        doc.addStream(
          [
            "BT /F1 14 Tf 40 350 Td (visible SECRET1 stays) Tj ET",
            "/Span <</MCID 0 /ActualText (SECRET1)>> BDC BT /F1 14 Tf 40 320 Td (SECRET1) Tj ET EMC",
            "/Span /P1 BDC BT /F1 14 Tf 40 290 Td (propSECRET2) Tj 150 0 Td (tail) Tj ET EMC",
            "/Span <</ActualText (untouched words)>> BDC BT /F1 14 Tf 40 100 Td (untouched words) Tj ET EMC",
            "BT 3 Tr /F1 14 Tf 40 220 Td (hiddenSECRET4) Tj ET",
            "/Fm Do",
          ].join("\n"),
          {},
        ),
      );
      // structure tree, thumbnail, private data, comment, link
      const element = doc.addObject({ S: "P", Pg: doc.findPage(0), K: 0, ActualText: doc.newString("structSECRET5") });
      doc.getTrailer().get("Root").put("StructTreeRoot", doc.addObject({ Type: "StructTreeRoot", K: [element] }));
      doc.findPage(0).put("PieceInfo", { App: { Private: doc.newString("pieceSECRET6") } });
      const note = doc.addObject({
        Type: "Annot", Subtype: "Text", Rect: [250, 345, 270, 365], Contents: doc.newString("noteSECRET7"),
      });
      const link = doc.addObject({
        Type: "Annot", Subtype: "Link", Rect: [40, 316, 100, 334], A: { S: "URI", URI: doc.newString("https://x.test/linkSECRET8") },
      });
      const widget = doc.addObject({
        Type: "Annot", Subtype: "Widget", FT: "Tx", Rect: [40, 215, 140, 235], T: doc.newString("f"),
        V: doc.newString("fieldSECRET9"), DA: doc.newString("/Helv 10 Tf 0 g"),
      });
      doc.findPage(0).put("Annots", [note, link, widget]);
      doc.getTrailer().get("Root").put("AcroForm", { Fields: [widget] });
    });
    const engine = await open(source);
    const areas = [find(engine, "SECRET1"), find(engine, "propSECRET2"), find(engine, "formSECRET3")];
    // the second SECRET1 with its link, the hidden text with its field, and the comment
    areas.push([40, 68, 130, 82], [40, 167, 150, 184], [250, 36, 270, 54]);
    await undoable(engine, () => engine.redactAreas(0, areas));
    const s = await shot(engine, 0, "redact-text");
    expect(s.at(45, 75)).toEqual([0, 0, 0]);

    const out = await engine.exportPdf();
    const text = pageText(load(out));
    expect(text).toContain("visible");
    expect(text).toContain("stays");
    expect(text).toContain("tail");
    expect(text).toContain("formkeep");
    expect(text).toContain("untouched words");
    const raw = everything(out);
    expect(raw).toContain("untouched words");
    expect([...raw.matchAll(/.{0,60}SECRET[0-9].{0,20}/g)].map((m) => m[0])).toEqual([]);
    expect(await engine.listFormFields()).toEqual([]);
  });

  it("removes only the covered characters of a line", async () => {
    const engine = await open(makePdf([{ content: "BT /F1 16 Tf 20 300 Td (Account 4711-0815 of Ms Rao) Tj ET" }]));
    await engine.redactAreas(0, [find(engine, "4711-0815")]);
    const text = pageText(engine);
    expect(text.replace(/\s+/g, " ")).toBe("Account of Ms Rao");
    expect(everything(await engine.exportPdf())).not.toContain("4711");
  });

  it("blanks image pixels, also in soft masks and forms", async () => {
    const source = makePdf([{ content: "" }], (doc) => {
      const photo = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 100, 100], false);
      photo.clear(180);
      // a "signature": black ink whose shape lives only in the transparency mask
      const ink = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 100, 100], true);
      const px = ink.getPixels();
      for (let y = 0; y < 100; y++)
        for (let x = 0; x < 100; x++) px.set([0, 0, 0, (x + y) % 10 < 3 ? 255 : 0], (y * 100 + x) * 4);
      const photoRef = doc.addImage(new mupdf.Image(photo));
      const inkRef = doc.addImage(new mupdf.Image(ink));
      expect(inkRef.get("SMask").isNull()).toBe(false);
      const form = doc.addStream("q 100 0 0 100 150 250 cm /Ink Do Q", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 400], Resources: { XObject: { Ink: inkRef } },
      });
      doc.findPage(0).get("Resources").put("XObject", { Photo: photoRef, Ink: inkRef, Fm: form });
      doc.findPage(0).put(
        "Contents",
        doc.addStream("q 100 0 0 100 20 250 cm /Photo Do Q q 100 0 0 100 20 100 cm /Ink Do Q /Fm Do", {}),
      );
    });
    const engine = await open(source);
    // the left half of each picture (page space)
    await undoable(engine, () => engine.redactAreas(0, [[20, 50, 70, 150], [20, 200, 70, 300], [150, 50, 200, 150]]));
    await shot(engine, 0, "redact-images");
    const out = load(await engine.exportPdf());
    const page = out.findPage(0);
    const images: { alpha: number[] | null; color: number[] }[] = [];
    const collect = (resources: mupdf.PDFObject) =>
      resources.get("XObject").forEach((object) => {
        const kind = object.get("Subtype").asName();
        if (kind === "Form") return collect(object.get("Resources"));
        const read = (o: mupdf.PDFObject) => {
          const pm = out.loadImage(o).toPixmap();
          const n = pm.getNumberOfComponents();
          const w = pm.getWidth();
          const px = pm.getPixels();
          // one pixel inside the redacted half, one outside
          return [px[(50 * w + 10) * n]!, ...Array.from({ length: 10 }, (_, k) => px[(50 * w + 80 + k) * n]!)];
        };
        const mask = object.get("SMask");
        images.push({ color: read(object), alpha: mask.isNull() ? null : read(mask) });
      });
    collect(page.get("Resources"));
    expect(images).toHaveLength(3);
    const [photo, ...inks] = images.sort((a, b) => Number(!!a.alpha) - Number(!!b.alpha));
    expect(photo!.color[0]).not.toBe(180);
    expect(photo!.color[1]).toBe(180);
    for (const image of inks) {
      expect(image!.alpha![0], "mask is flat under the redaction").toBe(255);
      expect(new Set(image!.alpha!.slice(1)).size, "and keeps its shape elsewhere").toBe(2);
    }
    // no untouched copy of a mask survives (identical new pictures are stored once)
    let objects = 0;
    for (let i = 1; i < out.countObjects(); i++) {
      const o = out.newIndirect(i).resolve();
      if (o.isDictionary() && o.get("Subtype").isName() && o.get("Subtype").asName() === "Image") objects++;
    }
    expect(objects).toBe(3);
  });

  it("cuts line art exactly at the edges and removes shapes it cannot cut", async () => {
    const content = [
      "0.8 0.9 1 rg 0 0 300 400 re f", // page background
      "0 G 2 w 20 300 m 280 300 l S", // rule
      "20 200 260 60 re S", // table box
      "0 g 100 330 m 120 360 140 360 160 330 c f", // drawn glyph
      "0 g 200 330 20 20 re f", // block fully inside
      "1 0 0 RG 20 100 m 80 160 l S", // slanted stroke outside
      "q 20 20 100 50 re W n 0 1 0 rg 0 0 300 400 re f Q", // clipped fill
      "0 g 250 20 20 20 re f",
    ].join("\n");
    const engine = await open(makePdf([{ content }]));
    const holes: Rect[] = [
      [90, 30, 230, 80], // glyph, block
      [120, 80, 180, 220], // rule and table
      [50, 340, 90, 370], // clipped fill
    ];
    await undoable(engine, () => engine.redactAreas(0, holes));
    const s = await shot(engine, 0, "redact-lineart");
    const back = [204, 229, 255];
    expect(s.at(5, 5)).toEqual(back);
    expect(s.at(200, 390)).toEqual(back);
    expect(s.at(60, 100), "rule left of the hole").toEqual([0, 0, 0]);
    expect(s.at(260, 100), "rule right of the hole").toEqual([0, 0, 0]);
    expect(s.at(20, 170), "table edge").toEqual([0, 0, 0]);
    expect(s.at(60, 140), "table top").toEqual([0, 0, 0]);
    expect(s.at(50, 270)[0], "slanted line").toBeGreaterThan(220);
    expect(s.at(40, 360), "clipped fill outside the hole").toEqual([0, 255, 0]);
    expect(s.at(200, 360), "clip still applies").toEqual(back);
    expect(s.at(260, 370)).toEqual([0, 0, 0]);
    // geometry under the holes is gone from the content itself
    const stream = engine.context.doc.findPage(0).get("Contents").readStream().asString();
    expect(stream).not.toMatch(/120 360 140 360/);
    expect(stream).not.toMatch(/200 330 20 20 re/);
    expect(stream).not.toMatch(/\b20 300 m\s+280 300 l/);
  });

  it("forgets added objects and recognised words under the area, on rotated pages", async () => {
    const engine = await open(makePdf([{ content: "", rotate: 90 }]));
    await engine.addObject({ kind: "text", page: 0, rect: [20, 20, 220, 40], align: "left", style, text: "objSECRET" });
    await engine.addObject({ kind: "rect", page: 0, rect: [20, 200, 60, 240], fill: [1, 0, 0], stroke: null });
    const word = (text: string, x: number) => ({ text, rect: [x, 100, x + 60, 115] as Rect, confidence: 90 });
    engine.context.state.ocr[0] = {
      result: {
        page: 0, languages: ["eng"],
        lines: [{ text: "ocrSECRET fine", rect: [20, 100, 160, 115], confidence: 90, words: [word("ocrSECRET", 20), word("fine", 100)] }],
      },
      edits: {},
      pageObject: engine.context.doc.findPage(0).asIndirect(),
    };
    await undoable(engine, () => engine.redactAreas(0, [[10, 10, 240, 50], [15, 95, 85, 120]]));
    expect((await engine.listObjects(0)).map((o) => o.kind)).toEqual(["rect"]);
    expect(engine.context.state.ocr[0]!.result.lines[0]!.text).toBe("fine");
    const s = await shot(engine, 0, "redact-rotated");
    // the object that was not under the area is still editable in place
    const [kept] = await engine.listObjects(0);
    await undoable(engine, () => engine.updateObject({ ...kept!, rect: [100, 200, 140, 240] }));
    expect((await shot(engine, 0)).at(120, 220)).toEqual([255, 0, 0]);
    expect((await shot(engine, 0)).at(30, 210)).toEqual([255, 255, 255]);
    await engine.undo();
    expect(s.at(100, 30)).toEqual([0, 0, 0]);
    expect(s.at(30, 210)).toEqual([255, 0, 0]);
    const out = await engine.exportPdf();
    expect(pageText(load(out))).toBe("");
    expect(everything(out)).not.toContain("objSECRET");
  });

  it("redacts inside a form used by several pages without changing the others", async () => {
    const source = makePdf([{ content: "" }, { content: "" }], (doc) => {
      const font = doc.findPage(0).get("Resources", "Font", "F1");
      const image = doc.addImage(new mupdf.Image(pngBytes(10, 10, () => [200, 0, 0])));
      const form = doc.addStream("BT /F1 16 Tf 20 300 Td (shared words) Tj ET q 50 0 0 50 20 100 cm /Im Do Q 20 50 100 10 re f", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 400], Resources: { Font: { F1: font }, XObject: { Im: image } },
      });
      const resources = doc.addObject({ XObject: { Fm: form } });
      const content = doc.addStream("/Fm Do", {});
      for (let i = 0; i < 2; i++) {
        doc.findPage(i).put("Resources", resources);
        doc.findPage(i).put("Contents", content);
      }
    });
    const engine = await open(source);
    const whole = (await engine.renderPage(0, 1)).data.slice();
    await undoable(engine, () => engine.redactAreas(1, [find(engine, "shared", 1), [10, 240, 45, 310], [60, 330, 90, 360]]));
    expect((await engine.renderPage(0, 1)).data).toEqual(whole);
    expect(pageText(engine, 0)).toBe("shared words");
    expect(pageText(engine, 1)).toBe("words");
  });

  it("does not disturb other pages that share content", async () => {
    const engine = await open(makePdf([{ content: "BT /F1 16 Tf 20 300 Td (twin text) Tj ET" }]));
    await engine.duplicatePage(0);
    await engine.redactAreas(1, [find(engine, "twin", 1)]);
    expect(pageText(engine, 0)).toBe("twin text");
    expect(pageText(engine, 1)).toBe("text");
    savePng(engine.context.doc, 1, "redact-twin");
    await expect(engine.redactAreas(0, [])).rejects.toThrow();
  });
});
