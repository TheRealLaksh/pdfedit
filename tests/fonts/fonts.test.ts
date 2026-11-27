/** Behaviour of the FONTS module: styles, spacing, fallback, embedding, undo, user and document fonts. */
import { existsSync, readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, test } from "vitest";
import { appendPageContent, ownResources } from "../../src/engine/content/page";
import { createAssetLoader, type EngineContext } from "../../src/engine/context";
import { addUserFont, inspectFont, listFonts, planText, writeText } from "../../src/engine/fonts";
import { family } from "../../src/engine/fonts/catalog";
import { strokeColourOps } from "../../src/engine/fonts/draw";
import { readTables } from "../../src/engine/fonts/sfnt";
import { draw, extractLines, makeContext, reopen, savePng, style } from "./helpers";
import { nodeAssets } from "./nodeAssets";

const url = (key: string, variant: "r" | "b" | "i" = "r") => family(key)!.urls[variant]!;
const SOURCE_SANS = "https://cdn.jsdelivr.net/npm/source-sans@3.52.0/OTF/SourceSans3-Regular.otf";
const CID_KEYED = "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf";

const original = (name: string, extra = {}) => ({ name, bold: false, italic: false, serif: false, mono: false, ...extra });

/** bounding box of everything darker than paper */
function inkBox(ctx: EngineContext): [number, number, number, number] {
  const pixmap = ctx.doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
  const width = pixmap.getWidth();
  const pixels = pixmap.getPixels();
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i]! > 200) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

const darkPixels = (ctx: EngineContext) =>
  ctx.doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false).getPixels().filter((v) => v < 128).length;

const baseFonts = (ctx: EngineContext) => {
  const fonts = ownResources(ctx.doc, ctx.doc.loadPage(0)).get("Font");
  const out: string[] = [];
  fonts.forEach((f) => out.push(f.get("BaseFont").asName()));
  return out;
};

describe("matching", () => {
  test("metric compatible substitutes are used and reported", async () => {
    const ctx = makeContext();
    for (const [name, expected] of [["Arial-BoldMT", "Arimo"], ["Calibri", "Carlito"], ["Cambria", "Caladea"], ["CourierNew", "Cousine"], ["TimesNewRomanPSMT", "Tinos"]]) {
      const plan = await planText(ctx, { text: "Invoice 42", style: style({ family: name! }), originalFont: original(name!) });
      expect(plan.fontsUsed).toEqual([expected]);
      expect(plan.substituted).toBe(true);
    }
    const exact = await planText(ctx, { text: "Invoice", style: style({ family: "Lato-Regular" }), originalFont: original("ABCDEF+Lato-Regular") });
    expect(exact).toMatchObject({ fontsUsed: ["Lato"], substituted: false, missing: [] });
  });

  test("Arimo has the metrics of Arial / Helvetica", async () => {
    const plan = await planText(makeContext(), { text: "Hello World", style: style({ size: 1000, family: "Helvetica" }) });
    // Helvetica AFM widths of "Hello World", no kerning
    const afm = 722 + 556 + 222 + 222 + 556 + 278 + 944 + 556 + 333 + 222 + 556;
    expect(Math.abs(plan.width - afm)).toBeLessThan(6);
  });

  test("a family chosen by the user wins over the document font", async () => {
    const ctx = makeContext();
    const picked = await planText(ctx, { text: "abc", style: style({ fontChoice: "web:lora" }), originalFont: original("Arial") });
    expect(picked.fontsUsed).toEqual(["Lora"]);
    const renamed = await planText(ctx, { text: "abc", style: style({ family: "Georgia" }), originalFont: original("Arial") });
    expect(renamed.fontsUsed).toEqual(["Gelasio"]);
  });

  test("characters outside the font fall back per cluster", async () => {
    const plan = await planText(makeContext(), { text: "Pay ₹500 😀 → नमस्ते", style: style({ family: "Calibri" }), originalFont: original("Calibri") });
    expect(plan.missing).toEqual([]);
    expect(plan.fontsUsed).toContain("Carlito");
    expect(plan.fontsUsed).toContain("Noto Sans Devanagari");
    expect(plan.fontsUsed).toContain("Noto Emoji");
  });

  test("characters nothing can draw are reported, the text still extracts", async () => {
    const ctx = makeContext();
    const written = await draw(ctx, "a\uE000b", 20, 40);
    expect(written.missing).toEqual(["\uE000"]);
    expect(extractLines(ctx.doc).join("")).toBe("a\uE000b");
  });

  test("Chinese, Japanese and Korean pick their own fonts", async () => {
    const ctx = makeContext();
    const used = async (text: string, extra = {}) => (await planText(ctx, { text, style: style({ family: "", ...extra }) })).fontsUsed;
    expect(await used("汉字")).toEqual(["Noto Sans SC"]);
    expect(await used("漢字學習")).toEqual(["Noto Sans TC"]);
    expect(await used("漢字です")).toEqual(["Noto Sans JP"]);
    expect(await used("漢字 한글")).toContain("Noto Sans KR");
    expect(await used("漢字", { family: "MS-Mincho" })).toEqual(["Noto Serif JP"]);
  });

  test("Urdu uses Nastaliq unless the document font is a naskh one", async () => {
    const ctx = makeContext(500, 200);
    const text = "اردو ہے";
    expect((await planText(ctx, { text, style: style({ family: "" }) })).fontsUsed).toContain("Noto Nastaliq Urdu");
    expect((await planText(ctx, { text, style: style({ family: "Arial" }) })).fontsUsed).toContain("Noto Sans Arabic");
    await draw(ctx, "اردو خوبصورت زبان ہے", 40, 80, { style: style({ size: 28, family: "Jameel Noori Nastaleeq" }) });
    savePng(ctx, "nastaliq");
    expect(extractLines(ctx.doc).join("")).toBe("اردو خوبصورت زبان ہے");
  });

  test("an unreachable font server is an error, not silent garbage", async () => {
    const ctx = makeContext();
    ctx.assets = createAssetLoader(async () => {
      throw new Error("offline");
    });
    await expect(planText(ctx, { text: "abc", style: style() })).rejects.toThrow(/offline|Could not load/);
  });
});

