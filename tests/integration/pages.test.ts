/** Page organisation: rotate, delete, reorder, duplicate, insert, extract and split. */
import { describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/engine";
import {
  assetBytes, bestLine, diffPixels, doc, findLine, fixtureBytes, mupdfDocument, mupdfText, normalise, openBytes,
  openDoc, render,
} from "./helpers";

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo"];

/** the marker word of every page, in order */
async function markers(engine: Engine, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await engine.exportText([i]);
    out.push(WORDS.find((w) => text.includes(`Page marker ${w}`)) ?? (text.trim() ? "other" : "blank"));
  }
  return out;
}

describe("page operations", () => {
  it("deletes pages", async () => {
    const { engine } = await openDoc("multipage");
    const result = await engine.deletePages([3, 0]);
    expect(result.doc.pageCount).toBe(3);
    expect(await markers(engine, 3)).toEqual(["bravo", "charlie", "echo"]);
    await engine.undo();
    expect(await markers(engine, 5)).toEqual(WORDS);
  });

  it("refuses to delete every page", async () => {
    const { engine } = await openDoc("en-truetype");
    await expect(engine.deletePages([0])).rejects.toThrow();
    expect((await engine.getPageText(0)).lines.length).toBeGreaterThan(0);
  });

  it("reorders pages and keeps the internal link pointing at the same content", async () => {
    const { engine } = await openDoc("multipage");
    await engine.reorderPages([3, 0, 1, 2, 4]);
    expect(await markers(engine, 5)).toEqual(["delta", "alpha", "bravo", "charlie", "echo"]);
    const pdf = mupdfDocument(await engine.exportPdf());
    const link = pdf.loadPage(1).getLinks()[0];
    expect(link, "link survives").toBeTruthy();
    expect(pdf.resolveLink(link!)).toBe(0);
  });

  it("duplicates a page into an independent copy", async () => {
    const { engine } = await openDoc("multipage");
    const result = await engine.duplicatePage(1);
    expect(result.doc.pageCount).toBe(6);
    expect(await markers(engine, 6)).toEqual(["alpha", "bravo", "bravo", "charlie", "delta", "echo"]);
    const target = (await engine.getPageText(2)).lines[0]!;
    const original = await render(engine, 1);
    await engine.editLines(2, [{ lineId: target.id, text: "Chapter bravo, second copy" }]);
    expect(diffPixels(original, await render(engine, 1)).changed, "the first copy is untouched").toBe(0);
    expect(normalise(await engine.exportText([1]))).toContain("Chapter bravo of the field guide");
  });

  it("rotates pages and keeps text usable", async () => {
    const { engine } = await openDoc("en-truetype");
    const before = await engine.getPageText(0);
    const result = await engine.rotatePages([0], 90);
    expect(result.doc.pages[0]!.width).toBeCloseTo(595, 0);
    expect(result.doc.pages[0]!.height).toBeCloseTo(420, 0);
    const turned = await engine.getPageText(0);
    expect(turned.lines.map((l) => l.text).sort()).toEqual(before.lines.map((l) => l.text).sort());
    for (const line of turned.lines) expect(line.angle).toBeCloseTo(Math.PI / 2, 2);
    const plain = normalise(await engine.exportText([0]));
    expect(plain.indexOf("Field notes"), `reading order on a turned page:
${plain}`).toBeLessThan(plain.indexOf("next visit"));
    const last = turned.lines.find((l) => l.text.startsWith("The next visit"))!;
    await engine.editLines(0, [{ lineId: last.id, text: "Edited while sideways." }]);
    expect(bestLine((await engine.getPageText(0)).lines, "Edited while sideways.").similarity).toBe(1);
    await engine.rotatePages([0], 270);
    expect(bestLine((await engine.getPageText(0)).lines, "Edited while sideways.").line!.angle).toBeCloseTo(0, 2);
  });

  it("inserts a blank page", async () => {
    const { engine } = await openDoc("multipage");
    const result = await engine.insertBlankPage(2, 300, 200);
    expect(result.doc.pageCount).toBe(6);
    expect([result.doc.pages[2]!.width, result.doc.pages[2]!.height]).toEqual([300, 200]);
    expect((await engine.getPageText(2)).kind).toBe("empty");
  });

  it("inserts another PDF, with its form fields and scripts intact", async () => {
    const { engine } = await openDoc("multipage");
    await engine.insertPdf(fixtureBytes("forms"), 1);
    const added = await engine.insertPdf(fixtureBytes("hi-chromium"), 0);
    expect(added.doc.pageCount).toBe(7);
    expect(added.doc.hasForms).toBe(true);
    expect((await engine.listFormFields()).map((f) => f.name)).toContain("full_name");
    expect((await engine.listFormFields()).find((f) => f.name === "full_name")!.page).toBe(2);
    const page = await engine.getPageText(0);
    expect(findLine(page, doc("hi-chromium").pages[0]!.lines[1]!, 0.95).editable).toBe(true);
    const reopened = await openBytes(await engine.exportPdf({ compress: true }), "joined.pdf");
    expect(reopened.info.pageCount).toBe(7);
  });

  it("inserts a password protected PDF only with its password", async () => {
    const { engine } = await openDoc("multipage");
    await expect(engine.insertPdf(fixtureBytes("password-aes256"), 5)).rejects.toThrow(/password/i);
    await expect(engine.insertPdf(fixtureBytes("password-aes256"), 5, "wrong")).rejects.toThrow(/password/i);
    expect((await engine.insertPdf(fixtureBytes("password-aes256"), 5, "test1234")).doc.pageCount).toBe(6);
    expect(mupdfText(await engine.exportPdf(), 5)).toContain("river survey");
  });

  it("inserts images as pages", async () => {
    const { engine } = await openDoc("multipage");
    const result = await engine.insertImagesAsPages([assetBytes("photo.jpg"), assetBytes("signature.png")], 1);
    expect(result.doc.pageCount).toBe(7);
    expect((await engine.listImages(1)).length).toBe(1);
    expect((await engine.listImages(2)).length).toBe(1);
    expect((await markers(engine, 7)).at(3)).toBe("bravo");
  });

  it("extracts and splits without changing the open document", async () => {
    const { engine } = await openDoc("multipage");
    const extracted = await openBytes(await engine.extractPages([4, 2]), "extract.pdf");
    expect(extracted.info.pageCount).toBe(2);
    expect(await markers(extracted.engine, 2)).toEqual(["echo", "charlie"]);
    const parts = await engine.splitDocument([[0, 1], [2], [3, 4]]);
    expect(parts.length).toBe(3);
    const counts = parts.map((p) => mupdfDocument(p).countPages());
    expect(counts).toEqual([2, 1, 2]);
    expect(mupdfText(parts[1]!, 0)).toContain("charlie");
    expect(await markers(engine, 5)).toEqual(WORDS);
  });

  it("keeps recognised text and added objects with their page when pages move", async () => {
    const { engine } = await openDoc("scan-en");
    await engine.insertBlankPage(0, 420, 595);
    await engine.deletePages([0]);
    await engine.insertPdf(fixtureBytes("en-truetype"), 1);
    const line = doc("scan-en").pages[0]!.lines[0]!;
    await engine.setOcrResult({ page: 0, languages: ["eng"], lines: [{ text: line.text, rect: line.rect, confidence: 95, words: [] }] });
    await engine.addObject({ kind: "rect", page: 0, rect: [40, 400, 90, 440], fill: [1, 0, 0], stroke: null });
    await engine.reorderPages([1, 0]);
    expect((await engine.getPageText(1)).lines.map((l) => l.text)).toEqual([line.text]);
    expect(await engine.listObjects(0)).toEqual([]);
    const moved = await engine.listObjects(1);
    expect(moved.length).toBe(1);
    expect(moved[0]!.page).toBe(1);
    await engine.duplicatePage(1);
    expect((await engine.getPageText(2)).lines.length, "the copy keeps the recognised text").toBe(1);
    await engine.deletePages([1]);
    expect((await engine.getPageText(1)).lines.map((l) => l.text)).toEqual([line.text]);
  });
});
