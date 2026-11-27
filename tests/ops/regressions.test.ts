/** Bugs found by the test corpus. Runs with the real TEXT module (rotation) and MuPDF. */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { Rect } from "../../src/engine/types";
import { label, load, makePdf, open, pageText, pngBytes, savePng, undoable } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);

const corpus = (name: string) => `tests/fixtures/pdfs/${name}.pdf`;
const fixture = (name: string) => new Uint8Array(readFileSync(corpus(name)));

/** number of pixels that differ outside the (slightly enlarged) rect */
async function changedOutside(engine: Engine, rect: Rect, act: () => Promise<unknown>): Promise<number> {
  const before = await engine.renderPage(0, 2);
  await act();
  const after = await engine.renderPage(0, 2);
  const [x0, y0, x1, y1] = [rect[0] * 2 - 8, rect[1] * 2 - 8, rect[2] * 2 + 8, rect[3] * 2 + 8];
  let n = 0;
  for (let y = 0; y < before.height; y++)
    for (let x = 0; x < before.width; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      const i = (y * before.width + x) * 4;
      if (Math.abs(before.data[i]! - after.data[i]!) > 24 || Math.abs(before.data[i + 1]! - after.data[i + 1]!) > 24) n++;
    }
  return n;
}

const contentOf = (engine: Engine) => engine.context.doc.findPage(0).get("Contents").readStream().asString();

describe("redaction keeps the stroke state of stroked text", () => {
  it("restores width, caps, joins and dashes, also in forms and inside text objects", async () => {
    const source = makePdf([{ content: "" }], (doc) => {
      const font = doc.findPage(0).get("Resources", "Font", "F1");
      const form = doc.addStream("q 0.2 w [3 1] 0 d BT /F1 24 Tf 1 Tr 30 80 Td (dashed outline in a form) Tj ET Q", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 400], Resources: { Font: { F1: font } },
      });
      doc.findPage(0).get("Resources").put("XObject", { Fm: form });
      doc.findPage(0).put(
        "Contents",
        doc.addStream(
          [
            "BT /F1 16 Tf 40 360 Td (remove this line) Tj ET",
            "q 0.35 w 1 J 2 j 4 M 0.2 0.2 0.2 RG BT /F1 24 Tf 2 Tr 30 300 Td (thin outlined bold) Tj ET Q",
            "0.25 w q BT /F1 24 Tf 1 Tr 30 250 Td (width set outside) Tj ET Q",
            "q BT /F1 24 Tf 1 Tr 0.2 w 30 200 Td (inside the text) Tj 0.5 w 0 -30 Td (object) Tj ET Q",
            "/Fm Do",
          ].join("\n"),
          {},
        ),
      );
    });
    const engine = await open(source);
    const area: Rect = [35, 24, 200, 46];
    const changed = await changedOutside(engine, area, () => undoable(engine, () => engine.redactAreas(0, [area])));
    savePng(engine.context.doc, 0, "regression-stroke");
    expect(changed).toBe(0);
    expect(pageText(engine)).not.toContain("remove");
    const content = contentOf(engine);
    expect(content).toContain("0.35 w");
    expect(content).not.toContain("PEs");
    const states = engine.context.doc.findPage(0).get("Resources", "ExtGState");
    expect(states.isNull() ? "" : states.toString()).not.toContain("PEs");
  });

  it.skipIf(!existsSync(corpus("positioning")))("positioning.pdf looks the same after redacting line 1", async () => {
    const engine = await open(fixture("positioning"));
    const line: Rect = [40, 24.6, 224.96, 37.86];
    expect(await changedOutside(engine, line, () => engine.redactAreas(0, [line]))).toBe(0);
    expect(contentOf(engine)).toMatch(/0?\.35 w/);
    expect(pageText(engine)).toContain("Outlined bold made with a stroke");
  });
});

describe("text export follows the direction of the text", () => {
  const content = [label("first line of text", 40, 340, 12), label("second line here", 40, 310, 12), label("third and last", 40, 280, 12)].join("\n");
  const expected = ["first line of text", "second line here", "third and last"];
  const lines = async (engine: Engine) => (await engine.exportText([0])).split("\n").map((l) => l.trim());

  it.each([90, 180, 270] as const)("after rotating the page by %i", async (degrees) => {
    const engine = await open(makePdf([{ content }]));
    expect(await lines(engine)).toEqual(expected);
    await engine.rotatePages([0], degrees);
    expect(await lines(engine)).toEqual(expected);
  });

  it.skipIf(!existsSync(corpus("en-truetype")))("keeps the order of en-truetype.pdf when rotated", async () => {
    const engine = await open(fixture("en-truetype"));
    const upright = await engine.exportText([0]);
    expect(upright.split("\n").length).toBeGreaterThan(2);
    for (let turn = 0; turn < 3; turn++) {
      await engine.rotatePages([0], 90);
      expect(await engine.exportText([0])).toBe(upright);
    }
  });
});

describe("exporting after undo", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads no unused objects (MuPDF would log errors)", async () => {
    const logged: unknown[][] = [];
    for (const channel of ["error", "warn"] as const)
      vi.spyOn(console, channel).mockImplementation((...args) => void logged.push(args));
    const engine = await open(makePdf([{}, {}]));
    await engine.addObject({ kind: "image", page: 0, rect: [10, 10, 60, 60], data: pngBytes(8, 8, () => [9, 9, 9]) });
    await engine.addObject({
      kind: "text", page: 0, rect: [10, 80, 200, 100], align: "left", text: "gone again",
      style: { family: "Helvetica", bold: false, italic: false, serif: false, mono: false, size: 12, color: [0, 0, 0] },
    });
    await engine.duplicatePage(0);
    for (let i = 0; i < 3; i++) await engine.undo();
    const out = await engine.exportPdf({ compress: true, flatten: true });
    await engine.extractPages([1]);
    await engine.splitDocument([[0], [1]]);
    await engine.exportPdf();
    await engine.redo();
    await engine.exportPdf();
    expect(pageText(load(out))).toBe("Page 1");
    expect(logged).toEqual([]);
  });
});
