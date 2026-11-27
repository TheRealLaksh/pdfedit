import { describe, expect, it, vi } from "vitest";
import type { PageObject, TextStyle } from "../../src/engine/types";
import { everything, makePdf, open, pageText, pngBytes, shot, undoable } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

const style: TextStyle = { family: "Helvetica", bold: false, italic: false, serif: false, mono: false, size: 14, color: [0, 0, 0] };
const red: [number, number, number] = [1, 0, 0];

describe("added objects", () => {
  it("adds every kind, undoably, and draws them where asked", async () => {
    const engine = await open(makePdf());
    const add = (o: Parameters<typeof engine.addObject>[0]) => undoable(engine, () => engine.addObject(o));

    await add({ kind: "rect", page: 0, rect: [20, 100, 90, 150], fill: red, stroke: null });
    await add({ kind: "ellipse", page: 0, rect: [110, 100, 180, 150], stroke: [0, 0, 1], strokeWidth: 4 });
    await add({ kind: "highlight", page: 0, rect: [35, 40, 140, 62] });
    await add({ kind: "line", page: 0, rect: [0, 0, 0, 0], from: [20, 170], to: [180, 170], stroke: [0, 0.5, 0], strokeWidth: 3 });
    await add({ kind: "arrow", page: 0, rect: [0, 0, 0, 0], from: [20, 200], to: [180, 230], stroke: red, strokeWidth: 3 });
    await add({
      kind: "ink", page: 0, rect: [0, 0, 0, 0], stroke: [0, 0, 0], strokeWidth: 2,
      paths: [[[20, 260], [40, 240], [60, 275], [80, 245], [100, 265]], [[120, 255]]],
    });
    await add({
      kind: "image", page: 0, rect: [200, 100, 280, 140],
      data: pngBytes(20, 10, (x) => (x < 10 ? [0, 200, 200] : [200, 0, 200])),
    });
    await add({
      kind: "text", page: 0, rect: [20, 290, 160, 305], align: "left", style,
      text: "A long sentence that has to wrap onto several lines.\nSecond paragraph.",
    });
    await add({ kind: "rect", page: 0, rect: [200, 200, 280, 220], fill: [0, 0, 0], stroke: null, rotation: 45, opacity: 0.5 });
    await add({ kind: "whiteout", page: 0, rect: [200, 290, 280, 320] });

    const s = await shot(engine, 0, "objects-all");
    expect(s.at(55, 125)).toEqual([255, 0, 0]);
    expect(s.at(110, 125)[2]).toBeGreaterThan(200);
    expect(s.at(145, 125)).toEqual([255, 255, 255]); // unfilled ellipse
    const yellow = s.at(36, 41);
    expect(yellow[0]).toBeGreaterThan(240);
    expect(yellow[2]).toBeLessThan(90);
    // multiply: black page text stays black under the highlight
    let black = 0;
    for (let x = 40; x < 110; x++) for (let y = 45; y < 60; y++) if (s.at(x, y)[0]! < 60) black++;
    expect(black).toBeGreaterThan(40);
    expect(s.at(100, 170)[1]).toBeGreaterThan(100);
    expect(s.at(176, 229)[0]).toBeGreaterThan(200);
    expect(s.at(220, 120)[0]).toBeLessThan(40);
    expect(s.at(260, 120)[1]).toBeLessThan(40);
    // rotated 50% black square: grey at the centre, white at the corner of the unrotated rect
    expect(s.at(240, 210)[0]).toBeGreaterThan(110);
    expect(s.at(240, 210)[0]).toBeLessThan(145);
    expect(s.at(202, 202)).toEqual([255, 255, 255]);
    expect(pageText(engine)).toContain("Second paragraph.");
    const list = await engine.listObjects(0);
    expect(list.map((o) => o.kind)).toEqual(["rect", "ellipse", "highlight", "line", "arrow", "ink", "image", "text", "rect", "whiteout"]);
    const textObject = list.find((o) => o.kind === "text")!;
    expect(textObject.rect[3]).toBeGreaterThan(340); // grew to hold the wrapped lines
    // our own pictures are not offered as existing images
    expect(await engine.listImages(0)).toEqual([]);
  });

  it("updates in place keeping stacking order, and removes", async () => {
    const engine = await open(makePdf());
    const a = (await engine.addObject({ kind: "rect", page: 0, rect: [50, 50, 150, 150], fill: red, stroke: null })).createdId!;
    const b = (await engine.addObject({ kind: "rect", page: 0, rect: [100, 100, 200, 200], fill: [0, 0, 1], stroke: null })).createdId!;
    const objA = (await engine.listObjects(0))[0]!;
    await undoable(engine, () => engine.updateObject({ ...objA, rect: [80, 80, 180, 180], fill: [0, 1, 0] } as PageObject));
    let s = await shot(engine, 0);
    expect(s.at(90, 90)).toEqual([0, 255, 0]);
    expect(s.at(120, 120), "b stays above a").toEqual([0, 0, 255]);
    expect(s.at(60, 60)).toEqual([255, 255, 255]);
    expect((await engine.listObjects(0)).map((o) => o.id)).toEqual([a, b]);
    await undoable(engine, () => engine.removeObject(b));
    s = await shot(engine, 0);
    expect(s.at(120, 120)).toEqual([0, 255, 0]);
    expect(await engine.listObjects(0)).toHaveLength(1);
    await engine.removeObject(a);
    expect((await shot(engine, 0)).ink([40, 80, 220, 220])).toBe(0);
    await expect(engine.removeObject(a)).rejects.toThrow();
    // nothing of the removed objects is left in the exported file
    const out = everything(await engine.exportPdf());
    expect(out).not.toContain("PEObj");
    expect(out).not.toContain("0 1 0 rg");
  });

  it("does not nest graphics state deeper with every object", async () => {
    const engine = await open(makePdf([{ content: "0.5 0 0 0.5 0 0 cm 1 0 0 rg 0 0 10 10 re f q" }]));
    for (let i = 0; i < 40; i++)
      await engine.addObject({ kind: "rect", page: 0, rect: [i * 5, 100, i * 5 + 4, 110], fill: [0, 0, 0], stroke: null });
    const p = engine.context.doc.loadPage(0);
    const content = p.getObject().get("Contents").readStream().asString();
    let depth = 0;
    let max = 0;
    for (const token of content.split(/\s+/)) {
      if (token === "q") max = Math.max(max, ++depth);
      if (token === "Q") depth--;
    }
    expect(depth).toBe(0);
    expect(max).toBeLessThanOrEqual(4);
    expect((await shot(engine, 0)).at(197, 105)).toEqual([0, 0, 0]);
  });

  it("follows a moved or resized rect for lines and ink", async () => {
    const engine = await open(makePdf([{ content: "" }]));
    await engine.addObject({ kind: "ink", page: 0, rect: [0, 0, 0, 0], stroke: red, strokeWidth: 4, paths: [[[10, 10], [50, 50]]] });
    const ink = (await engine.listObjects(0))[0]!;
    await undoable(engine, () => engine.updateObject({ ...ink, rect: [100, 100, 180, 180] }));
    const moved = (await engine.listObjects(0))[0]!;
    expect(moved.kind === "ink" && moved.paths[0]).toEqual([[100, 100], [180, 180]]);
    expect((await shot(engine, 0)).at(140, 140)).toEqual([255, 0, 0]);
  });

  it.each([0, 90, 180, 270] as const)("draws in displayed coordinates on a page rotated %i with a crop box", async (rotate) => {
    const engine = await open(makePdf([{ rotate, crop: [20, 30, 280, 370], content: "" }]));
    await engine.addObject({ kind: "rect", page: 0, rect: [10, 20, 60, 50], fill: red, stroke: null });
    await engine.addObject({ kind: "text", page: 0, rect: [10, 70, 200, 100], align: "left", style, text: `Rotation ${rotate}` });
    const s = await shot(engine, 0, `objects-rot${rotate}`);
    expect(s.at(12, 22)).toEqual([255, 0, 0]);
    expect(s.at(58, 48)).toEqual([255, 0, 0]);
    expect(s.at(64, 54)).toEqual([255, 255, 255]);
    expect(s.ink([10, 70, 80, 88])).toBeGreaterThan(0.05);
    const stext = engine.context.doc.loadPage(0).toStructuredText("preserve-whitespace");
    const lines = JSON.parse(stext.asJSON()).blocks.flatMap((b: any) => b.lines);
    expect(lines[0].bbox.w).toBeGreaterThan(lines[0].bbox.h * 2); // upright on screen
    expect(lines[0].bbox.x).toBeCloseTo(10, -1);
  });

  it("moves an object to another page", async () => {
    const engine = await open(makePdf([{ content: "" }, { content: "" }]));
    await engine.addObject({ kind: "rect", page: 0, rect: [10, 10, 60, 60], fill: red, stroke: null });
    const o = (await engine.listObjects(0))[0]!;
    const r = await undoable(engine, () => engine.updateObject({ ...o, page: 1 }));
    expect(r.changedPages).toEqual([0, 1]);
    expect((await shot(engine, 0)).at(30, 30)).toEqual([255, 255, 255]);
    expect((await shot(engine, 1)).at(30, 30)).toEqual([255, 0, 0]);
  });

  it("aligns and justifies wrapped text", async () => {
    const engine = await open(makePdf([{ content: "" }]));
    const text = "one two three four five six seven eight nine ten eleven twelve thirteen";
    let y = 20;
    for (const align of ["left", "center", "right", "justify"] as const) {
      await engine.addObject({ kind: "text", page: 0, rect: [50, y, 250, y + 80], align, style, text });
      y += 90;
    }
    const s = await shot(engine, 0, "objects-align");
    expect(s.ink([253, 0, 300, 400])).toBe(0);
    expect(s.ink([0, 0, 47, 400])).toBe(0);
    // the first justified line reaches the right edge
    expect(s.ink([240, 290, 251, 308])).toBeGreaterThan(0);
  });

  it("keeps a rotated text box's top left corner when it grows", async () => {
    const engine = await open(makePdf([{ content: "" }]));
    await engine.addObject({ kind: "text", page: 0, rect: [100, 100, 200, 115], rotation: 90, align: "left", style, text: "a\nb\nc\nd" });
    const o = (await engine.listObjects(0))[0]!;
    const [x0, y0, x1, y1] = o.rect;
    const centre = [(x0 + x1) / 2, (y0 + y1) / 2];
    // top left of the unrotated box, rotated a quarter turn clockwise
    expect(centre[0]! + (y1 - y0) / 2).toBeCloseTo(150 + 7.5, 3);
    expect(centre[1]! - (x1 - x0) / 2).toBeCloseTo(107.5 - 50, 3);
  });
});
