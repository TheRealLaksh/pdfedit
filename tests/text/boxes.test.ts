/** Boxes on the kinds of pages people really have: what is one box, and does it stay one after editing. */
import { describe, expect, it } from "vitest";
import type { TextLine } from "../../src/engine/types";
import { build, content, diffOutside, line, lines, open, render, union } from "./helpers";

const at = (x: number, y: number, text: string, size = 10, extra = "") => `BT /F1 ${size} Tf ${extra} 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`;
const texts = (list: TextLine[]) => list.map((l) => l.text).sort();
const edit = async (e: Awaited<ReturnType<typeof open>>, from: string, to: string) => {
  const target = await line(e, from);
  return e.editLines(0, [{ lineId: target.id, text: to }]);
};

describe("longer text next to its neighbours", () => {
  it("keeps a box that runs into the next column apart from it, edit after edit", async () => {
    const e = await open(build({ content: [at(40, 200, "Qty"), at(75, 200, "Description"), at(40, 180, "2"), at(75, 180, "Packaging")].join("\n") }));
    await edit(e, "Qty", "Quantity left");
    expect(texts(await lines(e))).toEqual(["2", "Description", "Packaging", "Quantity left"]);
    await edit(e, "Quantity left", "Quantity left over");
    expect(texts(await lines(e))).toEqual(["2", "Description", "Packaging", "Quantity left over"]);
    // the neighbour is still its own box and can be changed
    await edit(e, "Description", "Details");
    expect(texts(await lines(e))).toEqual(["2", "Details", "Packaging", "Quantity left over"]);
    await e.undo();
    await e.undo();
    await e.undo();
    expect(texts(await lines(e))).toEqual(["2", "Description", "Packaging", "Qty"]);
  });

  it("stops just short of the neighbour without joining it", async () => {
    const e = await open(build({ content: [at(40, 200, "No"), at(75, 200, "Total")].join("\n") }));
    await edit(e, "No", "No. one");
    expect(texts(await lines(e))).toEqual(["No. one", "Total"]);
  });

  it("stays one box when it crosses a table border", async () => {
    const e = await open(build({ content: [at(40, 200, "Debit"), "100 190 m 100 215 l S"].join("\n") }));
    await edit(e, "Debit", "Debit amount carried forward");
    expect(texts(await lines(e))).toEqual(["Debit amount carried forward"]);
    await edit(e, "Debit amount", "Credit amount carried forward");
    expect(texts(await lines(e))).toEqual(["Credit amount carried forward"]);
  });

  it("keeps the alignment a line had before its column changed", async () => {
    const rows = ["1,200", "87,000", "5"].map((t, i) => at(200 - [27.8, 30.6, 5.56][i]!, 200 - i * 14, t));
    const e = await open(build({ content: rows.join("\n") }));
    expect((await line(e, "87,000")).align).toBe("right");
    await edit(e, "1,200", "1,200 approx");
    await edit(e, "87,000", "7");
    const after = await line(e, "7");
    expect(after.align).toBe("right");
    expect(after.rect[2]).toBeCloseTo(200, 0);
    expect((await line(e, "5")).align).toBe("right");
  });

  it("does not cut a line at a blank that was left where it now starts", async () => {
    const e = await open(build({ content: `BT /F2 9 Tf 1 0 0 1 40 200 Tm (DATE        PARTICULARS              DEBIT) Tj ET`, fonts: { F2: standardCourier } }));
    const target = await line(e, "DEBIT");
    await e.editLines(0, [{ lineId: target.id, text: "DEBIT XQ", align: "right" }]);
    expect((await lines(e)).map((l) => l.text).join("|")).toContain("DEBIT XQ");
  });
});

const standardCourier = (doc: import("mupdf").PDFDocument) => {
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("Font"));
  dict.put("Subtype", doc.newName("Type1"));
  dict.put("BaseFont", doc.newName("Courier"));
  dict.put("Encoding", doc.newName("WinAnsiEncoding"));
  return doc.addObject(dict);
};

