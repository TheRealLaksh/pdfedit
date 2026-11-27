/**
 * Edit round trip over the corpus: edit one line, export, re-open and check that the new text is there, the old
 * text is gone, every other line is untouched, only pixels around the line changed, and undo / redo work.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/engine";
import type { PageText, Rect, RenderedPage, TextLine } from "../../src/engine/types";
import {
  OUT, assetBytes, bestLine, diffPixels, documents, findLine, mupdfDocument, mupdfText, normalise, openBytes, openDoc, overlap, pad,
  render, savePng, table, type ManifestDoc, type ManifestEdit,
} from "./helpers";

const cases = documents
  .filter((d) => d.tags.includes("text"))
  .flatMap((d) => d.edits.map((edit) => [`${d.id} p${edit.page} line ${edit.line}`, d, edit] as const));

const results: (string | number)[][] = [];

async function allText(engine: Engine, count: number): Promise<PageText[]> {
  const pages: PageText[] = [];
  for (let i = 0; i < count; i++) pages.push(await engine.getPageText(i));
  return pages;
}

/** every line other than the edited one is still there, with the same words in the same place */
function neighboursUnchanged(before: TextLine[], after: TextLine[], target: TextLine | null): string[] {
  const problems: string[] = [];
  const remaining = after.slice();
  for (const line of before) {
    if (line.id === target?.id) continue;
    const index = remaining.findIndex(
      (other) =>
        normalise(other.text) === normalise(line.text) && other.rect.every((v, k) => Math.abs(v - line.rect[k]!) < 1.5),
    );
    if (index === -1) {
      const near = bestLine(remaining, line.text, line.rect);
      problems.push(`neighbour ${JSON.stringify(line.text)} changed; closest now ${JSON.stringify(near.line?.text)} ${near.line?.rect.map(Math.round)} was ${line.rect.map(Math.round)}`);
    } else remaining.splice(index, 1);
  }
  const extra = remaining.filter((l) => !target || overlap(l.rect, pad(target.rect, 4)) < 0.3);
  for (const line of extra) problems.push(`unexpected new line ${JSON.stringify(line.text)} at ${line.rect.map(Math.round)}`);
  return problems;
}

function newTextFor(edit: ManifestEdit, current: string): string {
  if (edit.newText !== undefined) return edit.newText;
  const [from, to] = edit.replace!;
  expect(current).toContain(from);
  return current.replace(from, to);
}

/** minimum similarity of the re-read line */
const required = (entry: ManifestDoc) => (entry.producer === "mupdf-story" ? 0.9 : 0.999);

