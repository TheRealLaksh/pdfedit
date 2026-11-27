/** Opening, passwords, damaged and signed files, export options, metadata honesty and very large documents. */
import { describe, expect, it } from "vitest";
import {
  assetBytes, bestLine, diffPixels, doc, documents, findLine, fixtureBytes, largePdf, mupdfDocument, mupdfText,
  newEngine, normalise, openBytes, openDoc, pad, render,
} from "./helpers";

describe("opening", () => {
  it.each(documents.map((d) => [d.id, d] as const))("%s: opens, renders every page and exports", async (_id, entry) => {
    const { engine, info } = await openDoc(entry.id);
    expect(info.fileName).toBe(entry.file);
    expect(info.pageCount).toBe(entry.pageCount);
    expect(info.encrypted).toBe(entry.tags.includes("encrypted") && !!entry.password);
    expect(info.signed).toBe(!!entry.signed);
    expect(info.repaired).toBe(!!entry.repaired);
    expect(info.hasForms).toBe(entry.tags.includes("forms") || entry.tags.includes("signed"));
    for (const page of entry.pages) {
      expect(info.pages[page.index]!.width).toBeCloseTo(page.width, 0);
      expect(info.pages[page.index]!.height).toBeCloseTo(page.height, 0);
      const picture = await engine.renderPage(page.index, 1);
      expect(Math.abs(picture.width - page.width)).toBeLessThanOrEqual(2);
      expect(picture.data.length).toBe(picture.width * picture.height * 4);
      const text = await engine.getPageText(page.index); // must never throw, whatever the page contains
      expect(text.page).toBe(page.index);
    }
    const exported = await engine.exportPdf();
    const reopened = await openBytes(exported, entry.file);
    expect(reopened.info.pageCount).toBe(entry.pageCount);
    for (const page of entry.pages)
      expect(diffPixels(await render(engine, page.index), await render(reopened.engine, page.index)).changed, `page ${page.index} after export`).toBe(0);
    await engine.close();
    await reopened.engine.close();
  });

  it("renders a clipped region that matches the full rendering", async () => {
    const { engine } = await openDoc("en-standard14");
    const full = await engine.renderPage(0, 3);
    const tile = await engine.renderPage(0, 3, [30, 30, 230, 130]);
    expect(tile.width).toBe(600);
    expect(tile.height).toBe(300);
    let different = 0;
    for (let y = 0; y < tile.height; y++)
      for (let x = 0; x < tile.width; x++)
        if (Math.abs(tile.data[(y * tile.width + x) * 4]! - full.data[((y + 90) * full.width + x + 90) * 4]!) > 8) different++;
    expect(different).toBe(0);
  });

  it.each([
    ["empty input", new Uint8Array()],
    ["random bytes", new Uint8Array(4096).map((_, i) => (i * 197 + 13) % 256)],
    ["a text file", new TextEncoder().encode("this is not a pdf at all\n")],
  ])("rejects %s with a readable message", async (_label, bytes) => {
    const engine = newEngine();
    await expect(engine.open(bytes, "junk.pdf")).rejects.toThrow(/PDF|pages|read/i);
  });

  it("turns images into a new document", async () => {
    const engine = newEngine();
    const result = await engine.createFromImages([assetBytes("photo.png"), assetBytes("photo-page.jpg")], "pictures.pdf");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.doc.pageCount).toBe(2);
    expect(result.doc.pages[0]!.width / result.doc.pages[0]!.height).toBeCloseTo(320 / 220, 1);
    expect((await engine.listImages(0)).length).toBe(1);
    expect((await engine.getPageText(1)).kind).toBe("scanned");
    // creating the document is not something to undo
    const undone = await engine.undo();
    expect(undone.doc.pageCount).toBe(2);
    expect(undone.canUndo).toBe(false);
  });
});

describe("passwords", () => {
  it.each(["password-aes256", "password-rc4"])("%s: asks, rejects a wrong one, opens with the right one", async (id) => {
    const engine = newEngine();
    expect(await engine.open(fixtureBytes(id), "locked.pdf")).toEqual({ status: "password", wrong: false });
    expect(await engine.open(fixtureBytes(id), "locked.pdf", "nope")).toEqual({ status: "password", wrong: true });
    const result = await engine.open(fixtureBytes(id), "locked.pdf", "test1234");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.doc.encrypted).toBe(true);
  });

  it("opens an owner-password-only file straight away", async () => {
    const engine = newEngine();
    expect((await engine.open(fixtureBytes("owner-only"), "owner.pdf")).status).toBe("ok");
  });

  it.each(["password-aes256", "password-rc4", "owner-only"])("%s: an edited export has no encryption unless asked", async (id) => {
    const entry = doc(id);
    const { engine } = await openDoc(id);
    const edit = entry.edits[0]!;
    const target = findLine(await engine.getPageText(0), entry.pages[0]!.lines[edit.line]!);
    await engine.editLines(0, [{ lineId: target.id, text: edit.newText! }]);
    const open = await engine.exportPdf();
    expect(mupdfDocument(open).needsPassword()).toBe(false);
    expect(normalise(mupdfText(open, 0))).toContain(normalise(edit.newText!));
  });

  it.each([{ compress: false }, { compress: true }])("protects the export with a password (%o)", async (options) => {
    const { engine } = await openDoc("en-truetype");
    const exported = await engine.exportPdf({ ...options, password: "s3cret pass ü" });
    const locked = newEngine();
    expect((await locked.open(exported.slice(), "x.pdf")).status).toBe("password");
    expect((await locked.open(exported.slice(), "x.pdf", "wrong")).status).toBe("password");
    expect((await locked.open(exported.slice(), "x.pdf", "s3cret pass ü")).status).toBe("ok");
    expect(new TextDecoder("latin1").decode(exported)).toMatch(/\/Encrypt/);
    expect(normalise(mupdfText(exported, 0, "s3cret pass ü"))).toContain("river survey");
    // asking for a password once does not stick to the document
    expect(mupdfDocument(await engine.exportPdf()).needsPassword()).toBe(false);
  });
});

