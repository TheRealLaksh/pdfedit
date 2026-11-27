/** Added objects, existing images, redaction, watermark and page numbers. */
import { describe, expect, it } from "vitest";
import { rectFromPoints } from "../../src/engine/geom";
import type { NewPageObject, Point, Rect, TextStyle } from "../../src/engine/types";
import {
  assetBytes, bestLine, diffPixels, doc, findLine, mupdfDocument, mupdfText, normalise, openBytes, openDoc, overlap,
  pad, pixelAt, render, savePng,
} from "./helpers";

const style: TextStyle = { family: "Noto Sans", bold: false, italic: false, serif: false, mono: false, size: 16, color: [0.1, 0.1, 0.6] };
const BLUE: [number, number, number] = [0.1, 0.2, 0.8];

/** one of each kind inside a 150 x 70 box at (x, y) */
function samples(page: number, x: number, y: number): [string, NewPageObject, number][] {
  const rect: Rect = [x, y, x + 150, y + 70];
  return [
    ["text", { kind: "text", page, rect, text: "Added note\nदूसरी पंक्ति here", style, align: "left" }, 4],
    ["image", { kind: "image", page, rect, data: assetBytes("photo.png") }, 2],
    ["rect", { kind: "rect", page, rect, fill: [0.9, 0.8, 0.2], stroke: BLUE, strokeWidth: 2 }, 3],
    ["ellipse", { kind: "ellipse", page, rect, fill: null, stroke: BLUE, strokeWidth: 3 }, 4],
    ["highlight", { kind: "highlight", page, rect, fill: [1, 0.9, 0.1] }, 2],
    ["whiteout", { kind: "whiteout", page, rect, fill: [0.2, 0.2, 0.2] }, 2],
    ["line", { kind: "line", page, rect, from: [x, y], to: [x + 150, y + 70], stroke: BLUE, strokeWidth: 2 }, 5],
    ["arrow", { kind: "arrow", page, rect, from: [x, y + 35], to: [x + 150, y + 35], stroke: BLUE, strokeWidth: 3 }, 12],
    ["ink", { kind: "ink", page, rect, paths: [[[x + 5, y + 5], [x + 60, y + 60], [x + 100, y + 20], [x + 145, y + 55]]], stroke: BLUE, strokeWidth: 3 }, 6],
  ];
}

const targets: [string, number, number, number][] = [
  ["en-standard14", 0, 100, 420],
  ["rotated-pages", 1, 120, 250],
  ["rotated-pages", 2, 120, 250],
  ["rotated-pages", 3, 120, 250],
  ["offset-cropbox", 0, 120, 250],
  ["offset-cropbox", 1, 120, 200],
];

describe.each(targets)("added objects on %s page %i", (id, page, x, y) => {
  it.each(samples(page, x, y).map((s) => [s[0], s] as const))("%s: lands in the requested place, updates and removes cleanly", async (kind, [, object, slack]) => {
    const { engine, info } = await openDoc(id);
    const clean = await render(engine, page);
    const added = await engine.addObject(object);
    expect(added.createdId).toBeTruthy();
    expect(added.changedPages).toEqual([page]);
    const list = await engine.listObjects(page);
    expect(list.map((o) => o.id)).toEqual([added.createdId]);
    expect(list[0]!.kind).toBe(kind);
    // for lines, arrows and ink the stored box may be the box of the points themselves
    const points: Point[] =
      object.kind === "line" || object.kind === "arrow" ? [object.from, object.to] : object.kind === "ink" ? object.paths.flat() : [];
    const own = points.length ? rectFromPoints(points) : object.rect;
    for (let i = 0; i < 4; i++) {
      const value = list[0]!.rect[i]!;
      expect(Math.min(Math.abs(value - object.rect[i]!), Math.abs(value - own[i]!)), `rect ${list[0]!.rect}`).toBeLessThan(1);
    }

    const drawn = await render(engine, page);
    const where = diffPixels(clean, drawn, [pad(object.rect, slack)]);
    if (where.stray) savePng(`object-${id}-p${page}-${kind}`, drawn, [object.rect]);
    expect(where.changed, "something was drawn").toBeGreaterThan(60);
    expect(where.stray, `drawn at ${where.bounds?.map(Math.round)}, asked for ${object.rect}`).toBe(0);
    if (kind === "image" || kind === "whiteout" || kind === "rect" || kind === "highlight")
      expect(overlap(where.bounds!, object.rect)).toBeGreaterThan(0.95);

    // move it
    const moved = structuredClone(list[0]!);
    const lower = moved.rect[3] + 120 < info.pages[page]!.height - 5;
    const [dx, dy] = [40, lower ? 120 : -140];
    moved.rect = [moved.rect[0] + dx, moved.rect[1] + dy, moved.rect[2] + dx, moved.rect[3] + dy];
    if (moved.kind === "line" || moved.kind === "arrow") {
      moved.from = [moved.from[0] + dx, moved.from[1] + dy];
      moved.to = [moved.to[0] + dx, moved.to[1] + dy];
    }
    if (moved.kind === "ink") moved.paths = moved.paths.map((p) => p.map(([a, b]) => [a + dx, b + dy] as [number, number]));
    await engine.updateObject(moved);
    expect((await engine.listObjects(page)).length).toBe(1);
    const shifted = diffPixels(clean, await render(engine, page), [pad(moved.rect, slack)]);
    expect(shifted.changed).toBeGreaterThan(60);
    expect(shifted.stray, "nothing is left behind at the old place").toBe(0);

    // it survives export, and removing it restores the page exactly
    const reopened = await openBytes(await engine.exportPdf(), "objects.pdf");
    expect(diffPixels(await render(engine, page), await render(reopened.engine, page)).changed).toBe(0);
    await engine.removeObject(added.createdId!);
    expect(await engine.listObjects(page)).toEqual([]);
    expect(diffPixels(clean, await render(engine, page), [], 2, 2).changed).toBe(0);
    await engine.undo();
    expect((await engine.listObjects(page)).length).toBe(1);
  });
});