describe.each(cases)("edit: %s", (name, entry, edit) => {
  it("round trips without disturbing anything else", async () => {
    const expected = entry.pages[edit.page]!.lines[edit.line]!;
    const row: (string | number)[] = [name, "FAIL", "-", "-", "-", "-", "-"];
    results.push(row);
    const { engine } = await openDoc(entry.id);
    const before = await allText(engine, entry.pageCount);
    const target = findLine(before[edit.page]!, expected);
    const text = newTextFor(edit, target.text);
    const pictures: RenderedPage[] = [];
    for (let i = 0; i < entry.pageCount; i++) pictures.push(await render(engine, i));

    const result = await engine.editLines(edit.page, [{ lineId: target.id, text }]);
    row[3] = result.fallbackFonts.join(", ") || "original";
    expect(result.changedPages).toContain(edit.page);
    expect(result.canUndo).toBe(true);
    expect(result.doc.pageCount).toBe(entry.pageCount);
    expect(result.doc.pages[edit.page]!.revision, "page revision is bumped").not.toBe(before[edit.page]!.revision);

    // 0. undo restores the page exactly and redo brings the edit back (before anything is exported)
    const editedPicture = await render(engine, edit.page);
    const undone = await engine.undo();
    expect(undone.canRedo).toBe(true);
    expect(diffPixels(pictures[edit.page]!, await render(engine, edit.page), [], 2, 2).changed, "undo restores the pixels").toBe(0);
    expect((await engine.getPageText(edit.page)).lines.map((l) => l.text)).toEqual(before[edit.page]!.lines.map((l) => l.text));
    await engine.redo();
    expect(diffPixels(editedPicture, await render(engine, edit.page), [], 2, 2).changed, "redo restores the edit").toBe(0);

    const exported = await engine.exportPdf();
    expect(new TextDecoder("latin1").decode(exported.subarray(0, 5))).toBe("%PDF-");
    // export keeps the document protected only on request
    const reopened = await openBytes(exported, entry.file);
    expect(reopened.info.pageCount).toBe(entry.pageCount);
    expect(reopened.info.repaired, "the exported file must not need repair").toBe(false);
    const after = await allText(reopened.engine, entry.pageCount);
    const live = await engine.getPageText(edit.page);

    // 1. the new text is where the old line was, both in the live document and in the exported file
    for (const [label, page] of [["live", live], ["export", after[edit.page]!]] as const) {
      const found = bestLine(page.lines, text, pad(target.rect, 6));
      if (label === "export") row[2] = (found.similarity * 100).toFixed(0) + "%";
      expect(found.similarity, `${label}: wanted ${JSON.stringify(text)}, got ${JSON.stringify(found.line?.text)}`).toBeGreaterThanOrEqual(
        required(entry),
      );
    }
    const edited = bestLine(after[edit.page]!.lines, text, pad(target.rect, 6)).line!;

    // 2. look at the pixels before checking text, so a debug picture exists for any later failure
    const picture = await render(reopened.engine, edit.page);
    const size = target.style.size;
    const margin = Math.max(2.5, size * 0.45);
    const allowed: Rect[] = [pad(target.rect, margin), pad(edited.rect, margin), pad(expected.rect, margin)];
    const difference = diffPixels(pictures[edit.page]!, picture, allowed);
    row[4] = difference.stray;
    if (difference.stray > 0 || difference.changed < 15) {
      savePng(`edit-${entry.id}-p${edit.page}-l${edit.line}-before`, pictures[edit.page]!, allowed);
      savePng(`edit-${entry.id}-p${edit.page}-l${edit.line}-after`, picture, allowed);
    }
    expect(difference.changed, "the edit is visible").toBeGreaterThanOrEqual(15);
    expect(difference.stray, `pixels changed outside the edited line (all changes within ${difference.bounds?.map(Math.round)}, line ${target.rect.map(Math.round)})`).toBeLessThanOrEqual(4);

    // 3. look and position are kept
    expect(Math.abs(edited.style.size - size), "font size").toBeLessThanOrEqual(size * 0.04);
    target.style.color.forEach((c, k) => expect(Math.abs(edited.style.color[k]! - c), "colour").toBeLessThan(0.03));
    expect(edited.style.bold, "bold").toBe(target.style.bold);
    expect(edited.style.italic, "italic").toBe(target.style.italic);
    expect(Math.abs(edited.angle - target.angle), "angle").toBeLessThan(0.02);
    const baselineShift =
      -(edited.origin[0] - target.origin[0]) * Math.sin(target.angle) + (edited.origin[1] - target.origin[1]) * Math.cos(target.angle);
    expect(Math.abs(baselineShift), "baseline moved").toBeLessThan(Math.max(0.6, size * 0.05));
    if (target.align === "left" && target.dir === "ltr")
      expect(Math.hypot(edited.origin[0] - target.origin[0], edited.origin[1] - target.origin[1]), "line start moved").toBeLessThan(1);
    if (target.dir === "rtl") expect(Math.abs(edited.rect[2] - target.rect[2]), "right edge of right-to-left line").toBeLessThan(size * 0.3);

    // 4. old text gone, everything else untouched
    const stale = after[edit.page]!.lines.filter((l) => normalise(l.text) === normalise(target.text));
    expect(stale, "old line is still extractable").toEqual([]);
    const independent = normalise(mupdfText(exported, edit.page)).replace(/ /g, "");
    if (/Latin|Cyrillic|Greek/.test(entry.script)) {
      const wanted = normalise(text).replace(/ /g, "");
      const old = normalise(target.text).replace(/ /g, "");
      row[5] = independent.includes(wanted) ? "ok" : "SCRAMBLED";
      // soft: other readers matter, but the remaining checks should still run
      expect.soft(independent, "copy and search in other PDF readers: MuPDF reads the new text in order").toContain(wanted);
      if (!wanted.includes(old)) expect.soft(independent, "MuPDF no longer reads the old text").not.toContain(old);
    }
    expect(neighboursUnchanged(before[edit.page]!.lines, after[edit.page]!.lines, target)).toEqual([]);
    for (let i = 0; i < entry.pageCount; i++) {
      if (i === edit.page) continue;
      expect(neighboursUnchanged(before[i]!.lines, after[i]!.lines, null), `page ${i} text`).toEqual([]);
      const other = diffPixels(pictures[i]!, await render(reopened.engine, i));
      expect(other.changed, `page ${i} pixels changed although only page ${edit.page} was edited`).toBe(0);
    }

    // 6. undo still works after the file has been downloaded
    await engine.undo();
    const leftover = diffPixels(pictures[edit.page]!, await render(engine, edit.page), [], 2, 2).changed;
    row[6] = leftover ? "BROKEN" : "ok";
    expect.soft(leftover, "undo after a download restores the page").toBe(0);

    row[1] = "ok";
    await Promise.all([engine.close(), reopened.engine.close()]);
  });
});

