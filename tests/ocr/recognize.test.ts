/** Real recognition on generated scans (downloads language data into .tmp/ocr/tessdata once). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureOcr, OCR_LANGUAGES, recognizePage, terminateOcr } from "../../src/ocr";
import { estimateSkew, toGray } from "../../src/ocr/preprocess";
import { accuracy, closeBrowser, degrade, SAMPLES, savePng, TESSDATA, toRendered, typeset, type Sample, type ScanLook } from "./helpers";

const SCALE = 300 / 72;

const LOOKS: Record<string, ScanLook> = {
  eng: { paper: [236, 222, 186], noise: 7, skew: 1.6, shade: 0.18 },
  hin: { paper: [240, 238, 228], noise: 6, skew: -1.2, shade: 0.12 },
  ara: { paper: [214, 228, 240], noise: 5, skew: 0.9 },
  chi_sim: { paper: [245, 243, 236], noise: 7, skew: -2.1, shade: 0.15 },
  tam: { paper: [250, 249, 244], noise: 5, skew: 0.6 },
  rus: { paper: [232, 232, 228], noise: 8, skew: 3.5, shade: 0.2, speckle: 0.002 },
};

const MINIMUM: Record<string, number> = { eng: 0.97, hin: 0.85, ara: 0.8, chi_sim: 0.9, tam: 0.85, rus: 0.95 };

const table: Record<string, string | number>[] = [];

beforeAll(() => configureOcr({ cachePath: TESSDATA }));
afterAll(async () => {
  console.table(table);
  await terminateOcr();
  await closeBrowser();
});

describe("language list", () => {
  it("has unique codes with names", () => {
    expect(OCR_LANGUAGES.length).toBeGreaterThan(110);
    expect(new Set(OCR_LANGUAGES.map((l) => l.code)).size).toBe(OCR_LANGUAGES.length);
    for (const l of OCR_LANGUAGES) expect(l.name && l.nativeName && l.script, l.code).toBeTruthy();
  });
});

describe.each(Object.keys(SAMPLES))("recognition: %s", (code) => {
  const sample = SAMPLES[code]!;
  const look = LOOKS[code]!;

  for (const mode of ["chosen", "auto"] as const) {
    it(`reads a degraded scan, language ${mode}`, async () => {
      const scan = degrade(await typeset(sample, code), look);
      if (mode === "chosen") savePng(scan, `scans/${code}.png`);
      const progress: number[] = [];
      const started = Date.now();
      const result = await recognizePage(toRendered(scan), {
        languages: mode === "chosen" ? [code] : [],
        scale: SCALE,
        onProgress: (p) => progress.push(p.progress),
      });
      const text = result.lines.map((l) => l.text).join("\n");
      const score = accuracy(sample.lines.join("\n"), text);
      table.push({
        lang: code,
        mode,
        accuracy: Math.round(score * 1000) / 10,
        lines: result.lines.length,
        used: result.languages.join("+"),
        ms: Date.now() - started,
      });
      if (score < 0.99) console.log(`${code} ${mode}\n${text}`);
      expect(score).toBeGreaterThanOrEqual(MINIMUM[code]!);
      // English is read alongside every other script except those whose models already know Latin
      if (mode === "auto") expect(result.languages).toEqual(["eng", "chi_sim"].includes(code) ? [code] : [code, "eng"]);
      expect(result.lines.length).toBe(sample.lines.length);
      expect(progress.at(-1)).toBe(1);
      expect([...progress].sort((a, b) => a - b)).toEqual(progress);

      // geometry in page points: lines run top to bottom inside the page, baselines follow the skew
      const second = result.lines[1]!;
      const [from, to] = second.baseline!;
      const angle = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
      expect(Math.abs(angle - look.skew!)).toBeLessThan(0.7);
      for (const line of result.lines) {
        expect(line.rect[0]).toBeGreaterThan(10);
        expect(line.rect[2]).toBeLessThan(410);
        expect(line.rect[3] - line.rect[1]).toBeGreaterThan(6);
        expect(line.rect[3] - line.rect[1]).toBeLessThan(40);
        expect(line.dir).toBe(sample.dir ?? "ltr");
      }
      const tops = result.lines.map((l) => l.rect[1]);
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    }, 240_000);
  }
});

/** cases where script detection or the first reading goes wrong and the fallbacks have to save it */
const HARD: Record<string, { sample: Sample; minimum: number }> = {
  guj: {
    minimum: 0.9,
    sample: { lang: "gu", font: "'Nirmala UI'", lines: ["પુસ્તકાલયનો વાર્ષિક અહેવાલ", "પુસ્તકાલય દરરોજ સવારે આઠ વાગ્યે ખુલે છે.", "વિદ્યાર્થીઓ પાંચ પુસ્તકો લઈ શકે છે.", "કૃપા કરીને શાંતિ જાળવો."] },
  },
  kor: {
    minimum: 0.9,
    sample: { lang: "ko", font: "'Malgun Gothic'", lines: ["도서관 연간 보고서", "도서관은 매일 아침 여덟 시에 문을 엽니다.", "학생들은 책 다섯 권을 두 주 동안 빌릴 수 있습니다.", "열람실에서는 조용히 해 주시기 바랍니다."] },
  },
  fas: {
    minimum: 0.92,
    sample: { lang: "fa", dir: "rtl", font: "Arial", lines: ["گزارش سالانه کتابخانه", "کتابخانه هر روز از ساعت هشت صبح باز است.", "دانشجویان می‌توانند پنج کتاب را برای دو هفته امانت بگیرند.", "لطفا در سالن مطالعه سکوت را رعایت کنید."] },
  },
};