describe("object behaviour", () => {
  it("keeps stacking order when an object in the middle changes", async () => {
    const { engine } = await openDoc("en-standard14");
    const box: Rect = [100, 420, 200, 480];
    const colours: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (const fill of colours) await engine.addObject({ kind: "rect", page: 0, rect: box, fill, stroke: null });
    const [, middle] = await engine.listObjects(0);
    expect(pixelAt(await render(engine, 0), 150, 450)).toEqual([0, 0, 255]);
    await engine.updateObject({ ...middle!, rect: [101, 421, 201, 481] });
    expect(pixelAt(await render(engine, 0), 150, 450), "the top object stays on top").toEqual([0, 0, 255]);
    expect((await engine.listObjects(0)).map((o) => (o as { fill: number[] }).fill)).toEqual(colours);
  });

  it("applies rotation and opacity", async () => {
    const { engine } = await openDoc("en-standard14");
    await engine.addObject({ kind: "rect", page: 0, rect: [100, 450, 300, 470], fill: [0, 0, 0], stroke: null, rotation: 90, opacity: 0.5 });
    const picture = await render(engine, 0);
    const [r] = pixelAt(picture, 200, 380); // inside the rotated bar only
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(160);
    expect(pixelAt(picture, 110, 460)).toEqual([255, 255, 255]);
  });

  it("makes added text searchable in any script", async () => {
    const { engine } = await openDoc("empty-page");
    const lines = ["पुस्तकालय की सूचना", "الاجتماع القادم", "公共图书馆", "שלום לכולם", "ประกาศห้องสมุด"];
    for (const [i, text] of lines.entries())
      await engine.addObject({ kind: "text", page: 0, rect: [40, 60 + i * 60, 380, 100 + i * 60], text, style, align: "left" });
    const reopened = await openBytes(await engine.exportPdf({ compress: true }), "added.pdf");
    const page = await reopened.engine.getPageText(0);
    for (const text of lines) expect(bestLine(page.lines, text).similarity, `${text} -> ${bestLine(page.lines, text).line?.text}`).toBeGreaterThan(0.99);
  });

  it("wraps long text inside the box", async () => {
    const { engine } = await openDoc("empty-page");
    const rect: Rect = [40, 60, 200, 260];
    await engine.addObject({ kind: "text", page: 0, rect, text: "This sentence is much wider than its box and has to wrap over several lines.", style, align: "left" });
    const page = await engine.getPageText(0);
    expect(page.lines.length).toBeGreaterThan(3);
    for (const line of page.lines) expect(line.rect[2]).toBeLessThanOrEqual(rect[2] + 1);
  });

  it("rejects unknown ids without changing anything", async () => {
    const { engine } = await openDoc("en-standard14");
    await expect(engine.removeObject("nothing")).rejects.toThrow();
    expect((await engine.undo()).canRedo).toBe(false);
  });
});