describe("layout", () => {
  test("planText and writeText agree, spacing and scaling add up", async () => {
    const ctx = makeContext();
    const text = "one two three";
    const plain = await planText(ctx, { text, style: style() });
    const written = await draw(ctx, text, 20, 40);
    expect(written.width).toBeCloseTo(plain.width, 6);
    const spaced = await planText(ctx, { text, style: style({ letterSpacing: 1 }), charSpacing: 0.5 });
    expect(spaced.width).toBeCloseTo(plain.width + 1.5 * text.length, 4);
    const words = await planText(ctx, { text, style: style(), wordSpacing: 4 });
    expect(words.width).toBeCloseTo(plain.width + 8, 4);
    const squeezed = await planText(ctx, { text, style: style(), horizontalScale: 80 });
    expect(squeezed.width).toBeCloseTo(plain.width * 0.8, 4);
  });

  test("the ink ends where the reported width says, with spacing, scaling and underline", async () => {
    for (const extra of [{}, { charSpacing: 3 }, { horizontalScale: 60 }, { wordSpacing: 10 }]) {
      const ctx = makeContext(600, 100);
      const written = await draw(ctx, "HIH IHI HIH", 20, 50, { ...extra, style: style({ size: 30, underline: true }) });
      const [x0, , x1] = inkBox(ctx);
      expect(Math.abs(x0 - 20)).toBeLessThanOrEqual(1);
      expect(Math.abs(x1 - (20 + written.width))).toBeLessThanOrEqual(1.5);
    }
  });

  test("right to left text starts at the left end of the baseline too", async () => {
    const ctx = makeContext(600, 100);
    const written = await draw(ctx, "שלום עולם", 100, 50, { style: style({ size: 30 }) });
    const [x0, , x1] = inkBox(ctx);
    expect(x0).toBeGreaterThanOrEqual(99);
    expect(x1).toBeLessThanOrEqual(101 + written.width);
  });

  test("a rotated text matrix rotates the line", async () => {
    const ctx = makeContext(300, 300);
    const page = ctx.doc.loadPage(0);
    // baseline pointing up the page
    const written = await writeText(ctx, { text: "rotated text", style: style(), matrix: [0, 1, -1, 0, 150, 50], resources: ownResources(ctx.doc, page) });
    appendPageContent(ctx.doc, page, written.ops);
    const [x0, y0, x1, y1] = inkBox(ctx);
    expect(y1 - y0).toBeGreaterThan(3 * (x1 - x0));
    expect(Math.abs(y1 - 250)).toBeLessThanOrEqual(3);
  });

  test("empty text writes nothing; control characters become spaces", async () => {
    const ctx = makeContext();
    expect((await draw(ctx, "", 20, 40)).ops).toBe("");
    await draw(ctx, "a\tb\nc", 20, 80);
    expect(extractLines(ctx.doc)).toEqual(["a b c"]);
  });
});