describe("one box per thing a reader sees", () => {
  it("reads widely spaced characters (Tc) as words and boxes them tightly", async () => {
    const e = await open(build({ content: "BT /F1 10 Tf 12 Tc 1 0 0 1 20 200 Tm (ADMIT ONE) Tj ET" }));
    const all = await lines(e);
    expect(texts(all)).toEqual(["ADMIT ONE"]);
    // the spacing after the last letter is not part of the box
    expect(all[0]!.rect[2] - all[0]!.rect[0]).toBeLessThan(155);
  });

  it("joins widely tracked letters drawn one at a time", async () => {
    let x = 30;
    const ops: string[] = [];
    // Helvetica-Bold style spacing: each letter its own text object, 8 points apart
    const widths: Record<string, number> = { A: 6.67, D: 7.22, M: 8.33, I: 2.78, T: 6.11, O: 7.78, N: 7.22, E: 6.67, " ": 2.78 };
    for (const ch of "ADMIT ONE") {
      if (ch !== " ") ops.push(at(x, 200, ch));
      x += widths[ch]! + 4.5;
    }
    const e = await open(build({ content: ops.join("\n") }));
    expect(texts(await lines(e))).toEqual(["ADMIT ONE"]);
    await edit(e, "ADMIT ONE", "ADMIT TWO");
    expect((await lines(e)).length).toBe(1);
  });

  it("splits the columns of a tight table without borders", async () => {
    const rows = [0, 1, 2, 3, 4].map((i) => [at(40, 200 - i * 12, `Store ${i + 1}`, 9), at(76, 200 - i * 12, `Block ${"ABCDE"[i]}`, 9), at(114, 200 - i * 12, `${410 + i}`, 9)].join("\n"));
    const e = await open(build({ content: rows.join("\n") }));
    const all = texts(await lines(e));
    expect(all).toHaveLength(15);
    expect(all).toContain("Store 3");
    expect(all).toContain("Block C");
  });

  it("leaves loosely set text whole, even when words line up", async () => {
    const rows = [0, 1, 2, 3].map((i) => [at(40, 200 - i * 12, "Name:"), at(71, 200 - i * 12, "value")].join("\n"));
    // one word space between the two: separate operators, but a reader sees one phrase
    const e = await open(build({ content: rows.join("\n").replaceAll("71 ", "69.5 ") }));
    expect(await lines(e)).toHaveLength(4);
  });

  it("makes one box of lettering and its shadow, and changes both", async () => {
    const content2 = ["BT /F1 40 Tf 0.9 0.5 0.2 rg 1 0 0 1 49 191 Tm (SALE) Tj ET", "BT /F1 40 Tf 0.1 0.1 0.4 rg 1 0 0 1 40 200 Tm (SALE) Tj ET"].join("\n");
    const e = await open(build({ content: content2 }));
    const all = await lines(e);
    expect(texts(all)).toEqual(["SALE"]);
    expect(all[0]!.style.color[2]).toBeCloseTo(0.4, 2);
    const before = await render(e);
    await edit(e, "SALE", "SOLD");
    const now = await lines(e);
    expect(texts(now)).toEqual(["SOLD"]);
    expect(diffOutside(before, await render(e), [union(all[0]!.rect, now[0]!.rect)], 3)).toBe(0);
    // the old word is nowhere, underneath included
    expect(content(e)).not.toContain("(SALE)");
  });

  it("keeps a justified line with very wide gaps in one box", async () => {
    const full = (y: number, t: string) => `BT /F1 10 Tf ${(120 - widthOf(t)) / (t.split(" ").length - 1)} Tw 1 0 0 1 40 ${y} Tm (${t}) Tj ET`;
    // two words pushed to the margins, each drawn on its own with the space after the first
    const wide = [`BT /F1 10 Tf 1 0 0 1 40 176 Tm (long ) Tj ET`, `BT /F1 10 Tf 1 0 0 1 ${160 - widthOf("words")} 176 Tm (words) Tj ET`].join("\n");
    const e = await open(build({ content: [full(200, "we are all set to go on"), full(188, "and on about it in a very"), wide, full(164, "narrow column of text set")].join("\n") }));
    expect((await lines(e)).map((l) => l.text)).toContain("long words");
  });
});

/** Helvetica advance widths of lower case text at 10 points */
function widthOf(text: string): number {
  const w: Record<string, number> = { a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, " ": 278 };
  return [...text].reduce((n, c) => n + (w[c] ?? 556), 0) / 100;
}

describe("text inside its own clip", () => {
  it("widens the clip when text moves left out of it", async () => {
    const content2 = [at(40, 200, "Application fee "), "q 108 190 90 20 re W n BT /F1 10 Tf 1 0 0 1 110 200 Tm (..........................) Tj ET Q"].join("\n");
    const e = await open(build({ content: content2 }));
    const target = await line(e, "Application");
    expect(target.text.startsWith("Application fee ....")).toBe(true);
    await e.editLines(0, [{ lineId: target.id, text: target.text.replace("Application", "Tax") }]);
    const now = await lines(e);
    expect(now).toHaveLength(1);
    expect(now[0]!.text.startsWith("Tax fee ....")).toBe(true);
    const picture = await render(e);
    // ink right where the leader now begins, left of the old clip edge
    const x = Math.round((now[0]!.rect[0] + 38) * 2);
    let ink = 0;
    for (let y = 180; y < 210; y++) for (let dx = 0; dx < 40; dx++) if (picture.data[(y * picture.width + x + dx) * 4]! < 128) ink++;
    expect(ink).toBeGreaterThan(0);
  });
});

