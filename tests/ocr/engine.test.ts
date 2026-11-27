/**
 * Scanned pages end to end: real recognition, real fonts, real PDFs. Results are checked by rendering
 * (pixels outside the edited lines must not move), by recognising the result again and by extracting
 * text. Before / after pictures are written to .tmp/ocr/.
 * The text module is replaced by a small stand-in so that this file only depends on OCR and fonts.
 */
import * as mupdf from "mupdf";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "../../src/engine/engine";
import { invert, apply } from "../../src/engine/geom";
import type { Matrix, PageKind, PageText, Rect, TextLine } from "../../src/engine/types";
import { configureOcr, recognizePage, terminateOcr, OCR_SCALE } from "../../src/ocr";
import { createNodeAssets } from "../fonts/nodeAssets";
import {
  accuracy, closeBrowser, degrade, render, SAMPLES, savePage, scanPdf, TESSDATA, typeset, PAGE_H, PAGE_W,
  type Sample, type ScanLook,
} from "./helpers";

const forced = new Map<number, PageKind>();
vi.mock("../../src/engine/text", () => ({
  analyzePage(ctx: import("../../src/engine/context").EngineContext, page: number): PageText {
    const p = ctx.doc.loadPage(page);
    const json = JSON.parse(p.toStructuredText("preserve-whitespace").asJSON()) as {
      blocks: { lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
    };
    const lines: TextLine[] = json.blocks
      .flatMap((b) => b.lines ?? [])
      .map((l, i) => {
        const rect: Rect = [l.bbox.x, l.bbox.y, l.bbox.x + l.bbox.w, l.bbox.y + l.bbox.h];
        const style = { family: "x", bold: false, italic: false, serif: false, mono: false, size: l.bbox.h, color: [0, 0, 0] as [number, number, number] };
        return {
          id: `c${i}`, page, text: l.text, rect, quad: [rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]],
          origin: [rect[0], rect[3]], angle: 0, dir: "ltr", style, spans: [], align: "left", source: "content", editable: true,
        };
      });
    p.destroy();
    return { page, revision: 0, kind: forced.get(page) ?? (lines.length ? "mixed" : "scanned"), lines };
  },
}));

const assets = createNodeAssets();
beforeAll(() => configureOcr({ cachePath: TESSDATA }));
afterAll(async () => {
  await terminateOcr();
  await closeBrowser();
});

async function open(bytes: Uint8Array): Promise<Engine> {
  const engine = new Engine(assets);
  const opened = await engine.open(bytes, "scan.pdf");
  expect(opened.status).toBe("ok");
  return engine;
}

async function recognise(engine: Engine, languages: string[], page = 0) {
  const image = await engine.renderPage(page, OCR_SCALE);
  const result = await recognizePage(image, { languages, scale: OCR_SCALE });
  return engine.setOcrResult(result);
}

/** recognise the current appearance of the page from scratch */
async function read(engine: Engine, languages: string[], page = 0): Promise<string[]> {
  const image = await engine.renderPage(page, OCR_SCALE);
  const result = await recognizePage(image, { languages, scale: OCR_SCALE });
  return result.lines.map((l) => l.text);
}

const snapshot = (engine: Engine, page = 0) => render(engine.context.doc, page, 200 / 72);

/** pixels that differ clearly, outside the allowed rectangles (page points) */
function changedOutside(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>, allowed: Rect[]): number {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  const s = 200 / 72;
  let count = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) < 12) continue;
      if (!allowed.some((r) => x >= r[0] * s && x <= r[2] * s && y >= r[1] * s && y <= r[3] * s)) count++;
    }
  }
  return count;
}

const grow = (r: Rect, by: number): Rect => [r[0] - by, r[1] - by, r[2] + by, r[3] + by];

const lineWith = (page: PageText, part: string): TextLine => {
  const found = page.lines.find((l) => l.text.includes(part));
  expect(found, `line containing ${part}: ${page.lines.map((l) => l.text).join(" / ")}`).toBeTruthy();
  return found!;
};

const pageText = (engine: Engine, page = 0) => engine.context.doc.loadPage(page).toStructuredText("preserve-whitespace").asText();

/** a ruled line right under line 3 and a table-like box around the last line */
const RULES = `<div style="position:absolute;left:30px;width:360px;top:130.5px;height:1.2px;background:#333"></div>
<div style="position:absolute;left:28px;width:366px;top:163px;height:33px;border:1.2px solid #333;box-sizing:border-box"></div>
<div style="position:absolute;left:28px;width:366px;top:250px;height:30px;background:linear-gradient(90deg,#c33,#36c)"></div>`;