describe("styles", () => {
  test("real bold and italic files; synthetic ones when the family has none", async () => {
    const ctx = makeContext(600, 300);
    await draw(ctx, "Regular Aa", 20, 40);
    await draw(ctx, "Bold Aa", 20, 70, { style: style({ bold: true }) });
    await draw(ctx, "Italic Aa", 20, 100, { style: style({ italic: true }) });
    await draw(ctx, "Bold italic Aa", 20, 130, { style: style({ bold: true, italic: true }) });
    expect(baseFonts(ctx).map((n) => n.slice(7)).sort()).toEqual(["Arimo-Bold", "Arimo-BoldItalic", "Arimo-Italic", "Arimo-Regular"]);
    const fake = await draw(ctx, "synthetic Anton", 20, 180, { style: style({ fontChoice: "web:anton", bold: true, italic: true, color: [0.8, 0, 0] }) });
    expect(fake.ops).toContain("2 Tr");
    expect(fake.ops).toContain("0.8 0 0 RG");
    expect(fake.ops).toContain("1 0 0.21 1");
    await draw(ctx, "ಕನ್ನಡ दप्तर", 20, 230, { style: style({ italic: true, size: 24 }) });
    savePng(ctx, "styles");
  });

  test("synthetic bold really is heavier", async () => {
    const weigh = async (bold: boolean) => {
      const ctx = makeContext(400, 100);
      await draw(ctx, "synthetic weight", 20, 50, { style: style({ fontChoice: "web:didact-gothic", size: 32, bold }) });
      return darkPixels(ctx);
    };
    expect(await weigh(true)).toBeGreaterThan((await weigh(false)) * 1.15);
  });

  test("colour operators are used verbatim and mirrored for outlines", async () => {
    expect(strokeColourOps("0 0 0 1 k")).toBe("0 0 0 1 K");
    expect(strokeColourOps("/CS0 cs 0.5 scn")).toBe("/CS0 CS 0.5 SCN");
    expect(strokeColourOps("")).toBe("");
    const ctx = makeContext();
    const written = await draw(ctx, "cmyk", 20, 40, { colorOps: "0.1 0.9 0.8 0 k", style: style({ fontChoice: "web:anton", bold: true }) });
    expect(written.ops).toContain("0.1 0.9 0.8 0 k");
    expect(written.ops).toContain("0.1 0.9 0.8 0 K");
    expect(written.ops).not.toContain(" rg");
    const inherited = await draw(ctx, "inherit", 20, 80, { colorOps: "" });
    expect(inherited.ops).not.toMatch(/ (rg|g|k|scn)\n/);
  });

  test("invisible text extracts but draws nothing", async () => {
    const ctx = makeContext();
    await draw(ctx, "hidden words नमस्ते", 20, 40, { renderMode: 3, style: style({ underline: true }) });
    expect(darkPixels(ctx)).toBe(0);
    expect(extractLines(ctx.doc)).toEqual(["hidden words नमस्ते"]);
  });

  test("text state left by the surrounding content cannot disturb the output", async () => {
    const clean = makeContext(400, 100);
    await draw(clean, "steady text", 20, 50);
    const dirty = makeContext(400, 100);
    const page = dirty.doc.loadPage(0);
    const written = await writeText(dirty, { text: "steady text", style: style(), matrix: [1, 0, 0, 1, 20, 50], resources: ownResources(dirty.doc, page) });
    appendPageContent(dirty.doc, page, `5 Tc 9 Tw 40 Tz 7 Ts 3 Tr 20 w\n${written.ops}`);
    expect(inkBox(dirty)).toEqual(inkBox(clean));
  });
});

