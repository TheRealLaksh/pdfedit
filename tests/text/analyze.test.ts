/** Page analysis: reading order, scripts, page kinds, ids, speed, search and replace, redaction fallback. */
import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { analyze } from "../../src/engine/text/analyze";
import { redactAndRewrite } from "../../src/engine/text/fallback";
import { matchText } from "../../src/engine/text/diff";
import { matchesIn } from "../../src/engine/text/search";
import { reorderIndic, visualToLogical } from "../../src/engine/text/unicode";
import { build, diffOutside, extract, lines, open, render, savePng, standard } from "./helpers";
import { calls } from "./mockFonts";

vi.mock("../../src/engine/fonts", async () => await import("./mockFonts"));

const pieces = (s: string[]) => s.map((text) => ({ text, actual: false }));

describe("unicode order", () => {
  it("moves pre-base vowel signs and reph into logical order", () => {
    // visual: sign-i, na  ->  logical: na, sign-i
    expect(reorderIndic(pieces(["ि", "न"])).map((g) => g.text)).toEqual(["नि"]);
    // sign-i before a conjunct: half ka + ta
    expect(reorderIndic(pieces(["ि", "क्", "त"])).map((g) => g.text)).toEqual(["क्ति"]);
    // reph drawn after its consonant
    expect(reorderIndic(pieces(["क", "र्"])).map((g) => g.text)).toEqual(["र्क"]);
    // Tamil two part vowel: e-sign, ka, aa-sign -> ka + o-sign
    expect(reorderIndic(pieces(["ெ", "க", "ா"])).map((g) => g.text)).toEqual(["கொ"]);
    // Bengali e-kar + conjunct
    expect(reorderIndic(pieces(["ে", "ত"])).map((g) => g.text)).toEqual(["তে"]);
  });

  it("recovers logical order from right to left glyph order", () => {
    const run = (visual: string) => {
      const list = pieces([...visual]);
      const r = visualToLogical(list);
      return r.order.map((i) => r.mirrored.get(i) ?? list[i]!.text).join("");
    };
    const reverse = (s: string) => [...s].reverse().join("");
    const shalom = "שלום";
    expect(run(reverse(shalom))).toBe(shalom);
    // Hebrew with a number and a Latin word inside
    expect(run(`123 ${reverse(shalom)}`)).toBe(`${shalom} 123`);
    expect(run(`abc ${reverse(shalom)} ${reverse(shalom)}`)).toBe(`${shalom} ${shalom} abc`);
    // brackets are drawn mirrored
    expect(run(`(${reverse(shalom)}) ${reverse(shalom)}`)).toBe(`${shalom} (${shalom})`);
    // a Hebrew word inside an English sentence
    expect(run(`say ${reverse(shalom)} twice`)).toBe(`say ${shalom} twice`);
  });

  it("keeps a mostly left to right line with Hebrew and Arabic left to right", () => {
    const hebrew = "שלום";
    const arabic = "مرحبا";
    const reverse = (s: string) => [...s].reverse().join("");
    // as drawn: the right to left stretch is mirrored in place
    const list = pieces([..."Total: " + reverse(`${hebrew} ${arabic}`) + " (paid 2026)."]);
    const r = visualToLogical(list);
    expect(r.rtl).toBe(false);
    expect(r.order.map((i) => r.mirrored.get(i) ?? list[i]!.text).join("")).toBe(`Total: ${hebrew} ${arabic} (paid 2026).`);
  });

  it("judges the reading direction of two script lines from their punctuation and the page", () => {
    const hebrew = "\u05D4\u05D1\u05D0\u05D4";
    const arabic = "\u0627\u0644\u0642\u0627\u062F\u0645";
    const reverse = (s: string) => [...s].reverse().join("");
    const run = (visual: string, prior?: boolean) => {
      const list = pieces([...visual]);
      const r = visualToLogical(list, prior);
      return [r.rtl, r.order.map((i) => r.mirrored.get(i) ?? list[i]!.text).join("")];
    };
    // right to left sentence ending in Latin words and numbers: they stay one left to right stretch
    expect(run(`Room B12, 10:30 :${reverse(hebrew)}`)).toEqual([true, `${hebrew}: Room B12, 10:30`]);
    // left to right sentence ending in Arabic, though most letters are Arabic
    expect(run(`Next: ${reverse(`${arabic} ${arabic}`)}`)).toEqual([false, `Next: ${arabic} ${arabic}`]);
    // nothing in the line decides: the page does
    expect(run(`Go ${reverse(arabic)}`, false)[0]).toBe(false);
    expect(run(`Go ${reverse(arabic)}`, true)[0]).toBe(true);
  });

  it("diffs text keeping long unchanged stretches", () => {
    const map = matchText("the quick brown fox", "the slow brown fox");
    expect([...map.slice(0, 4)]).toEqual([0, 1, 2, 3]);
    expect([...map.slice(9)]).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("matches text across normalisation, case, ligatures and word boundaries", () => {
    expect(matchesIn("Café CAFÉ cafes", "café")).toEqual([
      [0, 4],
      [5, 10],
    ]);
    expect(matchesIn("an oﬃce", "office")).toEqual([[3, 7]]);
    expect(matchesIn("cat concat cat.", "cat", { wholeWord: true })).toEqual([
      [0, 3],
      [11, 14],
    ]);
    expect(matchesIn("Cat cat", "Cat", { matchCase: true })).toEqual([[0, 3]]);
    expect(matchesIn("it’s   here", "it's here")).toEqual([[0, 11]]);
  });
});

describe("page classification", () => {
  const image = (doc: mupdf.PDFDocument, res: mupdf.PDFObject) => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 40, 40], false);
    pix.clear(200);
    const xo = doc.newDictionary();
    xo.put("Im", doc.addImage(new mupdf.Image(pix)));
    res.put("XObject", xo);
  };

  it("reports empty, scanned, text and garbled pages", async () => {
    const e = await open(
      build(
        { content: "" },
        { content: "q 400 0 0 300 0 0 cm /Im Do Q", resources: image },
        { content: "BT /F1 12 Tf 40 200 Td (plain text) Tj ET" },
        { fonts: { F1: standard("ABCDEF+KrutiDev010") }, content: "BT /F1 14 Tf 40 200 Td (Hkkjr ljdkj dk vkns'k) Tj ET" },
        { content: "q 400 0 0 300 0 0 cm /Im Do Q BT /F1 12 Tf 3 Tr 40 200 Td (hidden recognised words) Tj ET", resources: image },
      ),
    );
    const kinds = [];
    for (let i = 0; i < 5; i++) kinds.push((await e.getPageText(i)).kind);
    expect(kinds).toEqual(["empty", "scanned", "text", "garbled", "mixed"]);
    const legacy = (await e.getPageText(3)).lines[0]!;
    expect(legacy.editable).toBe(false);
    expect(legacy.note).toMatch(/legacy/i);
    const r = await e.editLines(3, [{ lineId: legacy.id, text: "x" }]);
    expect(r.changedPages).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    // the hidden layer itself is not editable content (the OCR module may offer it as recognised lines)
    expect(analyze(e.context, 4).text.lines.every((l) => !l.editable)).toBe(true);
  });

  it("flags text whose characters cannot be known", async () => {
    const e = await open(
      build({
        fonts: {
          F1: (doc) => {
            const f = doc.newDictionary();
            f.put("Type", doc.newName("Font"));
            f.put("Subtype", doc.newName("Type1"));
            f.put("BaseFont", doc.newName("Helvetica"));
            const enc = doc.newDictionary();
            const diff = doc.newArray();
            diff.push(65);
            for (const n of ["g1", "g2", "g3", "g4"]) diff.push(doc.newName(n));
            enc.put("Differences", diff);
            f.put("Encoding", enc);
            return doc.addObject(f);
          },
        },
        content: "BT /F1 14 Tf 40 200 Td (ABCDABCD) Tj ET",
      }),
    );
    const page = await e.getPageText(0);
    expect(page.lines.every((l) => !l.editable)).toBe(true);
    expect(["garbled", "empty"]).toContain(page.kind);
  });

  it("gives stable ids, quads and styles", async () => {
    const bytes = build({
      fonts: { F1: standard("Times-BoldItalic") },
      content: "BT /F1 20 Tf 0 0.5 1 rg 50 200 Td (Styled line) Tj ET",
    });
    const a = await open(bytes);
    const b = await open(bytes);
    const [x] = await lines(a);
    const [y] = await lines(b);
    expect(x!.id).toBe(y!.id);
    expect(x!.style).toMatchObject({ family: "Times-BoldItalic", bold: true, italic: true, serif: true, mono: false, size: 20, color: [0, 0.5, 1] });
    expect(x!.origin).toEqual([50, 100]);
    expect(x!.rect[0]).toBeCloseTo(50, 3);
    expect(x!.rect[1]).toBeGreaterThan(75);
    expect(x!.rect[3]).toBeLessThan(110);
    expect(x!.spans).toEqual([{ start: 0, end: 11, style: x!.style }]);
  });

  it("analyses a 20k glyph page quickly", async () => {
    const rows = [];
    for (let i = 0; i < 160; i++)
      rows.push(`BT /F1 4 Tf 20 ${780 - i * 4.8} Td [(${"lorem ipsum dolor sit amet ".repeat(2)}) -40 (${"consectetur adipiscing elit sed do eiusmod tempor ".repeat(1)}) 20 (incididunt ut labore et dolore)] TJ ET`);
    const e = await open(build({ content: rows.join("\n"), size: [600, 800] }));
    analyze(e.context, 0);
    e.context.cache.clear();
    const start = performance.now();
    const result = analyze(e.context, 0);
    const time = performance.now() - start;
    console.log(`analysed ${result.interp!.glyphs.length} glyphs in ${time.toFixed(0)} ms`);
    expect(result.interp!.glyphs.length).toBeGreaterThan(20_000);
    expect(result.text.lines).toHaveLength(160);
    expect(time).toBeLessThan(900);
  });

  it("survives damaged content", async () => {
    const e = await open(build({ content: "BT /F9 12 Tf 40 200 Td (unknown font) Tj ET Q Q EMC ET BT /F1 12 Tf 40 100 Td (fine) Tj <zz> [ ( Tj" }));
    const page = await e.getPageText(0);
    expect(page.lines.map((l) => l.text)).toContain("fine");
  });
});

