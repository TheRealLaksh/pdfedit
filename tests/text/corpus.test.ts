/** Regression run over the generated corpus (tests/fixtures), when it is present. */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Rect } from "../../src/engine/types";
import { diffOutside, open, render, union } from "./helpers";

vi.mock("../../src/engine/fonts", async () => await import("./mockFonts"));

const dir = "tests/fixtures/pdfs/";
interface Doc {
  id: string;
  file: string;
  password: string | null;
  pages: { kind?: string; lines?: { text: string }[] }[];
}
const documents: Doc[] = fs.existsSync(dir + "manifest.json") ? JSON.parse(fs.readFileSync(dir + "manifest.json", "utf8")).documents : [];
const norm = (s: string) => s.normalize("NFC").replace(/[\u00AD\u200B-\u200F]/g, "").replace(/\s+/g, " ").trim();

/** text that cannot be read from the file at all */
const unreadable = /^(scan-(?!searchable)|broken-|story-)/;

describe.skipIf(!documents.length)("fixture corpus", () => {
  for (const d of documents) {
    if (unreadable.test(d.id) || !fs.existsSync(dir + d.file)) continue;
    it(d.id, async () => {
      const bytes = new Uint8Array(fs.readFileSync(dir + d.file));
      const { Engine } = await import("../../src/engine/engine");
      const probe = new Engine();
      const opened = await probe.open(bytes, d.file, d.password ?? undefined);
      expect(opened.status).toBe("ok");
      const e = probe as Awaited<ReturnType<typeof open>>;
      for (let p = 0; p < Math.min(d.pages.length, 4); p++) {
        const found = (await e.getPageText(p)).lines.map((l) => norm(l.text));
        for (const l of d.pages[p]!.lines ?? []) expect(found).toContain(norm(l.text));
      }
      // rewrite up to four lines: reorder their words, which keeps every character available
      const pool = (await e.getPageText(0)).lines.filter((l) => l.editable && l.text.trim().length > 5);
      for (let k = 0; k < Math.min(4, pool.length); k++) {
        const current = (await e.getPageText(0)).lines;
        const target = current.find((l) => l.text === pool[Math.floor((k * pool.length) / 4)]!.text);
        if (!target) continue;
        const words = target.text.split(" ");
        const next = words.length > 2 ? [words[1], words[0], ...words.slice(2, -1)].join(" ") : target.text.slice(0, Math.ceil(target.text.length * 0.7)).trim();
        if (next === target.text) continue;
        const before = await render(e);
        await e.editLines(0, [{ lineId: target.id, text: next }]);
        const after = await render(e);
        const lines = (await e.getPageText(0)).lines;
        const got = lines.find((l) => norm(l.text) === norm(next));
        expect(got, `${next} <- ${lines.map((l) => l.text).join(" | ")}`).toBeDefined();
        const box: Rect = union(target.rect, got!.rect);
        expect(diffOutside(before, after, [box], 2.5), `pixels outside ${next}`).toBeLessThan(5);
        for (const l of current)
          if (l.id !== target.id)
            expect(
              lines.some((x) => x.text === l.text && Math.hypot(x.origin[0] - l.origin[0], x.origin[1] - l.origin[1]) < 0.1),
              `neighbour ${l.text}`,
            ).toBe(true);
      }
    });
  }
});
