/**
 * The text engine together with the real FONTS module: words the document's own font cannot draw must come
 * out shaped, in place and extractable. Fonts are downloaded once into .tmp/fonts-cache.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { Rect } from "../../src/engine/types";
import { nodeAssets } from "../fonts/nodeAssets";
import { build, diffOutside, extract, lines, open, render, savePng, union } from "./helpers";

const dir = "tests/fixtures/pdfs/";
const norm = (s: string) => s.normalize("NFC").replace(/[\u00AD\u200B-\u200F]/g, "").replace(/\s+/g, " ").trim();

/** document, line number, new word to put in front and at the end */
const cases: [string, string][] = [
  ["en-chromium", "Quizzical jumbo"],
  ["en-standard14", "Za\u017C\u00F3\u0142\u0107 g\u0119\u015Bl\u0105"],
  ["en-cff", "Quizzical \u0416\u0443\u043A"],
  ["hi-chromium", "\u091C\u093C\u0930\u0942\u0930\u0940 \u091D\u0930\u0928\u093E"],
  ["hi-type3", "\u091C\u093C\u0930\u0942\u0930\u0940 \u091D\u0930\u0928\u093E"],
  ["mr-chromium", "\u091D\u0930\u093E"],
  ["bn-chromium", "\u099D\u09B0\u09CD\u09A3\u09BE"],
  ["ta-chromium", "\u0B9C\u0BCB\u0BB0\u0BCD"],
  ["te-chromium", "\u0C1D\u0C30\u0C3F"],
  ["gu-chromium", "\u0A9D\u0AB0\u0AA3\u0AC1\u0A82"],
  ["pa-chromium", "\u0A1D\u0A30\u0A28\u0A3E"],
  ["kn-chromium", "\u0C9D\u0CB0\u0CBF"],
  ["ml-chromium", "\u0D1D\u0D30\u0D3F"],
  ["or-chromium", "\u0B1D\u0B30"],
  ["ar-chromium", "\u0632\u062E\u0631\u0641\u0629"],
  ["ur-chromium", "\u0698\u0627\u0644\u06C1"],
  ["he-chromium", "\u05D6\u05D9\u05E7\u05D9\u05EA"],
  ["th-chromium", "\u0E0C\u0E32\u0E19"],
  ["zh-chromium", "\u9F8D\u9CF3"],
  ["ja-chromium", "\u9B31\u8594"],
  ["ko-chromium", "\uBDC1\uC25D"],
  ["ru-chromium", "\u0429\u0443\u043A\u0430"],
  ["el-chromium", "\u03A8\u03C5\u03C7\u03AE"],
  ["rotated-text", "Jazzy quiz"],
  ["rotated-pages", "Jazzy quiz"],
  ["offset-cropbox", "Jazzy quiz"],
  ["justified-chromium", "Jazzy"],
  ["type3-latin", "Jazzy quiz"],
];