describe("embedding", () => {
  test("one embedded font per family, grown as glyphs are added, subset", async () => {
    const ctx = makeContext();
    await draw(ctx, "abc", 20, 40);
    await draw(ctx, "xyz ABC 123", 20, 80);
    await draw(ctx, "abc again", 20, 120);
    expect(baseFonts(ctx)).toHaveLength(1);
    expect(extractLines(ctx.doc)).toEqual(["abc", "xyz ABC 123", "abc again"]);
    const bytes = ctx.doc.saveToBuffer("compress").asUint8Array();
    expect(bytes.length).toBeLessThan(15_000);
  });

  test("concurrent writes share the fonts safely", async () => {
    const ctx = makeContext(600, 842);
    const texts = Array.from({ length: 20 }, (_, i) => `line ${i} ${String.fromCharCode(65 + i)} किताब ${i}`);
    const page = ctx.doc.loadPage(0);
    const resources = ownResources(ctx.doc, page);
    const written = await Promise.all(texts.map((text, i) => writeText(ctx, { text, style: style(), matrix: [1, 0, 0, 1, 20, 800 - i * 30], resources })));
    for (const w of written) appendPageContent(ctx.doc, ctx.doc.loadPage(0), w.ops);
    expect(extractLines(reopen(ctx.doc))).toEqual(texts);
  });

  test("undo and redo restore the fonts together with the page", async () => {
    const ctx = makeContext();
    ctx.doc.enableJournal();
    const states = [structuredClone(ctx.state)];
    const step = async (text: string, y: number) => {
      ctx.doc.beginOperation(text);
      await draw(ctx, text, 20, y);
      ctx.doc.endOperation();
      ctx.cache.clear();
      states.push(structuredClone(ctx.state));
    };
    await step("first line", 40);
    await step("second ZQXJ", 80);
    ctx.doc.undo();
    ctx.state = structuredClone(states[1]!);
    expect(extractLines(ctx.doc)).toEqual(["first line"]);
    ctx.doc.undo();
    ctx.state = structuredClone(states[0]!);
    expect(extractLines(ctx.doc)).toEqual([]);
    ctx.doc.redo();
    ctx.state = structuredClone(states[1]!);
    ctx.doc.redo();
    ctx.state = structuredClone(states[2]!);
    expect(extractLines(ctx.doc)).toEqual(["first line", "second ZQXJ"]);
    ctx.doc.undo();
    ctx.state = structuredClone(states[1]!);
    await step("third, after undo: WMK", 120);
    expect(extractLines(reopen(ctx.doc))).toEqual(["first line", "third, after undo: WMK"]);
    savePng(ctx, "undo");
  });

  test("pages render correctly after a font grew, also through undo and redo", async () => {
    const ctx = makeContext(400, 150);
    ctx.doc.enableJournal();
    const render = () => ctx.doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false).getPixels().slice();
    /** the same file opened from scratch, so nothing is cached */
    const truth = () => {
      mupdf.emptyStore();
      const copy = new mupdf.PDFDocument(ctx.doc.saveToBuffer("").asUint8Array().slice());
      const pixels = copy.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false).getPixels().slice();
      copy.destroy();
      mupdf.emptyStore();
      return pixels;
    };
    const step = async (text: string, y: number) => {
      ctx.doc.beginOperation(text);
      await draw(ctx, text, 20, y);
      ctx.doc.endOperation();
      // as the engine does after every mutation, undo and redo
      ctx.cache.clear();
    };
    const check = (label: string) => {
      const live = render();
      const expected = truth();
      // draw again so that the (possibly stale) fonts are cached for the next step
      render();
      expect(live.filter((v, i) => Math.abs(v - expected[i]!) > 60).length, label).toBe(0);
    };
    await step("abc \u0915\u093F\u0924\u093E\u092C", 40);
    render();
    await step("XYZ 987 \u0935\u093F\u0926\u094D\u092F\u093E", 90);
    expect(render().filter((v) => v < 128).length).toBeGreaterThan(300);
    check("after second write");
    ctx.doc.undo();
    ctx.cache.clear();
    check("after undo");
    ctx.doc.redo();
    ctx.cache.clear();
    check("after redo");
  });

  test("writing many lines stays fast", async () => {
    const ctx = makeContext();
    await draw(ctx, "warm up 汉字", 20, 40);
    const page = ctx.doc.loadPage(0);
    const resources = ownResources(ctx.doc, page);
    const started = performance.now();
    for (let i = 0; i < 400; i++)
      await writeText(ctx, { text: `Row ${i}: amount ${(i * 7919) % 100000} paid`, style: style(), matrix: [1, 0, 0, 1, 0, 0], resources });
    expect(performance.now() - started).toBeLessThan(4000);
  });
});

