/**
 * The whole chain on pictures whose truth is known: MuPDF draws the original and what the edited picture
 * should look like; the editor's result is compared with the latter pixel by pixel.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { project, homography, rectQuad, rotateQuad } from "../../src/image/geometry";
import { ImageSession } from "../../src/image/session";
import type { Picture, Quad4, RenderResult, TextBox } from "../../src/image/types";
import { createNodeAssets } from "../fonts/nodeAssets";
import { apply, crop, decode, png, sheet } from "./helpers";

const assets = createNodeAssets();
const out = fileURLToPath(new URL("../../.tmp/img/tests/", import.meta.url));
const W = 420;
const H = 200;

interface Line {
  x: number;
  y: number;
  size: number;
  font: "Helvetica" | "Times-Roman" | "Helvetica-Bold";
  text: string;
  color?: string;
  matrix?: string;
}

/** a page drawn at two pixels per point */
function draw(lines: Line[], background = "0.96 0.95 0.92 rg 0 0 420 200 re f"): Picture {
  const doc = new mupdf.PDFDocument();
  const fonts = doc.newDictionary();
  const names = [...new Set(lines.map((l) => l.font))];
  names.forEach((name, i) => {
    const font = doc.newDictionary();
    font.put("Type", doc.newName("Font"));
    font.put("Subtype", doc.newName("Type1"));
    font.put("BaseFont", doc.newName(name));
    font.put("Encoding", doc.newName("WinAnsiEncoding"));
    fonts.put(`F${i}`, doc.addObject(font));
  });
  const resources = doc.newDictionary();
  resources.put("Font", fonts);
  const content = lines
    .map((l) => `q ${l.matrix ?? ""} BT /F${names.indexOf(l.font)} ${l.size} Tf ${l.color ?? "0.12 0.12 0.14"} rg ${l.x} ${H - l.y} Td (${l.text}) Tj ET Q`)
    .join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, doc.addObject(resources), `${background}\n${content}`));
  const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
  return decode(pixmap.asPNG());
}

/** a recogniser's box: loosely around the line, in picture pixels */
const around = (l: Line, width: number): Quad4 => rectQuad((l.x - 2) * 2, (l.y - l.size * 0.85) * 2, (l.x + width) * 2, (l.y + l.size * 0.3) * 2);

/** mean absolute difference per channel inside a rectangle */
function error(a: Picture, b: Picture, [x0, y0, x1, y1]: [number, number, number, number]): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c]! - b.data[i + c]!);
      n += 3;
    }
  return sum / n;
}

function changedOutside(a: Picture, b: Picture, [x0, y0, x1, y1]: [number, number, number, number]): number {
  let n = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
    }
  return n;
}

