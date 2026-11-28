/**
 * Recognised boxes cover whole lines and digits read right. Real recognition (language data is downloaded
 * into .tmp/ocr/tessdata once) on a picture taken on an Android device and on pictures drawn by Chromium.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectText, lineLanguages } from "../../src/image/detect";
import { rectQuad } from "../../src/image/geometry";
import { grow } from "../../src/image/lines";
import type { Picture, Quad4, TextBox } from "../../src/image/types";
import { configureOcr, recognizePage, terminateOcr } from "../../src/ocr";
import { closeBrowser, launch, TESSDATA } from "../ocr/helpers";
import { bounds, decode } from "./helpers";

beforeAll(() => configureOcr({ cachePath: TESSDATA }));
afterAll(async () => {
  await terminateOcr();
  await closeBrowser();
});

const plain = (t: string) => t.normalize("NFC").replace(/\s+/g, " ").trim();
const read = async (picture: Picture, languages: string[] = []) => (await detectText(picture, recognizePage, { languages })).boxes;

describe("growing a box over its line", () => {
  /** black bars as letters on white */
  function bars(parts: [number, number, number, number][], width = 400, height = 100): Picture {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [x0, y0, x1, y1] of parts)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([20, 20, 20, 255], (y * width + x) * 4);
    return { width, height, data };
  }
  const letters = (from: number, count: number): [number, number, number, number][] =>
    Array.from({ length: count }, (_, i) => [from + i * 16, 40, from + i * 16 + 8, 60]);
  const box = rectQuad(19, 39, 93, 61);

  it("takes in the words that follow, but not another column", () => {
    const picture = bars([...letters(20, 5), ...letters(102, 2), ...letters(190, 3)]);
    const [x0, , x1] = bounds(grow(picture, [box], 0).quad);
    expect(x0).toBe(19);
    expect(x1).toBeGreaterThanOrEqual(126);
    expect(x1).toBeLessThan(135);
  });

  it("takes in what comes before as well", () => {
    const picture = bars(letters(20, 8));
    const [x0, , x1] = bounds(grow(picture, [rectQuad(68, 39, 141, 61)], 0).quad);
    expect(x0).toBeLessThanOrEqual(20);
    expect(x1).toBeLessThan(143);
  });

  it("stops at a rule between columns", () => {
    const picture = bars([...letters(20, 5), [98, 5, 100, 95], ...letters(104, 2)]);
    expect(grow(picture, [box], 0).quad).toEqual(box);
  });

  it("joins a box of the same line", () => {
    const picture = bars([...letters(20, 5), ...letters(102, 2)]);
    const quads: Quad4[] = [box, rectQuad(101, 39, 127, 61)];
    expect(grow(picture, quads, 0).absorbed).toEqual([1]);
  });

  it("reads Latin lines without the other scripts", () => {
    expect(lineLanguages("Gate 70 to", ["hin", "eng"])).toEqual(["eng"]);
    expect(lineLanguages("समय 10 से", ["hin", "eng"])).toEqual(["hin", "eng"]);
    expect(lineLanguages("2024", ["chi_sim"])).toEqual(["chi_sim"]);
  });
});

describe("a notice photographed on a device", () => {
  it("covers every line to its end and reads the digits", { timeout: 180_000 }, async () => {
    const picture = decode(readFileSync(fileURLToPath(new URL("fixtures/notice.png", import.meta.url))));
    const boxes = await read(picture);
    expect(boxes.map((b) => plain(b.text))).toEqual([
      "Corner Book Shop",
      "Opening hours 10 to 18",
      "Closed on public holidays",
      "Readings every Friday",
      "हर शनिवार को खुला",
    ]);
    const [, , right] = bounds(boxes[1]!.quad);
    // the "18" ends at 405
    expect(right).toBeGreaterThanOrEqual(403);
  });
});

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  font?: string;
  color?: string;
}

interface Scene {
  name: string;
  lines: Line[];
  background?: string;
  extra?: string;
  languages?: string[];
}

const column = (x: number, y: number, size: number, texts: string[], font?: string): Line[] =>
  texts.map((text, i) => ({ text, x, y: y + i * size * 2.1, size, font }));