describe.skipIf(!fs.existsSync(dir))("editing with the real fonts module", () => {
  for (const [id, word] of cases) {
    it(`${id}: types new words`, async () => {
      if (!fs.existsSync(`${dir}${id}.pdf`)) return;
      const e = await open(new Uint8Array(fs.readFileSync(`${dir}${id}.pdf`)), nodeAssets);
      const pool = (await lines(e)).filter((l) => l.editable && l.text.trim().length > 8);
      const target = pool[1] ?? pool[0]!;
      const words = target.text.split(" ");
      // replace one word in the middle (or the whole of an unspaced line's second half)
      const next =
        words.length > 2
          ? [words[0], word, ...words.slice(2)].join(" ")
          : words.length === 2
            ? `${words[0]} ${word}`
            : target.text.slice(0, Math.ceil(target.text.length / 2)) + word.replace(/ /g, "");
      const before = await render(e);
      const result = await e.editLines(0, [{ lineId: target.id, text: next }]);
      const after = await render(e);
      savePng(e, `real-${id}`);
      expect(result.warnings.filter((w) => w.startsWith("No available font"))).toEqual([]);
      const now = await lines(e);
      const got = now.find((l) => norm(l.text) === norm(next));
      expect(got, `${next}\n<- ${now.map((l) => l.text).join("\n")}`).toBeDefined();
      const box: Rect = union(target.rect, got!.rect);
      expect(diffOutside(before, after, [box], 4)).toBeLessThan(12);
      expect(diffOutside(before, after, [], 0)).toBeGreaterThan(10);
      // the same line can be edited again afterwards
      await e.editLines(0, [{ lineId: got!.id, text: target.text }]);
      expect((await lines(e)).map((l) => norm(l.text))).toContain(norm(target.text));
    });
  }

  it("draws missing characters in a plain document and keeps them searchable", async () => {
    const e = await open(build({ content: "BT /F1 16 Tf 0.1 0.2 0.7 rg 40 200 Td (Price list for visitors) Tj ET" }), nodeAssets);
    const l = (await lines(e))[0]!;
    const next = "Price list \u20B9 \u0928\u092E\u0938\u094D\u0924\u0947 \u0645\u0631\u062D\u0628\u0627 \u4E2D\u6587 for visitors";
    const result = await e.editLines(0, [{ lineId: l.id, text: next }]);
    savePng(e, "real-mixed", 0, 3);
    expect(result.warnings).toEqual([]);
    expect(result.fallbackFonts.length).toBeGreaterThan(0);
    expect((await lines(e)).map((x) => norm(x.text))).toContain(norm(next));
    expect(extract(e)).toContain("\u0928\u092E\u0938\u094D\u0924\u0947");
    expect((await e.findText("\u4E2D\u6587")).length).toBe(1);
  });

  it("restyles a line with the substitute fonts", async () => {
    const e = await open(build({ content: "BT /F1 16 Tf 40 200 Td (Restyle this line) Tj 0 -30 Td (not this one) Tj ET" }), nodeAssets);
    const [first, second] = await lines(e);
    const before = await render(e);
    await e.editLines(0, [{ lineId: first!.id, text: first!.text, style: { italic: true, bold: true, color: [0.8, 0, 0] } }]);
    savePng(e, "real-restyle");
    const now = await lines(e);
    const styled = now.find((l) => l.text === "Restyle this line")!;
    expect(styled.style.bold).toBe(true);
    expect(styled.style.italic).toBe(true);
    expect(styled.style.color[0]).toBeCloseTo(0.8, 2);
    expect(styled.origin[1]).toBeCloseTo(first!.origin[1], 2);
    expect(diffOutside(before, await render(e), [union(first!.rect, styled.rect)], 3)).toBe(0);
    expect(now.find((l) => l.text === "not this one")!.origin).toEqual(second!.origin);
  });
});

describe.skipIf(!fs.existsSync(`${dir}scan-en.pdf`))("find and replace over recognised pages", () => {
  it("finds recognised lines and sends their replacements to the OCR module", async () => {
    const e = await open(new Uint8Array(fs.readFileSync(`${dir}scan-en.pdf`)), nodeAssets);
    const manifest = JSON.parse(fs.readFileSync(`${dir}manifest.json`, "utf8"));
    const expected = manifest.documents.find((d: { id: string }) => d.id === "scan-en").pages[0].lines as { text: string; rect: Rect }[];
    await e.setOcrResult({
      page: 0,
      languages: ["eng"],
      lines: expected.map((l) => ({ text: l.text, rect: l.rect, confidence: 95, words: [] })),
    });
    const found = await e.findText("library");
    expect(found.length).toBeGreaterThan(1);
    expect(found.every((m) => m.lineId.startsWith("ocr:"))).toBe(true);
    const result = await e.replaceText("library", "archive");
    expect(result.count).toBe(found.length);
    expect((await lines(e)).some((l) => l.text.includes("archive"))).toBe(true);
    expect(await e.findText("library")).toHaveLength(0);
  });
});