describe("editing a scanned page", () => {
  const sample = SAMPLES.eng!;
  const look: ScanLook = { paper: [234, 220, 184], noise: 7, skew: 0.7, shade: 0.16 };
  let engine: Engine;
  let original: ReturnType<typeof snapshot>;
  let scanned: Uint8Array;

  beforeAll(async () => {
    scanned = scanPdf(degrade(await typeset(sample, "eng-rules", { extraHtml: RULES }), look));
    engine = await open(scanned);
    original = snapshot(engine);
    savePage(engine.context.doc, "eng-0-before.png");
  }, 120_000);

  it("turns recognised lines into editable lines with a believable style", async () => {
    const change = await recognise(engine, ["eng"]);
    expect(change.changedPages).toEqual([0]);
    expect(change.canUndo).toBe(true);
    const text = await engine.getPageText(0);
    expect(text.kind).toBe("scanned");
    expect(text.lines).toHaveLength(5);
    expect(accuracy(sample.lines.join("\n"), text.lines.map((l) => l.text).join("\n"))).toBeGreaterThan(0.98);
    for (const l of text.lines) {
      expect(l.id).toMatch(/^ocr:/);
      expect(l.source).toBe("ocr");
      expect(l.editable).toBe(true);
      expect(Math.abs((l.angle * 180) / Math.PI - 0.7)).toBeLessThan(0.5);
      expect(l.style.serif, l.text).toBe(true);
    }
    const [head, ...body] = text.lines;
    expect(head!.style.bold).toBe(true);
    expect(body.every((l) => !l.style.bold)).toBe(true);
    expect(head!.style.size).toBeGreaterThan(14.5);
    expect(head!.style.size).toBeLessThan(20);
    for (const l of body) {
      expect(l.style.size).toBeGreaterThan(11);
      expect(l.style.size).toBeLessThan(15.5);
      expect(l.align).toBe("left");
      // ink is #161616 on this paper: dark
      expect(Math.max(...l.style.color)).toBeLessThan(0.35);
    }
  }, 120_000);

  it("replaces words so that the page looks untouched elsewhere", async () => {
    const text = await engine.getPageText(0);
    const money = lineWith(text, "48,250");
    const result = await engine.editLines(0, [{ lineId: money.id, text: money.text.replace("48,250", "63,975").replace("below", "above") }]);
    expect(result.warnings).toEqual([]);
    savePage(engine.context.doc, "eng-1-edited.png");
    const after = snapshot(engine);
    const now = lineWith(await engine.getPageText(0), "63,975");
    expect(now.id).toBe(money.id);
    // fitted size is close to the typeset 13pt, width close to the original
    expect(Math.abs(now.style.size - 13)).toBeLessThan(0.9);
    expect(now.style.serif).toBe(true);
    expect(now.style.bold).toBe(false);
    expect(Math.abs(now.rect[0] - money.rect[0])).toBeLessThan(2);
    expect(Math.abs(now.rect[2] - money.rect[2])).toBeLessThan(8);
    expect(changedOutside(original, after, [grow(money.rect, 4)])).toBeLessThan(30);
    // the new text is real, selectable text
    expect(pageText(engine)).toContain("63,975");

    const seen = await read(engine, ["eng"]);
    expect(seen.join("\n")).toContain("63,975");
    expect(seen.join("\n")).not.toContain("48,250");
    const expected = sample.lines.map((l) => l.replace("48,250", "63,975").replace("below", "above"));
    expect(accuracy(expected.join("\n"), seen.join("\n"))).toBeGreaterThan(0.97);
  }, 120_000);

  it("keeps ruled lines when the line next to them is rewritten, deleted or restyled", async () => {
    const before = snapshot(engine);
    const text = await engine.getPageText(0);
    const first = text.lines[0]!;
    const rule = lineWith(text, "committee met"); // the rule runs under this line
    const boxed = lineWith(text, "written comments");
    const result = await engine.editLines(0, [
      { lineId: first.id, text: "Annual Report of the Garden Society", align: "center" },
      { lineId: rule.id, text: "" },
      { lineId: boxed.id, text: "Please phone the treasurer before Monday noon.", style: { color: [0.7, 0.05, 0.05] } },
    ]);
    expect(result.warnings.join()).toMatch(/covered, not erased/);
    savePage(engine.context.doc, "eng-2-more.png");
    const after = snapshot(engine);
    const now = await engine.getPageText(0);
    expect(now.lines).toHaveLength(4);
    expect(now.lines.some((l) => l.id === rule.id)).toBe(false);
    const heading = lineWith(now, "Garden");
    expect(heading.style.bold).toBe(true);
    const centre = (r: Rect) => (r[0] + r[2]) / 2;
    expect(Math.abs(centre(heading.rect) - centre(first.rect))).toBeLessThan(4);
    expect(changedOutside(before, after, [grow(first.rect, 5), grow(heading.rect, 5), grow(rule.rect, 4), grow(boxed.rect, 4)])).toBeLessThan(30);

    // the rule under the deleted line is still there: sample it between where letters were
    const s = 200 / 72;
    let darkOnRule = 0;
    for (let x = Math.round(40 * s); x < 380 * s; x++) {
      let dark = false;
      for (let y = Math.round(126 * s); y < 140 * s; y++) if (after.data[(y * after.width + x) * 4]! < 120) dark = true;
      if (dark) darkOnRule++;
    }
    expect(darkOnRule / (340 * s)).toBeGreaterThan(0.97);

    const seen = (await read(engine, ["eng"])).join("\n");
    expect(seen).toContain("Garden Society");
    expect(seen).toContain("treasurer");
    expect(seen).not.toContain("committee met");
    expect(seen).not.toContain("secretary");
  }, 180_000);

  it("replaces its own earlier change instead of stacking on it", async () => {
    const line = lineWith(await engine.getPageText(0), "63,975");
    await engine.editLines(0, [{ lineId: line.id, text: "Nothing was spent." }]);
    savePage(engine.context.doc, "eng-3-again.png");
    expect(pageText(engine)).toContain("Nothing was spent.");
    expect(pageText(engine)).not.toContain("63,975");
    const seen = (await read(engine, ["eng"])).join("\n");
    expect(seen).toContain("Nothing was spent");
    expect(seen).not.toContain("63,975");
    // one layer invocation, however many edits
    const content = new TextDecoder().decode(
      (await import("../../src/engine/content/page")).readPageContent(engine.context.doc.loadPage(0)),
    );
    expect(content.match(/\/PEOcr\d* Do/g)).toHaveLength(1);
  }, 120_000);

  it("moves, resizes, shrinks to fit and underlines", async () => {
    const line = lineWith(await engine.getPageText(0), "northern pier");
    await engine.editLines(0, [{ lineId: line.id, text: line.text, offset: [10, 62], style: { size: line.style.size * 1.2, underline: true } }]);
    const moved = lineWith(await engine.getPageText(0), "northern pier");
    expect(moved.rect[0]).toBeGreaterThan(line.rect[0] + 6);
    expect(moved.rect[1]).toBeGreaterThan(line.rect[1] + 55);
    expect(moved.style.size).toBeGreaterThan(13);
    await engine.editLines(0, [{ lineId: line.id, text: line.text + " This sentence is now much longer than before.", fit: "shrink", style: { size: line.style.size } }]);
    const shrunk = lineWith(await engine.getPageText(0), "much longer");
    expect(shrunk.rect[2] - shrunk.rect[0]).toBeLessThan((line.rect[2] - line.rect[0]) * 1.05);
    savePage(engine.context.doc, "eng-4-moved.png");
  }, 120_000);

  it("follows undo and redo", async () => {
    const latest = pageText(engine);
    for (let i = 0; i < 5; i++) await engine.undo();
    const clean = snapshot(engine);
    expect(changedOutside(original, clean, [])).toBe(0);
    expect((await engine.getPageText(0)).lines.map((l) => l.text).join()).toContain("48,250");
    await engine.undo(); // recognition itself
    expect((await engine.getPageText(0)).lines).toHaveLength(0);
    for (let i = 0; i < 6; i++) await engine.redo();
    expect(pageText(engine)).toBe(latest);
  }, 120_000);

  it("saves a file that opens again with the change in it", async () => {
    const saved = engine.context.doc.saveToBuffer("compress").asUint8Array().slice();
    expect(saved.length).toBeLessThan(scanned.length + 250_000);
    const again = mupdf.Document.openDocument(saved, "application/pdf").asPDF()!;
    expect(again.loadPage(0).toStructuredText("").asText()).toContain("Nothing was spent.");
    savePage(again, "eng-5-saved.png");
  });

  it("keeps working after the same page is recognised again", async () => {
    const edited = lineWith(await engine.getPageText(0), "Nothing was spent");
    await recognise(engine, ["eng"]);
    const text = await engine.getPageText(0);
    expect(text.lines.filter((l) => l.text.includes("Nothing was spent"))).toHaveLength(1);
    expect(lineWith(text, "Nothing was spent").id).toBe(edited.id);
    expect(text.lines.length).toBeLessThanOrEqual(5);
  }, 120_000);
});