describe("find and replace", () => {
  const doc = () =>
    build(
      { content: "BT /F1 14 Tf 40 250 Td (Total: 100 dollars) Tj 0 -30 Td [(The tot) 20 (al is final)] TJ ET" },
      { content: "BT /F1 14 Tf 40 250 Td (Nothing here) Tj ET" },
      { content: "BT /F1 14 Tf 40 250 Td (Grand total and subtotal) Tj ET" },
    );

  it("finds across pages with quads over the match", async () => {
    const e = await open(doc());
    const found = await e.findText("total");
    expect(found.map((m) => m.page)).toEqual([0, 0, 2, 2]);
    expect(await e.findText("total", { wholeWord: true })).toHaveLength(3);
    expect(await e.findText("Total", { matchCase: true })).toHaveLength(1);
    expect(await e.findText("total", { pages: [2] })).toHaveLength(2);
    const quad = found[0]!.quads[0]!;
    const l = (await lines(e))[0]!;
    expect(quad[0]).toBeCloseTo(l.rect[0], 3);
    expect(quad[2] - quad[0]).toBeGreaterThan(25);
    expect(quad[2] - quad[0]).toBeLessThan(40);
  });

  it("replaces every match and counts them", async () => {
    const e = await open(doc());
    const before = await render(e, 1);
    const r = await e.replaceText("total", "sum", { wholeWord: true });
    expect(r.count).toBe(3);
    expect(r.changedPages).toEqual([0, 2]);
    expect(extract(e, 0)).toContain("sum: 100 dollars");
    expect(extract(e, 0)).toContain("The sum is final");
    expect(extract(e, 2)).toContain("Grand sum and subtotal");
    expect(diffOutside(before, await render(e, 1), [])).toBe(0);
    await e.undo();
    expect(extract(e, 2)).toContain("Grand total and subtotal");
  });

  it("replaces only the chosen matches", async () => {
    const e = await open(doc());
    const found = await e.findText("total");
    const r = await e.replaceText("total", "TOTAL", {}, [found[3]!]);
    expect(r.count).toBe(1);
    expect(extract(e, 2)).toContain("Grand total and subTOTAL");
    expect(extract(e, 0)).toContain("Total: 100");
  });
});

