/** Picked document fonts, equally long lines, and unreadable lines recovered by recognition. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OcrLine } from "../../src/engine/types";
import { nodeAssets } from "../fonts/nodeAssets";
import { build, open, savePng, standard } from "./helpers";

const lines = (rows: [number, string, number?][]) =>
  rows.map(([y, text, tw]) => `BT /F1 12 Tf ${tw ?? 0} Tw 1 0 0 1 40 ${y} Tm (${text}) Tj ET`).join("\n");

describe("lines that are merely the same length", () => {
  it("are not taken for justified text, so that adding words does not squeeze them", async () => {
    const text = "Entry: the gauge was read at nine and noted in the book";
    const engine = await open(build({ content: lines([[260, text], [244, text], [228, text], [212, text]]), size: [500, 300] }));
    const before = (await engine.getPageText(0)).lines;
    expect(before.map((l) => l.align)).toEqual(["left", "left", "left", "left"]);
    await engine.editLines(0, [{ lineId: before[1]!.id, text: `${text} again` }]);
    const after = (await engine.getPageText(0)).lines[1]!;
    expect(after.text).toBe(`${text} again`);
    expect(after.rect[2]).toBeGreaterThan(before[1]!.rect[2] + 20);
  });

  it("while truly stretched lines stay justified", async () => {
    // word spacing chosen so that two different lines end at the same place
    const a = "The reading room stays open late during the examination month so";
    const probe = await open(build({ content: lines([[260, a], [244, "that students from nearby colleges can prepare without any"]]), size: [500, 300] }));
    const [first, second] = (await probe.getPageText(0)).lines;
    const tw = (first!.rect[2] - second!.rect[2]) / (second!.text.split(" ").length - 1);
    const engine = await open(
      build({ content: lines([[260, a], [244, second!.text, tw], [228, a], [212, second!.text, tw]]), size: [500, 300] }),
    );
    expect((await engine.getPageText(0)).lines.map((l) => l.align)).toEqual(["justify", "justify", "justify", "justify"]);
  });
});

describe("measuring an edit while typing", () => {
  it("says whether the text still fits, without changing the document", async () => {
    const content = [
      "BT /F1 12 Tf 40 260 Td (Total due) Tj 160 0 Td (Rs 900) Tj ET",
      "BT /F1 12 Tf 40 230 Td (A line with the whole row to itself) Tj ET",
    ].join("\n");
    const engine = await open(build({ content, size: [500, 300] }), nodeAssets);
    const [label, , free] = (await engine.getPageText(0)).lines;
    const measure = async (id: string, text: string, fit?: "shrink") => {
      let result = await engine.measureLine(0, { lineId: id, text, fit });
      for (let i = 0; i < 100 && result.estimated; i++) result = await engine.measureLine(0, { lineId: id, text, fit });
      return result;
    };
    const same = await measure(label!.id, "Total due");
    expect(same.overflow).toBe("none");
    expect(same.width).toBeCloseTo(same.originalWidth, 1);
    expect((await measure(label!.id, "Total due now")).overflow).toBe("longer");
    const long = await measure(label!.id, "Total amount that is now due for payment");
    expect(long.overflow).toBe("collides");
    expect(long.maxWidth).toBeLessThan(160);
    expect(long.fitSize).toBeLessThan(6);
    expect((await measure(label!.id, "Total amount that is now due for payment", "shrink")).overflow).toBe("none");
    const row = await measure(free!.id, "A line with the whole row to itself, and then some");
    expect(row.overflow).toBe("longer");
    // the estimate matches what saving produces
    await engine.editLines(0, [{ lineId: free!.id, text: "A line with the whole row to itself, and then some" }]);
    const after = (await engine.getPageText(0)).lines[2]!;
    expect(Math.abs(after.rect[2] - after.rect[0] - row.width)).toBeLessThan(2);
    await engine.undo();
  });
});

describe("a document font picked for another line", () => {
  it("is listed, and types with the document's own font", async () => {
    const engine = await open(new Uint8Array(readFileSync("tests/fixtures/pdfs/en-truetype.pdf")), nodeAssets);
    const choices = (await engine.listFonts()).filter((f) => f.source === "document");
    const serif = choices.find((f) => f.family === "Deja Vu Serif")!;
    expect(serif, choices.map((f) => f.family).join()).toBeTruthy();
    const target = (await engine.getPageText(0)).lines.find((l) => l.style.family === "DejaVuSans")!;
    const result = await engine.editLines(0, [{ lineId: target.id, text: target.text, style: { fontChoice: serif.id } }]);
    expect(result.warnings).toEqual([]);
    const after = (await engine.getPageText(0)).lines.find((l) => l.text === target.text)!;
    expect(after.style.family).toBe("DejaVuSerif");
    savePng(engine, "wave2-picked-font");
    // letters the subset lacks still get drawn
    const again = await engine.editLines(0, [{ lineId: after.id, text: "Quizzical jackdaws vex: ÆØß 2048", style: { fontChoice: serif.id } }]);
    expect(again.warnings).toEqual([]);
    expect((await engine.getPageText(0)).lines.some((l) => l.text === "Quizzical jackdaws vex: ÆØß 2048")).toBe(true);
    savePng(engine, "wave2-picked-font-2");
    // added text can use it too
    const added = await engine.addObject({
      kind: "text", page: 0, rect: [40, 400, 400, 440], text: "Added in the document serif", align: "left",
      style: { ...target.style, fontChoice: serif.id },
    });
    expect(added.warnings).toEqual([]);
    expect(await engine.exportText([0])).toContain("Added in the document serif");
    savePng(engine, "wave2-picked-font-3");
  });
});

describe("an unreadable line on an otherwise good page", () => {
  /** a font whose character map sends every letter to the private use area */
  const broken = (doc: Parameters<ReturnType<typeof standard>>[0]) => {
    const dict = doc.newDictionary();
    dict.put("Type", doc.newName("Font"));
    dict.put("Subtype", doc.newName("Type1"));
    dict.put("BaseFont", doc.newName("Helvetica"));
    dict.put("Encoding", doc.newName("WinAnsiEncoding"));
    const map = Array.from({ length: 95 }, (_, i) => `<${(32 + i).toString(16)}> <${(0xe000 + i).toString(16)}>`);
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <ff> endcodespacerange ${map.length} beginbfchar ${map.join(" ")} endbfchar endcmap end end`;
    dict.put("ToUnicode", doc.addStream(cmap, doc.newDictionary()));
    return doc.addObject(dict);
  };

  it("gives way to the recognised line, which can then be replaced", async () => {
    const content = [
      "BT /F1 14 Tf 40 250 Td (This first line reads perfectly well.) Tj ET",
      "BT /F2 14 Tf 40 220 Td (Hidden meaning inside) Tj ET",
      "BT /F1 14 Tf 40 190 Td (This third line is also fine to edit.) Tj ET",
      "BT /F1 14 Tf 40 160 Td (And so is the fourth one down here.) Tj ET",
    ].join("\n");
    const engine = await open(
      build({ content, fonts: { F1: standard("Helvetica"), F2: broken }, size: [400, 300] }),
      nodeAssets,
    );
    const before = await engine.getPageText(0);
    const locked = before.lines.find((l) => !l.editable)!;
    expect(locked).toBeTruthy();
    const read = (text: string, y: number, x1: number): OcrLine => ({
      text,
      rect: [40, y - 11, x1, y + 4],
      baseline: [[40, y], [x1, y]],
      confidence: 92,
      words: [{ text, rect: [40, y - 11, x1, y + 4], confidence: 92 }],
    });
    // the recogniser reports every line of the page, readable ones included
    await engine.setOcrResult({
      page: 0,
      languages: ["eng"],
      lines: [
        read("This first line reads perfectly well.", 50, 282),
        read("Hidden meaning inside", 80, 190),
        read("This third line is also fine to edit.", 110, 282),
      ],
    });
    const merged = await engine.getPageText(0);
    expect(merged.lines).toHaveLength(4);
    expect(merged.lines.every((l) => l.editable)).toBe(true);
    const recovered = merged.lines.filter((l) => l.source === "ocr");
    expect(recovered.map((l) => l.text)).toEqual(["Hidden meaning inside"]);
    const result = await engine.editLines(0, [{ lineId: recovered[0]!.id, text: "Plain words at last" }]);
    expect(result.warnings).toEqual([]);
    savePng(engine, "wave2-unlocked");
    const final = await engine.getPageText(0);
    expect(final.lines.map((l) => l.text)).toContain("Plain words at last");
    expect(final.lines.some((l) => !l.editable)).toBe(false);
    // the unreadable operators are gone from the file, the good lines are untouched
    const out = await engine.exportText([0]);
    expect(out).toContain("Plain words at last");
    expect(out).toContain("This third line is also fine to edit.");
    expect(/[-]/.test(engine.context.doc.loadPage(0).toStructuredText("").asText())).toBe(false);
  });
});
