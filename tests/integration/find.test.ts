/** Find and replace across pages and scripts. */
import { describe, expect, it } from "vitest";
import {
  bestLine, diffPixels, doc, documents, intersection, area, normalise, openBytes, openDoc, pad, quadToRect, render,
} from "./helpers";

describe("find", () => {
  it("finds across all pages, with quads over the words", async () => {
    const { engine } = await openDoc("multipage");
    const matches = await engine.findText("weather");
    expect(matches.map((m) => m.page)).toEqual([0, 1, 2, 3, 4]);
    for (const match of matches) {
      const line = (await engine.getPageText(match.page)).lines.find((l) => l.id === match.lineId)!;
      expect(line.text.slice(match.start, match.end)).toBe("weather");
      expect(match.context).toContain("weather");
      expect(match.quads.length).toBeGreaterThan(0);
      const box = quadToRect(match.quads[0]!);
      expect(intersection(box, line.rect)).toBeGreaterThan(area(box) * 0.8);
      expect(box[2] - box[0]).toBeLessThan((line.rect[2] - line.rect[0]) * 0.5);
    }
  });

  it("honours case, whole word and page filters", async () => {
    const { engine } = await openDoc("multipage");
    expect((await engine.findText("CHAPTER")).length).toBe(6);
    expect((await engine.findText("Chapter", { matchCase: true })).length).toBe(5);
    expect((await engine.findText("chap")).length).toBe(6);
    expect((await engine.findText("chap", { wholeWord: true })).length).toBe(0);
    expect((await engine.findText("weather", { pages: [1, 3] })).map((m) => m.page)).toEqual([1, 3]);
    expect(await engine.findText("")).toEqual([]);
    expect(await engine.findText("zeppelin")).toEqual([]);
  });

  // second word of the second line of every simple language file
  const languages = documents.filter((d) => d.producer === "chromium" && d.pages[0]!.lines.length >= 7 && !d.tags.includes("table") && !["mixed-chromium", "justified-chromium"].includes(d.id));
  it.each(languages.map((d) => [d.id, d] as const))("%s: finds a phrase typed the normal way, in either normal form", async (_id, entry) => {
    const { engine } = await openDoc(entry.id);
    const line = entry.pages[0]!.lines[1]!;
    const words = line.text.split(" ");
    const phrase = words.length > 1 ? words.slice(0, 2).join(" ") : line.text.slice(0, 3);
    for (const query of [phrase.normalize("NFC"), phrase.normalize("NFD")]) {
      const matches = await engine.findText(query);
      expect(matches.length, `${query} in ${line.text}`).toBeGreaterThan(0);
      // one of the matches covers the line the phrase was taken from
      const boxes = matches.flatMap((m) => m.quads.map(quadToRect));
      expect(boxes.some((b) => intersection(b, line.rect) > area(b) * 0.6), `quads ${JSON.stringify(boxes)} line ${line.rect}`).toBe(true);
    }
  });

  it("finds recognised text on scans", async () => {
    const entry = doc("scan-en");
    const { engine } = await openDoc(entry.id);
    expect(await engine.findText("library")).toEqual([]);
    await engine.setOcrResult({ page: 0, languages: ["eng"], lines: entry.pages[0]!.lines.map((l) => ({ text: l.text, rect: l.rect, confidence: 95, words: [] })) });
    const matches = await engine.findText("library");
    expect(matches.length).toBe(2);
    expect(matches[0]!.lineId).toMatch(/^ocr:/);
  });
});

describe("replace", () => {
  it("replaces every match, counts them and undoes in one step", async () => {
    const { engine } = await openDoc("multipage");
    const result = await engine.replaceText("weather", "harvest");
    expect(result.count).toBe(5);
    expect(result.changedPages).toEqual([0, 1, 2, 3, 4]);
    expect((await engine.findText("weather")).length).toBe(0);
    expect((await engine.findText("harvest")).length).toBe(5);
    const reopened = await openBytes(await engine.exportPdf(), "replaced.pdf");
    expect((await reopened.engine.findText("harvest")).length).toBe(5);
    await engine.undo();
    expect((await engine.findText("weather")).length).toBe(5);
  });

  it("replaces two matches in one line and changes only those lines", async () => {
    const { engine } = await openDoc("en-standard14");
    const before = await engine.getPageText(0);
    const picture = await render(engine, 0);
    const hit = before.lines.filter((l) => /the/i.test(l.text));
    const result = await engine.replaceText("the", "our", { matchCase: true, wholeWord: true });
    expect(result.count).toBeGreaterThan(0);
    const size = Math.max(...hit.map((l) => l.style.size));
    expect(diffPixels(picture, await render(engine, 0), hit.map((l) => pad(l.rect, size * 0.6))).stray).toBe(0);
    expect((await engine.findText("the", { matchCase: true, wholeWord: true })).length).toBe(0);
  });

  it("replaces only the chosen matches", async () => {
    const { engine } = await openDoc("multipage");
    const matches = await engine.findText("weather");
    const result = await engine.replaceText("weather", "tide", undefined, [matches[1]!, matches[3]!]);
    expect(result.count).toBe(2);
    expect((await engine.findText("tide")).map((m) => m.page)).toEqual([1, 3]);
    expect((await engine.findText("weather")).map((m) => m.page)).toEqual([0, 2, 4]);
  });

  it.each([
    ["hi-chromium", "सोमवार", "बुधवार"],
    ["ar-chromium", "الاثنين", "الأربعاء"],
    ["zh-chromium", "图书馆", "博物馆"],
    ["ta-chromium", "நூலகம்", "ஊரகம்"],
    ["ru-chromium", "собрание", "заседание"],
  ])("%s: replaces %s", async (id, from, to) => {
    const { engine } = await openDoc(id);
    const lines = doc(id).pages[0]!.lines.filter((l) => l.text.includes(from));
    expect(lines.length, "fixture has the word").toBeGreaterThan(0);
    const result = await engine.replaceText(from, to);
    expect(result.count, `matches of ${from}`).toBeGreaterThanOrEqual(lines.length);
    const reopened = await openBytes(await engine.exportPdf(), "replaced.pdf");
    const page = await reopened.engine.getPageText(0);
    for (const line of lines) {
      const wanted = line.text.split(from).join(to);
      const found = bestLine(page.lines, wanted, pad(line.rect, 6));
      expect(found.similarity, `${wanted} read as ${normalise(found.line?.text ?? "")}`).toBeGreaterThan(0.99);
    }
  });

  it("reports nothing changed when there is no match", async () => {
    const { engine } = await openDoc("multipage");
    const result = await engine.replaceText("zeppelin", "airship");
    expect(result.count ?? 0).toBe(0);
    expect(result.changedPages).toEqual([]);
  });
});