function show(name: string, ...pictures: Picture[]) {
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}${name}.png`, png(sheet(pictures.map((p) => crop(p, 0, 0, p.width, p.height, 1)))));
}

const lines: Line[] = [
  { x: 30, y: 60, size: 24, font: "Helvetica", text: "Invoice number 4821" },
  { x: 30, y: 115, size: 22, font: "Times-Roman", text: "Delivered on 14 March" },
  { x: 30, y: 165, size: 20, font: "Helvetica-Bold", text: "Amount due 950.00" },
];

describe("editing a picture", () => {
  const picture = draw(lines);
  const session = new ImageSession(picture, assets);
  const box = (i: number): TextBox => ({ id: `b${i}`, source: "ocr", text: lines[i]!.text, quad: around(lines[i]!, [220, 205, 180][i]!) });

  it("recognises the family, weight, size and colour", { timeout: 120_000 }, async () => {
    const wanted = [["arimo", 400], ["tinos", 400], ["arimo", 700]] as const;
    for (let i = 0; i < 3; i++) {
      const a = await session.analyze(box(i));
      expect([a.style.font, a.style.weight]).toEqual(wanted[i]);
      expect(a.style.size).toBeGreaterThan(lines[i]!.size * 2 * 0.95);
      expect(a.style.size).toBeLessThan(lines[i]!.size * 2 * 1.05);
      for (const c of a.style.color) expect(Math.abs(c - 33)).toBeLessThan(16);
      expect(a.blank).toBe(false);
      expect(a.style.grain).toBe(0);
    }
  });

  it("asks for no change when nothing changed", async () => {
    expect((await session.render(box(0), {})).patch).toBeNull();
    expect((await session.render(box(0), { text: lines[0]!.text })).patch).toBeNull();
  });

  const edits = ["Invoice number 7390", "Delivered on 22 October", "Amount due 1,284.50"];
  it.each([0, 1, 2])("retypes line %i so that it looks like the real thing", { timeout: 120_000 }, async (i) => {
    const r = await session.render(box(i), { text: edits[i]! });
    const edited = apply(picture, r.patch);
    const truth = draw(lines.map((l, k) => (k === i ? { ...l, text: edits[i]! } : l)));
    const area: [number, number, number, number] = [30, (lines[i]!.y - 30) * 2, 600, (lines[i]!.y + 12) * 2];
    show(`line${i}`, crop(picture, ...area, 2), crop(edited, ...area, 2), crop(truth, ...area, 2));
    expect(changedOutside(picture, edited, area)).toBe(0);
    // far closer to the truly retyped page than the original is
    expect(error(edited, truth, area)).toBeLessThan(error(picture, truth, area) * 0.55);
    expect(error(edited, truth, area)).toBeLessThan(4.5);
    expect(r.missing).toEqual([]);
  });

  it("leaves unchanged letters exactly as they were", async () => {
    const r = await session.render(box(0), { text: "Invoice number 4825" });
    expect(r.kept).toBeGreaterThanOrEqual(14);
    // everything up to the changed figure is untouched
    expect(r.patch!.x).toBeGreaterThan(300);
    const redrawn = await session.render(box(0), { text: "Invoice number 4825", keep: false });
    expect(redrawn.kept).toBe(0);
    expect(redrawn.patch!.x).toBeLessThan(90);
  });

  it("moves the letters after a change without redrawing them", { timeout: 60_000 }, async () => {
    const r = await session.render(box(2), { text: "Amount owed 950.00" });
    expect(r.kept).toBeGreaterThanOrEqual(10);
    const truth = draw(lines.map((l, k) => (k === 2 ? { ...l, text: "Amount owed 950.00" } : l)));
    const edited = apply(picture, r.patch);
    show("moved", crop(edited, 30, 270, 600, 350, 2), crop(truth, 30, 270, 600, 350, 2));
    expect(error(edited, truth, [30, 270, 600, 350])).toBeLessThan(7);
  });

  it("removes text cleanly", async () => {
    const edited = apply(picture, (await session.render(box(1), { text: "" })).patch);
    const empty = draw(lines.filter((_, k) => k !== 1));
    const area: [number, number, number, number] = [30, 170, 500, 250];
    expect(error(edited, empty, area)).toBeLessThan(0.5);
  });

  it("follows style changes made by hand", async () => {
    const r: RenderResult = await session.render(box(0), { style: { color: [200, 30, 30] } });
    const p = r.patch!;
    let red = 0;
    for (let i = 0; i < p.mask.length; i++) if (p.mask[i] && p.data[i * 4]! > 150 && p.data[i * 4 + 1]! < 80) red++;
    expect(red).toBeGreaterThan(300);
  });
});

describe("harder pictures", () => {
  it("reads a tilted line on a gradient and retypes it along the same slope", { timeout: 120_000 }, async () => {
    // seven degrees, over a colour ramp made of narrow strips
    const ramp = Array.from({ length: 105 }, (_, i) => `${(0.15 + i / 300).toFixed(3)} 0.25 ${(0.55 - i / 400).toFixed(3)} rg ${i * 4} 0 4.2 200 re f`).join("\n");
    const angle = (7 * Math.PI) / 180;
    const line: Line = { x: 0, y: H, size: 26, font: "Helvetica-Bold", text: "Summer fair 2027", color: "1 0.95 0.8", matrix: `${Math.cos(angle)} ${-Math.sin(angle)} ${Math.sin(angle)} ${Math.cos(angle)} 70 100 cm` };
    const picture = draw([line], ramp);
    // the line starts at (70, 100) from the top and runs 7 degrees downwards
    const flat = rectQuad(138, 200 - 48, 140 + 430, 200 + 16);
    const quad = rotateQuad(flat, angle, [140, 200]);
    const session = new ImageSession(picture, assets);
    const box: TextBox = { id: "t", source: "manual", text: line.text, quad };
    const a = await session.analyze(box);
    expect(a.style.font).toMatch(/arimo|roboto|inter/);
    expect(a.style.color[0]).toBeGreaterThan(235);
    const edited = apply(picture, (await session.render(box, { text: "Winter fair 2028" })).patch);
    const truth = draw([{ ...line, text: "Winter fair 2028" }], ramp);
    show("tilted", picture, edited, truth);
    const area: [number, number, number, number] = [130, 140, 620, 300];
    expect(error(edited, truth, area)).toBeLessThan(error(picture, truth, area) * 0.45);
  });

  it("handles a line seen in perspective", { timeout: 120_000 }, async () => {
    const flat = draw([{ x: 20, y: 110, size: 30, font: "Helvetica", text: "Gate 4 entrance" }]);
    // the middle band of the flat picture, mapped onto a trapezium
    const source = rectQuad(20, 150, 480, 250);
    const target: Quad4 = [[60, 130], [700, 170], [690, 255], [55, 290]];
    const back = homography(460, 100, target);
    const data = new Uint8ClampedArray(760 * 400 * 4).fill(255);
    const forward = homography(460, 100, source);
    const { invert, sample } = { invert: (await import("../../src/image/geometry")).invert, sample: (await import("../../src/image/raster")).sample };
    const toFrame = invert(back);
    for (let y = 0; y < 400; y++)
      for (let x = 0; x < 760; x++) {
        const [u, v] = project(toFrame, x + 0.5, y + 0.5);
        const [sx, sy] = project(forward, Math.max(0, Math.min(460, u)), Math.max(0, Math.min(100, v)));
        for (let c = 0; c < 3; c++) data[(y * 760 + x) * 4 + c] = sample(flat.data, flat.width, flat.height, sx, sy, 4, c);
      }
    const picture: Picture = { width: 760, height: 400, data };
    const session = new ImageSession(picture, assets);
    const box: TextBox = { id: "p", source: "manual", text: "Gate 4 entrance", quad: target };
    expect((await session.analyze(box)).style.font).toMatch(/arimo|inter|roboto/);
    const r = await session.render(box, { text: "Gate 9 entrance" });
    expect(r.patch).not.toBeNull();
    expect(r.kept).toBeGreaterThan(8);
    show("perspective", picture, apply(picture, r.patch));
    // only the figure changes: the words before and after it are not touched
    expect(r.patch!.x).toBeGreaterThan(340);
    expect(r.patch!.x + r.patch!.width).toBeLessThan(460);
  });

  it("copes with a box that holds no text", async () => {
    const session = new ImageSession(draw([]), assets);
    const box: TextBox = { id: "n", source: "manual", text: "nothing", quad: rectQuad(100, 100, 300, 140) };
    expect((await session.analyze(box)).blank).toBe(true);
    const r = await session.render(box, { text: "hello" });
    expect(r.patch).not.toBeNull();
  });

  it("draws other scripts with their own fonts", { timeout: 120_000 }, async () => {
    const session = new ImageSession(draw([]), assets);
    const sample = await session.sample({ font: "mukta", weight: 700, italic: false }, "नमस्ते", 48);
    expect(sample.alpha.reduce((s, v) => s + (v > 128 ? 1 : 0), 0)).toBeGreaterThan(100);
  });
});