describe.each(Object.entries(HARD))("automatic detection: %s", (code, { sample, minimum }) => {
  it("ends up with the right language", async () => {
    const scan = degrade(await typeset(sample, "hard-" + code), { paper: [240, 236, 224], noise: 5, skew: 0.8 });
    const result = await recognizePage(toRendered(scan), { languages: [], scale: SCALE });
    expect(result.languages[0]).toBe(code);
    expect(accuracy(sample.lines.join("\n"), result.lines.map((l) => l.text).join("\n"))).toBeGreaterThan(minimum);
  }, 240_000);
});

describe("difficult pages", () => {
  it("estimates the tilt of a page", async () => {
    for (const skew of [-6, -0.8, 0, 2.5, 7]) {
      const scan = degrade(await typeset(SAMPLES.eng!, "eng"), { skew, noise: 4 });
      const rendered = toRendered(scan);
      expect(Math.abs(estimateSkew(toGray(rendered.data, rendered.width, rendered.height)) - skew)).toBeLessThan(0.2);
    }
  });

  it("turns a sideways scan upright and reports page coordinates of the original", async () => {
    const upright = degrade(await typeset(SAMPLES.eng!, "eng"), { noise: 4 });
    // turn the picture 90 degrees clockwise
    const { width, height } = upright;
    const data = new Uint8Array(upright.data.length);
    for (let y = 0; y < width; y++)
      for (let x = 0; x < height; x++)
        data.set(upright.data.subarray(((height - 1 - x) * width + y) * 3, ((height - 1 - x) * width + y) * 3 + 3), (y * height + x) * 3);
    const result = await recognizePage(toRendered({ width: height, height: width, data }), { languages: [], scale: SCALE });
    const text = result.lines.map((l) => l.text).join("\n");
    expect(accuracy(SAMPLES.eng!.lines.join("\n"), text)).toBeGreaterThan(0.95);
    const first = result.lines[0]!;
    // the heading now runs down the right-hand side
    expect(first.rect[3] - first.rect[1]).toBeGreaterThan(first.rect[2] - first.rect[0]);
    expect(first.rect[0]).toBeGreaterThan(230);
    const [from, to] = first.baseline!;
    expect(to[1]).toBeGreaterThan(from[1] + 100);
  }, 240_000);

  it("returns nothing for a blank page without loading anything", async () => {
    const data = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    const result = await recognizePage({ page: 3, revision: 1, width: 200, height: 200, data }, { languages: [], scale: SCALE });
    expect(result).toEqual({ page: 3, languages: [], lines: [] });
  });

  it("can be cancelled and used again", async () => {
    const page = toRendered(degrade(await typeset(SAMPLES.eng!, "eng"), { noise: 3 }));
    const abort = new AbortController();
    const job = recognizePage(page, {
      languages: ["eng"],
      scale: SCALE,
      signal: abort.signal,
      onProgress: (p) => p.progress > 0.2 && abort.abort(),
    });
    await expect(job).rejects.toThrow(/cancelled/);
    const again = await recognizePage(page, { languages: ["eng"], scale: SCALE });
    expect(again.lines.length).toBe(5);
  }, 240_000);

  it("reports an understandable error for a language that cannot be loaded", async () => {
    const page = toRendered(degrade(await typeset(SAMPLES.eng!, "eng"), {}));
    await expect(recognizePage(page, { languages: ["zzz"], scale: SCALE })).rejects.toThrow(/download|zzz|failed/i);
    const again = await recognizePage(page, { languages: ["eng"], scale: SCALE });
    expect(again.lines.length).toBe(5);
  }, 240_000);
});