describe("repeated and special edits", () => {
  const first = async (id: string, line: number) => {
    const opened = await openDoc(id);
    const entry = documents.find((d) => d.id === id)!;
    const page = await opened.engine.getPageText(0);
    return { ...opened, entry, page, target: findLine(page, entry.pages[0]!.lines[line]!) };
  };

  it.each(["en-truetype", "en-chromium", "hi-chromium", "ar-chromium", "zh-chromium", "type3-latin"])(
    "%s: the same line can be edited three times and still reads correctly",
    async (id) => {
      let { engine, page, target, entry } = await first(id, id === "type3-latin" ? 2 : id === "en-truetype" ? 7 : 6);
      const base = target.text;
      const original = await render(engine, 0);
      const words = base.split(" ");
      const joiner = /Han/.test(entry.script) ? "" : " ";
      const variants = [base + joiner + words[0], [...words].reverse().join(" "), base];
      for (const text of variants) {
        await engine.editLines(0, [{ lineId: target.id, text }]);
        page = await engine.getPageText(0);
        const found = bestLine(page.lines, text, pad(target.rect, 8));
        expect(found.similarity, `after ${JSON.stringify(text)} read ${JSON.stringify(found.line?.text)}`).toBeGreaterThanOrEqual(0.99);
        target = found.line!;
        expect(page.lines.length, "no leftover fragments").toBe(entry.pages[0]!.lines.length);
      }
      // back to the original words: it should look like the original again
      const difference = diffPixels(original, await render(engine, 0), [], 2, 96);
      const budget = (target.rect[2] - target.rect[0]) * (target.rect[3] - target.rect[1]) * 4 * 0.08;
      expect(difference.changed, "restoring the text restores the look").toBeLessThan(budget);
      for (let i = 0; i < 3; i++) await engine.undo();
      expect(diffPixels(original, await render(engine, 0), [], 2, 2).changed).toBe(0);
    },
  );

  it("deletes a line when the text is empty", async () => {
    const { engine, page, target } = await first("en-standard14", 2);
    const before = await render(engine, 0);
    await engine.editLines(0, [{ lineId: target.id, text: "" }]);
    const after = await engine.getPageText(0);
    expect(after.lines.map((l) => l.text)).not.toContain(target.text);
    expect(after.lines.length).toBe(page.lines.length - 1);
    expect(neighboursUnchanged(page.lines, after.lines, target)).toEqual([]);
    expect(diffPixels(before, await render(engine, 0), [pad(target.rect, 4)]).stray).toBe(0);
    expect(normalise(mupdfText(await engine.exportPdf(), 0))).not.toContain("treasurer");
  });

  it("edits several lines in one call", async () => {
    const { engine, page } = await first("en-truetype", 0);
    const edits = [page.lines[1]!, page.lines[3]!, page.lines[7]!].map((l, i) => ({ lineId: l.id, text: `Batch edit number ${i + 1}` }));
    await engine.editLines(0, edits);
    const texts = (await engine.getPageText(0)).lines.map((l) => normalise(l.text));
    for (const e of edits) expect(texts).toContain(e.text);
    await engine.undo();
    expect((await engine.getPageText(0)).lines.map((l) => l.text)).toEqual(page.lines.map((l) => l.text));
  });

  it("applies colour, size, bold and underline overrides", async () => {
    const { engine, target } = await first("en-standard14", 1);
    await engine.editLines(0, [
      { lineId: target.id, text: target.text, style: { color: [0.8, 0.1, 0.1], size: 16, bold: true, underline: true } },
    ]);
    const reopened = await openBytes(await engine.exportPdf(), "styled.pdf");
    const styled = bestLine((await reopened.engine.getPageText(0)).lines, target.text);
    expect(styled.similarity).toBe(1);
    expect(styled.line!.style.size).toBeCloseTo(16, 0);
    expect(styled.line!.style.bold).toBe(true);
    expect(styled.line!.style.color[0]).toBeCloseTo(0.8, 1);
    expect(styled.line!.style.color[2]).toBeLessThan(0.2);
  });

  it("keeps the right edge of a right aligned line and the centre of a centred one", async () => {
    const { engine, page, entry } = await first("en-standard14", 0);
    const right = findLine(page, entry.pages[0]!.lines[11]!);
    const centre = findLine(page, entry.pages[0]!.lines[12]!);
    await engine.editLines(0, [
      { lineId: right.id, text: "Right aligned total: 12,345,678", align: "right" },
      { lineId: centre.id, text: "A much longer centred closing remark here", align: "center" },
    ]);
    const after = (await engine.getPageText(0)).lines;
    const newRight = bestLine(after, "Right aligned total: 12,345,678").line!;
    const newCentre = bestLine(after, "A much longer centred closing remark here").line!;
    expect(newRight.rect[2]).toBeCloseTo(right.rect[2], 0);
    expect((newCentre.rect[0] + newCentre.rect[2]) / 2).toBeCloseTo((centre.rect[0] + centre.rect[2]) / 2, 0);
  });

  it("keeps a justified line as wide as before", async () => {
    const { engine, target } = await first("en-justified", 2);
    await engine.editLines(0, [{ lineId: target.id, text: "railway first arrived in the valley. Children still count", align: "justify" }]);
    const found = bestLine((await engine.getPageText(0)).lines, "railway first arrived in the valley. Children still count");
    expect(found.similarity).toBeGreaterThan(0.99);
    expect(Math.abs(found.line!.rect[2] - target.rect[2])).toBeLessThan(1.5);
    expect(Math.abs(found.line!.rect[0] - target.rect[0])).toBeLessThan(1);
  });

  it("moves a line by an offset", async () => {
    const { engine, target } = await first("en-truetype", 7);
    await engine.editLines(0, [{ lineId: target.id, text: target.text, offset: [40, 60] }]);
    const found = bestLine((await engine.getPageText(0)).lines, target.text);
    expect(found.similarity).toBe(1);
    expect(found.line!.rect[0] - target.rect[0]).toBeCloseTo(40, 0);
    expect(found.line!.rect[1] - target.rect[1]).toBeCloseTo(60, 0);
  });

  it("moves a line correctly on a turned page", async () => {
    const entry = documents.find((d) => d.id === "rotated-pages")!;
    const { engine } = await openDoc(entry.id);
    for (const page of [1, 2, 3]) {
      const target = findLine(await engine.getPageText(page), entry.pages[page]!.lines[2]!);
      await engine.editLines(page, [{ lineId: target.id, text: target.text, offset: [25, 35] }]);
      const found = bestLine((await engine.getPageText(page)).lines, target.text);
      expect(found.line!.rect[0] - target.rect[0], `page ${page} x`).toBeCloseTo(25, 0);
      expect(found.line!.rect[1] - target.rect[1], `page ${page} y`).toBeCloseTo(35, 0);
    }
  });

  it("shrinks long text to the original width when asked", async () => {
    const { engine, target } = await first("en-truetype", 7);
    const long = "The next visit has been moved to Friday afternoon instead.";
    await engine.editLines(0, [{ lineId: target.id, text: long, fit: "shrink" }]);
    const found = bestLine((await engine.getPageText(0)).lines, long);
    expect(found.similarity).toBeGreaterThan(0.99);
    expect(found.line!.rect[2]).toBeLessThanOrEqual(target.rect[2] + 1.5);
  });

  it.each([
    ["en-truetype", 7, "Budget: ¥900 ≈ €5 → paid ✓"],
    ["en-standard14", 10, "Next meeting: पुस्तकालय में सोमवार"],
    ["en-chromium", 6, "Next meeting: الاثنين القادم"],
    ["en-cff", 4, "下一课在星期五 (next lesson)"],
    ["hi-chromium", 6, "अगली बैठक Library Hall 2 में होगी।"],
    ["he-chromium", 6, "הפגישה הבאה: Room B12, 10:30"],
  ] as const)("%s: accepts text from another script (%#)", async (id, line, text) => {
    const { engine, target, page } = await first(id, line);
    const before = await render(engine, 0);
    const result = await engine.editLines(0, [{ lineId: target.id, text }]);
    const exported = await engine.exportPdf();
    const reopened = await openBytes(exported, "other-script.pdf");
    const after = await reopened.engine.getPageText(0);
    const found = bestLine(after.lines, text, pad(target.rect, 8));
    expect(found.similarity, `read ${JSON.stringify(found.line?.text)}; substituted ${result.fallbackFonts}`).toBeGreaterThanOrEqual(0.97);
    expect(after.lines.length).toBe(page.lines.length);
    const picture = await render(reopened.engine, 0);
    const margin = target.style.size * 0.6;
    const difference = diffPixels(before, picture, [pad(target.rect, margin), pad(found.line!.rect, margin)]);
    if (difference.stray > 8) savePng(`cross-script-${id}`, picture, [pad(target.rect, margin), pad(found.line!.rect, margin)]);
    expect(difference.stray).toBeLessThanOrEqual(8);
    // no tofu: MuPDF must not fall back to missing glyphs
    expect(mupdfText(exported, 0)).not.toContain("�");
  });

  it("removes stale ActualText so the old words cannot be recovered", async () => {
    const { engine, entry, page } = await first("positioning", 0);
    const expected = entry.pages[0]!.lines.find((l) => l.tags?.includes("actualtext"))!;
    const target = findLine(page, expected);
    await engine.editLines(0, [{ lineId: target.id, text: "Fresh words only" }]);
    const pdf = mupdfDocument(await engine.exportPdf());
    let raw = "";
    for (let i = 1; i < pdf.countObjects(); i++) {
      const object = pdf.newIndirect(i);
      try {
        if (object.isStream()) raw += object.readStream().asString() + "\n";
        raw += object.resolve().toString(true, true) + "\n";
      } catch {
        /* free object */
      }
    }
    expect(raw).not.toContain("Marked content carries actual text");
  });

  it("uses an uploaded font when the user picks it", async () => {
    const { engine, target } = await first("en-truetype", 7);
    const font = await engine.addUserFont("FixtureSerif.ttf", assetBytes("FixtureSerif.ttf"));
    expect(font.source).toBe("user");
    expect((await engine.listFonts()).map((f) => f.id)).toContain(font.id);
    await engine.editLines(0, [{ lineId: target.id, text: "Written with an uploaded font", style: { fontChoice: font.id } }]);
    const exported = await engine.exportPdf();
    const found = bestLine((await (await openBytes(exported, "user-font.pdf")).engine.getPageText(0)).lines, "Written with an uploaded font");
    expect(found.similarity).toBe(1);
    expect(found.line!.style.family.replace(/[\s-]/g, "")).toMatch(/FixtureSerif/i);
  });

  it("leaves the document untouched when an edit fails", async () => {
    const { engine, page } = await first("en-truetype", 0);
    const before = await render(engine, 0);
    await expect(engine.editLines(0, [{ lineId: "no-such-line", text: "x" }])).rejects.toThrow();
    expect(diffPixels(before, await render(engine, 0), [], 2, 0).changed).toBe(0);
    expect((await engine.getPageText(0)).lines.map((l) => l.text)).toEqual(page.lines.map((l) => l.text));
    expect((await engine.undo()).canRedo).toBe(false);
  });
});

afterAll(() => {
  if (!results.length) return;
  const output = table(["Edit", "Core", "Re-read", "Font", "Stray px", "MuPDF", "Undo after download"], results);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "edits.md"), `# Edit round trips (core checks ${results.filter((r) => r[1] === "ok").length}/${results.length} pass)\n\n${output}\n`);
  console.log("\n" + output);
});