const OTHER: Record<string, { look: ScanLook; line: number; text: string; gray?: boolean }> = {
  hin: { look: { paper: [238, 236, 224], noise: 6, skew: -0.8, shade: 0.1 }, line: 2, text: "पुस्तकालय शाम छह बजे बंद होता है।" },
  ara: { look: { paper: [214, 228, 240], noise: 5, skew: 0.6 }, line: 2, text: "يمكن للأساتذة استعارة عشرة كتب لمدة شهر." },
  chi_sim: { look: { paper: [244, 240, 228], noise: 6, skew: 0.5, shade: 0.1 }, line: 1, text: "图书馆每天上午九点开门，晚上十点关门。" },
  tam: { look: { paper: [250, 249, 244], noise: 5 }, line: 2, text: "ஆசிரியர்கள் பத்து புத்தகங்களை எடுக்கலாம்.", gray: true },
  rus: { look: { paper: [226, 226, 222], noise: 7, skew: 1.5, shade: 0.15 }, line: 2, text: "Учителя могут взять десять книг на целый месяц." },
};

describe.each(Object.entries(OTHER))("editing a %s scan", (code, spec) => {
  it("rewrites one line natively", async () => {
    const sample: Sample = SAMPLES[code]!;
    const engine = await open(scanPdf(degrade(await typeset(sample, code + "-edit"), spec.look), { gray: spec.gray }));
    await recognise(engine, [code]);
    const before = snapshot(engine);
    savePage(engine.context.doc, `${code}-0-before.png`);
    const text = await engine.getPageText(0);
    expect(text.lines).toHaveLength(5);
    const line = text.lines[spec.line]!;
    const result = await engine.editLines(0, [{ lineId: line.id, text: spec.text }]);
    expect(result.warnings).toEqual([]);
    savePage(engine.context.doc, `${code}-1-edited.png`);
    const after = snapshot(engine);
    const now = (await engine.getPageText(0)).lines.find((l) => l.id === line.id)!;
    expect(now.text).toBe(spec.text);
    expect(Math.abs(now.style.size - 13)).toBeLessThan(1.8);
    if (line.dir === "rtl") expect(Math.abs(now.rect[2] - line.rect[2])).toBeLessThan(2.5);
    else expect(Math.abs(now.rect[0] - line.rect[0])).toBeLessThan(2.5);
    expect(changedOutside(before, after, [grow(line.rect, 5), grow(now.rect, 3)])).toBeLessThan(30);
    const seen = (await read(engine, [code])).join("\n");
    const expected = sample.lines.map((l, i) => (i === spec.line ? spec.text : l)).join("\n");
    expect(accuracy(expected, seen)).toBeGreaterThan(code === "ara" ? 0.8 : 0.88);
  }, 240_000);
});