describe("existing images", () => {
  const entry = doc("images");
  const expected = entry.pages[0]!.images!;

  it("lists every placement with its position and pixel size", async () => {
    const { engine } = await openDoc("images");
    const images = await engine.listImages(0);
    expect(images.length).toBe(expected.length);
    for (const want of expected.filter((i) => i.rect)) {
      const match = images.find((i) => i.rect.every((v, k) => Math.abs(v - want.rect![k]!) < 1));
      expect(match, `image at ${want.rect}`).toBeTruthy();
      expect([match!.pixelWidth, match!.pixelHeight]).toEqual([want.pixelWidth, want.pixelHeight]);
    }
    expect(new Set(images.map((i) => i.id)).size).toBe(images.length);
  });

  const pick = async () => {
    const opened = await openDoc("images");
    const images = await opened.engine.listImages(0);
    const at = (rect: Rect) => images.find((i) => i.rect.every((v, k) => Math.abs(v - rect[k]!) < 1))!;
    return { ...opened, first: at(expected[0]!.rect!), clean: await render(opened.engine, 0) };
  };

  it("moves and resizes one placement only", async () => {
    const { engine, first, clean } = await pick();
    const rect: Rect = [150, 440, 240, 500];
    await engine.moveImage(0, first.id, rect);
    const picture = await render(engine, 0);
    expect(diffPixels(clean, picture, [pad(first.rect, 1), pad(rect, 1)]).stray).toBe(0);
    const images = await engine.listImages(0);
    expect(images.length).toBe(expected.length);
    expect(images.some((i) => i.rect.every((v, k) => Math.abs(v - rect[k]!) < 1))).toBe(true);
    await engine.undo();
    expect(diffPixels(clean, await render(engine, 0), [], 2, 2).changed).toBe(0);
  });

  it("deletes one placement and leaves the text and the other copies", async () => {
    const { engine, first, clean } = await pick();
    await engine.deleteImage(0, first.id);
    expect(diffPixels(clean, await render(engine, 0), [pad(first.rect, 1)]).stray).toBe(0);
    expect((await engine.listImages(0)).length).toBe(expected.length - 1);
    expect(normalise(mupdfText(await engine.exportPdf(), 0))).toContain("Caption for the two pictures above");
  });

  it("replaces the pixels of one placement in the same place", async () => {
    const { engine, first, clean } = await pick();
    await engine.replaceImage(0, first.id, assetBytes("photo.jpg"));
    const picture = await render(engine, 0);
    const difference = diffPixels(clean, picture, [pad(first.rect, 1)]);
    expect(difference.changed).toBeGreaterThan(500);
    expect(difference.stray).toBe(0);
    const images = await engine.listImages(0);
    expect(images.length).toBe(expected.length);
    expect(images.filter((i) => i.pixelWidth === 200 && i.pixelHeight === 140).length).toBe(1);
  });
});