describe("user fonts", () => {
  test("an uploaded font is listed, preferred for its family name and usable", async () => {
    const ctx = makeContext(600, 200);
    const choice = addUserFont(ctx, "brand.ttf", await nodeAssets.bytes(url("pacifico")));
    expect(choice).toMatchObject({ family: "Pacifico", source: "user" });
    expect(choice.scripts).toContain("Latin");
    expect(listFonts(ctx)[0]).toEqual(choice);
    const auto = await draw(ctx, "automatic by name", 20, 60, { originalFont: original("ABCDEF+Pacifico-Regular"), style: style({ family: "Pacifico-Regular" }) });
    expect(auto).toMatchObject({ fontsUsed: ["Pacifico"], substituted: false });
    const picked = await draw(ctx, "picked, with नमस्ते", 20, 120, { style: style({ fontChoice: choice.id }) });
    expect(picked.fontsUsed).toContain("Pacifico");
    expect(picked.fontsUsed).toContain("Noto Sans Devanagari");
    expect(extractLines(ctx.doc)).toEqual(["automatic by name", "picked, with नमस्ते"]);
    savePng(ctx, "user-font");
  });

  test("bold uses the user's bold file when it was uploaded too", async () => {
    const ctx = makeContext();
    addUserFont(ctx, "r.ttf", await nodeAssets.bytes(url("lato")));
    addUserFont(ctx, "b.ttf", await nodeAssets.bytes(url("lato", "b")));
    const written = await draw(ctx, "heavy", 20, 40, { style: style({ family: "Lato", bold: true }) });
    expect(written.ops).not.toContain("2 Tr");
    expect(baseFonts(ctx)[0]).toContain("Lato-Bold");
  });

  test("OpenType CFF fonts embed and round-trip", async () => {
    const ctx = makeContext(600, 200);
    const choice = addUserFont(ctx, "SourceSans3.otf", await nodeAssets.bytes(SOURCE_SANS));
    await draw(ctx, "CFF outlines: office fi 0123", 20, 60, { style: style({ fontChoice: choice.id, size: 28 }) });
    await draw(ctx, "second write Åéîõü", 20, 120, { style: style({ fontChoice: choice.id, size: 28 }) });
    const saved = reopen(ctx.doc, "compress,garbage");
    expect(extractLines(saved)).toEqual(["CFF outlines: office fi 0123", "second write Åéîõü"]);
    expect(ctx.doc.saveToBuffer("compress").asUint8Array().length).toBeLessThan(60_000);
    expect(darkPixels(ctx)).toBeGreaterThan(1500);
    savePng(ctx, "cff");
  });

  test("CID keyed CFF fonts map glyphs to their CIDs", async () => {
    const ctx = makeContext(600, 200);
    const choice = addUserFont(ctx, "cid.otf", await nodeAssets.bytes(CID_KEYED));
    await draw(ctx, "한국어 CID 글꼴 abc 123", 20, 80, { style: style({ fontChoice: choice.id, size: 30 }) });
    savePng(ctx, "cid-keyed");
    expect(extractLines(reopen(ctx.doc))).toEqual(["한국어 CID 글꼴 abc 123"]);
    // the same line drawn with the TrueType build of the family looks alike
    const reference = makeContext(600, 200);
    await draw(reference, "한국어 CID 글꼴 abc 123", 20, 80, { style: style({ fontChoice: "web:noto-sans-kr", size: 30 }) });
    expect(Math.abs(darkPixels(ctx) - darkPixels(reference)) / darkPixels(reference)).toBeLessThan(0.08);
  });

  test.runIf(existsSync("C:/Windows/Fonts/cambria.ttc"))("collections register each face", async () => {
    const ctx = makeContext();
    const choice = addUserFont(ctx, "cambria.ttc", new Uint8Array(readFileSync("C:/Windows/Fonts/cambria.ttc")));
    expect(choice.family).toBe("Cambria");
    expect(ctx.userFonts.size).toBe(2);
    const written = await draw(ctx, "From a collection ∑", 20, 40, { style: style({ family: "Cambria" }) });
    expect(written.substituted).toBe(false);
    expect(extractLines(reopen(ctx.doc))).toEqual(["From a collection ∑"]);
    savePng(ctx, "ttc");
  });

  test("files that are not fonts are refused", () => {
    const ctx = makeContext();
    expect(() => addUserFont(ctx, "a.ttf", new TextEncoder().encode("definitely not a font file"))).toThrow(/not a TrueType/);
    expect(() => addUserFont(ctx, "a.woff", new TextEncoder().encode("wOFF0000000000000000"))).toThrow(/WOFF/);
  });
});