const SCENES: Scene[] = [
  { name: "small", lines: column(30, 30, 15, ["Opening hours 10 to 18", "Please ring at gate 7", "Open all year since 1987", "Total due 1,250.00"]) },
  { name: "medium", lines: column(30, 30, 24, ["Opening hours 10 to 18", "Platform 4 departs 17:45", "Room 101", "Call 080 4718 2290"], "Verdana") },
  { name: "serif", lines: column(30, 30, 34, ["Opening hours 10 to 18", "Established in 1971", "Chapter 7 begins on page 117"], "Georgia") },
  { name: "mono", lines: column(30, 30, 26, ["Order 7781 total 10", "Seat 18 row 1"], "'Courier New'") },
  { name: "large", lines: column(30, 30, 64, ["Sale ends 31", "Floor 10 to 18"]) },
  {
    name: "table",
    lines: ["Item", "Notebook", "Pencil box", "Ruler"].flatMap((item, row) =>
      [item, ["Qty", "10", "7", "18"][row]!, ["Price", "170", "1,110", "71"][row]!].map((text, col) => ({
        text,
        x: [40, 260, 400][col]!,
        y: 40 + row * 55,
        size: 24,
      })),
    ),
    extra: [25, 80, 135, 190, 245].map((y) => `<div style="position:absolute;left:20px;top:${y}px;width:500px;height:1px;background:#999"></div>`).join("") +
      [20, 245, 385, 520].map((x) => `<div style="position:absolute;left:${x}px;top:25px;width:1px;height:221px;background:#999"></div>`).join(""),
  },
  {
    name: "dark",
    background: "#1f2f4d",
    lines: column(40, 40, 28, ["Doors open at 17", "Last entry 21:10"]).map((l) => ({ ...l, color: "#ffffff" })),
  },
  // two scripts on a page this short are not always recognised automatically
  {
    name: "hindi",
    languages: ["hin", "eng"],
    lines: column(30, 30, 30, ["हर शनिवार को खुला", "समय सुबह 10 से 18", "Opening hours 10 to 18"], "'Nirmala UI', Arial"),
  },
];

const WIDTH = 760;
const HEIGHT = 340;

/** the picture, and for every line the first and last column holding its ink */
async function draw(scene: Scene) {
  const page = await (await launch()).newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const ground = scene.background ?? "#f2eee4";
  await page.setContent(
    `<meta charset="utf-8"><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:${ground}">${scene.extra ?? ""}${scene.lines
      .map(
        (l) =>
          `<span style="position:absolute;white-space:nowrap;line-height:1.3;left:${l.x}px;top:${l.y}px;font-size:${l.size}px;font-family:${l.font ?? "Arial"};color:${l.color ?? "#222"}">${l.text}</span>`,
      )
      .join("")}`,
  );
  const picture = decode(await page.screenshot());
  const rects = await page.$$eval("span", (spans) => spans.map((s) => s.getBoundingClientRect().toJSON() as DOMRect));
  await page.close();
  const background = picture.data.slice(0, 3);
  const ink = rects.map((r) => {
    let from = Infinity;
    let to = -Infinity;
    for (let y = Math.ceil(r.top); y < Math.floor(r.bottom); y++)
      for (let x = Math.floor(r.left); x < Math.ceil(r.right); x++) {
        const at = (y * picture.width + x) * 4;
        if (Math.abs(picture.data[at]! - background[0]!) + Math.abs(picture.data[at + 1]! - background[1]!) < 120) continue;
        from = Math.min(from, x);
        to = Math.max(to, x + 1);
      }
    return { from, to, middle: (r.top + r.bottom) / 2 };
  });
  return { picture, ink };
}

const covering = (boxes: TextBox[], line: Line, middle: number) =>
  boxes.filter((b) => {
    const [x0, y0, x1, y1] = bounds(b.quad);
    return y0 < middle + line.size * 0.2 && y1 > middle - line.size * 0.2 && x1 > line.x + 2 && x0 < line.x + line.size;
  });

describe("drawn pictures", () => {
  it.each(SCENES)("$name: whole lines, nothing left over at the ends", { timeout: 180_000 }, async (scene) => {
    const { picture, ink } = await draw(scene);
    const boxes = await read(picture, scene.languages);
    const seen = boxes.map((b) => `${plain(b.text)} [${bounds(b.quad).map(Math.round).join()}]`).join(" | ");
    const wrong: string[] = [];
    for (const [i, line] of scene.lines.entries()) {
      const { from, to, middle } = ink[i]!;
      const [box, ...more] = covering(boxes, line, middle);
      if (!box || more.length) {
        wrong.push(`${line.text}: ${box ? "several boxes" : "no box"}`);
        continue;
      }
      const [x0, , x1] = bounds(box.quad);
      if (plain(box.text) !== plain(line.text)) wrong.push(`${line.text}: read "${box.text}"`);
      if (x0 > from + 2 || x1 < to - 2) wrong.push(`${line.text}: ink ${from}-${to}, box ${Math.round(x0)}-${Math.round(x1)}`);
      if (x0 < from - line.size * 0.6 || x1 > to + line.size * 0.6) wrong.push(`${line.text}: box too wide, ink ${from}-${to}, box ${Math.round(x0)}-${Math.round(x1)}`);
    }
    expect(wrong, seen).toEqual([]);
  });
});
