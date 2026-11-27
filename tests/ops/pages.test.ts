import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { OcrPageResult, TextStyle } from "../../src/engine/types";
import { formPdf } from "./formFixture";
import { everything, label, load, makePdf, open, pageText, pageTexts, pngBytes, shot, undoable } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

const style: TextStyle = { family: "Helvetica", bold: false, italic: false, serif: false, mono: false, size: 14, color: [0, 0, 0] };
const four = () => makePdf([{}, {}, {}, {}]);
const rect = (page: number) => ({ kind: "rect" as const, page, rect: [10, 10, 60, 40] as [number, number, number, number], fill: [1, 0, 0] as [number, number, number], stroke: null });

/** link on page 1 to page 3, bookmarks to pages 2 and 3, a name destination */
function linked() {
  return makePdf([{}, {}, {}], (doc) => {
    const link = doc.addObject({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 100, 30] });
    link.put("Dest", [doc.findPage(2), "Fit"]);
    const web = doc.addObject({
      Type: "Annot", Subtype: "Link", Rect: [10, 40, 100, 60], A: { S: "URI", URI: doc.newString("https://example.com/") },
    });
    doc.findPage(0).put("Annots", [link, web]);
    const items = doc.outlineIterator();
    items.insert({ title: "Second", uri: "#page=2", open: false });
    items.insert({ title: "Third", uri: "#page=3", open: false });
  });
}

function linksOf(doc: mupdf.PDFDocument, page: number): string[] {
  const p = doc.loadPage(page);
  const out = p.getLinks().map((l) => (l.isExternal() ? l.getURI() : `page ${doc.resolveLink(l) + 1}`));
  p.destroy();
  return out;
}

/** inject recognised text as the OCR module would store it */
function fakeOcr(engine: Engine, page: number, text: string) {
  const result: OcrPageResult = {
    page, languages: ["eng"],
    lines: [{ text, rect: [10, 20, 100, 35], confidence: 90, words: [{ text, rect: [10, 20, 100, 35], confidence: 90 }] }],
  };
  engine.context.state.ocr[page] = { result, edits: {}, pageObject: engine.context.doc.findPage(page).asIndirect() };
}

