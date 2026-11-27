/**
 * Text extraction over the whole corpus: accuracy per language, line geometry, style and page kind.
 * Prints a per-language table (also written to .tmp/integration/accuracy.md), with MuPDF as a baseline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PageText } from "../../src/engine/types";
import {
  OUT, documents, extentMatch, fixtureBytes, matchLines, mupdfLines, normalise, openDoc, overlap, quadToRect, render,
  inkPixels, savePng, score, table, type Accuracy, type ManifestDoc,
} from "./helpers";

const textDocs = documents.filter((d) => d.tags.includes("text"));

/** minimum character accuracy; the corpus is clean, so simple scripts must be perfect */
function threshold(entry: ManifestDoc): number {
  // MuPDF's story writer stores a poor Unicode map for several scripts: reported, loosely gated
  if (entry.producer === "mupdf-story") return 0.6;
  if (entry.tags.includes("vertical")) return 0.9;
  if (entry.tags.includes("cff") && entry.producer === "chromium-cff") return 0.95;
  if (/Latin|Cyrillic|Greek|Han|Japanese|Hangul/.test(entry.script)) return 0.995;
  return 0.97;
}

interface Row {
  entry: ManifestDoc;
  engine: Accuracy;
  baseline: Accuracy;
  milliseconds: number;
}
const rows: Row[] = [];

function combine(parts: Accuracy[]): Accuracy {
  const characters = parts.reduce((s, p) => s + p.characters, 0);
  const errors = parts.reduce((s, p) => s + (1 - p.accuracy) * p.characters, 0);
  return {
    lines: parts.reduce((s, p) => s + p.lines, 0),
    exact: parts.reduce((s, p) => s + p.exact, 0),
    characters,
    accuracy: characters ? 1 - errors / characters : 1,
    extra: parts.reduce((s, p) => s + p.extra, 0),
    failures: parts.flatMap((p) => p.failures),
  };
}

const cache = new Map<string, Promise<PageText[]>>();
function extract(entry: ManifestDoc): Promise<PageText[]> {
  let found = cache.get(entry.id);
  if (!found) {
    found = (async () => {
      const { engine } = await openDoc(entry.id);
      const pages: PageText[] = [];
      for (const page of entry.pages) pages.push(await engine.getPageText(page.index));
      await engine.close();
      return pages;
    })();
    cache.set(entry.id, found);
  }
  return found;
}

