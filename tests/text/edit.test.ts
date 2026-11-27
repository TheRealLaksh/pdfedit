/** Surgical editing of generated PDFs: pixels outside the edit must not change. */
import fs from "node:fs";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../src/engine/engine";
import type { Rect } from "../../src/engine/types";
import { build, content, diffAll, diffOutside, extract, line, lines, open, render, reopen, savePng, standard, union } from "./helpers";
import { calls } from "./mockFonts";

vi.mock("../../src/engine/fonts", async () => await import("./mockFonts"));

beforeEach(() => {
  calls.length = 0;
});

/** edit one line and report the pixels that changed outside the old and new line boxes */
async function change(engine: Engine, find: string, text: string, extra: Record<string, unknown> = {}, page = 0, slack = 2) {
  const target = await line(engine, find, page);
  const before = await render(engine, page);
  const result = await engine.editLines(page, [{ lineId: target.id, text, ...extra }]);
  const after = await render(engine, page);
  const updated = (await lines(engine, page)).find((l) => l.text === text);
  const box: Rect = updated ? union(target.rect, updated.rect) : target.rect;
  return { target, updated, result, before, after, stray: diffOutside(before, after, [box], slack), changed: diffAll(before, after) };
}

const invoice = () =>
  build({
    content: [
      "BT /F1 18 Tf 0.8 0.1 0.1 rg 50 250 Td (Invoice number 2024 is due) Tj ET",
      "BT /F1 12 Tf 0 g 14 TL 50 200 Td [(Second) -300 (line) 40 ( stays here)] TJ T* (Third line) Tj (Fourth line) ' 2 0.5 (Fifth line) \" 0 -14 Td (Sixth line) Tj ET",
      "0.2 0.4 0.9 rg 40 60 120 30 re f",
    ].join("\n"),
  });

