/** The same flows with the real text module: what the app actually does with a scanned document. */
import * as mupdf from "mupdf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { PageText } from "../../src/engine/types";
import { configureOcr, OCR_SCALE, recognizePage, terminateOcr } from "../../src/ocr";
import { createNodeAssets } from "../fonts/nodeAssets";
import { closeBrowser, degrade, render, SAMPLES, savePage, scanPdf, TESSDATA, typeset } from "./helpers";

const assets = createNodeAssets();
beforeAll(() => configureOcr({ cachePath: TESSDATA }));
afterAll(async () => {
  await terminateOcr();
  await closeBrowser();
});

async function open(bytes: Uint8Array): Promise<Engine> {
  const engine = new Engine(assets);
  await engine.open(bytes, "scan.pdf");
  return engine;
}

async function recognise(engine: Engine, page: number, languages = ["eng"]) {
  const image = await engine.renderPage(page, OCR_SCALE);
  return engine.setOcrResult(await recognizePage(image, { languages, scale: OCR_SCALE }));
}

const texts = (p: PageText) => p.lines.map((l) => l.text);
const extracted = (engine: Engine, page: number) => engine.context.doc.loadPage(page).toStructuredText("").asText();

async function scan(name = "eng", look = { paper: [238, 232, 214] as [number, number, number], noise: 5, skew: 0.5 }) {
  return scanPdf(degrade(await typeset(SAMPLES[name]!, name), look));
}

