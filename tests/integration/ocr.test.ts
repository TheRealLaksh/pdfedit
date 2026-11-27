/**
 * Engine side of recognition, driven with synthetic OCR results built from the manifest geometry (tesseract
 * itself runs in the browser and is covered by the OCR module and the end-to-end tests).
 */
import { describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/engine";
import type { OcrPageResult, Rect, RenderedPage } from "../../src/engine/types";
import {
  bestLine, diffPixels, documents, findLine, inkPixels, mupdfText, normalise, openBytes, openDoc, overlap, pad,
  pixelAt, render, savePng, similarity, type ExpectedLine, type ManifestDoc,
} from "./helpers";

/** The tight box of the ink inside a manifest line box, and the row the letters stand on: what tesseract reports. */
function tight(picture: RenderedPage, [x0, y0, x1, y1]: Rect, scale: number): { rect: Rect; baseline: number } | null {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const rows: number[] = [];
  for (let y = Math.max(0, Math.floor(y0 * scale)); y < Math.min(picture.height, Math.ceil(y1 * scale)); y++) {
    let count = 0;
    for (let x = Math.max(0, Math.floor(x0 * scale)); x < Math.min(picture.width, Math.ceil(x1 * scale)); x++) {
      const i = (y * picture.width + x) * 4;
      if (picture.data[i]! + picture.data[i + 1]! + picture.data[i + 2]! > 500) continue;
      count++;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
    rows[y] = count;
  }
  if (!Number.isFinite(left)) return null;
  const busiest = Math.max(...rows.filter((n) => n !== undefined));
  let base = bottom;
  while (base > top && (rows[base - 1] ?? 0) < busiest * 0.3) base--;
  return { rect: [left / scale, top / scale, right / scale, bottom / scale], baseline: base / scale };
}

async function ocrResult(engine: Engine, entry: ManifestDoc, page = 0): Promise<OcrPageResult> {
  const scale = 4;
  const picture = await engine.renderPage(page, scale);
  return {
    page,
    languages: [entry.tesseract ?? "eng"],
    lines: entry.pages[page]!.lines.map((line: ExpectedLine) => {
      const text = line.intended ?? line.text;
      const found = tight(picture, line.rect, scale);
      if (!found) throw new Error(`fixture ${entry.id}: no ink under ${line.text}`);
      const { rect, baseline } = found;
      const [x0, , x1] = rect;
      const words = text.split(" ");
      // words separated by an ordinary word space, widths shared in proportion to their length
      const gap = Math.min(line.size * 0.28, (x1 - x0) / (words.length * 2));
      const letters = words.reduce((sum, w) => sum + [...w].length, 0);
      const ink = x1 - x0 - gap * (words.length - 1);
      let at = 0;
      const boxes = words.map((word) => {
        const width = (ink * [...word].length) / letters;
        const left = line.dir === "rtl" ? x1 - at - width : x0 + at;
        at += width + gap;
        return { text: word, rect: [left, rect[1], left + width, rect[3]] as Rect, confidence: 96 };
      });
      return { text, rect, baseline: [[x0, baseline], [x1, baseline]], confidence: 96, words: boxes, dir: line.dir };
    }),
  };
}

const scans = documents.filter((d) => d.tags.includes("scanned") && !d.tags.includes("searchable"));

describe.each(scans.map((d) => [d.id, d] as const))("scanned page: %s", (_id, entry) => {
  it("turns a recognition result into editable lines and undoes it", async () => {
    const { engine } = await openDoc(entry.id);
    const before = await render(engine, 0);
    const result = await engine.setOcrResult(await ocrResult(engine, entry));
    expect(result.changedPages).toContain(0);
    const page = await engine.getPageText(0);
    expect(page.lines.length).toBe(entry.pages[0]!.lines.length);
    for (const expected of entry.pages[0]!.lines) {
      const line = findLine(page, expected, 0.999);
      expect(line.id).toMatch(/^ocr:/);
      expect(line.source).toBe("ocr");
      expect(line.editable).toBe(true);
      expect(line.confidence).toBeGreaterThan(90);
      expect(overlap(line.rect, expected.rect)).toBeGreaterThan(0.8);
      expect(line.dir).toBe(expected.dir);
      // a skewed picture inflates these synthetic boxes; real recognition is checked in tests/e2e/ocr.spec.ts
      if (entry.skew) continue;
      expect(line.style.size, `size guess for ${expected.text} (true size ${expected.size})`).toBeGreaterThan(expected.size * 0.75);
      expect(line.style.size, `size guess for ${expected.text} (true size ${expected.size})`).toBeLessThan(expected.size * 1.3);
    }
    expect(diffPixels(before, await render(engine, 0), [], 2, 0).changed, "recognition alone must not change the page").toBe(0);
    await engine.undo();
    expect((await engine.getPageText(0)).lines).toEqual([]);
    await engine.redo();
    expect((await engine.getPageText(0)).lines.length).toBe(entry.pages[0]!.lines.length);
  });

  it("edits a line so that it looks like part of the scan", async () => {
    const edit = entry.edits[0]!;
    const expected = entry.pages[0]!.lines[edit.line]!;
    const { engine } = await openDoc(entry.id);
    await engine.setOcrResult(await ocrResult(engine, entry));
    const target = findLine(await engine.getPageText(0), expected);
    const before = await render(engine, 0);
    await engine.editLines(0, [{ lineId: target.id, text: edit.newText! }]);
    const exported = await engine.exportPdf();
    const reopened = await openBytes(exported, entry.file);
    const picture = await render(reopened.engine, 0);
    const margin = expected.size * 0.8;
    const edited = bestLine((await engine.getPageText(0)).lines, edit.newText!, pad(expected.rect, margin));
    const allowed = [pad(expected.rect, margin), pad(edited.line?.rect ?? expected.rect, margin)];
    const difference = diffPixels(before, picture, allowed);
    savePng(`ocr-edit-${entry.id}`, picture, allowed);
    expect(difference.changed, "the edit is visible").toBeGreaterThan(40);
    expect(difference.stray, `changes reach outside the line: ${difference.bounds?.map(Math.round)}`).toBeLessThanOrEqual(8);
    expect(edited.similarity, `engine reads ${JSON.stringify(edited.line?.text)}`).toBeGreaterThan(0.99);
    // the new words are real text in the exported file
    const independent = bestMatch(mupdfText(exported, 0), edit.newText!);
    expect(independent, "exported file has selectable new text").toBeGreaterThan(0.9);
    // paper, not a white or dark box: the area just left of the new text keeps the paper tone
    const [x, y] = [Math.max(2, expected.rect[0] - 4), (expected.rect[1] + expected.rect[3]) / 2];
    const inside = pixelAt(picture, expected.dir === "rtl" ? expected.rect[2] - 1 : expected.rect[0] + 0.5, expected.rect[1] + 1);
    const outside = pixelAt(picture, x, y);
    for (let k = 0; k < 3; k++) expect(Math.abs(inside[k]! - outside[k]!), `patch colour ${inside} next to paper ${outside}`).toBeLessThan(22);
    // other lines still have their ink
    for (const other of entry.pages[0]!.lines)
      if (other !== expected) expect(inkPixels(picture, other.rect)).toBeGreaterThan(20);
  });

  it("replaces, rather than stacks, a second edit of the same line", async () => {
    const edit = entry.edits[0]!;
    const expected = entry.pages[0]!.lines[edit.line]!;
    const { engine } = await openDoc(entry.id);
    await engine.setOcrResult(await ocrResult(engine, entry));
    let target = findLine(await engine.getPageText(0), expected);
    const first = expected.text.split(" ")[0]!;
    await engine.editLines(0, [{ lineId: target.id, text: edit.newText! + " " + first }]);
    target = bestLine((await engine.getPageText(0)).lines, edit.newText! + " " + first, pad(expected.rect, 12)).line!;
    await engine.editLines(0, [{ lineId: target.id, text: first }]);
    const page = await engine.getPageText(0);
    expect(page.lines.length, "no duplicate lines").toBe(entry.pages[0]!.lines.length);
    const text = normalise(mupdfText(await engine.exportPdf(), 0));
    expect(text, "the first replacement must be gone").not.toContain(normalise(edit.newText!));
  });
});

/** best similarity between `wanted` and any extracted line */
function bestMatch(text: string, wanted: string): number {
  return Math.max(0, ...text.split("\n").map((line) => similarity(wanted, line)));
}

describe("broken text layers", () => {
  const garbled = documents.filter((d) => d.tags.includes("garbled"));
  it.each(garbled.map((d) => [d.id, d] as const))("%s: recognised lines replace the unreadable ones and can be edited", async (_id, entry) => {
    const { engine } = await openDoc(entry.id);
    await engine.setOcrResult(await ocrResult(engine, entry));
    const page = await engine.getPageText(0);
    expect(page.lines.every((l) => l.source === "ocr"), JSON.stringify(page.lines.map((l) => [l.source, l.text]))).toBe(true);
    expect(page.lines.length).toBe(entry.pages[0]!.lines.length);
    const expected = entry.pages[0]!.lines[2]!;
    const target = findLine(page, { ...expected, text: expected.intended! });
    const before = await render(engine, 0);
    const replacement = entry.id === "legacy-krutidev" ? "अगली बैठक शुक्रवार को होगी।" : "Recognition recovered this line.";
    await engine.editLines(0, [{ lineId: target.id, text: replacement }]);
    const picture = await render(engine, 0);
    const margin = expected.size * 0.7;
    const edited = bestLine((await engine.getPageText(0)).lines, replacement);
    expect(edited.similarity).toBeGreaterThan(0.99);
    const difference = diffPixels(before, picture, [pad(expected.rect, margin), pad(edited.line!.rect, margin)]);
    if (difference.stray > 4) savePng(`garbled-edit-${entry.id}`, picture, [expected.rect]);
    expect(difference.stray).toBeLessThanOrEqual(4);
    expect(difference.changed).toBeGreaterThan(20);
    const exported = mupdfText(await engine.exportPdf(), 0);
    expect(exported, "the broken characters under the line are removed").not.toContain(expected.text);
  });
});

describe("searchable scan", () => {
  it("editing a line changes what the reader sees, not only the hidden text", async () => {
    const entry = documents.find((d) => d.id === "scan-searchable-en")!;
    const { engine } = await openDoc(entry.id);
    const page = await engine.getPageText(0);
    const edit = entry.edits[0]!;
    const expected = entry.pages[0]!.lines[edit.line]!;
    const target = findLine(page, expected);
    const before = await render(engine, 0);
    await engine.editLines(0, [{ lineId: target.id, text: edit.newText! }]);
    const picture = await render(engine, 0);
    const margin = expected.size * 0.8;
    const difference = diffPixels(before, picture, [pad(expected.rect, margin)]);
    savePng("searchable-scan-edit", picture, [pad(expected.rect, margin)]);
    expect(difference.changed, "the visible page changed").toBeGreaterThan(40);
    expect(difference.stray).toBeLessThanOrEqual(8);
    expect(bestMatch(mupdfText(await engine.exportPdf(), 0), edit.newText!)).toBeGreaterThan(0.95);
  });
});

describe("make searchable", () => {
  it("adds an invisible text layer without changing the look", async () => {
    const entry = documents.find((d) => d.id === "scan-en")!;
    const { engine } = await openDoc(entry.id);
    await engine.setOcrResult(await ocrResult(engine, entry));
    const before = await render(engine, 0);
    const result = await engine.makeSearchable([0]);
    expect(result.changedPages).toContain(0);
    expect(diffPixels(before, await render(engine, 0), [], 2, 0).changed).toBe(0);
    const text = mupdfText(await engine.exportPdf(), 0);
    for (const line of entry.pages[0]!.lines) expect(bestMatch(text, line.text), line.text).toBeGreaterThan(0.95);
    await engine.undo();
    expect(normalise(mupdfText(await engine.exportPdf(), 0))).toBe("");
  });

  it.each(["scan-hi", "scan-ar", "scan-zh", "scan-ta"])("%s: the layer carries the original script", async (id) => {
    const entry = documents.find((d) => d.id === id)!;
    const { engine } = await openDoc(id);
    await engine.setOcrResult(await ocrResult(engine, entry));
    await engine.makeSearchable([0]);
    const reopened = await openBytes(await engine.exportPdf(), entry.file);
    const found = await engine.findText(entry.pages[0]!.lines[1]!.text.split(" ")[0]!);
    expect(found.length).toBeGreaterThan(0);
    const text = mupdfText(await reopened.engine.exportPdf(), 0);
    const good = entry.pages[0]!.lines.filter((line) => bestMatch(text, line.text) > 0.9).length;
    expect(good, text).toBeGreaterThanOrEqual(entry.pages[0]!.lines.length - 1);
  });
});