describe("removing every line", () => {
  it.each(["eng", "hin", "ara", "chi_sim", "tam", "rus"])("leaves clean paper behind (%s)", async (code) => {
    const sample = SAMPLES[code]!;
    const look = OTHER[code]?.look ?? { paper: [234, 220, 184] as [number, number, number], noise: 7, skew: -1.4, shade: 0.16 };
    const engine = await open(scanPdf(degrade(await typeset(sample, code + "-edit"), look)));
    await recognise(engine, [code]);
    const text = await engine.getPageText(0);
    await engine.editLines(0, text.lines.map((l) => ({ lineId: l.id, text: "" })));
    savePage(engine.context.doc, `${code}-2-blank.png`);
    const after = snapshot(engine);
    // compare every pixel with its surroundings: nothing like a letter part may be left
    let leftovers = 0;
    const lum = (x: number, y: number) => after.data[(y * after.width + x) * 4 + 1]!;
    for (let y = 8; y < after.height - 8; y++)
      for (let x = 8; x < after.width - 8; x++) {
        const around = (lum(x - 8, y) + lum(x + 8, y) + lum(x, y - 8) + lum(x, y + 8)) / 4;
        if (around - lum(x, y) > 55) leftovers++;
      }
    expect(leftovers).toBeLessThan(25);
    expect((await engine.getPageText(0)).lines).toHaveLength(0);
    expect(await read(engine, [code])).toEqual([]);
  }, 180_000);
});