describe("scanned document through the whole engine", () => {
  it("goes from scanned to editable, searchable and replaceable", async () => {
    const engine = await open(await scan());
    const before = await engine.getPageText(0);
    expect(before.kind).toBe("scanned");
    expect(before.lines).toHaveLength(0);

    await recognise(engine, 0);
    const ready = await engine.getPageText(0);
    expect(ready.lines).toHaveLength(5);

    await engine.makeSearchable([0]);
    const searchable = await engine.getPageText(0);
    expect(texts(searchable)).toHaveLength(5);
    expect(searchable.lines.every((l) => l.source === "ocr" && l.editable)).toBe(true);

    const matches = await engine.findText("library");
    expect(matches).toHaveLength(0);
    const found = await engine.findText("committee");
    expect(found).toHaveLength(2);
    expect(found.every((m) => m.lineId.startsWith("ocr:") && m.quads.length > 0)).toBe(true);

    const result = await engine.replaceText("committee", "council");
    expect(result.count).toBe(2);
    savePage(engine.context.doc, "integrated-replaced.png");
    const after = await engine.getPageText(0);
    expect(after.kind).toBe("scanned");
    expect(after.lines).toHaveLength(5);
    expect(texts(after).join("\n")).not.toMatch(/committee/i);
    expect(texts(after).join("\n")).toMatch(/council met/);
    expect(extracted(engine, 0)).not.toMatch(/committee/i);
    const seen = await recognizePage(await engine.renderPage(0, OCR_SCALE), { languages: ["eng"], scale: OCR_SCALE });
    expect(seen.lines.map((l) => l.text).join(" ")).toMatch(/council met/);
    expect(seen.lines.map((l) => l.text).join(" ")).not.toMatch(/Committee/i);

    await engine.undo();
    expect(texts(await engine.getPageText(0)).join("\n")).toMatch(/committee met/);
    await engine.redo();
    expect(texts(await engine.getPageText(0)).join("\n")).toMatch(/council met/);
  }, 240_000);

  it("edits a scan that was saved with a text layer, without recognising it again", async () => {
    const first = await open(await scan());
    await recognise(first, 0);
    await first.makeSearchable([0]);
    const engine = await open(await first.exportPdf({ compress: true }));
    const shown = await engine.getPageText(0);
    expect(shown.lines).toHaveLength(5);
    expect(shown.lines.every((l) => l.source === "ocr" && l.editable && l.id.startsWith("ocr:h:"))).toBe(true);
    const target = shown.lines.find((l) => l.text.includes("48,250"))!;
    const before = render(engine.context.doc, 0);
    await engine.editLines(0, [{ lineId: target.id, text: target.text.replace("48,250", "12,345") }]);
    savePage(engine.context.doc, "integrated-layer-edit.png");
    const after = render(engine.context.doc, 0);
    let changed = 0;
    for (let i = 0; i < after.data.length; i += 4) if (Math.abs(after.data[i]! - before.data[i]!) > 40) changed++;
    expect(changed).toBeGreaterThan(200);
    expect(extracted(engine, 0)).toContain("12,345");
    expect(extracted(engine, 0)).not.toContain("48,250");
    const now = await engine.getPageText(0);
    expect(now.lines).toHaveLength(5);
    expect(now.lines.find((l) => l.id === target.id)!.text).toContain("12,345");
    const seen = await recognizePage(await engine.renderPage(0, OCR_SCALE), { languages: ["eng"], scale: OCR_SCALE });
    expect(seen.lines.map((l) => l.text).join(" ")).toContain("12,345");
    // a second line of the same page still works, and undo returns to the saved file
    const other = now.lines.find((l) => l.text.includes("secretary"))!;
    await engine.editLines(0, [{ lineId: other.id, text: "Send comments by Monday." }]);
    expect(extracted(engine, 0)).not.toContain("secretary");
    await engine.undo();
    await engine.undo();
    expect(extracted(engine, 0)).toContain("48,250");
    expect(extracted(engine, 0)).toContain("secretary");
    expect((await engine.getPageText(0)).lines.map((l) => l.id)).toEqual(shown.lines.map((l) => l.id));
  }, 240_000);

  it("does not bring redacted words back when another line is changed afterwards", async () => {
    const engine = await open(await scan());
    await recognise(engine, 0);
    const lines = (await engine.getPageText(0)).lines;
    await engine.editLines(0, [
      { lineId: lines[1]!.id, text: "Private account 99887766." },
      { lineId: lines[3]!.id, text: "A second changed line." },
    ]);
    const secret = (await engine.getPageText(0)).lines.find((l) => l.text.includes("Private"))!.rect;
    await engine.redactAreas(0, [[secret[0] - 3, secret[1] - 3, secret[2] + 60, secret[3] + 3]]);
    expect(extracted(engine, 0)).not.toContain("99887766");
    const second = (await engine.getPageText(0)).lines.find((l) => l.text.includes("second"))!;
    await engine.editLines(0, [{ lineId: second.id, text: "Changed once more." }]);
    savePage(engine.context.doc, "integrated-redacted.png");
    const after = extracted(engine, 0);
    expect(after).toContain("Changed once more.");
    expect(after).not.toContain("99887766");
    expect(after).not.toContain("second changed");
    expect(texts(await engine.getPageText(0)).join(" ")).not.toContain("99887766");
  }, 240_000);

  it("finds the recognition again after the pages were rearranged", async () => {
    const two = new mupdf.PDFDocument(await scan());
    const other = new mupdf.PDFDocument(await scan("rus"));
    two.graftPage(1, other, 0);
    const engine = await open(two.saveToBuffer("").asUint8Array().slice());
    await recognise(engine, 0);
    await recognise(engine, 1, ["rus"]);
    const english = texts(await engine.getPageText(0));
    const russian = texts(await engine.getPageText(1));

    // move the pages without telling the OCR module, as a careless caller would
    const ctx = engine.context;
    ctx.doc.beginOperation("swap");
    ctx.doc.rearrangePages([1, 0]);
    ctx.doc.endOperation();
    ctx.cache.clear();
    expect(texts(await engine.getPageText(0))).toEqual(russian);
    expect(texts(await engine.getPageText(1))).toEqual(english);
    const line = (await engine.getPageText(1)).lines[1]!;
    await engine.editLines(1, [{ lineId: line.id, text: "Moved and then changed." }]);
    expect(extracted(engine, 1)).toContain("Moved and then changed.");
    expect(extracted(engine, 0)).not.toContain("Moved");
  }, 240_000);

  it("works through the reorder, duplicate and rotate operations of the app", async () => {
    const two = new mupdf.PDFDocument(await scan());
    two.graftPage(1, new mupdf.PDFDocument(await scan("rus")), 0);
    const engine = await open(two.saveToBuffer("").asUint8Array().slice());
    await recognise(engine, 0);
    const english = texts(await engine.getPageText(0));
    await engine.reorderPages([1, 0]);
    expect((await engine.getPageText(0)).lines).toHaveLength(0);
    expect(texts(await engine.getPageText(1))).toEqual(english);
    await engine.rotatePages([1], 90);
    const turned = await engine.getPageText(1);
    expect(texts(turned)).toEqual(english);
    expect(Math.abs(turned.lines[0]!.angle - Math.PI / 2)).toBeLessThan(0.03);

    await engine.duplicatePage(1);
    const copy = await engine.getPageText(2);
    expect(texts(copy)).toEqual(english);
    await engine.editLines(2, [{ lineId: copy.lines[1]!.id, text: "Only the copy says this." }]);
    expect(texts(await engine.getPageText(2))).toContain("Only the copy says this.");
    expect(texts(await engine.getPageText(1))).toEqual(english);
    expect(extracted(engine, 1)).not.toContain("Only the copy");
    savePage(engine.context.doc, "integrated-copy.png", 2);

    const out = await engine.exportPdf({ compress: true });
    const again = mupdf.Document.openDocument(out, "application/pdf").asPDF()!;
    expect(again.loadPage(2).toStructuredText("").asText()).toContain("Only the copy says this.");
    expect(render(again, 2).width).toBeGreaterThan(0);
  }, 240_000);
});