describe("editing the same box again", () => {
  it("keeps the word gap when words are added to letter-by-letter tracked text", async () => {
    let x = 30;
    const widths: Record<string, number> = { N: 7.22, O: 7.78, T: 6.11, E: 6.67 };
    const ops = [..."NOTE"].map((ch) => {
      const op = at(x, 200, ch);
      x += widths[ch]! + 2;
      return op;
    });
    const e = await open(build({ content: ops.join("\n") }));
    await edit(e, "NOTE", "TONE");
    await edit(e, "TONE", "TONE ONE");
    expect((await lines(e)).map((l) => l.text)).toEqual(["TONE ONE"]);
  });

  it("reads the indented first line of a justified paragraph as justified", async () => {
    const spread = (x: number, y: number, t: string) => `BT /F1 10 Tf ${(250 - x - widthOf(t)) / (t.split(" ").length - 1)} Tw 1 0 0 1 ${x} ${y} Tm (${t}) Tj ET`;
    const rows = [spread(56, 200, "once there were small old gardens in"), spread(40, 188, "all of the streets around here and they"), spread(40, 176, "were looked after with a great deal of")];
    const e = await open(build({ content: rows.join("\n") }));
    const first = await line(e, "once there");
    expect(first.align).toBe("justify");
    await e.editLines(0, [{ lineId: first.id, text: first.text.replace("small", "wide") }]);
    const now = await line(e, "once there");
    expect(now.rect[0]).toBeCloseTo(56, 0);
    expect(now.rect[2]).toBeCloseTo(250, 0);
  });
});

describe("tables written with spaces after each cell", () => {
  it("keeps the cells of a ruled table apart", async () => {
    const row = (y: number, a: string, b: string, c: string) =>
      [`BT /F1 10 Tf 1 0 0 1 44 ${y} Tm (${a} ) Tj ET`, `BT /F1 10 Tf 1 0 0 1 104 ${y} Tm (${b} ) Tj ET`, `BT /F1 10 Tf 1 0 0 1 164 ${y} Tm (${c} ) Tj ET`].join("\n");
    const rules = [40, 100, 160, 220].map((x) => `${x} 150 m ${x} 215 l S`).join(" ");
    const e = await open(build({ content: [row(200, "Sl", "Name", "Room"), row(185, "one", "Khan", "twelve"), row(170, "two", "Roy", "fourteen"), rules].join("\n") }));
    expect((await lines(e)).map((l) => l.text.trim()).sort()).toEqual(["Khan", "Name", "Room", "Roy", "Sl", "fourteen", "one", "twelve", "two"]);
  });

  it("keeps every other box as it was when one is changed", async () => {
    const rows = [0, 1, 2].map((i) => [at(40, 200 - i * 12, `Store ${i + 1}`, 9), at(76, 200 - i * 12, `Block ${"ABC"[i]}`, 9)].join("\n"));
    const e = await open(build({ content: rows.join("\n") }));
    const before = texts(await lines(e));
    expect(before).toHaveLength(6);
    // without the other rows these two would no longer show that they are columns
    await edit(e, "Block A", "Dock");
    await edit(e, "Block B", "Yard");
    expect(texts(await lines(e))).toEqual(["Block C", "Dock", "Store 1", "Store 2", "Store 3", "Yard"]);
  });
});

describe("what is remembered about an edited page", () => {
  it("is dropped when the page is turned, and comes back with undo", async () => {
    const e = await open(build({ content: [at(40, 200, "Qty"), at(75, 200, "Description"), at(40, 180, "2")].join("\n") }));
    await edit(e, "Qty", "Quantity left");
    await e.rotatePages([0], 90);
    expect((await lines(e)).length).toBeGreaterThanOrEqual(2);
    await e.undo();
    expect(texts(await lines(e))).toEqual(["2", "Description", "Quantity left"]);
    await e.undo();
    expect(texts(await lines(e))).toEqual(["2", "Description", "Qty"]);
    await e.redo();
    expect(texts(await lines(e))).toEqual(["2", "Description", "Quantity left"]);
  });
});
