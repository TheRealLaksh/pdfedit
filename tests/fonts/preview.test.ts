/** The typing preview: document fonts rebuilt so a real browser accepts them, and the stand-ins. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { family } from "../../src/engine/fonts/catalog";
import { cmapRanges } from "../../src/engine/fonts/sfnt";
import type { PreviewFont, TextLine } from "../../src/engine/types";
import { nodeAssets } from "./nodeAssets";

const OUT = ".tmp/fonts";
mkdirSync(OUT, { recursive: true });
const corpus = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/pdfs/${name}.pdf`));

async function open(name: string): Promise<Engine> {
  const engine = new Engine(nodeAssets);
  const result = await engine.open(corpus(name), `${name}.pdf`);
  if (result.status !== "ok") throw new Error("could not open");
  return engine;
}

interface Sample {
  doc: string;
  line: TextLine;
  font: PreviewFont;
}

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.setContent("<!doctype html><meta charset=utf-8><body></body>");
});
afterAll(() => browser?.close());

/** load through FontFace and measure `text` in that font alone */
function inBrowser(font: PreviewFont, text: string, size: number) {
  return page.evaluate(
    async ({ data, text, size }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const name = `f${Math.random().toString(36).slice(2)}`;
      try {
        const face = new FontFace(name, bytes.buffer);
        await face.load();
        document.fonts.add(face);
      } catch (e) {
        return { loaded: false, width: 0, fallback: 0, error: String(e) };
      }
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${size}px ${name}, monospace`;
      const width = context.measureText(text).width;
      context.font = `${size}px monospace`;
      return { loaded: true, width, fallback: context.measureText(text).width, error: "" };
    },
    { data: Buffer.from(font.data).toString("base64"), text, size },
  );
}

const DOCS = [
  "en-truetype", "en-cff", "en-chromium", "ru-chromium", "el-chromium", "he-chromium", "th-chromium",
  "zh-chromium", "ja-chromium", "ko-chromium", "table-chromium", "justified-chromium", "positioning",
];

describe("getLineFont", () => {
  const samples: Sample[] = [];

  it("rebuilds embedded fonts that Chromium accepts, with widths that match the page", async () => {
    const report: string[] = [];
    for (const name of DOCS) {
      const engine = await open(name);
      const { lines } = await engine.getPageText(0);
      const done = new Set<string>();
      let tried = 0;
      for (const line of lines) {
        if (!line.editable || tried >= 8) continue;
        const font = await engine.getLineFont(0, line.id);
        if (!font) continue;
        const key = `${font.family}:${font.data.length}`;
        if (done.has(key)) continue;
        done.add(key);
        tried++;
        const covered = new Set(font.coverage);
        expect(font.coverage!.length).toBeGreaterThan(0);
        expect(new Set(cmapRanges(font.data).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)))).toEqual(covered);
        const all = [...line.text].every((c) => covered.has(c.codePointAt(0)!) || c === " ");
        const size = 64;
        const result = await inBrowser(font, line.text, size);
        expect(result.loaded, `${name} ${font.family} ${result.error}`).toBe(true);
        const pageWidth = Math.hypot(line.quad[2] - line.quad[0], line.quad[3] - line.quad[1]);
        const ratio = result.width / ((pageWidth * size) / line.style.size);
        report.push(`${name} ${font.family} cover=${all} ratio=${ratio.toFixed(3)} fallback=${font.fallback} "${line.text.slice(0, 30)}"`);
        samples.push({ doc: name, line, font });
        if (all && line.align !== "justify" && name !== "positioning") {
          expect(ratio, `${name} ${font.family} ${line.text}`).toBeGreaterThan(0.9);
          expect(ratio, `${name} ${font.family} ${line.text}`).toBeLessThan(1.1);
        }
      }
      report.push(`${name}: ${tried} fonts`);
    }
    writeFileSync(`${OUT}/preview.txt`, report.join("\n"));
    expect(samples.length).toBeGreaterThan(10);
    expect(new Set(samples.map((s) => s.doc))).toContain("en-cff");
  }, 120_000);

  it("shows the same letters as the page (picture for review)", async () => {
    const rows: { image: string; font: string; text: string; size: number }[] = [];
    for (const { doc, line, font } of samples.slice(0, 24)) {
      const engine = await open(doc);
      const scale = 36 / line.style.size;
      const [x0, y0, x1, y1] = line.rect;
      const r = await engine.renderPage(0, scale, [x0 - 2, y0 - 2, Math.min(x1 + 2, x0 + 900 / scale), y1 + 2]);
      const png = await page.evaluate(
        ({ w, h, data }) => {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const bytes = Uint8ClampedArray.from(atob(data), (c) => c.charCodeAt(0));
          canvas.getContext("2d")!.putImageData(new ImageData(bytes, w, h), 0, 0);
          return canvas.toDataURL();
        },
        { w: r.width, h: r.height, data: Buffer.from(r.data.buffer).toString("base64") },
      );
      rows.push({ image: png, font: Buffer.from(font.data).toString("base64"), text: line.text, size: 36 });
    }
    await page.evaluate(async (rows) => {
      document.body.innerHTML = "";
      document.body.style.cssText = "background:#fff;margin:8px;width:1000px";
      for (const [i, row] of rows.entries()) {
        const face = new FontFace(`row${i}`, Uint8Array.from(atob(row.font), (c) => c.charCodeAt(0)).buffer);
        await face.load();
        document.fonts.add(face);
        const img = new Image();
        img.src = row.image;
        await img.decode();
        const typed = document.createElement("div");
        typed.textContent = row.text;
        typed.dir = "auto";
        typed.style.cssText = `font:${row.size}px row${i}, cursive;color:#06c;white-space:pre;overflow:hidden;line-height:1.35;border-bottom:1px solid #ccc`;
        document.body.append(img, typed);
      }
    }, rows);
    await page.screenshot({ path: `${OUT}/preview-lines.png`, fullPage: true });
  }, 120_000);

  it("gives null where there is nothing to rebuild, and a stand-in to use instead", async () => {
    const engine = await open("en-standard14");
    const { lines } = await engine.getPageText(0);
    expect(await engine.getLineFont(0, lines[0]!.id)).toBeNull();
    expect(await engine.getLineFont(0, "no-such-line")).toBeNull();
    expect(await engine.getLineFont(0, "ocr:1:0")).toBeNull();
    const stand = await engine.getChoiceFont(`auto:${lines[0]!.style.family}`, false, false);
    expect(stand?.family).toMatch(/Arimo|Tinos|Cousine/);
    expect((await inBrowser(stand!, "Hello", 20)).loaded).toBe(true);
  });

  it("falls back to a font of the line's script", async () => {
    const engine = await open("hi-chromium");
    const { lines } = await engine.getPageText(0);
    const line = lines.find((l) => /[ऀ-ॿ]{3}/.test(l.text))!;
    const font = await engine.getLineFont(0, line.id);
    // Hindi needs shaping rules: a subset without them must not claim the letters
    if (font) {
      const devanagari = font.coverage!.some((c) => c >= 0x900 && c <= 0x97f);
      if (devanagari) expect((await inBrowser(font, line.text, 40)).loaded).toBe(true);
    }
    const chosen = await engine.getChoiceFont("web:noto-sans-devanagari", true, false);
    expect(chosen?.family).toBe("Noto Sans Devanagari");
  });
});

describe("getChoiceFont and document fonts", () => {
  it("serves catalog, user and document fonts, and lists the document's own", async () => {
    const engine = await open("en-truetype");
    const list = await engine.listFonts();
    const own = list.filter((f) => f.source === "document");
    expect(own.length).toBeGreaterThan(0);
    for (const choice of own) {
      const font = await engine.getChoiceFont(choice.id, false, false);
      if (font) expect((await inBrowser(font, "Abc", 20)).loaded, choice.family).toBe(true);
    }
    const web = await engine.getChoiceFont("web:arimo", true, true);
    expect(web!.family).toBe("Arimo");
    const bytes = await nodeAssets.bytes(family("tinos")!.urls.r);
    const user = await engine.addUserFont("mine.ttf", bytes.slice());
    expect((await engine.getChoiceFont(user.id, false, false))!.data.length).toBe(bytes.length);
    expect(await engine.getChoiceFont("web:nothing", false, false)).toBeNull();
    expect(await engine.getChoiceFont("user:gone", false, false)).toBeNull();
    expect(await engine.getChoiceFont("doc:999999", false, false)).toBeNull();
    expect(await engine.getChoiceFont("rubbish", false, false)).toBeNull();
  });
});