describe.each(textDocs.map((d) => [d.id, d] as const))("extraction: %s", (_id, entry) => {
  it("reads every line in logical order", async () => {
    const started = performance.now();
    const pages = await extract(entry);
    const milliseconds = performance.now() - started;
    const mine = combine(pages.map((p, i) => score(entry.pages[i]!.lines, p.lines)));
    const baseline = combine(
      entry.pages.map((p) => score(p.lines, mupdfLines(fixtureBytes(entry.id), p.index, entry.password ?? undefined))),
    );
    rows.push({ entry, engine: mine, baseline, milliseconds });
    expect(mine.accuracy, `${entry.id} character accuracy\n${mine.failures.join("\n")}`).toBeGreaterThanOrEqual(
      threshold(entry),
    );
    if (threshold(entry) >= 0.995)
      expect(mine.extra, `${entry.id} produced extra lines\n${mine.failures.join("\n")}`).toBe(0);
  });

  it("classifies pages as text and marks lines editable", async () => {
    const pages = await extract(entry);
    for (const [i, page] of pages.entries()) {
      expect(page.page).toBe(i);
      expect(["text", "mixed"], `${entry.id} page ${i} kind`).toContain(page.kind);
      for (const line of page.lines) {
        expect(line.source).toBe("content");
        expect(line.page).toBe(i);
        // lines this producer stored with an unreadable Unicode map may be refused
        if (entry.producer !== "mupdf-story" || !line.text.includes("�"))
          expect(line.editable, `${entry.id} "${line.text}" is not editable: ${line.note}`).toBe(true);
      }
    }
  });

  it("gives consistent ids, spans, quads and geometry", async () => {
    const pages = await extract(entry);
    const again = await openDoc(entry.id);
    for (const [i, page] of pages.entries()) {
      const expected = entry.pages[i]!;
      const ids = page.lines.map((l) => l.id);
      expect(new Set(ids).size, "line ids are unique").toBe(ids.length);
      expect((await again.engine.getPageText(i)).lines.map((l) => l.id), "ids are stable for a revision").toEqual(ids);
      for (const line of page.lines) {
        expect(line.id.startsWith("ocr:")).toBe(false);
        // spans tile the text exactly
        const spans = [...line.spans].sort((a, b) => a.start - b.start);
        expect(spans.length, line.text).toBeGreaterThan(0);
        expect(spans[0]!.start, line.text).toBe(0);
        expect(spans.at(-1)!.end, line.text).toBe(line.text.length);
        for (let s = 1; s < spans.length; s++) expect(spans[s]!.start, line.text).toBe(spans[s - 1]!.end);
        // rect is the bounding box of the quad and lies on the page
        const fromQuad = quadToRect(line.quad);
        for (let k = 0; k < 4; k++) expect(Math.abs(fromQuad[k]! - line.rect[k]!), `${line.text} quad/rect`).toBeLessThan(1);
        expect(line.rect[0]).toBeGreaterThan(-3);
        expect(line.rect[1]).toBeGreaterThan(-3);
        expect(line.rect[2]).toBeLessThan(expected.width + 3);
        expect(line.rect[3]).toBeLessThan(expected.height + 3);
      }
      const picture = await render(again.engine, i);
      const { matches } = matchLines(expected.lines, page.lines);
      const problems: string[] = [];
      for (const { expected: want, actual, similarity } of matches) {
        if (!actual || similarity < 0.8) continue; // text mistakes are reported by the accuracy test
        const vertical = want.tags?.includes("vertical") || Math.abs(Math.sin(want.angle ?? 0)) > 0.9;
        const tilted = !vertical && Math.abs(want.angle ?? 0) > 0.05;
        const label = JSON.stringify(want.text.slice(0, 30));
        if (overlap(want.rect, actual.rect) < 0.6) problems.push(`${label}: rect ${actual.rect.map(Math.round)} expected near ${want.rect.map(Math.round)}`);
        else if (!tilted && extentMatch(want.rect, actual.rect, vertical) < 0.85)
          problems.push(`${label}: extent ${actual.rect.map(Math.round)} expected ${want.rect.map(Math.round)}`);
        if (inkPixels(picture, actual.rect) < 10) problems.push(`${label}: no ink inside the reported rect`);
        if (Math.abs(actual.style.size - want.size) > want.size * 0.12)
          problems.push(`${label}: size ${actual.style.size.toFixed(2)} expected ${want.size}`);
        if (want.color) {
          const delta = Math.max(...want.color.map((c, k) => Math.abs(c - actual.style.color[k]!)));
          if (delta > 0.08) problems.push(`${label}: colour ${actual.style.color.map((c) => c.toFixed(2))} expected ${want.color}`);
        }
        if (want.angle !== undefined) {
          const turn = Math.atan2(Math.sin(actual.angle - want.angle), Math.cos(actual.angle - want.angle));
          if (Math.abs(turn) > 0.04) problems.push(`${label}: angle ${actual.angle.toFixed(3)} expected ${want.angle}`);
        } else if (!vertical && Math.abs(actual.angle) > 0.04) problems.push(`${label}: angle ${actual.angle.toFixed(3)} expected 0`);
        if (want.dir === "rtl" && actual.dir !== "rtl") problems.push(`${label}: direction ${actual.dir}, expected rtl`);
        // the baseline starts inside (or at the edge of) the line box
        const [ox, oy] = actual.origin;
        if (ox < actual.rect[0] - 3 || ox > actual.rect[2] + 3 || oy < actual.rect[1] - 3 || oy > actual.rect[3] + 3)
          problems.push(`${label}: origin ${actual.origin.map(Math.round)} outside ${actual.rect.map(Math.round)}`);
      }
      if (problems.length) savePng(`geometry-${entry.id}-p${i}`, picture, page.lines.map((l) => l.rect));
      expect(problems, `${entry.id} page ${i}`).toEqual([]);
    }
    await again.engine.close();
  });
});

