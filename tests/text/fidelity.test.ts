/** Details that make an edit look native: spacing, alignment, raised text, layered copies, substitutes. */
import { describe, expect, it } from "vitest";
import { planText } from "../../src/engine/fonts";
import { nodeAssets } from "../fonts/nodeAssets";
import { build, line, lines, open, standard } from "./helpers";

const page = (content: string, fonts?: Parameters<typeof build>[0]["fonts"]) => build({ content, fonts, size: [400, 300] });

describe("fidelity", () => {
  it("spaces new letters like the rest of a tracked line", async () => {
    // every letter positioned on its own, 4pt wider apart than the font says (as browsers do)
    const widths: Record<string, number> = { T: 7.332, R: 8.664, A: 8.004, C: 8.664, K: 8.004 };
    let x = 50;
    const content = [..."TRACK"].map((c) => {
      const op = `BT /F1 12 Tf ${x} 200 Td (${c}) Tj ET`;
      x += widths[c]! + 4;
      return op;
    });
    const e = await open(page(content.join("\n")));
    const before = await line(e, "TRACK");
    expect(before.style.letterSpacing).toBeCloseTo(4, 0);
    await e.editLines(0, [{ lineId: before.id, text: "TRACKCAT" }]);
    const after = await line(e, "TRACKCAT");
    // three more letters, each with its 4pt
    expect(after.rect[2] - before.rect[2]).toBeCloseTo(8.664 + 8.004 + 7.332 + 12, 0);
  });

  it("keeps superscripts and subscripts on their line", async () => {
    const e = await open(
      page("BT /F1 12 Tf 50 200 Td (Water is H) Tj -2.5 Ts /F1 10 Tf (2) Tj 0 Ts /F1 12 Tf (O and mc) Tj 4.5 Ts /F1 10 Tf (2) Tj 0 Ts /F1 12 Tf ( holds) Tj ET"),
    );
    expect((await lines(e)).map((l) => l.text)).toEqual(["Water is H2O and mc2 holds"]);
  });

  it("recognises justified neighbours and a right aligned line among other lines", async () => {
    const long = (y: number, text: string, width: number) => {
      const words = text.split(" ");
      const gaps = words.length - 1;
      // Helvetica widths are not needed: the word spacing makes both lines end at the same place
      return { y, text, gaps, width };
    };
    const rows = [long(250, "alpha beta gamma delta epsilon zeta eta theta", 300), long(236, "iota kappa lambda mu nu xi omicron pi rho sigma", 300)];
    const probe = await open(page(rows.map((r) => `BT /F1 11 Tf 50 ${r.y} Td (${r.text}) Tj ET`).join("\n")));
    const natural = await lines(probe);
    const content = rows.map((r) => {
      const own = natural.find((l) => l.text === r.text)!;
      const tw = (r.width - (own.rect[2] - own.rect[0])) / r.gaps;
      return `BT /F1 11 Tf ${tw.toFixed(4)} Tw 50 ${r.y} Td (${r.text}) Tj ET`;
    });
    content.push("BT /F1 11 Tf 0 Tw 50 222 Td (short end) Tj ET");
    const total = "Total due 40";
    const measure = await open(page(`BT /F1 11 Tf 50 100 Td (${total}) Tj ET`));
    const w = (await line(measure, total)).rect[2] - 50;
    content.push(`BT /F1 11 Tf ${(350 - w).toFixed(3)} 180 Td (${total}) Tj ET`);
    const e = await open(page(content.join("\n")));
    expect((await line(e, "alpha")).align).toBe("justify");
    expect((await line(e, "iota")).align).toBe("justify");
    expect((await line(e, "short")).align).toBe("left");
    expect((await line(e, total)).align).toBe("right");
  });

  it("treats letters painted again from another font as one line", async () => {
    const e = await open(
      page("BT /F1 18 Tf 1 1 0 rg 50 200 Td (Outlined) Tj ET BT /F2 18 Tf 1 0 0 rg 50 200 Td (Outlined) Tj ET", {
        F1: standard("Helvetica"),
        F2: standard("Helvetica"),
      }),
    );
    expect((await lines(e)).map((l) => l.text)).toEqual(["Outlined"]);
    const target = await line(e, "Outlined");
    await e.editLines(0, [{ lineId: target.id, text: "Outline" }]);
    expect((await lines(e)).map((l) => l.text)).toEqual(["Outline"]);
  });

  it("sizes a substitute font to the letter heights of the original", async () => {
    const e = await open(page("BT /F1 12 Tf 50 200 Td (x) Tj ET"), nodeAssets);
    const style = { family: "Unknown Face", bold: false, italic: false, serif: false, mono: false, size: 20, color: [0, 0, 0] as [number, number, number] };
    const originalFont = { name: "Unknown Face", bold: false, italic: false, serif: false, mono: false };
    const plain = await planText(e.context, { text: "Heights", style, originalFont });
    const taller = await planText(e.context, {
      text: "Heights",
      style,
      originalFont,
      reference: [..."HIEFT"].map((char) => ({ char, top: 0.8, bottom: 0 })),
    });
    expect(taller.width / plain.width).toBeGreaterThan(1.05);
    expect(taller.width / plain.width).toBeLessThan(1.36);
  });
});