describe("the document's own font", () => {
  /** the subset font program embedded for a first write */
  async function embedded(text: string, fontChoice: string): Promise<Uint8Array> {
    const ctx = makeContext();
    await draw(ctx, text, 20, 40, { style: style({ fontChoice }) });
    const font = ownResources(ctx.doc, ctx.doc.loadPage(0)).get("Font", "PEF1");
    return font.get("DescendantFonts", 0, "FontDescriptor", "FontFile2").readStream().asUint8Array().slice();
  }

  test("is used for the characters it has, others fall back", async () => {
    const bytes = await embedded("Brand new", "web:pacifico");
    const ctx = makeContext();
    const font = original("XYZABC+HouseScript", { bytes });
    const same = await planText(ctx, { text: "wand Bear", style: style({ family: "HouseScript" }), originalFont: font });
    expect(same).toMatchObject({ fontsUsed: ["HouseScript"], substituted: false, missing: [] });
    const more = await draw(ctx, "Brand Zoo", 20, 40, { style: style({ family: "HouseScript" }), originalFont: font });
    expect(more.fontsUsed).toEqual(["HouseScript", "Arimo"]);
    expect(extractLines(reopen(ctx.doc)).join("")).toBe("Brand Zoo");
  });

  test("is not used when bold or italic changes", async () => {
    const bytes = await embedded("abc", "web:pacifico");
    const plan = await planText(makeContext(), { text: "abc", style: style({ family: "HouseScript", bold: true }), originalFont: original("HouseScript", { bytes }) });
    expect(plan.fontsUsed).toEqual(["Arimo"]);
  });

  test("a subset without shaping tables is not trusted with complex scripts", async () => {
    const bytes = await embedded("नमस्ते", "web:noto-sans-devanagari");
    const plan = await planText(makeContext(), { text: "नमस्ते", style: style({ family: "HouseHindi" }), originalFont: original("HouseHindi", { bytes }) });
    expect(plan.fontsUsed).toEqual(["Noto Sans Devanagari"]);
  });
});

describe("inspectFont", () => {
  test("TrueType", async () => {
    const info = (await inspectFont(await nodeAssets.bytes(url("arimo"))))!;
    expect(info.unitsPerEm).toBe(2048);
    expect(info.hasUnicode(65)).toBe(true);
    expect(info.hasUnicode(0x4e00)).toBe(false);
    const a = info.glyphForUnicode(65);
    expect(info.advance(a)).toBe(1366);
    expect(info.hasGlyphOutline(a)).toBe(true);
    expect(info.hasGlyphOutline(info.glyphForUnicode(32))).toBe(true);
    expect(info.hasGlyphOutline(999999)).toBe(false);
  });

  test("a subset keeps empty glyphs, which are reported as such", async () => {
    const ctx = makeContext();
    await draw(ctx, "AC", 20, 40);
    const font = ownResources(ctx.doc, ctx.doc.loadPage(0)).get("Font", "PEF1");
    const view = font.get("DescendantFonts", 0, "FontDescriptor", "FontFile2").readStream().asUint8Array();
    const full = (await inspectFont(await nodeAssets.bytes(url("arimo"))))!;
    const subset = (await inspectFont(view))!;
    expect(subset.hasGlyphOutline(full.glyphForUnicode(65))).toBe(true);
    expect(subset.hasGlyphOutline(full.glyphForUnicode(66))).toBe(false);
    expect(subset.hasUnicode(65)).toBe(true);
    expect(subset.hasUnicode(66)).toBe(false);
  });

  test("OpenType CFF and bare CFF", async () => {
    const otf = await nodeAssets.bytes(SOURCE_SANS);
    for (const bytes of [otf, readTables(otf).get("CFF ")!]) {
      const info = (await inspectFont(bytes))!;
      expect(info.unitsPerEm).toBe(1000);
      expect(info.hasUnicode(65)).toBe(true);
      const a = info.glyphForUnicode(65);
      expect(info.advance(a)).toBeGreaterThan(400);
      expect(info.hasGlyphOutline(a)).toBe(true);
      expect(info.hasGlyphOutline(info.glyphForUnicode(32))).toBe(true);
    }
  });

  test("anything else is null", async () => {
    expect(await inspectFont(new Uint8Array(0))).toBeNull();
    expect(await inspectFont(new TextEncoder().encode("hello, I am not a font at all, really not"))).toBeNull();
  });
});
