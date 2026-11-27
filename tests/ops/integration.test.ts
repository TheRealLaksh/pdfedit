/**
 * OPS with the real FONTS, TEXT and OCR modules. Downloads fonts into .tmp/fonts-cache the first time.
 * The corpus part runs when tests/fixtures/pdfs exists.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { Rect, TextStyle } from "../../src/engine/types";
import { createNodeAssets } from "../fonts/nodeAssets";
import { formPdf } from "./formFixture";
import { everything, load, makePdf, open, OUT, pageText, pngBytes, savePng, shot } from "./helpers";

const assets = createNodeAssets();
const style: TextStyle = { family: "Noto Sans", bold: false, italic: false, serif: false, mono: false, size: 16, color: [0.1, 0.1, 0.4] };
const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, "");

const SAMPLES = [
  "नमस्ते दुनिया, क्षत्रिय किताब",
  "வணக்கம் உலகம் தமிழ்",
  "বাংলা ভাষা শিক্ষা",
  "مرحبا بالعالم العربي",
  "שלום עולם",
  "中文排版测试，日本語のテキスト",
  "สวัสดีชาวโลก ภาษาไทย",
  "Ελληνικά и русский, café naïve",
];

describe("with the real fonts module", () => {
  it("writes added text in many scripts that extracts and survives export", { timeout: 180_000 }, async () => {
    const engine = await open(makePdf([{ content: "", size: [420, 600] }]), new Engine(assets));
    let y = 20;
    for (const text of SAMPLES) {
      const result = await engine.addObject({ kind: "text", page: 0, rect: [20, y, 400, y + 24], align: "left", style, text });
      expect(result.warnings).toEqual([]);
      y += 40;
    }
    await engine.addObject({
      kind: "text", page: 0, rect: [20, 360, 200, 380], align: "justify", style: { ...style, size: 13, underline: true, letterSpacing: 0.5 },
      text: "यह एक लंबा अनुच्छेद है जो कई पंक्तियों में बँटना चाहिए ताकि संरेखण जाँचा जा सके।",
    });
    await engine.addObject({
      kind: "text", page: 0, rect: [220, 360, 400, 380], align: "right", rotation: 0, opacity: 0.6, style: { ...style, size: 13, bold: true },
      text: "هذه فقرة طويلة يجب أن تنقسم إلى عدة أسطر لاختبار المحاذاة من اليمين.",
    });
    await engine.addWatermark({ text: "गोपनीय", style: { ...style, size: 60, color: [0.8, 0, 0] }, opacity: 0.2, angle: 30 });
    await engine.addPageNumbers({ format: "पृष्ठ {n} / {total}", position: "bottom-center", style: { ...style, size: 11 }, margin: 16, startAt: 1 });
    await shot(engine, 0);
    savePng(engine.context.doc, 0, "real-scripts");

    for (const options of [{}, { compress: true }, { compress: true, flatten: true }]) {
      const bytes = await engine.exportPdf(options);
      const text = squash(pageText(load(bytes)));
      for (const sample of SAMPLES) expect(text, sample).toContain(squash(sample));
      savePng(bytes, 0, `real-scripts-${Object.keys(options).join("-") || "plain"}`);
      writeFileSync(`${OUT}/real-scripts.pdf`, bytes);
    }
    const compressed = await engine.exportPdf({ compress: true });
    expect(compressed.length).toBeLessThan(700_000);
    const exported = squash(await engine.exportText());
    for (const sample of SAMPLES) expect(exported, `text export: ${sample}`).toContain(squash(sample));
  });

  it("updating a text object repeatedly keeps the file small and leaves no old text", { timeout: 120_000 }, async () => {
    const engine = await open(makePdf([{ content: "" }]), new Engine(assets));
    await engine.addObject({ kind: "text", page: 0, rect: [20, 40, 280, 60], align: "left", style, text: "पुराना OLDWORD" });
    const first = (await engine.exportPdf()).length;
    for (let i = 0; i < 6; i++) {
      const [o] = await engine.listObjects(0);
      await engine.updateObject({ ...o!, kind: "text", text: `नया पाठ ${i}` } as typeof o & object);
    }
    const bytes = await engine.exportPdf();
    expect(squash(pageText(load(bytes)))).toBe(squash("नया पाठ 5"));
    expect(everything(bytes)).not.toContain("OLDWORD");
    expect(bytes.length).toBeLessThan(first * 1.6 + 5000);
    await engine.undo();
    expect(squash(pageText(engine))).toBe(squash("नया पाठ 4"));
  });

  it("fills forms in Indic, Arabic and CJK", { timeout: 180_000 }, async () => {
    const engine = await open(formPdf(true), new Engine(assets));
    const field = async (name: string) => (await engine.listFormFields()).find((f) => f.name === name)!;
    const fill = async (name: string, value: string) => {
      const f = await field(name);
      const result = await engine.setFormField(f.page, f.id, value);
      expect(result.warnings).toEqual([]);
    };
    await fill("name", "आशा वर्मा");
    await fill("address", "பார்க் தெரு 12\n中文地址一二三\nشارع الحديقة");
    await fill("pin", "१२३४५६");
    await fill("city", "मुंबई");
    await shot(engine, 0);
    savePng(engine.context.doc, 0, "real-forms");
    const flat = await engine.exportPdf({ flatten: true, compress: true });
    savePng(flat, 0, "real-forms-flat");
    const text = squash(pageText(load(flat)));
    for (const value of ["आशा वर्मा", "பார்க் தெரு 12", "中文地址一二三", "شارع الحديقة", "मुंबई"])
      expect(text, value).toContain(squash(value));
    const kept = load(await engine.exportPdf({ compress: true }));
    expect(kept.loadPage(0).getWidgets().map((w) => w.getValue())).toContain("आशा वर्मा");
    savePng(kept, 0, "real-forms-kept");
  });

  it("redacts text written in a complex script completely", { timeout: 120_000 }, async () => {
    const engine = await open(makePdf([{ content: "" }]), new Engine(assets));
    await engine.addObject({ kind: "text", page: 0, rect: [20, 40, 280, 60], align: "left", style, text: "गुप्त कुंजी" });
    await engine.addObject({ kind: "text", page: 0, rect: [20, 140, 280, 160], align: "left", style, text: "खुला पाठ" });
    await engine.redactAreas(0, [[10, 35, 290, 75]]);
    const bytes = await engine.exportPdf();
    const doc = load(bytes);
    expect(squash(pageText(doc))).toBe(squash("खुला पाठ"));
    const raw = everything(bytes);
    const utf16 = (s: string) => Buffer.from(s, "utf16le").swap16();
    expect(raw).not.toContain("गुप्त");
    expect(raw.toLowerCase()).not.toContain(utf16("गुप्त").toString("hex"));
    expect(Buffer.from(bytes).includes(utf16("गुप्त"))).toBe(false);
  });
});

describe("with the real OCR module", () => {
  const scan = () =>
    makePdf([{ content: "" }], (doc) => {
      const picture = doc.addImage(new mupdf.Image(pngBytes(300, 400, () => [250, 248, 240])));
      doc.findPage(0).get("Resources").put("XObject", { Scan: picture });
      doc.findPage(0).put("Contents", doc.addStream("q 300 0 0 400 0 0 cm /Scan Do Q", {}));
    });

  it("hides OCR patches from the image list, follows page moves and redacts recognised words", { timeout: 120_000 }, async () => {
    const engine = await open(scan(), new Engine(assets));
    const word = (text: string, x: number): { text: string; rect: Rect; confidence: number } => ({
      text, rect: [x, 100, x + 70, 116], confidence: 95,
    });
    await engine.setOcrResult({
      page: 0, languages: ["eng"],
      lines: [{ text: "secretive ordinary", rect: [40, 100, 200, 116], confidence: 95, words: [word("secretive", 40), word("ordinary", 130)] }],
    });
    const line = (await engine.getPageText(0)).lines[0]!;
    await engine.editLines(0, [{ lineId: line.id, text: "secretive changed" }]);
    expect(await engine.listImages(0)).toHaveLength(1);

    await engine.insertBlankPage(0, 200, 200);
    await engine.rotatePages([1], 90);
    const turned = (await engine.getPageText(1)).lines[0]!;
    expect(turned.text).toBe("secretive changed");
    expect(Math.abs(Math.sin(turned.angle))).toBeGreaterThan(0.9);
    await engine.rotatePages([1], 270);
    await engine.duplicatePage(1);
    expect((await engine.getPageText(2)).lines[0]!.text).toBe("secretive changed");

    await engine.redactAreas(1, [[35, 95, 112, 122]]);
    const left = (await engine.getPageText(1)).lines.map((l) => l.text).join(" ");
    expect(left).not.toContain("secretive");
    expect(await engine.exportText([1])).not.toContain("secretive");
    expect(await engine.exportText([2])).toContain("secretive");
    savePng(engine.context.doc, 1, "real-ocr-redacted");
    const saved = await engine.exportPdf({ compress: true });
    expect(pageText(load(saved), 1)).not.toContain("secretive");
    expect(pageText(load(saved), 2)).toContain("secretive");
  });
});

const CORPUS = "tests/fixtures/pdfs";
const files = existsSync(CORPUS) ? readdirSync(CORPUS).filter((f) => f.endsWith(".pdf")) : [];

describe.skipIf(!files.length)("every operation over the fixture corpus", () => {
  it.each(files)("%s", { timeout: 180_000 }, async (file) => {
    const engine = new Engine(assets);
    const bytes = new Uint8Array(readFileSync(`${CORPUS}/${file}`));
    let result = await engine.open(bytes, file);
    if (result.status === "password") result = await engine.open(bytes, file, "test1234");
    expect(result.status).toBe("ok");

    const pictures = async () => {
      const out: string[] = [];
      for (let i = 0; i < Math.min(8, engine.context.doc.countPages()); i++)
        out.push(createHash("sha1").update((await engine.renderPage(i, 0.5)).data).digest("hex"));
      return [engine.context.doc.countPages(), ...out];
    };
    const original = await pictures();
    const originalText = await engine.exportText([0]);
    let steps = 0;
    const run = async (call: Promise<unknown>) => {
      await call;
      steps++;
    };

    const png = pngBytes(30, 20, () => [20, 120, 60]);
    for (let page = 0; page < Math.min(3, engine.context.doc.countPages()); page++) {
      const images = await engine.listImages(page);
      if (!images.length) continue;
      const [x0, y0, x1, y1] = images[0]!.rect;
      const target: Rect = [x0 + 7, y0 + 9, x1 + 7, y1 + 9];
      await run(engine.moveImage(page, images[0]!.id, target));
      const moved = (await engine.listImages(page))[0]!;
      moved.rect.forEach((v, i) => expect(Math.abs(v - target[i]!), `${file} moved image`).toBeLessThan(0.6));
      await run(engine.replaceImage(page, moved.id, png));
      const count = (await engine.listImages(page)).length;
      await run(engine.deleteImage(page, moved.id));
      expect((await engine.listImages(page)).length).toBe(count - 1);
    }

    for (const field of (await engine.listFormFields()).filter((f) => !f.readOnly).slice(0, 12)) {
      const value =
        field.type === "checkbox" || field.type === "radio"
          ? true
          : field.options
            ? (field.options.at(-1) ?? "")
            : "परीक्षण 12";
      await run(engine.setFormField(field.page, field.id, value));
    }

    await run(engine.addObject({ kind: "text", page: 0, rect: [30, 30, 260, 50], align: "left", style, text: "Added नोट" }));
    await run(engine.addObject({ kind: "highlight", page: 0, rect: [30, 60, 200, 80] }));
    await run(engine.rotatePages([0], 90));
    await run(engine.duplicatePage(0));
    await run(engine.insertBlankPage(1, 300, 300));
    const count = engine.context.doc.countPages();
    await run(engine.reorderPages([...Array(count).keys()].reverse()));
    await run(engine.deletePages([count - 2]));
    await run(engine.insertPdf(makePdf(), 0));

    // redact the first recognisable line of the first original page we can read
    let secret = "";
    for (let page = 0; page < engine.context.doc.countPages() && !secret; page++) {
      const text = await engine.getPageText(page);
      const line = text.lines.find((l) => l.source === "content" && squash(l.text).length > 12 && !l.text.includes("Page") && !l.text.includes(String.fromCharCode(0xfffd)));
      if (!line) continue;
      secret = squash(line.text);
      await run(engine.redactAreas(page, [line.rect]));
      expect(squash(await engine.exportText([page])), `${file}: redacted line is gone`).not.toContain(secret);
    }
    await run(engine.addWatermark({ text: "SAMPLE", style: { ...style, size: 48 }, opacity: 0.2, angle: 45 }));
    await run(engine.addPageNumbers({ format: "{n}/{total}", position: "bottom-right", style, margin: 20, startAt: 1 }));

    const final = engine.context.doc.countPages();
    const plain = await engine.exportPdf();
    expect(load(plain).countPages()).toBe(final);
    const small = load(await engine.exportPdf({ compress: true, flatten: true, password: "p,w" }), "p,w");
    expect(small.countPages()).toBe(final);
    // exporting with every option must not change how the pages look
    const open_ = new mupdf.PDFDocument(plain);
    for (let i = 0; i < Math.min(5, final); i++) {
      const picture = (doc: mupdf.PDFDocument) => {
        const p = doc.loadPage(i);
        const pm = p.toPixmap([0.5, 0, 0, 0.5, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
        const data = pm.getPixels().slice();
        pm.destroy();
        p.destroy();
        return data;
      };
      const a = picture(open_);
      const b = picture(small);
      let differing = 0;
      for (let k = 0; k < a.length; k++) if (Math.abs(a[k]! - b[k]!) > 40) differing++;
      if (differing / a.length >= 0.004) {
        savePng(open_, i, `diff-${file}-a`);
        savePng(small, i, `diff-${file}-b`);
      }
      expect(differing / a.length, `${file} page ${i + 1} after compress + flatten`).toBeLessThan(0.004);
    }
    expect((await engine.exportText()).length).toBeGreaterThan(0);

    for (let i = 0; i < steps; i++) await engine.undo();
    expect(await pictures(), `${file}: undoing everything restores the original`).toEqual(original);
    expect(await engine.exportText([0])).toBe(originalText);
    for (let i = 0; i < steps; i++) await engine.redo();
    expect(engine.context.doc.countPages()).toBe(final);
    await engine.close();
  });
});
