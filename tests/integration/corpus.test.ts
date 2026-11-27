/** Guards the fixtures themselves with MuPDF only, so a broken corpus is never blamed on the editor. */
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, documents, fixtureBytes, mupdfDocument, normalise } from "./helpers";

const REQUIRED_LANGUAGES = [
  "English", "Hindi", "Marathi", "Bengali", "Tamil", "Telugu", "Gujarati", "Punjabi", "Kannada", "Malayalam",
  "Odia", "Urdu", "Arabic", "Hebrew", "Chinese", "Japanese", "Korean", "Thai", "Russian", "Greek",
];

describe("fixture corpus", () => {
  it("covers every required language and kind of file, within the size budget", () => {
    const languages = new Set(documents.map((d) => d.language));
    for (const language of REQUIRED_LANGUAGES) expect(languages, language).toContain(language);
    const tags = new Set(documents.flatMap((d) => d.tags));
    for (const tag of [
      "table", "columns", "justified", "rotated-page", "rotated-text", "xobject", "forms", "images", "encrypted",
      "damaged", "scanned", "legacy", "type3", "cff", "truetype", "standard14", "mixed",
    ])
      expect(tags, tag).toContain(tag);
    const bytes = readdirSync(FIXTURES).reduce((sum, f) => sum + statSync(join(FIXTURES, f)).size, 0);
    expect(bytes).toBeLessThan(15_000_000);
  });

  it.each(documents.map((d) => [d.id, d] as const))("%s opens with the declared pages", (_id, entry) => {
    const pdf = mupdfDocument(fixtureBytes(entry.id), entry.password ?? undefined);
    expect(pdf.countPages()).toBe(entry.pageCount);
    if (entry.repaired) expect(pdf.wasRepaired()).toBe(true);
    for (const page of entry.pages) {
      const loaded = pdf.loadPage(page.index);
      const [x0, y0, x1, y1] = loaded.getBounds();
      expect(x1 - x0).toBeCloseTo(page.width, 0);
      expect(y1 - y0).toBeCloseTo(page.height, 0);
      for (const line of page.lines) {
        expect(line.rect[0], line.text).toBeGreaterThanOrEqual(-2);
        expect(line.rect[2], line.text).toBeLessThanOrEqual(page.width + 2);
        expect(line.rect[3], line.text).toBeLessThanOrEqual(page.height + 2);
      }
      loaded.destroy();
    }
    pdf.destroy();
  });

  // plain Latin files written with ordinary operators must be readable by an independent extractor
  const readable = ["en-standard14", "en-truetype", "en-cff", "en-chromium", "positioning", "type3-latin", "columns-table",
    "rotated-pages", "offset-cropbox", "xobject-shared", "multipage"];
  it.each(readable)("%s contains its expected words according to MuPDF", (id) => {
    const entry = documents.find((d) => d.id === id)!;
    const pdf = mupdfDocument(fixtureBytes(id));
    for (const page of entry.pages) {
      const text = normalise(pdf.loadPage(page.index).toStructuredText("preserve-whitespace").asText()).replace(/ /g, "");
      for (const line of page.lines)
        for (const word of line.text.split(" ")) expect(text, `${id}: ${word}`).toContain(word);
    }
    pdf.destroy();
  });
});
