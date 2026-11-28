/**
 * Small lettering in app screenshots, two scripts on one line, and the safety net for readings that
 * cannot be trusted. Real recognition on pictures drawn by Chromium (see replicas.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { believable, detectText, withoutSigns } from "../../src/image/detect";
import { textRegions } from "../../src/image/segment";
import { ImageSession } from "../../src/image/session";
import type { Picture, TextBox } from "../../src/image/types";
import { changedWords, doubtful } from "../../src/image/words";
import { configureOcr, recognizePage, terminateOcr } from "../../src/ocr";
import { createNodeAssets } from "../fonts/nodeAssets";
import { closeBrowser, TESSDATA } from "../ocr/helpers";
import { apply, bounds } from "./helpers";
import { MIXED, render, SCREENS } from "./replicas";
import { score } from "./score";

beforeAll(() => configureOcr({ cachePath: TESSDATA }));
afterAll(async () => {
  await terminateOcr();
  await closeBrowser();
});

const read = async (picture: Picture, languages: string[] = []) => (await detectText(picture, recognizePage, { languages })).boxes;
const plain = (t: string) => t.normalize("NFC").replace(/[‌‍]/g, "").replace(/\s+/g, " ").trim();

describe("lettering on plain ground", () => {
  it("parts two groups of marks and ignores a rule under them", () => {
    const width = 300;
    const data = new Uint8ClampedArray(width * 80 * 4).fill(255);
    const bar = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([20, 20, 20, 255], (y * width + x) * 4);
    };
    for (const from of [30, 120]) for (let i = 0; i < 5; i++) bar(from + i * 8, 30, from + i * 8 + 4, 44);
    bar(30, 52, 66, 54);
    const regions = textRegions({ width, height: 80, data });
    expect(regions.map((r) => r.box)).toEqual([
      [30, 30, 66, 44],
      [120, 30, 156, 44],
    ]);
  });

  it("drops signs read from icons, and shapes that are not text", () => {
    expect(withoutSigns("® Dashboard")).toBe("Dashboard");
    expect(withoutSigns("«> Popular |")).toBe("Popular");
    expect(withoutSigns("Hours: 10 - 18 (1)")).toBe("Hours: 10 - 18 (1)");
    const square = { box: [0, 0, 20, 20] as [number, number, number, number], marks: 1 };
    expect(believable({ text: "@", confidence: 95 }, square)).toBe(false);
    expect(believable({ text: "O", confidence: 95 }, square)).toBe(false);
    expect(believable({ text: "Open", confidence: 91 }, { box: [0, 0, 40, 12], marks: 4 })).toBe(true);
  });
});

describe("a learning dashboard saved as a small soft JPEG", () => {
  it.each([
    { out: 620, quality: 70, least: 12 },
    { out: 520, dpr: 2, quality: 55, least: 10 },
    { out: 700, dpr: 2, quality: 60, least: 12 },
  ])("boxes tabs, badges and small labels at $out pixels", { timeout: 180_000 }, async ({ least, ...variant }) => {
    const { picture, truth } = await render(SCREENS.dashboard, variant);
    const result = score(await read(picture), truth);
    const seen = JSON.stringify(result);
    expect(result.boxed, seen).toBeGreaterThanOrEqual(least);
    for (const label of ["In Progress (1)", "Completed (0)", "Open Course"]) expect(result.missed, seen).not.toContain(label);
    expect(result.junk.length, seen).toBeLessThanOrEqual(1);
  });

  it("finds button and chip labels in either polarity", { timeout: 180_000 }, async () => {
    const { picture, truth } = await render(SCREENS.buttons, { quality: 55 });
    const result = score(await read(picture), truth);
    expect(result.boxed, JSON.stringify(result)).toBeGreaterThanOrEqual(15);
  });

  it("finds nothing in photographs and logos", { timeout: 180_000 }, async () => {
    const { picture } = await render(SCREENS.wordless, { quality: 60 });
    expect((await read(picture)).map((b) => b.text)).toEqual([]);
  });
});

describe("two scripts on one line, language detected", () => {
  const cases = {
    notice: ["खुलने का समय / Hours: 10 to 18", "आज की तारीख / Date: 13/02/2026"],
    poster: ["पुस्तक मेला / Book Fair 2026"],
    sign: ["धीरे चलें GO SLOW", "स्कूल आगे है / School Ahead"],
    bengali: ["খোলার সময় / Hours: 10 to 18"],
    tamil: ["ஞாயிறு விடுமுறை / Closed on Sunday"],
    telugu: ["తెరిచే సమయం / Hours: 10 to 18"],
    gujarati: ["ખુલવાનો સમય / Hours: 10 to 18"],
    malayalam: ["തുറക്കുന്ന സമയം / Hours: 10 to 18"],
  };
  it.each(Object.entries(cases))("%s reads both halves", { timeout: 300_000 }, async (name, lines) => {
    const { picture } = await render(MIXED[name as keyof typeof MIXED], { quality: 75 });
    const texts = (await read(picture)).map((b) => plain(b.text));
    for (const line of lines) expect(texts).toContain(plain(line));
  });
});

describe("a line that was read wrongly", () => {
  let picture: Picture;
  let box: TextBox;
  let session: ImageSession;
  beforeAll(async () => {
    picture = (await render(MIXED.notice, { quality: 85 })).picture;
    // forced to English, the Hindi half comes out as nonsense
    box = (await read(picture, ["eng"])).find((b) => b.text.includes("Hours"))!;
    session = new ImageSession(picture, createNodeAssets());
  }, 180_000);

  /** pixels that differ left of a column */
  const changedLeftOf = (after: Picture, x: number) => {
    let n = 0;
    for (let y = 0; y < picture.height; y++)
      for (let i = y * picture.width * 4; i < (y * picture.width + x) * 4; i++) if (after.data[i] !== picture.data[i]) n++;
    return n;
  };

  it("redraws only the changed word and leaves the rest of the picture's own letters", { timeout: 120_000 }, async () => {
    expect(box.text).not.toContain("खुलने");
    const result = await session.render(box, { text: box.text.replace(/18$/, "19") });
    expect(result.unsafe).toBeFalsy();
    expect(result.patch).not.toBeNull();
    const after = apply(picture, result.patch);
    const [x0, , x1] = bounds(box.quad);
    // everything before the last tenth of the line stays exactly as it was
    expect(changedLeftOf(after, Math.floor(x0 + (x1 - x0) * 0.88))).toBe(0);
  });

  it("draws nothing when the changed words cannot be told apart", { timeout: 120_000 }, async () => {
    const garbled = { ...box, id: "garbled", text: "qzv 18", confidence: 40 };
    const result = await session.render(garbled, { text: "qzv 19" });
    expect(result).toMatchObject({ unsafe: true, patch: null });
    // a change of look would set the whole line from the reading
    expect(await session.render(box, { style: { size: 40 } })).toMatchObject({ unsafe: true, patch: null });
  });

  it("still drags and removes such a line", { timeout: 120_000 }, async () => {
    expect((await session.render(box, { move: [0, 20] })).patch).not.toBeNull();
    expect((await session.render(box, { text: "" })).patch).not.toBeNull();
    const both = await session.render(box, { move: [0, 20], style: { size: 40 } });
    expect(both.unsafe).toBe(true);
    expect(both.patch).not.toBeNull();
  });

  it("trusts a reading the user has confirmed", () => {
    expect(doubtful({ confidence: 40 }, 0.9)).toBe(true);
    expect(doubtful({ confidence: 70 }, 0.35)).toBe(true);
    expect(doubtful({ confidence: 70, weakest: 12 }, 0.6)).toBe(true);
    expect(doubtful({ confidence: 94, weakest: 90 }, 0.6)).toBe(false);
    expect(doubtful({ confidence: 40, checked: true }, 0.3)).toBe(false);
  });

  it("knows which words changed", () => {
    expect(changedWords("a b c d", "a b x d")).toEqual({ from: 2, to: 3, text: "x" });
    expect(changedWords("a b c", "a b c d")).toEqual({ from: 3, to: 3, text: "d" });
    expect(changedWords("a b c", "b c")).toEqual({ from: 0, to: 1, text: "" });
  });
});