describe("redaction", () => {
  const allBytes = (bytes: Uint8Array) => {
    const pdf = mupdfDocument(bytes);
    let out = "";
    for (let i = 1; i < pdf.countObjects(); i++) {
      try {
        const object = pdf.newIndirect(i);
        if (object.isStream()) out += object.readStream().asString() + "\n";
        out += object.resolve().toString(true, true) + "\n";
      } catch {
        /* free object */
      }
    }
    pdf.destroy();
    return out;
  };

  it.each([
    ["en-standard14", 2, "treasurer"],
    ["hi-chromium", 2, "सदस्यता"],
    ["positioning", 1, "shuffled"],
    ["type3-latin", 1, "streams"],
  ] as const)("%s: really removes the text", async (id, line, word) => {
    const entry = doc(id);
    const { engine } = await openDoc(id);
    const target = findLine(await engine.getPageText(0), entry.pages[0]!.lines[line]!);
    const before = await render(engine, 0);
    await engine.redactAreas(0, [pad(target.rect, 1)]);
    const exported = await engine.exportPdf();
    expect(mupdfText(exported, 0)).not.toContain(word);
    expect(allBytes(exported), "nothing recoverable in any object").not.toContain(word);
    const reopened = await openBytes(exported, "redacted.pdf");
    const text = await reopened.engine.getPageText(0);
    expect(text.lines.length).toBe(entry.pages[0]!.lines.length - 1);
    expect(diffPixels(before, await render(reopened.engine, 0), [pad(target.rect, 4)]).stray).toBe(0);
  });

  it("removes words from text shared through a form XObject on that page only", async () => {
    const entry = doc("xobject-shared");
    const { engine } = await openDoc(entry.id);
    const target = findLine(await engine.getPageText(0), entry.pages[0]!.lines[0]!);
    await engine.redactAreas(0, [pad(target.rect, 0.5)]);
    const exported = await engine.exportPdf();
    expect(mupdfText(exported, 0)).not.toContain("cooperative");
    expect(mupdfText(exported, 1)).toContain("cooperative");
  });

  it("removes image pixels under the rectangle", async () => {
    const { engine } = await openDoc("images");
    const rect = doc("images").pages[0]!.images![0]!.rect!;
    const [cx, cy] = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
    await engine.redactAreas(0, [[cx - 30, cy - 20, cx + 30, cy + 20]]);
    const exported = await engine.exportPdf({ compress: true });
    // take the cover away: look at the image data itself
    const pdf = mupdfDocument(exported);
    const colours = new Set<string>();
    pdf.loadPage(0).toStructuredText("preserve-images").walk({
      onImageBlock(bbox, _transform, image) {
        if (Math.abs(bbox[0] - rect[0]) > 2 || Math.abs(bbox[1] - rect[1]) > 2) return;
        const pixels = image.toPixmap();
        const x = Math.round(pixels.getWidth() / 2);
        const y = Math.round(pixels.getHeight() / 2);
        const offset = y * pixels.getStride() + x * pixels.getNumberOfComponents();
        colours.add(pixels.getPixels().slice(offset, offset + 3).join(","));
      },
    });
    for (const colour of colours) {
      const [r, g, b] = colour.split(",").map(Number) as [number, number, number];
      const uniform = (r < 8 && g < 8 && b < 8) || (r > 247 && g > 247 && b > 247);
      expect(uniform, `pixel in the middle of the redacted area is still ${colour}`).toBe(true);
    }
    // the other copy of the same picture keeps its pixels
    const clean = await render((await openDoc("images")).engine, 0);
    const after = await render((await openBytes(exported, "r.pdf")).engine, 0);
    expect(diffPixels(clean, after, [pad(rect, 1)]).stray).toBe(0);
  });
});

describe("stamps", () => {
  it("adds a watermark to the chosen pages and undoes it", async () => {
    const { engine } = await openDoc("multipage");
    const clean = await render(engine, 1);
    const untouched = await render(engine, 0);
    const result = await engine.addWatermark({ text: "DRAFT मसौदा", style: { ...style, size: 48 }, opacity: 0.2, angle: 45, pages: [1, 2] });
    expect(result.changedPages.sort()).toEqual([1, 2]);
    expect(diffPixels(clean, await render(engine, 1)).changed).toBeGreaterThan(500);
    expect(diffPixels(untouched, await render(engine, 0)).changed).toBe(0);
    expect(mupdfText(await engine.exportPdf(), 2)).toContain("DRAFT");
    await engine.undo();
    expect(diffPixels(clean, await render(engine, 1), [], 2, 2).changed).toBe(0);
  });

  it.each(["top-left", "top-right", "bottom-center"] as const)("numbers pages at %s, also on turned pages", async (position) => {
    const { engine } = await openDoc("rotated-pages");
    await engine.addPageNumbers({ format: "Folio {n} / {total}", position, style: { ...style, size: 11 }, margin: 20, startAt: 5 });
    const reopened = await openBytes(await engine.exportPdf(), "numbered.pdf");
    for (let i = 0; i < 4; i++) {
      const info = reopened.info.pages[i]!;
      const found = (await reopened.engine.getPageText(i)).lines.find((l) => normalise(l.text).startsWith("Folio"));
      expect(found, `page ${i}`).toBeTruthy();
      // {total} may be read as the page count or as the last number printed
      expect(normalise(found!.text)).toMatch(new RegExp(`^Folio ${5 + i} / (4|8)$`));
      expect(Math.abs(found!.angle)).toBeLessThan(0.02);
      const [x0, y0, x1, y1] = found!.rect;
      if (position.startsWith("top")) expect(y0).toBeLessThan(40);
      else expect(y1).toBeGreaterThan(info.height - 40);
      if (position.endsWith("left")) expect(x0).toBeCloseTo(20, -1);
      if (position.endsWith("right")) expect(x1).toBeGreaterThan(info.width - 30);
      if (position.endsWith("center")) expect((x0 + x1) / 2).toBeCloseTo(info.width / 2, -1);
    }
  });
});
