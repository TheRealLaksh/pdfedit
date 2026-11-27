/** Hostile or generated files with enormous lines must stay fast and must not crash. */
import { describe, expect, it } from "vitest";
import { build, lines, open } from "./helpers";

const words = (n: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n);
const read = async (content: string) => {
  const e = await open(build({ content, size: [400, 300] }));
  const started = Date.now();
  const page = await e.getPageText(0);
  return { e, page, ms: Date.now() - started };
};

describe("very long lines", () => {
  it("cuts a huge line into pieces that are read but not offered for editing", async () => {
    const { e, page, ms } = await read(`BT /F1 10 Tf 10 100 Td (${words(200_000)}) Tj ET BT /F1 12 Tf 10 200 Td (An ordinary line) Tj ET`);
    expect(ms).toBeLessThan(8000);
    expect(page.kind).toBe("text");
    const ordinary = page.lines.find((l) => l.text === "An ordinary line")!;
    expect(ordinary.editable).toBe(true);
    const long = page.lines.filter((l) => l !== ordinary);
    for (const l of long) {
      expect(l.editable).toBe(false);
      expect(l.note).toMatch(/too long/);
    }
    await e.editLines(0, [{ lineId: ordinary.id, text: "An edited line" }]);
    expect((await lines(e)).some((l) => l.text === "An edited line")).toBe(true);
  });

  it("handles microscopic text and heavy overprinting", async () => {
    const tiny = await read(`BT /F1 0.001 Tf 10 100 Td (${words(60_000)}) Tj ET`);
    expect(tiny.ms).toBeLessThan(8000);
    const stacked = await read(`BT /F1 10 Tf ${"1 0 0 1 10 100 Tm (abcd) Tj ".repeat(8000)}ET`);
    expect(stacked.ms).toBeLessThan(8000);
    expect(stacked.page.lines.map((l) => l.text)).toEqual(["abcd"]);
  });
});