describe("redaction fallback", () => {
  it("replaces a line without our interpreter, keeping images and line art", async () => {
    const e = await open(
      build({
        content:
          "0.9 g 30 190 220 30 re f 0 g 30 188 220 0.5 re f BT /F1 14 Tf 40 200 Td (Old sentence here) Tj ET BT /F1 14 Tf 40 150 Td (Neighbour line) Tj ET",
      }),
    );
    const before = await render(e);
    const model = analyze(e.context, 0).models.find((m) => m.line.text.startsWith("Old"))!;
    const doc = e.context.doc;
    const page = doc.loadPage(0);
    calls.length = 0;
    doc.beginOperation("redact");
    await redactAndRewrite(e.context, page, [[model, { lineId: model.line.id, text: "New words" }]], { warnings: [], fallbackFonts: [] });
    doc.endOperation();
    page.destroy();
    e.context.cache.clear();
    expect(extract(e)).not.toContain("Old sentence");
    expect(extract(e)).toContain("New words");
    expect(extract(e)).toContain("Neighbour line");
    const after = await render(e);
    expect(diffOutside(before, after, [model.line.rect])).toBe(0);
    expect(calls[0]!.matrix[4]).toBeCloseTo(40, 2);
    expect(calls[0]!.matrix[5]).toBeCloseTo(200, 2);
    savePng(e, "redaction");
  });
});