describe("damaged files", () => {
  it.each(["damaged-xref", "damaged-truncated"])("%s: is repaired, editable and exports cleanly", async (id) => {
    const entry = doc(id);
    const { engine, info } = await openDoc(id);
    expect(info.repaired).toBe(true);
    const edit = entry.edits[0]!;
    const target = findLine(await engine.getPageText(0), entry.pages[0]!.lines[edit.line]!);
    await engine.editLines(0, [{ lineId: target.id, text: edit.newText! }]);
    await engine.undo();
    await engine.redo();
    const reopened = await openBytes(await engine.exportPdf(), entry.file);
    expect(reopened.info.repaired).toBe(false);
    expect(bestLine((await reopened.engine.getPageText(0)).lines, edit.newText!).similarity).toBe(1);
  });
});

describe("honest metadata", () => {
  const info = (bytes: Uint8Array) => {
    const pdf = mupdfDocument(bytes);
    const get = (key: string) => pdf.getMetaData(`info:${key}`) ?? "";
    return { producer: get("Producer"), created: get("CreationDate"), modified: get("ModDate"), title: get("Title") };
  };

  it("sets ModDate to now and leaves producer, creation date and title alone", async () => {
    const before = info(fixtureBytes("signed-simulated"));
    expect(before.modified).toContain("20200101");
    const { engine, info: opened } = await openDoc("signed-simulated");
    expect(opened.signed).toBe(true);
    const target = (await engine.getPageText(0)).lines[0]!;
    await engine.editLines(0, [{ lineId: target.id, text: "This document carried a signature field" }]);
    const after = info(await engine.exportPdf());
    expect(after.producer).toBe(before.producer);
    expect(after.created).toBe(before.created);
    expect(after.title).toBe(before.title);
    const year = new Date().getFullYear();
    expect(after.modified, "ModDate").toMatch(new RegExp(`^D:(${year - 1}|${year}|${year + 1})`));
  });

  it("does not remove the signature field to hide that the file was signed", async () => {
    const { engine } = await openDoc("signed-simulated");
    const target = (await engine.getPageText(0)).lines[0]!;
    await engine.editLines(0, [{ lineId: target.id, text: "Changed text" }]);
    const pdf = mupdfDocument(await engine.exportPdf());
    expect(pdf.getTrailer().get("Root", "AcroForm", "Fields").length).toBe(1);
  });
});