describe("rotated pages", () => {
  for (const rotate of [90, 270] as const) {
    it(`edits a scan stored sideways with /Rotate ${rotate}`, async () => {
      const bytes = scanPdf(degrade(await typeset(SAMPLES.eng!, "eng"), { paper: [240, 232, 210], noise: 5 }), { rotate });
      const engine = await open(bytes);
      await recognise(engine, ["eng"]);
      const before = snapshot(engine);
      expect(before.width).toBeGreaterThan(before.height);
      const line = lineWith(await engine.getPageText(0), "48,250");
      await engine.editLines(0, [{ lineId: line.id, text: line.text.replace("48,250", "99,001") }]);
      savePage(engine.context.doc, `eng-rotate${rotate}.png`);
      const now = lineWith(await engine.getPageText(0), "99,001");
      expect(Math.abs(now.angle)).toBeLessThan(0.02);
      expect(Math.abs(now.rect[0] - line.rect[0])).toBeLessThan(2);
      expect(Math.abs(now.origin[1] - line.origin[1])).toBeLessThan(2);
      expect(changedOutside(before, snapshot(engine), [grow(line.rect, 4)])).toBeLessThan(30);
      expect((await read(engine, ["eng"])).join(" ")).toContain("99,001");
    }, 180_000);
  }

  it("keeps recognised lines in place when the page is turned afterwards", async () => {
    const engine = await open(scanPdf(degrade(await typeset(SAMPLES.eng!, "eng"), { noise: 4 })));
    await recognise(engine, ["eng"]);
    const line = lineWith(await engine.getPageText(0), "48,250");
    const doc = engine.context.doc;
    const matrixBefore = doc.loadPage(0).getTransform() as Matrix;
    doc.beginOperation("rotate");
    doc.findPage(0).put("Rotate", 90);
    doc.endOperation();
    engine.context.cache.clear();
    const turned = lineWith(await engine.getPageText(0), "48,250");
    const matrixAfter = doc.loadPage(0).getTransform() as Matrix;
    const expected = apply(matrixAfter, apply(invert(matrixBefore), line.origin));
    expect(Math.hypot(turned.origin[0] - expected[0], turned.origin[1] - expected[1])).toBeLessThan(0.5);
    expect(Math.abs(turned.angle - Math.PI / 2)).toBeLessThan(0.02);
    await engine.editLines(0, [{ lineId: turned.id, text: turned.text.replace("48,250", "10,000") }]);
    savePage(doc, "eng-turned-after.png");
    expect((await read(engine, [])).join(" ")).toContain("10,000");
  }, 180_000);
});

/** real text whose letters mean nothing to a reader of the file, as with legacy fonts */
function garbledPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Times-Roman"), "Latin");
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", font);
  resources.put("Font", fonts);
  const rows = SAMPLES.eng!.lines
    .map((l, i) => `BT /F1 ${i ? 13 : 17} Tf 0.1 0.1 0.35 rg 34 ${250 - i * 34} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`)
    .join("\n");
  const art = "0.9 0.93 0.8 rg 28 176 366 22 re f 0.2 G 1 w 30 172 m 390 172 l S";
  const page = doc.addPage([0, 0, PAGE_W, PAGE_H], 0, resources, `${art}\n${rows}`);
  doc.insertPage(-1, page);
  return doc.saveToBuffer("").asUint8Array().slice();
}

describe("pages whose text is real but unreadable", () => {
  it("deletes the old text operators instead of painting a picture, and keeps the art", async () => {
    forced.set(0, "garbled");
    try {
      const engine = await open(garbledPdf());
      await recognise(engine, ["eng"]);
      savePage(engine.context.doc, "garbled-0-before.png");
      const before = snapshot(engine);
      const text = await engine.getPageText(0);
      expect(text.lines).toHaveLength(5);
      expect(text.lines.every((l) => l.source === "ocr")).toBe(true);
      const line = lineWith(text, "committee met");
      await engine.editLines(0, [{ lineId: line.id, text: "The board will meet again in June." }]);
      savePage(engine.context.doc, "garbled-1-edited.png");
      const content = pageText(engine);
      expect(content).toContain("The board will meet again in June.");
      expect(content).not.toContain("committee met");
      for (const other of ["Quarterly Report", "48,250", "northern pier", "secretary"]) expect(content).toContain(other);
      // no picture was added to hide anything
      const images: unknown[] = [];
      engine.context.doc.loadPage(0).toStructuredText("preserve-images").walk({ onImageBlock: () => void images.push(1) });
      expect(images).toHaveLength(0);
      expect(changedOutside(before, snapshot(engine), [grow(line.rect, 4)])).toBeLessThan(30);
      const now = await engine.getPageText(0);
      expect(now.lines.filter((l) => l.text.includes("board will meet"))).toHaveLength(1);
      expect(now.lines).toHaveLength(5);
      // blue ink stays blue
      const colour = lineWith(now, "board").style.color;
      expect(colour[2]).toBeGreaterThan(colour[0] + 0.12);
    } finally {
      forced.clear();
    }
  }, 180_000);
});