describe("styles", () => {
  it.each(["en-standard14", "en-truetype"])("%s keeps weight, slant and family", async (id) => {
    const entry = documents.find((d) => d.id === id)!;
    const [page] = await extract(entry);
    const { matches } = matchLines(entry.pages[0]!.lines, page!.lines);
    for (const { expected, actual } of matches) {
      expect(actual, expected.text).not.toBeNull();
      expect(actual!.style.bold, `bold: ${expected.text}`).toBe(expected.bold ?? false);
      expect(actual!.style.italic, `italic: ${expected.text}`).toBe(expected.italic ?? false);
      expect(actual!.style.family, expected.text).not.toMatch(/^[A-Z]{6}\+/);
    }
  });

  it("recognises serif and monospaced faces", async () => {
    const [page] = await extract(documents.find((d) => d.id === "en-standard14")!);
    const style = (start: string) => page!.lines.find((l) => normalise(l.text).startsWith(start))!.style;
    expect(style("ledger_total").mono).toBe(true);
    expect(style("The treasurer").serif).toBe(true);
    expect(style("Members met").serif).toBe(false);
    expect(style("Members met").mono).toBe(false);
  });

  it("guesses right, centre and justified alignment", async () => {
    const [standard] = await extract(documents.find((d) => d.id === "en-standard14")!);
    expect(standard!.lines.find((l) => l.text.startsWith("Members met"))!.align).toBe("left");
    const [justified] = await extract(documents.find((d) => d.id === "en-justified")!);
    expect(justified!.lines.slice(0, 4).map((l) => l.align)).toEqual(["justify", "justify", "justify", "justify"]);
  });
});

describe("pages that need recognition", () => {
  const cases = documents.filter((d) => d.tags.includes("garbled") || d.tags.includes("scanned") || d.tags.includes("empty"));
  it.each(cases.map((d) => [d.id, d] as const))("%s is classified correctly", async (_id, entry) => {
    const pages = await extract(entry);
    const kind = entry.pages[0]!.kind;
    const accepted: Record<string, string[]> = {
      garbled: ["garbled"],
      scanned: ["scanned"],
      empty: ["empty"],
      mixed: ["mixed", "text"],
    };
    expect(accepted[kind], `${entry.id} reported ${pages[0]!.kind}: ${JSON.stringify(pages[0]!.lines.map((l) => l.text))}`).toContain(
      pages[0]!.kind,
    );
    if (kind === "scanned" || kind === "empty") expect(pages[0]!.lines).toEqual([]);
    if (kind === "mixed") expect(score(entry.pages[0]!.lines, pages[0]!.lines).accuracy).toBeGreaterThanOrEqual(0.99);
  });
});

afterAll(() => {
  if (!rows.length) return;
  const percent = (v: number) => (v * 100).toFixed(1) + "%";
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const list = groups.get(row.entry.language) ?? [];
    list.push(row);
    groups.set(row.entry.language, list);
  }
  const byLanguage = [...groups.entries()].map(([language, list]) => {
    const mine = combine(list.map((r) => r.engine));
    const base = combine(list.map((r) => r.baseline));
    return [language, list.length, `${mine.exact}/${mine.lines}`, percent(mine.accuracy), mine.extra, `${base.exact}/${base.lines}`, percent(base.accuracy)];
  });
  byLanguage.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const headers = ["Language", "Files", "Exact lines", "Chars", "Extra", "MuPDF exact", "MuPDF chars"];
  const perFile = rows
    .slice()
    .sort((a, b) => a.engine.accuracy - b.engine.accuracy)
    .map((r) => [r.entry.id, `${r.engine.exact}/${r.engine.lines}`, percent(r.engine.accuracy), r.engine.extra, Math.round(r.milliseconds)]);
  const total = combine(rows.map((r) => r.engine));
  const output =
    `# Extraction accuracy (${total.exact}/${total.lines} lines exact, ${percent(total.accuracy)} of characters)\n\n` +
    table(headers, byLanguage) +
    "\n\n## Per file\n\n" +
    table(["File", "Exact lines", "Chars", "Extra", "ms"], perFile) +
    "\n\n## Mismatches\n\n" +
    rows
      .filter((r) => r.engine.failures.length)
      .map((r) => `### ${r.entry.id}\n${r.engine.failures.map((f) => "- " + f).join("\n")}`)
      .join("\n\n") +
    "\n";
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "accuracy.md"), output);
  console.log("\n" + output.split("\n## Mismatches")[0]);
});