describe("export options", () => {
  it("compresses without changing the look", async () => {
    const { engine } = await openDoc("hi-chromium");
    const target = (await engine.getPageText(0)).lines[6]!;
    await engine.editLines(0, [{ lineId: target.id, text: "अगली बैठक शुक्रवार को होगी। Hall 3" }]);
    const plain = await engine.exportPdf();
    const small = await engine.exportPdf({ compress: true });
    expect(small.length).toBeLessThanOrEqual(plain.length * 1.02);
    expect(small.length, "added fonts are subset").toBeLessThan(250_000);
    const a = await openBytes(plain, "a.pdf");
    const b = await openBytes(small, "b.pdf");
    expect(diffPixels(await render(a.engine, 0), await render(b.engine, 0)).changed).toBe(0);
    expect((await b.engine.getPageText(0)).lines.map((l) => l.text)).toEqual((await a.engine.getPageText(0)).lines.map((l) => l.text));
    // the document being edited is not renumbered or broken by exporting
    expect((await engine.getPageText(0)).lines.length).toBe((await a.engine.getPageText(0)).lines.length);
    await engine.undo();
    expect((await engine.getPageText(0)).lines[6]!.text).toBe(target.text);
  });

  it("exports a subset of pages in the order given", async () => {
    const { engine } = await openDoc("multipage");
    const exported = await engine.exportPdf({ pages: [3, 1] });
    const reopened = await openBytes(exported, "subset.pdf");
    expect(reopened.info.pageCount).toBe(2);
    expect(mupdfText(exported, 0)).toContain("delta");
    expect(mupdfText(exported, 1)).toContain("bravo");
    expect((await engine.listFormFields()).length).toBe(0);
  });

  it.each([["png", [0x89, 0x50, 0x4e, 0x47]], ["jpeg", [0xff, 0xd8, 0xff]]] as const)("exports a page as %s at the chosen resolution", async (format, magic) => {
    const { engine } = await openDoc("rotated-pages");
    const bytes = await engine.exportPageImage(1, 144, format);
    expect(Array.from(bytes.slice(0, magic.length))).toEqual(magic);
    const mupdf = await import("mupdf");
    const image = new mupdf.Image(bytes.slice());
    expect(Math.abs(image.getWidth() - 420 * 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(image.getHeight() - 595 * 2)).toBeLessThanOrEqual(2);
  });

  it.each(["en-standard14", "hi-chromium", "ar-chromium", "zh-chromium", "th-chromium"])("%s: exports plain text in reading order", async (id) => {
    const entry = doc(id);
    const { engine } = await openDoc(id);
    const text = normalise(await engine.exportText());
    let from = 0;
    for (const line of entry.pages[0]!.lines) {
      const at = text.indexOf(normalise(line.text), from);
      expect(at, `${line.text} missing or out of order in:\n${text}`).toBeGreaterThanOrEqual(0);
      from = at;
    }
  });

  it("exports text of chosen pages only", async () => {
    const { engine } = await openDoc("multipage");
    const text = await engine.exportText([2]);
    expect(text).toContain("charlie");
    expect(text).not.toContain("alpha");
  });
});

describe("undo history", () => {
  it("walks back and forward through mixed operations", async () => {
    const { engine } = await openDoc("multipage");
    const snapshot = async () => {
      const pages = [];
      const undone = await engine.exportText();
      pages.push(undone);
      return pages.join();
    };
    const states = [await snapshot()];
    const line = (await engine.getPageText(0)).lines[1]!;
    await engine.editLines(0, [{ lineId: line.id, text: "Page marker alpha was changed." }]);
    states.push(await snapshot());
    await engine.deletePages([1]);
    states.push(await snapshot());
    await engine.reorderPages([3, 2, 1, 0]);
    states.push(await snapshot());
    await engine.addObject({ kind: "text", page: 0, rect: [40, 300, 300, 330], text: "A sticky remark", align: "left", style: { family: "Noto Sans", bold: false, italic: false, serif: false, mono: false, size: 14, color: [0, 0, 0] } });
    states.push(await snapshot());
    for (let i = states.length - 2; i >= 0; i--) {
      await engine.undo();
      expect(await snapshot(), `after undo to step ${i}`).toBe(states[i]);
    }
    expect((await engine.undo()).canUndo).toBe(false);
    for (let i = 1; i < states.length; i++) {
      await engine.redo();
      expect(await snapshot(), `after redo to step ${i}`).toBe(states[i]);
    }
    // a new change drops the redo branch
    await engine.undo();
    const result = await engine.rotatePages([0], 90);
    expect(result.canRedo).toBe(false);
  });
});

describe("a 300 page document", () => {
  const bytes = largePdf(300, 40);

  it("opens quickly and analyses any page quickly", async () => {
    let started = performance.now();
    const { engine, info } = await openBytes(bytes, "ledger.pdf");
    expect(performance.now() - started, "open ms").toBeLessThan(3000);
    expect(info.pageCount).toBe(300);
    await engine.getPageText(0);
    started = performance.now();
    const page = await engine.getPageText(217);
    expect(performance.now() - started, "one page of text, ms").toBeLessThan(400);
    expect(page.lines.length).toBe(40);
    expect(page.lines[39]!.text).toBe("Ledger page 218 row 40: stock counted and signed off");
  });

  it("edits the last page, finds across all pages and exports in reasonable time", async () => {
    const { engine } = await openBytes(bytes, "ledger.pdf");
    const before = await render(engine, 299);
    const target = (await engine.getPageText(299)).lines[5]!;
    let started = performance.now();
    await engine.editLines(299, [{ lineId: target.id, text: "Ledger page 300 row 6: stock recounted today" }]);
    expect(performance.now() - started, "edit ms").toBeLessThan(2000);
    expect(diffPixels(before, await render(engine, 299), [pad(target.rect, 5)]).stray).toBe(0);
    started = performance.now();
    const matches = await engine.findText("row 40:");
    expect(matches.length).toBe(300);
    expect(performance.now() - started, "find ms").toBeLessThan(15_000);
    started = performance.now();
    const exported = await engine.exportPdf({ compress: true });
    expect(performance.now() - started, "export ms").toBeLessThan(10_000);
    expect(exported.length).toBeLessThan(bytes.length * 1.5);
    started = performance.now();
    await engine.deletePages(Array.from({ length: 150 }, (_, i) => i * 2));
    await engine.undo();
    expect(performance.now() - started, "delete 150 pages and undo, ms").toBeLessThan(8000);
  });

  it("handles a single page with twenty thousand glyphs", async () => {
    const { engine } = await openBytes(largePdf(1, 400), "dense.pdf");
    const started = performance.now();
    const page = await engine.getPageText(0);
    expect(performance.now() - started, "dense page ms (budget 300, doubled for test machines)").toBeLessThan(600);
    expect(page.lines.length, "four tight columns stay separate").toBe(400);
  });
});
