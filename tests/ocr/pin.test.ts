import { describe, expect, it } from "vitest";
import { doubtfulLines } from "../../src/ocr";
import type { RawBlock } from "../../src/ocr/convert";
import { LANGUAGE_DATA_VERSION, pinnedWorkerSource } from "../../src/ocr/tess";

describe("pages in two scripts", () => {
  const line = (confidence: number, y: number) => {
    const bbox = { x0: 0, y0: y, x1: 100, y1: y + 20 };
    return { bbox, words: [{ text: "abcdef", confidence, bbox }] };
  };
  const page = (...confidences: number[]): RawBlock[] => [{ paragraphs: [{ lines: confidences.map((c, i) => line(c, i * 30)) }] }];

  it("picks out badly read lines among well read ones", () => {
    expect(doubtfulLines(page(95, 20, 90, 35)).map((b) => b.y0)).toEqual([30, 90]);
  });

  it("leaves clean pages and wholly unreadable pages to the other checks", () => {
    expect(doubtfulLines(page(95, 90))).toEqual([]);
    expect(doubtfulLines(page(20, 30))).toEqual([]);
  });
});

describe("language data is requested with a pinned version", () => {
  const run = (url: string) => {
    const asked: string[] = [];
    const imported: string[] = [];
    const self = { fetch: (u: string) => asked.push(u) };
    new Function("self", "importScripts", pinnedWorkerSource("https://cdn.example/worker.js"))(self, (s: string) =>
      imported.push(s),
    );
    self.fetch(url);
    expect(imported).toEqual(["https://cdn.example/worker.js"]);
    return asked[0];
  };

  it("pins the language packages", () => {
    const base = "https://cdn.jsdelivr.net/npm/@tesseract.js-data";
    expect(run(`${base}/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz`)).toBe(
      `${base}/chi_sim@${LANGUAGE_DATA_VERSION}/4.0.0_best_int/chi_sim.traineddata.gz`,
    );
    expect(run(`${base}/osd/4.0.0/osd.traineddata.gz`)).toBe(`${base}/osd@${LANGUAGE_DATA_VERSION}/4.0.0/osd.traineddata.gz`);
  });

  it("leaves other requests alone", () => {
    for (const url of [
      "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz",
      "https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core.wasm.js",
    ])
      expect(run(url)).toBe(url);
  });
});
