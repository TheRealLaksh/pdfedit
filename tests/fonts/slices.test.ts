/** Only the fonts a line needs are fetched: CJK in slices, and nothing of the wrong script. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAssetLoader, type AssetLoader } from "../../src/engine/context";
import { Engine } from "../../src/engine/engine";
import { planText } from "../../src/engine/fonts";
import { parseSlices } from "../../src/engine/fonts/slices";
import { draw, extractLines, makeContext, reopen, savePng, style } from "./helpers";
import { nodeAssets } from "./nodeAssets";

function counting(refuse?: RegExp): { assets: AssetLoader; asked: string[]; bytes: () => number } {
  const asked: string[] = [];
  let total = 0;
  const assets = createAssetLoader(async (url) => {
    asked.push(url);
    if (refuse?.test(url)) throw new Error("offline");
    const data = await nodeAssets.bytes(url);
    total += data.length;
    return data;
  });
  return { assets, asked, bytes: () => total };
}

describe("slices", () => {
  it("reads which file holds which characters", () => {
    const css = `@font-face { font-family: 'X'; src: url(./files/x-4-400-normal.woff2) format('woff2'), url(./files/x-4-400-normal.woff) format('woff'); unicode-range: U+4E00-4E10,U+3002; }`;
    expect(parseSlices(css, "https://a/b")).toEqual([
      { url: "https://a/b/files/x-4-400-normal.woff", ranges: [[0x4e00, 0x4e10], [0x3002, 0x3002]] },
    ]);
  });

  it("draws Chinese, Japanese and Korean from small pieces", async () => {
    const { assets, asked, bytes } = counting();
    const ctx = { ...makeContext(500, 200), assets };
    const samples = [
      ["图书馆每天上午九点开门。Open 9", style({ family: "SimSun", serif: true, size: 24 })],
      ["図書館は毎朝九時に開館します。", style({ family: "MS Gothic", size: 24 })],
      ["도서관은 매일 아침에 문을 엽니다", style({ family: "Malgun Gothic", size: 24, bold: true })],
    ] as const;
    for (const [i, [text, look]] of samples.entries()) {
      const written = await draw(ctx, text, 20, 40 + i * 50, { style: look });
      expect(written.missing).toEqual([]);
    }
    expect(asked.filter((u) => /@expo-google-fonts\/noto-(sans|serif)-(sc|tc|jp|kr)/.test(u))).toEqual([]);
    expect(asked.filter((u) => u.endsWith(".woff")).length).toBeGreaterThan(3);
    expect(bytes()).toBeLessThan(2_500_000);
    savePng(ctx, "cjk-slices");
    const text = extractLines(reopen(ctx.doc)).join("\n").replace(/\s/g, "");
    for (const [line] of samples) expect(text).toContain(line.replace(/\s/g, ""));
  });

  it("falls back to the whole font when the pieces cannot be listed", async () => {
    const { assets, asked } = counting(/fontsource/);
    const ctx = { ...makeContext(), assets };
    const plan = await planText(ctx, { text: "中文", style: style({ family: "SimHei" }) });
    expect(plan.missing).toEqual([]);
    expect(asked.some((u) => /noto-sans-sc@.*\.ttf$/.test(u))).toBe(true);
  });

  it("fetches only what Hindi typed into an italic serif line needs", async () => {
    const { assets, asked } = counting();
    const engine = new Engine(assets);
    await engine.open(new Uint8Array(readFileSync("tests/fixtures/pdfs/en-truetype.pdf")), "a.pdf");
    const line = (await engine.getPageText(0)).lines.find((l) => l.style.italic)!;
    asked.length = 0;
    const result = await engine.editLines(0, [{ lineId: line.id, text: `${line.text} नमस्ते दुनिया।` }]);
    expect(result.warnings).toEqual([]);
    expect(asked.filter((u) => /tinos|arimo/i.test(u))).toEqual([]);
    expect(asked.filter((u) => /Devanagari/.test(u))).toHaveLength(1);
  });
});