describe("replacement text that covers a whole line", () => {
  it("goes when the line is edited and the glyphs read correctly by themselves", async () => {
    const e = await open(
      build({ content: "/Span << /ActualText (Marked content carries actual text) >> BDC BT /F1 13 Tf 40 240 Td (Marked content carries actual text) Tj ET EMC" }),
    );
    const l = (await lines(e))[0]!;
    await e.editLines(0, [{ lineId: l.id, text: "Marked content carries fresh words" }]);
    expect((await lines(e))[0]!.text).toBe("Marked content carries fresh words");
    expect(extract(e)).toBe("Marked content carries fresh words");
  });
});

describe("clusters from producers that use filler glyphs and ActualText", () => {
  /** Helvetica with its own widths and ToUnicode: B maps to U+FEFF, m is a zero width combining acute */
  const font = (doc: mupdf.PDFDocument) => {
    const cmap = [
      "begincmap 1 begincodespacerange <00> <FF> endcodespacerange",
      "5 beginbfchar <78> <0078> <79> <0079> <41> <006B> <42> <FEFF> <6D> <0301> endbfchar endcmap",
    ].join(" ");
    const f = doc.newDictionary();
    f.put("Type", doc.newName("Font"));
    f.put("Subtype", doc.newName("Type1"));
    f.put("BaseFont", doc.newName("Helvetica"));
    f.put("Encoding", doc.newName("WinAnsiEncoding"));
    f.put("FirstChar", 32);
    f.put("LastChar", 126);
    f.put("Widths", Array.from({ length: 95 }, (_, i) => (i + 32 === 109 ? 0 : 600)));
    f.put("ToUnicode", doc.addStream(cmap, doc.newDictionary()));
    return doc.addObject(f);
  };
  const page = (content: string) => open(build({ fonts: { F1: font }, content }));

  it("drops zero width no-break spaces from the text", async () => {
    const e = await page("BT /F1 20 Tf 40 100 Td (xABy) Tj ET");
    expect((await lines(e))[0]!.text).toBe("xky");
    const inside = await page("BT /F1 20 Tf 40 100 Td (x) Tj /Span <</ActualText <FEFF0061FEFF0062>>> BDC (AB) Tj EMC (y) Tj ET");
    expect((await lines(inside))[0]!.text).toBe("xaby");
  });

  it("splits a cluster by span membership", async () => {
    // the accent outside the span sits on a glyph of the span
    const e = await page("BT /F1 20 Tf 40 100 Td (x) Tj /Span <</ActualText <FEFF005A0057>>> BDC (AB) Tj EMC (my) Tj ET");
    expect((await lines(e))[0]!.text).toBe("xZẂy".normalize("NFC"));
    // an accent inside its own span sits on ordinary glyphs, which keep their own text
    const own = await page("BT /F1 20 Tf 40 100 Td (x) Tj /Span <</ActualText <FEFF0301>>> BDC (m) Tj EMC (y) Tj ET");
    expect((await lines(own))[0]!.text).toBe("x́y".normalize("NFC"));
  });

  it("adds text inside a multi operator span without duplicating the span text", async () => {
    const e = await page("BT /F1 20 Tf 40 100 Td (x) Tj /Span <</ActualText <FEFF005A0057>>> BDC (A) Tj (B) Tj EMC (y) Tj ET");
    const l = (await lines(e))[0]!;
    expect(l.text).toBe("xZWy");
    for (const text of ["xxZWy", "xxZWxy"]) {
      const now = (await lines(e))[0]!;
      await e.editLines(0, [{ lineId: now.id, text }]);
      expect((await lines(e))[0]!.text).toBe(text);
    }
  });
});