describe("simple fonts", () => {
  it("replaces a word with the original font and leaves every other pixel alone", async () => {
    const e = await open(invoice());
    const { updated, stray, result, target } = await change(e, "Invoice", "Invoice number 2025 is paid");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
    expect(calls).toHaveLength(0);
    expect(result.fallbackFonts).toEqual([]);
    expect(updated!.style).toEqual(target.style);
    expect(updated!.origin[0]).toBeCloseTo(target.origin[0], 3);
    expect(updated!.origin[1]).toBeCloseTo(target.origin[1], 3);
    const again = await reopen(e);
    expect(extract(again)).toContain("Invoice number 2025 is paid");
    expect(extract(again)).not.toContain("2024");
    savePng(e, "invoice");
  });

  it("keeps untouched operators byte for byte", async () => {
    const e = await open(invoice());
    await change(e, "Invoice", "Invoice number 7 is due");
    const c = content(e);
    expect(c).toContain("[(Second) -300 (line) 40 ( stays here)] TJ T* (Third line) Tj (Fourth line) ' 2 0.5 (Fifth line) \" 0 -14 Td (Sixth line) Tj ET");
    expect(c).toContain("0.2 0.4 0.9 rg 40 60 120 30 re f");
  });

  for (const word of ["Second", "Third", "Fourth", "Fifth", "Sixth"]) {
    it(`edits the ${word} line without moving its neighbours (Td, T*, ', ")`, async () => {
      const e = await open(invoice());
      const original = (await lines(e)).map((l) => ({ text: l.text, x: l.origin[0], y: l.origin[1], w: l.rect[2] - l.rect[0] }));
      const { stray, target } = await change(e, word, `${word} changed a lot`);
      expect(stray).toBe(0);
      const now = await lines(e);
      for (const o of original) {
        if (o.text === target.text) continue;
        const n = now.find((l) => l.text === o.text)!;
        expect(n, o.text).toBeDefined();
        expect(n.origin[0]).toBeCloseTo(o.x, 2);
        expect(n.origin[1]).toBeCloseTo(o.y, 2);
        expect(n.rect[2] - n.rect[0]).toBeCloseTo(o.w, 2);
      }
    });
  }

  it("deletes a line", async () => {
    const e = await open(invoice());
    const { stray, changed } = await change(e, "Third", "");
    expect(changed).toBeGreaterThan(20);
    expect(stray).toBe(0);
    expect(extract(e)).not.toContain("Third");
    expect(extract(e)).toContain("Fourth line");
  });

  it("changes nothing when nothing changed", async () => {
    const e = await open(invoice());
    const before = content(e);
    const l = await line(e, "Third");
    const r = await e.editLines(0, [{ lineId: l.id, text: l.text, style: { size: l.style.size } }]);
    expect(r.changedPages).toEqual([]);
    expect(content(e)).toBe(before);
  });

  it("undo restores the page exactly", async () => {
    const e = await open(invoice());
    const before = await render(e);
    await change(e, "Invoice", "Something else entirely");
    await e.undo();
    expect(diffAll(before, await render(e))).toBe(0);
    await e.redo();
    expect(extract(e)).toContain("Something else entirely");
  });

  it("edits the same line repeatedly", async () => {
    const e = await open(invoice());
    for (const text of ["Invoice number 1 is due", "Invoice number 22 is due", "Receipt 3", "Invoice number 2024 is due"]) {
      const l = (await lines(e))[0]!;
      await e.editLines(0, [{ lineId: l.id, text }]);
      expect((await lines(e))[0]!.text).toBe(text);
    }
    // back to the first text: it must look like the original
    const original = await open(invoice());
    expect(diffAll(await render(original), await render(e))).toBeLessThan(30);
  });

  it("applies colour, size, letter spacing and offset to only that line", async () => {
    for (const extra of [{ style: { color: [0, 0.6, 0] } }, { style: { size: 15 } }, { style: { letterSpacing: 1.5 } }, { offset: [30, -12] }]) {
      const e = await open(invoice());
      const { stray, updated, target, changed } = await change(e, "Third", "Third line", extra);
      expect(changed).toBeGreaterThan(20);
      expect(stray, JSON.stringify(extra)).toBe(0);
      expect(updated).toBeDefined();
      expect(calls).toHaveLength(0);
      if ("offset" in extra) {
        expect(updated!.origin[0] - target.origin[0]).toBeCloseTo(30, 2);
        expect(updated!.origin[1] - target.origin[1]).toBeCloseTo(-12, 2);
      } else if (extra.style!.color) expect(updated!.style.color[1]).toBeCloseTo(0.6, 2);
      else if (extra.style!.size) expect(updated!.style.size).toBeCloseTo(15, 2);
      else expect(updated!.style.letterSpacing).toBeCloseTo(1.5, 1);
      // the following lines keep their colour
      expect((await line(e, "Fourth")).style.color).toEqual([0, 0, 0]);
    }
  });

  it("shrinks to the original width on request", async () => {
    const e = await open(invoice());
    const { updated, target } = await change(e, "Third", "Third line that has become much longer", { fit: "shrink" });
    expect((await lines(e)).map((l) => l.text)).toContain("Third line that has become much longer");
    expect(updated!.rect[2] - updated!.rect[0]).toBeCloseTo(target.rect[2] - target.rect[0], 1);
  });

  it("adds and removes an underline", async () => {
    const e = await open(invoice());
    const added = await change(e, "Third", "Third line", { style: { underline: true } });
    expect(added.stray).toBe(0);
    expect(added.updated!.style.underline).toBe(true);
    const grown = await change(e, "Third", "Third line, longer", {});
    expect(grown.stray).toBe(0);
    expect(grown.updated!.style.underline).toBe(true);
    const removed = await change(e, "Third", "Third line", { style: { underline: false } });
    expect(removed.updated!.style.underline).toBeFalsy();
    const original = await open(invoice());
    expect(diffAll(await render(original), await render(e))).toBeLessThan(10);
  });

  it("hands characters the font cannot draw to the FONTS module, in place and in the same colour", async () => {
    const e = await open(invoice());
    const { target, result, before, after } = await change(e, "Invoice", "Invoice number 2024 is \u0928\u092E\u0938\u094D\u0924\u0947");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.text).toBe("\u0928\u092E\u0938\u094D\u0924\u0947");
    expect(call.colorOps).toBe("");
    expect(call.style.size).toBeCloseTo(18, 3);
    expect(call.originalFont!.name).toBe("Helvetica");
    // text space of the request maps to the baseline of the line, y up
    expect(call.matrix[0]).toBeCloseTo(1, 5);
    expect(call.matrix[3]).toBeCloseTo(1, 5);
    expect(call.matrix[5]).toBeCloseTo(250, 3);
    expect(call.matrix[4]).toBeGreaterThan(target.origin[0] + 150);
    expect(result.fallbackFonts).toEqual(["Helvetica"]);
    // only the replaced end of the line changes
    expect(diffOutside(before, after, [[call.matrix[4] - 1, target.rect[1], 400, target.rect[3]]])).toBe(0);
  });

  it("redraws the whole line when the user picks another font", async () => {
    const e = await open(invoice());
    const { result } = await change(e, "Third", "Third line", { style: { fontChoice: "builtin:x" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe("Third line");
    expect(result.fallbackFonts).toEqual([]);
    expect((await lines(e)).filter((l) => l.text === "Third line")).toHaveLength(1);
  });

  it("uses the bold sibling already in the document", async () => {
    const e = await open(
      build({
        fonts: { F1: standard("Helvetica"), F2: standard("Helvetica-Bold") },
        content: "BT /F1 14 Tf 40 200 Td (Make this bold) Tj ET BT /F2 14 Tf 40 100 Td (A heading) Tj ET",
      }),
    );
    const { updated, stray } = await change(e, "Make", "Make this bold", { style: { bold: true } });
    expect(calls).toHaveLength(0);
    expect(updated!.style.bold).toBe(true);
    expect(updated!.style.family).toBe("Helvetica-Bold");
    expect(stray).toBe(0);
  });
});

describe("layout and alignment", () => {
  const table = () =>
    build({
      content: [
        "BT /F1 12 Tf 40 250 Td [(Item name) -9000 (Amount)] TJ ET",
        "BT /F1 12 Tf 1 0 0 1 273.31 230 Tm (1,200.00) Tj 1 0 0 1 286.64 214 Tm (45.50) Tj 1 0 0 1 279.98 198 Tm (310.00) Tj ET",
        "BT /F1 12 Tf 40 230 Td (Chairs) Tj 0 -16 Td (Lamp) Tj 0 -16 Td (Desk) Tj ET",
        "BT /F1 12 Tf 1 0 0 1 130 160 Tm (Centred title of the section) Tj ET BT /F1 11 Tf 1 0 0 1 164 145 Tm (a subtitle below) Tj ET",
      ].join("\n"),
    });

  it("does not merge columns and keeps the other column still", async () => {
    const e = await open(table());
    const texts = (await lines(e)).map((l) => l.text);
    expect(texts).toContain("Item name");
    expect(texts).toContain("Amount");
    expect(texts).toContain("Chairs");
    const amount = await line(e, "Amount");
    const { stray } = await change(e, "Item name", "Product");
    expect(stray).toBe(0);
    expect((await line(e, "Amount")).origin).toEqual(amount.origin.map((v) => expect.closeTo(v, 2)));
  });

  it("keeps the right edge of right aligned figures", async () => {
    const e = await open(table());
    const target = await line(e, "45.50");
    expect(target.align).toBe("right");
    const { updated, stray } = await change(e, "45.50", "12,345.50");
    expect(updated!.rect[2]).toBeCloseTo(target.rect[2], 1);
    expect(updated!.rect[0]).toBeLessThan(target.rect[0] - 10);
    expect(stray).toBe(0);
  });

  it("keeps the centre of centred text", async () => {
    const e = await open(table());
    const target = await line(e, "Centred");
    expect(target.align).toBe("center");
    const { updated } = await change(e, "Centred", "Centred title, extended");
    expect((updated!.rect[0] + updated!.rect[2]) / 2).toBeCloseTo((target.rect[0] + target.rect[2]) / 2, 1);
  });

  it("moves a line to another alignment inside its block", async () => {
    const e = await open(table());
    const sub = await line(e, "subtitle");
    const title = await line(e, "Centred");
    expect(title.rect[0]).toBeLessThan(sub.rect[0]);
    const { updated } = await change(e, "subtitle", sub.text, { align: "left" });
    expect(updated!.rect[0]).toBeCloseTo(Math.min(title.rect[0], sub.rect[0]), 1);
  });

  it("keeps justified lines justified", async () => {
    const words = [
      "BT /F1 12 Tf 40 250 Td 3.1 Tw (alpha beta gamma delta epsilon zeta) Tj 0 Tw ET",
      "BT /F1 12 Tf 40 236 Td (and a second line of the same width as above) Tj ET",
    ];
    const e = await open(build({ content: words.join("\n") }));
    const [a, b] = await lines(e);
    // make both lines exactly as wide, as a justifying producer would
    const gap = (b!.rect[2] - b!.rect[0] - (a!.rect[2] - a!.rect[0])) / 5 + 3.1;
    const justified = await open(
      build({
        content: [
          words[0]!.replace("3.1 Tw", `${gap.toFixed(5)} Tw`),
          words[1]!,
          "BT /F1 12 Tf 40 222 Td (third line, equally wide: pad pad pad p) Tj ET",
          "BT /F1 12 Tf 40 208 Td (end.) Tj ET",
        ].join("\n"),
      }),
    );
    const first = await line(justified, "alpha");
    expect(first.align).toBe("justify");
    const { updated } = await change(justified, "alpha", "alpha beta gamma delta zeta");
    expect(updated!.rect[2]).toBeCloseTo(first.rect[2], 1);
    expect(updated!.rect[0]).toBeCloseTo(first.rect[0], 2);
  });

  it("joins glyphs drawn one operator at a time and out of order", async () => {
    const font = new mupdf.Font("Helvetica");
    let x = 60;
    const placed = [..."Scattered words here"].map((c) => {
      const at = x;
      x += font.advanceGlyph(font.encodeCharacter(c)) * 14;
      return { c, at };
    });
    const ops = placed
      .filter((p) => p.c !== " ")
      .sort((a, b) => ((a.at * 7919) % 101) - ((b.at * 7919) % 101))
      .map((p) => `BT /F1 14 Tf 1 0 0 1 ${p.at.toFixed(4)} 150 Tm (${p.c}) Tj ET`);
    const e = await open(build({ content: ops.join("\n") }));
    expect((await lines(e)).map((l) => l.text)).toEqual(["Scattered words here"]);
    const { updated, stray } = await change(e, "Scattered", "Scattered words there");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
  });

  it("treats a doubled (fake bold) line as one and edits both layers", async () => {
    const e = await open(
      build({ content: "BT /F1 20 Tf 50 150 Td (Shadow title) Tj ET BT /F1 20 Tf 50.5 150 Td (Shadow title) Tj ET BT /F1 12 Tf 50 100 Td (other) Tj ET" }),
    );
    expect((await lines(e)).map((l) => l.text)).toEqual(["Shadow title", "other"]);
    const { stray, updated } = await change(e, "Shadow", "Shadow tale");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
    expect(extract(e)).not.toContain("title");
    expect(content(e).match(/Tm/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("geometry", () => {
  it("edits rotated and skewed text along its own baseline", async () => {
    const angle = (a: number, x: number, y: number) => {
      const r = (a * Math.PI) / 180;
      return `${[Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r)].map((v) => v.toFixed(6)).join(" ")} ${x} ${y} Tm`;
    };
    const e = await open(
      build({
        content: `BT /F1 14 Tf ${angle(90, 60, 60)} (Vertical label) Tj ET BT /F1 14 Tf ${angle(30, 150, 100)} (Slanted words) Tj ET BT /F1 14 Tf 1 0 0.3 1 150 50 Tm (Oblique text) Tj ET`,
      }),
    );
    expect((await line(e, "Oblique")).style.italic).toBe(true);
    for (const [find, text] of [["Vertical", "Vertical caption"], ["Slanted", "Slanted works"], ["Oblique", "Oblique test"]]) {
      const before = await line(e, find!);
      const { updated, stray } = await change(e, find!, text!);
      expect(updated, text).toBeDefined();
      expect(updated!.angle).toBeCloseTo(before.angle, 4);
      expect(updated!.origin[0]).toBeCloseTo(before.origin[0], 2);
      expect(updated!.origin[1]).toBeCloseTo(before.origin[1], 2);
      expect(stray).toBe(0);
    }
    savePng(e, "rotated");
  });

  for (const rotate of [90, 180, 270] as const) {
    it(`works on a page rotated by ${rotate}`, async () => {
      const e = await open(build({ rotate, content: "BT /F1 16 Tf 60 150 Td (Rotated page text) Tj ET BT /F1 10 Tf 60 100 Td (stays) Tj ET" }));
      const { updated, stray, target } = await change(e, "Rotated", "Rotated page works");
      expect(updated!.angle).toBeCloseTo(target.angle, 4);
      expect(stray).toBe(0);
      expect(extract(e)).toContain("Rotated page works");
    });
  }

  it("works under flipped and scaled coordinate systems", async () => {
    const e = await open(
      build({ content: "q 0.5 0 0 -0.5 0 300 cm BT /F1 32 Tf 1 0 0 -1 80 200 Tm (Flipped coordinates) Tj ET Q BT /F1 -14 Tf -1 0 0 -1 50 40 Tm (negative size) Tj ET" }),
    );
    const { updated, stray, target } = await change(e, "Flipped", "Flipped coordinate system");
    expect(target.style.size).toBeCloseTo(16, 3);
    expect(updated!.origin[0]).toBeCloseTo(40, 2);
    expect(stray).toBe(0);
    const second = await change(e, "negative", "negative sizes");
    expect(second.updated).toBeDefined();
    expect(second.stray).toBe(0);
  });

  it("widens a tight clip so longer text stays visible", async () => {
    const e = await open(build({ content: "q 48 195 62 20 re W n BT /F1 14 Tf 50 200 Td (Clipped) Tj ET Q BT /F1 10 Tf 50 100 Td (below) Tj ET" }));
    const { updated, stray, after } = await change(e, "Clipped", "Clipped but now longer");
    expect(updated!.text).toBe("Clipped but now longer");
    expect(stray).toBe(0);
    // ink exists near the right end of the new text
    const r = updated!.rect;
    const blank = { ...after, data: new Uint8ClampedArray(after.data.length).fill(255) };
    expect(diffAll(after, blank)).toBeGreaterThan(0);
    expect(diffOutside(after, blank, [[0, 0, r[2] - 30, 400]], 0)).toBeGreaterThan(20);
    savePng(e, "clip");
  });
});

describe("colour and graphics state", () => {
  it("reuses exotic colour spaces and restores them for the text that follows", async () => {
    const e = await open(
      build({
        resources: (doc, res) => {
          const fn = doc.newDictionary();
          fn.put("FunctionType", 2);
          fn.put("Domain", [0, 1]);
          fn.put("C0", [0, 0, 0, 0]);
          fn.put("C1", [0, 0.9, 0.8, 0]);
          fn.put("N", 1);
          const sep = doc.newArray();
          sep.push(doc.newName("Separation"));
          sep.push(doc.newName("Spot"));
          sep.push(doc.newName("DeviceCMYK"));
          sep.push(doc.addObject(fn));
          const spaces = doc.newDictionary();
          spaces.put("CS1", doc.addObject(sep));
          res.put("ColorSpace", spaces);
          const gs = doc.newDictionary();
          const half = doc.newDictionary();
          half.put("ca", 0.5);
          gs.put("H", half);
          res.put("ExtGState", gs);
        },
        content:
          "BT /F1 16 Tf /CS1 cs 1 scn 40 250 Td (Spot colour text) Tj 0 -30 Td (second spot line) Tj 0 0 0 1 k 0 -30 Td (cmyk black) Tj /H gs 0 -30 Td (half alpha) Tj ET",
      }),
    );
    const spot = await line(e, "Spot");
    expect(spot.style.color[0]).toBeGreaterThan(0.9);
    expect(spot.style.color[1]).toBeLessThan(0.2);
    const r = await change(e, "Spot colour", "Spot colour test");
    expect(r.stray).toBe(0);
    expect(r.updated!.style.color).toEqual(spot.style.color);
    const recolour = await change(e, "Spot colour test", "Spot colour test", { style: { color: [0, 0, 1] } });
    expect(recolour.stray).toBe(0);
    expect(recolour.updated!.style.color).toEqual([0, 0, 1]);
    expect((await line(e, "second spot")).style.color).toEqual(spot.style.color);
    const alpha = await change(e, "half alpha", "half alpha text");
    expect(alpha.stray).toBe(0);
  });
});

describe("form XObjects", () => {
  const shared = () => {
    const doc = new mupdf.PDFDocument();
    const font = standard("Helvetica")(doc);
    const fonts = doc.newDictionary();
    fonts.put("F1", font);
    const res = doc.newDictionary();
    res.put("Font", fonts);
    const form = (body: string, resources: mupdf.PDFObject) => {
      const d = doc.newDictionary();
      d.put("Type", doc.newName("XObject"));
      d.put("Subtype", doc.newName("Form"));
      d.put("BBox", [0, 0, 120, 40]);
      d.put("Resources", resources);
      return doc.addStream(body, d);
    };
    const inner = form("BT /F1 14 Tf 4 8 Td (Letterhead) Tj ET", res);
    const xo = doc.newDictionary();
    xo.put("In", inner);
    const outerRes = doc.newDictionary();
    outerRes.put("XObject", xo);
    const outer = form("q 1 0 0 1 0 0 cm /In Do Q", outerRes);
    for (let i = 0; i < 2; i++) {
      const x = doc.newDictionary();
      x.put("Fm", outer);
      const r = doc.newDictionary();
      r.put("XObject", x);
      r.put("Font", fonts);
      const page = doc.addPage([0, 0, 300, 300], 0, r, `q 1 0 0 1 40 240 cm /Fm Do Q q 1 0 0 1 40 100 cm /Fm Do Q BT /F1 10 Tf 40 50 Td (page ${i}) Tj ET`);
      doc.insertPage(-1, page);
    }
    return doc.saveToBuffer("").asUint8Array().slice();
  };

  it("copies shared forms on write, and extends their bounding box", async () => {
    const e = await open(shared());
    const all = (await lines(e)).filter((l) => l.text === "Letterhead");
    expect(all).toHaveLength(2);
    const otherPage = await render(e, 1);
    const before = await render(e, 0);
    const r = await e.editLines(0, [{ lineId: all[0]!.id, text: "Letterhead of another company" }]);
    expect(r.changedPages).toEqual([0]);
    expect(diffAll(otherPage, await render(e, 1))).toBe(0);
    const now = await lines(e);
    const edited = now.find((l) => l.text === "Letterhead of another company")!;
    expect(edited).toBeDefined();
    expect(now.filter((l) => l.text === "Letterhead")).toHaveLength(1);
    expect(diffOutside(before, await render(e, 0), [union(all[0]!.rect, edited.rect)])).toBe(0);
    expect((await lines(e, 1)).filter((l) => l.text === "Letterhead")).toHaveLength(2);
    savePng(e, "forms");
  });
});

describe("producer habits", () => {
  it("handles TeX style text: no space glyphs, ligature glyph names, kerning in TJ", async () => {
    const e = await open(
      build({
        fonts: {
          F1: (doc) => {
            const f = doc.newDictionary();
            f.put("Type", doc.newName("Font"));
            f.put("Subtype", doc.newName("Type1"));
            f.put("BaseFont", doc.newName("Times-Roman"));
            const enc = doc.newDictionary();
            const diff = doc.newArray();
            diff.push(12);
            diff.push(doc.newName("fi"));
            enc.put("Differences", diff);
            f.put("Encoding", enc);
            return doc.addObject(f);
          },
        },
        content: "BT /F1 12 Tf 40 200 Td [(The)-333(\\014rst)-333(T)80(heorem)-333(holds)] TJ 0 -16 Td [(next)-333(line)] TJ ET",
      }),
    );
    expect((await lines(e)).map((l) => l.text)).toEqual(["The first Theorem holds", "next line"]);
    const { updated, stray } = await change(e, "first", "The first great Theorem still holds");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("edits one cell of a table drawn with clipping per cell", async () => {
    const cell = (x: number, y: number, text: string) => `q ${x} ${y - 4} 90 18 re W* n BT /F1 11 Tf ${x + 2} ${y} Td /P <</MCID 0>> BDC (${text}) Tj EMC ET Q`;
    const rules = [38, 130, 222].map((x) => `${x} 176 0.5 44 re f`).join(" ");
    const e = await open(build({ content: [rules, cell(40, 200, "North"), cell(132, 200, "1,250"), cell(40, 182, "South"), cell(132, 182, "980")].join("\n") }));
    expect((await lines(e)).map((l) => l.text).sort()).toEqual(["1,250", "980", "North", "South"]);
    const { updated, stray } = await change(e, "South", "Southwest");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
  });

  it("applies several edits that share one operator", async () => {
    const e = await open(build({ content: "BT /F1 12 Tf 40 200 Td [(left side) -12000 (right side)] TJ 0 -20 Td (after) Tj ET" }));
    const [a, b, c] = await lines(e);
    await e.editLines(0, [
      { lineId: a!.id, text: "left hand" },
      { lineId: b!.id, text: "right hand side" },
    ]);
    const now = await lines(e);
    expect(now.map((l) => l.text)).toEqual(["left hand", "right hand side", "after"]);
    expect(now[1]!.origin[0]).toBeCloseTo(b!.origin[0], 2);
    expect(now[2]!.origin).toEqual(c!.origin);
  });

  it("keeps filled, stroked and invisible render modes", async () => {
    const e = await open(build({ content: "BT /F1 30 Tf 1 Tr 0 0.4 0 RG 0.7 w 40 200 Td (Outline text) Tj 0 Tr 0 -60 Td (solid) Tj ET" }));
    expect((await lines(e))[0]!.style.color).toEqual([0, 0.4, 0]);
    const { stray } = await change(e, "Outline", "Outline word");
    expect(stray).toBe(0);
  });
});

describe("bytes and writing modes", () => {
  it("keeps high bytes of literal strings intact when it splices around them", async () => {
    // 0x80 and 0x93 are the euro sign and a curly quote in WinAnsi, written as raw bytes
    const e = await open(
      build({ content: "BT /F1 16 Tf 40 200 Td <8031302093746F74616C94> Tj ( of fees) Tj 0 -40 Td (\\200 5 \\223net\\224) Tj ET" }),
    );
    const before = (await lines(e)).map((l) => l.text);
    expect(before[0]).toBe("€10 “total” of fees");
    const { updated, stray } = await change(e, "total", "€10 “total” of all fees");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
    expect((await lines(e))[1]!.text).toBe(before[1]);
  });

  it("edits vertical writing (Identity-V)", async () => {
    const e = await open(
      (() => {
        const doc = new mupdf.PDFDocument();
        const ref = doc.addCJKFont(new mupdf.Font("ja"), "ja", 1);
        const fonts = doc.newDictionary();
        fonts.put("F1", ref);
        const res = doc.newDictionary();
        res.put("Font", fonts);
        // UniJIS vertical CMap: codes are UCS-2
        doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, res, "BT /F1 20 Tf 200 260 Td <65e5672c8a9e306e6587> Tj ET BT /F1 20 Tf 100 260 Td <65875b57> Tj ET"));
        return doc.saveToBuffer("").asUint8Array().slice();
      })(),
    );
    const l = await line(e, "日本");
    expect(l.angle).toBeCloseTo(Math.PI / 2, 3);
    expect(l.text).toBe("日本語の文");
    const { updated, stray } = await change(e, "日本", "日本の文字書");
    savePng(e, "vertical");
    expect(updated).toBeDefined();
    expect(updated!.origin[0]).toBeCloseTo(l.origin[0], 2);
    expect(updated!.origin[1]).toBeCloseTo(l.origin[1], 2);
    expect(stray).toBe(0);
  });

  it("stays fast and exact when every glyph has its own operator", async () => {
    const rows: string[] = [];
    for (let r = 0; r < 150; r++)
      for (let c = 0; c < 120; c++) rows.push(`BT /F1 5 Tf 1 0 0 1 ${20 + c * 3.1} ${770 - r * 5} Tm (${"abcdefg"[(r + c) % 7]}) Tj ET`);
    const e = await open(build({ content: rows.join("\n"), size: [420, 800] }));
    let started = performance.now();
    const all = await lines(e);
    const analysis = performance.now() - started;
    expect(all).toHaveLength(150);
    started = performance.now();
    await e.editLines(0, [{ lineId: all[75]!.id, text: all[75]!.text.slice(0, 60) + "gggg" + all[75]!.text.slice(60) }]);
    const editing = performance.now() - started;
    console.log(`18000 operators: analysed in ${analysis.toFixed(0)} ms, edited in ${editing.toFixed(0)} ms`);
    expect(analysis).toBeLessThan(1500);
    expect(editing).toBeLessThan(1500);
    expect((await lines(e))[75]!.text).toContain("gggg");
  });
});

describe("embedded fonts", () => {
  const windows = "C:/Windows/Fonts/";
  const file = [windows + "arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find((f) => fs.existsSync(f));

  it.skipIf(!file)("types new characters with a CID TrueType font, learning unmapped glyphs from its program", async () => {
    const e = await open(
      (() => {
        const doc = new mupdf.PDFDocument();
        const font = new mupdf.Font("Emb", fs.readFileSync(file!));
        const ref = doc.addFont(font);
        const hex = [..."Embedded sample"].map((c) => font.encodeCharacter(c).toString(16).padStart(4, "0")).join("");
        const fonts = doc.newDictionary();
        fonts.put("F1", ref);
        const res = doc.newDictionary();
        res.put("Font", fonts);
        doc.insertPage(-1, doc.addPage([0, 0, 400, 200], 0, res, `BT /F1 20 Tf 40 100 Td <${hex}> Tj ET`));
        return doc.saveToBuffer("").asUint8Array().slice();
      })(),
    );
    const { updated, stray, target } = await change(e, "Embedded", "Embedded sample deep");
    expect(updated!.style).toEqual(target.style);
    expect(stray).toBe(0);
    expect(calls).toHaveLength(0);
    // MuPDF writes this font with the space glyph mapped to a no-break space
    expect(extract(await reopen(e)).replaceAll(String.fromCharCode(160), " ")).toContain("Embedded sample deep");
  });

  it("handles Unicode CMaps without embedded widths (CJK)", async () => {
    const e = await open(
      (() => {
        const doc = new mupdf.PDFDocument();
        const ref = doc.addCJKFont(new mupdf.Font("zh-Hans"), "zh-Hans");
        const fonts = doc.newDictionary();
        fonts.put("F1", ref);
        const res = doc.newDictionary();
        res.put("Font", fonts);
        doc.insertPage(-1, doc.addPage([0, 0, 400, 200], 0, res, `BT /F1 20 Tf 40 100 Td <4e2d658765876863> Tj 0 -40 Td <5185 5bb9> Tj ET`));
        return doc.saveToBuffer("").asUint8Array().slice();
      })(),
    );
    const { updated, stray } = await change(e, "\u4E2D\u6587", "\u4E2D\u6587\u6D4B\u8BD5\u6587\u6863");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("edits Type3 text with its own glyphs", async () => {
    const e = await open(
      (() => {
        const doc = new mupdf.PDFDocument();
        const procs = doc.newDictionary();
        const draw = (name: string, body: string) => procs.put(name, doc.addStream(`600 0 d0 ${body}`, doc.newDictionary()));
        draw("a", "50 0 500 500 re f");
        draw("b", "300 0 m 550 600 l 50 600 l f");
        draw("space", "");
        const enc = doc.newDictionary();
        enc.put("Differences", [32, doc.newName("space"), 97, doc.newName("a"), doc.newName("b")]);
        const f = doc.newDictionary();
        f.put("Type", doc.newName("Font"));
        f.put("Subtype", doc.newName("Type3"));
        f.put("FontBBox", [0, 0, 600, 700]);
        f.put("FontMatrix", [0.001, 0, 0, 0.001, 0, 0]);
        f.put("CharProcs", doc.addObject(procs));
        f.put("Encoding", doc.addObject(enc));
        f.put("FirstChar", 32);
        f.put("LastChar", 98);
        f.put("Widths", Array.from({ length: 67 }, () => 600));
        const fonts = doc.newDictionary();
        fonts.put("T3", doc.addObject(f));
        const res = doc.newDictionary();
        res.put("Font", fonts);
        doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, res, "BT /T3 30 Tf 20 100 Td (abab ab) Tj ET"));
        return doc.saveToBuffer("").asUint8Array().slice();
      })(),
    );
    const l = (await lines(e))[0]!;
    expect(l.text).toBe("abab ab");
    const { updated, stray } = await change(e, "abab", "abab bbaa");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("replaces stale ActualText", async () => {
    const e = await open(
      build({ content: "BT /F1 18 Tf 40 150 Td /Span <</ActualText (office) /MCID 3>> BDC (office) Tj EMC ( hours) Tj ET" }),
    );
    const { updated, stray } = await change(e, "office", "shop hours");
    expect(updated).toBeDefined();
    expect(stray).toBe(0);
    expect(content(e)).not.toContain("ActualText (office)");
    expect(content(e)).toContain("MCID 3");
    expect(extract(e)).toBe("shop hours");
  });
});
