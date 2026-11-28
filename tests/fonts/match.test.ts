/** Fonts with meaningless names are matched by the widths of their letters. */
import { describe, expect, it } from "vitest";
import { planText } from "../../src/engine/fonts";
import { closestByMetrics, METRIC_LETTERS } from "../../src/engine/fonts/match";
import { METRICS } from "../../src/engine/fonts/metrics.data";
import { makeContext, style } from "./helpers";

const widthsOf = (key: string, variant = 2, scale = 1) => {
  const row = METRICS.find((r) => r[0] === key)!;
  const list = (row[variant] as string).split(" ").map(Number);
  return Object.fromEntries([...METRIC_LETTERS].map((c, i) => [c, (list[i]! * scale) / 1000]));
};
const plain = { serif: false, mono: false, bold: false };

describe("matching by metrics", () => {
  it("finds a family from its widths, also from a subset and in bold", () => {
    expect(closestByMetrics(widthsOf("lato"), plain)).toBe("lato");
    expect(closestByMetrics(widthsOf("montserrat"), plain)).toBe("montserrat");
    expect(closestByMetrics(widthsOf("lora"), { ...plain, serif: true })).toBe("lora");
    expect(closestByMetrics(widthsOf("open-sans", 3), { ...plain, bold: true })).toMatch(/open-sans|noto-sans/);
    const subset = Object.fromEntries(Object.entries(widthsOf("poppins")).filter(([c]) => "Totalamoundue2548INVR".includes(c)));
    expect(closestByMetrics(subset, plain)).toBe("poppins");
  });

  it("keeps the generic stand in when there is too little to go on or nothing is alike", () => {
    expect(closestByMetrics({ a: 0.5, b: 0.5 }, plain)).toBeNull();
    const odd = Object.fromEntries([...METRIC_LETTERS].map((c, i) => [c, i % 2 ? 0.3 : 0.9]));
    expect(closestByMetrics(odd, plain)).toBeNull();
    expect(closestByMetrics(widthsOf("lato"), { ...plain, mono: true })).toBeNull();
  });

  it("is used when drawing for an unknown font, but never over a known name", async () => {
    const ctx = makeContext();
    const look = style({ family: "QZX-Report" });
    const originalFont = { name: "QZX-Report", ...plain, italic: false, widths: widthsOf("lato") };
    expect((await planText(ctx, { text: "Quarterly total", style: look, originalFont })).fontsUsed).toEqual(["Lato"]);
    const known = { ...originalFont, name: "Calibri" };
    expect((await planText(ctx, { text: "Quarterly total", style: style({ family: "Calibri" }), originalFont: known })).fontsUsed).toEqual(["Carlito"]);
  });
});
