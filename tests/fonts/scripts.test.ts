/** Every script: shaping, rendering, extraction and agreement with Chromium. */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, test } from "vitest";
import { ownResources } from "../../src/engine/content/page";
import { planText } from "../../src/engine/fonts";
import { family } from "../../src/engine/fonts/catalog";
import { loadFace } from "../../src/engine/fonts/face";
import { SCRIPTS } from "../../src/engine/fonts/scripts";
import { compareWithChromium } from "./chromium";
import { draw, extractLines, makeContext, reopen, savePng, style } from "./helpers";
import { logicalText } from "./logical";
import { nodeAssets } from "./nodeAssets";
import { SAMPLES } from "./samples";

/**
 * MuPDF starts a new "line" where the writing direction changes, and reverses Arabic-Indic digits
 * (its own heuristic); these samples are checked word by word instead.
 */
const MIXED_DIRECTION = new Set(["Arabic", "Bidi LTR", "Bidi RTL"]);

describe("samples", () => {
  test("every character is drawn, text round-trips, in a compact file", async () => {
    const ctx = makeContext(700, 40 * SAMPLES.length + 20);
    const ops: string[] = [];
    for (const [i, [name, text]] of SAMPLES.entries()) {
      const written = await draw(ctx, text, 20, 35 + i * 40);
      expect(written.missing, name).toEqual([]);
      expect(written.width, name).toBeGreaterThan(20);
      expect(written.ascent, name).toBeGreaterThan(5);
      ops.push(written.ops);
    }
    const resources = ownResources(ctx.doc, ctx.doc.loadPage(0));
    for (const [i, [name, text]] of SAMPLES.entries()) {
      expect(logicalText(ops[i]!, resources), `${name} with ActualText`).toBe(text);
      expect(logicalText(ops[i]!, resources, false), `${name} ToUnicode only`).toBe(text);
    }

    savePng(ctx, "samples", 1.6);
    const saved = reopen(ctx.doc, "compress,garbage");
    const lines = extractLines(saved);
    const all = lines.join("");
    for (const [name, text] of SAMPLES) {
      if (!MIXED_DIRECTION.has(name)) expect(lines, name).toContain(text);
      else
        for (const word of text.split(/[^\p{L}\p{M}]+/u).filter((w) => w.length > 1)) expect(all, `${name}: ${word}`).toContain(word);
    }
    expect(ctx.doc.saveToBuffer("compress").asUint8Array().length).toBeLessThan(400_000);
  });

  test("MuPDF's own font subsetting at export keeps the pages intact", async () => {
    const ctx = makeContext(700, 40 * 12);
    const some = SAMPLES.filter(([n]) => ["Latin", "Hindi", "Bengali", "Tamil", "Urdu", "Hebrew", "Thai", "Khmer", "Chinese", "Korean"].includes(n));
    for (const [i, [, text]] of some.entries()) await draw(ctx, text, 20, 35 + i * 40);
    const pixels = () => ctx.doc.loadPage(0).toPixmap(ctx.mupdf.Matrix.identity, ctx.mupdf.ColorSpace.DeviceGray, false).getPixels().slice();
    const before = pixels();
    const text = extractLines(ctx.doc);
    ctx.doc.subsetFonts();
    const after = reopen(ctx.doc, "compress,garbage");
    const now = after.loadPage(0).toPixmap(ctx.mupdf.Matrix.identity, ctx.mupdf.ColorSpace.DeviceGray, false).getPixels();
    let different = 0;
    for (let i = 0; i < before.length; i++) if (Math.abs(before[i]! - now[i]!) > 40) different++;
    expect(different).toBe(0);
    expect(extractLines(after)).toEqual(text);
  });

  test.runIf(existsSync(chromium.executablePath()))("shaping matches Chromium with the same fonts", async () => {
    const half = Math.ceil(SAMPLES.length / 2);
    for (const [i, part] of [SAMPLES.slice(0, half), SAMPLES.slice(half)].entries()) {
      for (const result of await compareWithChromium(part, `chromium${i}`)) {
        // Chromium trims the spacing of Japanese punctuation, which plain text drawing does not
        if (result.name === "Japanese") continue;
        expect(Math.abs(result.width - result.chromiumWidth), result.name).toBeLessThan(0.5);
        expect(result.mismatch, result.name).toBeLessThan(0.005);
      }
    }
  });
});

describe("hard cases against Chromium", () => {
  test.runIf(existsSync(chromium.executablePath()))("conjuncts, joiners, stacked marks, nested bidi, Nastaliq", async () => {
    const hard: [string, string][] = [
      ["Kerning", "AVATAR To Wa office difficult waffle"],
      ["Marks", "q̃ a̐ Z̤̈ ọ̀é"],
      ["Devanagari", "ट्ट्ठ ड्ढ ह्म ह्य द्द द्ध रु रू श्र ज़ फ़ क़ ॐ ऽ ऱ्य ्र"],
      ["Joiners", "क्‌ष क्‍ष র‍্যাব ශ්‍රී می‌خواهم"],
      ["Nested bidi", "אבג (abc 123 [דהו]) ٤٥٪ -12.5% זח"],
    ];
    const nastaliq: [string, string][] = [["Nastaliq", "اردو خوبصورت زبان ہے، محبت"]];
    const results = [
      ...(await compareWithChromium(hard, "hard")),
      ...(await compareWithChromium(nastaliq, "nastaliq-chromium", "Noto Nastaliq Urdu")),
    ];
    for (const result of results) {
      expect(Math.abs(result.width - result.chromiumWidth), result.name).toBeLessThan(0.5);
      expect(result.mismatch, result.name).toBeLessThan(0.005);
    }
  });
});

describe("script coverage", () => {
  test("every script in the table has a font that draws and shapes its letters", async () => {
    const letter = /\p{L}/u;
    const failures: string[] = [];
    for (const script of SCRIPTS) {
      const own = new RegExp(`\\p{Script=${script.name}}`, "u");
      const url = family(script.sans)!.urls.r;
      const face = await loadFace(await nodeAssets.bytes(url));
      let sample = "";
      for (let cp = 0x41; cp < 0x1ffff && [...sample].length < 6; cp++) {
        const ch = String.fromCodePoint(cp);
        if (own.test(ch) && letter.test(ch) && face!.glyph(cp)) sample += ch;
      }
      if (!sample) {
        failures.push(`${script.name}: ${script.sans} has no letters of it`);
        continue;
      }
      if (script.ot && !script.ot.some((t) => face!.gsubScripts.has(t)))
        failures.push(`${script.name}: ${script.sans} lacks shaping rules ${[...face!.gsubScripts].join(",")}`);
      for (const serif of [false, true]) {
        const result = await planText(makeContext(), { text: sample, style: style({ serif, family: "" }) });
        if (result.missing.length || !result.width) failures.push(`${script.name} ${serif ? "serif" : "sans"}: ${result.missing.join("")}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