describe("stroked text elsewhere on an unreadable page", () => {
  it("keeps its line width and dashes when other text is removed", async () => {
    forced.set(0, "garbled");
    try {
      const doc = mupdf.Document.openDocument(garbledPdf(), "application/pdf").asPDF()!;
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const old = new TextDecoder("latin1").decode(page.getObject().get("Contents").readStream().asUint8Array());
      const outline = "q 2.2 w [3 1] 0 d 1 J BT /F1 34 Tf 1 Tr 34 30 Td (OUTLINE ONLY) Tj ET Q";
      page.getObject().put("Contents", doc.addStream(`${old}\n${outline}`, doc.newDictionary()));
      const engine = await open(doc.saveToBuffer("").asUint8Array().slice());
      await recognise(engine, ["eng"]);
      const before = snapshot(engine);
      const line = lineWith(await engine.getPageText(0), "committee met");
      await engine.editLines(0, [{ lineId: line.id, text: "The board will meet again in June." }]);
      savePage(engine.context.doc, "garbled-stroked.png");
      expect(pageText(engine)).not.toContain("committee met");
      expect(changedOutside(before, snapshot(engine), [grow(line.rect, 4)])).toBeLessThan(30);
    } finally {
      forced.clear();
    }
  }, 180_000);
});

describe("searchable scans", () => {
  it("adds invisible words in the right places, once", async () => {
    const sample = SAMPLES.eng!;
    const engine = await open(scanPdf(degrade(await typeset(sample, "eng"), { paper: [240, 236, 220], noise: 5, skew: 1.1 })));
    await expect(engine.makeSearchable([0])).rejects.toThrow(/Recognise/);
    await recognise(engine, ["eng"]);
    const before = snapshot(engine);
    const result = await engine.makeSearchable([0]);
    expect(result.changedPages).toEqual([0]);
    expect(changedOutside(before, snapshot(engine), [])).toBe(0);
    const text = pageText(engine);
    expect(accuracy(sample.lines.join("\n"), text)).toBeGreaterThan(0.97);
    // search finds a word where the picture shows it
    const lines = await engine.getPageText(0);
    const line = lineWith(lines, "northern pier");
    expect(lines.lines).toHaveLength(5);
    const hits = engine.context.doc.loadPage(0).search("northern", undefined) as unknown as number[][][];
    expect(hits).toHaveLength(1);
    const q = hits[0]![0]!;
    expect(q[1]!).toBeGreaterThan(line.rect[1] - 5);
    expect(q[5]!).toBeLessThan(line.rect[3] + 5);
    expect(q[0]!).toBeGreaterThan(line.rect[0]);
    expect(q[2]!).toBeLessThan(line.rect[2]);

    await engine.makeSearchable([0]).catch(() => undefined);
    expect(pageText(engine).match(/northern/g)).toHaveLength(1);

    // editing afterwards removes the invisible words of that line as well
    await engine.editLines(0, [{ lineId: line.id, text: "Work on the southern gate starts in May." }]);
    const now = pageText(engine);
    expect(now).toContain("southern gate");
    expect(now).not.toContain("northern");
    expect(now).toContain("secretary");
  }, 180_000);

  it("makes Hindi and Arabic scans searchable", async () => {
    for (const code of ["hin", "ara"]) {
      const sample = SAMPLES[code]!;
      const engine = await open(scanPdf(degrade(await typeset(sample, code), { noise: 4 })));
      await recognise(engine, [code]);
      await engine.makeSearchable([0]);
      expect(accuracy(sample.lines.join("\n"), pageText(engine)), code).toBeGreaterThan(0.75);
    }
  }, 180_000);
});