describe("page tools", () => {
  it("rotates pages and keeps objects where they are on the paper", async () => {
    const engine = await open(makePdf([{ content: "0 g 20 340 40 20 re f" }]));
    await engine.addObject(rect(0));
    await engine.addObject({ kind: "text", page: 0, rect: [100, 100, 250, 120], align: "left", style, text: "turning" });
    await engine.addObject({ kind: "line", page: 0, rect: [0, 0, 0, 0], from: [20, 200], to: [120, 200], stroke: [0, 0, 1], strokeWidth: 4 });
    fakeOcr(engine, 0, "word");
    const r = await undoable(engine, () => engine.rotatePages([0], 90));
    expect(r.doc.pages[0]).toMatchObject({ width: 400, height: 300 });
    const [box, text, line] = await engine.listObjects(0);
    // the 50x30 box at the top left is now 30x50 at the top right
    expect(box!.rect).toEqual([360, 10, 390, 60]);
    expect(text!.rotation).toBe(90);
    expect(line!.kind === "line" && line!.from).toEqual([200, 20]);
    expect(engine.context.state.ocr[0]!.result.lines[0]!.rect).toEqual([365, 10, 380, 100]);
    const before = await shot(engine, 0, "pages-rotated");
    expect(before.at(375, 35)).toEqual([255, 0, 0]);
    // rewriting every object from its registry entry changes nothing on screen
    const pixels = (await engine.renderPage(0, 1)).data.slice();
    for (const o of await engine.listObjects(0)) await engine.updateObject(o);
    const now = (await engine.renderPage(0, 1)).data;
    let differing = 0;
    for (let i = 0; i < now.length; i++) if (Math.abs(now[i]! - pixels[i]!) > 8) differing++;
    expect(differing).toBeLessThan(20);
    for (const d of [180, 270] as const) await engine.rotatePages([0], d);
    for (const o of await engine.listObjects(0)) await engine.updateObject(o);
    expect((await shot(engine, 0)).width).toBe(300);
  });

  it("deletes pages with their state, links and bookmarks, leaving nothing behind", async () => {
    const engine = await open(linked());
    await engine.addObject(rect(0));
    await engine.addObject(rect(2));
    fakeOcr(engine, 1, "second");
    const r = await undoable(engine, () => engine.deletePages([1]));
    expect(r.doc.pageCount).toBe(2);
    expect(pageTexts(engine)).toEqual(["Page 1", "Page 3"]);
    expect((await engine.listObjects(1)).length).toBe(1);
    expect(engine.context.state.ocr).toEqual({});
    expect(linksOf(engine.context.doc, 0)).toEqual(["page 2", "https://example.com/"]);
    expect(engine.context.doc.loadOutline()!.map((o) => o.title)).toEqual(["Third"]);
    const out = await engine.exportPdf();
    expect(everything(out)).not.toContain("Page 2");
    expect(everything(out)).not.toContain("Second");

    await engine.deletePages([1]);
    expect(linksOf(engine.context.doc, 0)).toEqual(["https://example.com/"]);
    expect(engine.context.doc.loadOutline()).toBeNull();
    await expect(engine.deletePages([0])).rejects.toThrow(/at least one/);
  });

  it("removes the form fields of deleted pages", async () => {
    const engine = await open(formPdf());
    await undoable(engine, () => engine.deletePages([1]));
    const names = (await engine.listFormFields()).map((f) => f.name);
    expect(names).toEqual(["name", "address", "pin", "agree", "size", "city", "colour"]);
    expect(everything(await engine.exportPdf())).not.toContain("locked");
    await engine.setFormField(0, (await engine.listFormFields())[4]!.id, true);
  });

  it("reorders pages and everything that points at them", async () => {
    const engine = await open(linked());
    await engine.addObject(rect(0));
    fakeOcr(engine, 2, "third");
    const r = await undoable(engine, () => engine.reorderPages([2, 0, 1]));
    expect(r.changedPages).toEqual([0, 1, 2]);
    expect(pageTexts(engine)).toEqual(["Page 3", "Page 1", "Page 2"]);
    expect(await engine.listObjects(1)).toHaveLength(1);
    expect(engine.context.state.ocr[0]!.result.page).toBe(0);
    expect(linksOf(engine.context.doc, 1)[0]).toBe("page 1");
    expect(engine.context.doc.loadOutline()!.map((o) => o.page)).toEqual([2, 0]);
    await expect(engine.reorderPages([0, 0, 1])).rejects.toThrow();
    const saved = load(await engine.exportPdf());
    expect(pageText(saved, 0)).toBe("Page 3");
  });

  it("duplicates a page with independent objects", async () => {
    const engine = await open(four());
    const id = (await engine.addObject(rect(1))).createdId!;
    await engine.addObject(rect(3));
    fakeOcr(engine, 1, "dup");
    await undoable(engine, () => engine.duplicatePage(1));
    expect(pageTexts(engine)).toEqual(["Page 1", "Page 2", "Page 2", "Page 3", "Page 4"]);
    const [original] = await engine.listObjects(1);
    const [copy] = await engine.listObjects(2);
    expect(original!.id).toBe(id);
    expect(copy!.id).not.toBe(id);
    expect(await engine.listObjects(4)).toHaveLength(1);
    expect(engine.context.state.ocr[2]!.pageObject).toBe(engine.context.doc.findPage(2).asIndirect());
    await undoable(engine, () => engine.updateObject({ ...copy!, rect: [100, 100, 150, 130] }));
    expect((await shot(engine, 1)).at(30, 20)).toEqual([255, 0, 0]);
    expect((await shot(engine, 2)).at(30, 20)).toEqual([255, 255, 255]);
    expect((await shot(engine, 2)).at(120, 115)).toEqual([255, 0, 0]);
    await engine.removeObject(id);
    expect((await shot(engine, 2)).at(120, 115)).toEqual([255, 0, 0]);
    expect((await shot(engine, 1)).at(30, 20)).toEqual([255, 255, 255]);
  });

  it("shares form values between a page and its duplicate", async () => {
    const engine = await open(formPdf());
    await undoable(engine, () => engine.duplicatePage(0));
    const names = (await engine.listFormFields()).filter((f) => f.name === "name");
    expect(names.map((f) => f.page)).toEqual([0, 1]);
    const result = await undoable(engine, () => engine.setFormField(1, names[1]!.id, "Both"));
    expect(result.changedPages.sort()).toEqual([0, 1]);
    expect((await engine.listFormFields()).filter((f) => f.name === "name").map((f) => f.value)).toEqual(["Both", "Both"]);
    expect((await shot(engine, 0)).ink([20, 35, 200, 60])).toBeGreaterThan(0.02);
  });

  it("inserts blank and image pages", async () => {
    const engine = await open(four());
    await engine.addObject(rect(2));
    await undoable(engine, () => engine.insertBlankPage(1, 200, 100));
    expect(engine.context.doc.countPages()).toBe(5);
    expect((await engine.listObjects(3)).length).toBe(1);
    const image = pngBytes(60, 30, () => [0, 128, 0]);
    const r = await undoable(engine, () => engine.insertImagesAsPages([image, image], 99));
    expect(r.changedPages).toEqual([5, 6]);
    expect(r.doc.pages[6]).toMatchObject({ width: 842, height: 421 });
    expect((await shot(engine, 6)).at(400, 200)).toEqual([0, 128, 0]);
    expect(await engine.listImages(6)).toHaveLength(1);
  });

  it("creates a document from images", async () => {
    const engine = new Engine();
    const result = await engine.createFromImages([pngBytes(30, 60, () => [10, 20, 30])], "photo.pdf");
    expect(result.status === "ok" && result.doc.pageCount).toBe(1);
    expect(result.status === "ok" && result.doc.pages[0]).toMatchObject({ width: 421, height: 842 });
    await undoable(engine, () => engine.addObject(rect(0)));
  });

  it("inserts another PDF keeping links and form fields", async () => {
    const engine = await open(formPdf());
    await engine.setFormField(0, (await engine.listFormFields())[0]!.id, "Mine");
    await undoable(engine, () => engine.insertPdf(formPdf(), 1));
    expect(engine.context.doc.countPages()).toBe(4);
    const fields = await engine.listFormFields();
    expect(fields).toHaveLength(20);
    const incoming = fields.find((f) => f.page === 1 && f.name === "name_2")!;
    expect(incoming).toBeDefined();
    await engine.setFormField(1, incoming.id, "Theirs");
    await engine.setFormField(1, fields.find((f) => f.page === 1 && f.type === "radio")!.id, true);
    const after = await engine.listFormFields();
    expect(after.find((f) => f.name === "name")!.value).toBe("Mine");
    expect(after.find((f) => f.name === "name_2")!.value).toBe("Theirs");
    expect(after.filter((f) => f.name === "size_2").map((f) => f.checked)).toEqual([true, false]);

    await undoable(engine, () => engine.insertPdf(linked(), 0));
    expect(linksOf(engine.context.doc, 0)).toEqual(["page 3", "https://example.com/"]);
    expect(engine.context.doc.countPages()).toBe(7);
    const saved = load(await engine.exportPdf());
    expect(saved.countPages()).toBe(7);
    expect(linksOf(saved, 0)).toEqual(["page 3", "https://example.com/"]);
  });

  it("asks for the password of a protected PDF", async () => {
    const protectedBytes = (() => {
      const d = new mupdf.PDFDocument(makePdf([{ content: label("Secret page") }]));
      return d.saveToBuffer("encrypt=aes-256,user-password=test1234,owner-password=other").asUint8Array().slice();
    })();
    const engine = await open(four());
    await expect(engine.insertPdf(protectedBytes, 0)).rejects.toThrow(/password protected/);
    await expect(engine.insertPdf(protectedBytes, 0, "nope")).rejects.toThrow(/Wrong password/);
    await expect(engine.insertPdf(new Uint8Array([1, 2, 3]), 0)).rejects.toThrow();
    expect(engine.context.doc.countPages()).toBe(4);
    await undoable(engine, () => engine.insertPdf(protectedBytes, 4, "test1234"));
    expect(pageText(engine, 4)).toBe("Secret page");
    expect(load(await engine.exportPdf()).needsPassword()).toBe(false);
  });

  it("extracts and splits without changing the open document", async () => {
    const engine = await open(four());
    await engine.addObject(rect(2));
    const some = load(await engine.extractPages([2, 0]));
    expect([pageText(some, 0), pageText(some, 1)]).toEqual(["Page 3", "Page 1"]);
    const bytes = await engine.extractPages([1]);
    expect(everything(bytes)).not.toContain("Page 3");
    const parts = await engine.splitDocument([[0, 1], [2], [3]]);
    expect(parts.map((p) => load(p).countPages())).toEqual([2, 1, 1]);
    expect(engine.context.doc.countPages()).toBe(4);
    expect((await engine.undo()).doc.pageCount).toBe(4);
  });

  it("keeps the whole undo history intact after exporting and extracting", async () => {
    const engine = await open(four());
    const history = [pageTexts(engine)];
    const step = async (call: Promise<unknown>) => {
      await call;
      history.push(pageTexts(engine));
    };
    await step(engine.duplicatePage(0));
    await step(engine.insertBlankPage(1, 100, 100));
    await engine.exportPdf({ compress: true, flatten: true, password: "x" });
    await step(engine.reorderPages([4, 3, 2, 1, 0, 5].slice(0, engine.context.doc.countPages())));
    await engine.extractPages([0]);
    await engine.splitDocument([[1], [2]]);
    await step(engine.deletePages([2]));
    await engine.exportPdf();
    for (let i = history.length - 2; i >= 0; i--) {
      await engine.undo();
      expect(pageTexts(engine), `undo to step ${i}`).toEqual(history[i]);
    }
    await engine.exportPdf();
    for (let i = 1; i < history.length; i++) {
      await engine.redo();
      expect(pageTexts(engine), `redo to step ${i}`).toEqual(history[i]);
    }
  });

  it("copies documents with very long bookmark lists", async () => {
    const engine = await open(
      makePdf([{}], (doc) => {
        const items = doc.outlineIterator();
        for (let i = 0; i < 6000; i++) items.insert({ title: `Entry ${i}`, uri: "#page=1", open: false });
      }),
    );
    const saved = load(await engine.exportPdf());
    expect(saved.loadOutline()).toHaveLength(6000);
    expect(pageText(saved)).toBe("Page 1");
  });

  it("works on an encrypted original", async () => {
    const d = new mupdf.PDFDocument(four());
    const bytes = d.saveToBuffer("encrypt=aes-256,user-password=pw,owner-password=pw").asUint8Array().slice();
    const engine = new Engine();
    await open(bytes, engine, "pw");
    await undoable(engine, () => engine.reorderPages([3, 2, 1, 0]));
    await undoable(engine, () => engine.duplicatePage(0));
    expect(load(await engine.extractPages([0])).needsPassword()).toBe(false);
    const plain = load(await engine.exportPdf());
    expect(plain.needsPassword()).toBe(false);
    expect(pageText(plain, 0)).toBe("Page 4");
  });

  it("keeps history aligned after failed and do-nothing operations", async () => {
    const engine = await open(four());
    await engine.addObject(rect(0));
    const after = (await engine.renderPage(0, 1)).data.slice();
    // fail before changing anything, and after changing something
    await expect(engine.insertPdf(new Uint8Array([1]), 0)).rejects.toThrow();
    await expect(engine.deletePages([0, 1, 2, 3])).rejects.toThrow();
    await expect(engine.addObject({ kind: "image", page: 0, rect: [0, 0, 9, 9], data: new Uint8Array([1]) })).rejects.toThrow();
    await expect(engine.rotatePages([0, 99], 90)).rejects.toThrow();
    expect(engine.context.doc.countPages()).toBe(4);
    expect((await engine.renderPage(0, 1)).data).toEqual(after);
    await undoable(engine, () => engine.reorderPages([0, 1, 2, 3]));
    await engine.undo();
    await engine.undo();
    expect((await shot(engine, 0)).at(30, 20)).toEqual([255, 255, 255]);
    expect(await engine.listObjects(0)).toEqual([]);
  });

  it("handles a long document quickly", async () => {
    const engine = await open(makePdf(Array.from({ length: 400 }, () => ({}))));
    const t = performance.now();
    await engine.deletePages([5, 6, 7]);
    await engine.reorderPages([...Array(397).keys()].reverse());
    await engine.duplicatePage(10);
    await engine.exportPdf({ compress: true });
    expect(performance.now() - t).toBeLessThan(15_000);
    expect(pageText(engine, 0)).toBe("Page 400");
  });
});
