import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { exifOrientation } from "../../src/engine/ops/imageData";
import type { Engine } from "../../src/engine/engine";
import { everything, label, makePdf, open, pageText, pngBytes, shot, undoable } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

const solid = (r: number, g: number, b: number, w = 8, h = 8) => pngBytes(w, h, () => [r, g, b]);
/** left half one colour, right half another, top-left corner black */
const marked = () => pngBytes(40, 20, (x, y) => (x < 8 && y < 8 ? [0, 0, 0] : x < 20 ? [0, 200, 0] : [0, 0, 200]));

function fixture(content: string, build?: (doc: mupdf.PDFDocument, x: Record<string, mupdf.PDFObject>) => void, rotate: 0 | 90 = 0) {
  return makePdf([{ content, rotate }], (doc) => {
    const xobjects: Record<string, mupdf.PDFObject> = {
      Red: doc.addImage(new mupdf.Image(solid(255, 0, 0))),
      Blue: doc.addImage(new mupdf.Image(solid(0, 0, 255))),
    };
    build?.(doc, xobjects);
    const resources = doc.findPage(0).get("Resources");
    resources.put("XObject", xobjects);
  });
}

const draw = (name: string, x: number, y: number, w: number, h: number) => `q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q`;
const rects = async (engine: Engine) => (await engine.listImages(0)).map((i) => i.rect.map(Math.round));
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

describe("existing images", () => {
  it("lists, moves, resizes and deletes page images without touching the rest", async () => {
    const engine = await open(
      fixture(`${draw("Red", 20, 300, 60, 40)}\n${draw("Blue", 150, 300, 60, 40)}\n${label("keep me", 20, 40)}`),
    );
    expect(await rects(engine)).toEqual([[20, 60, 80, 100], [150, 60, 210, 100]]);
    expect((await engine.listImages(0))[0]).toMatchObject({ pixelWidth: 8, pixelHeight: 8 });

    await undoable(engine, () => engine.moveImage(0, "img-0", [100, 200, 220, 280]));
    expect(await rects(engine)).toEqual([[100, 200, 220, 280], [150, 60, 210, 100]]);
    let s = await shot(engine, 0);
    expect(s.at(30, 80)).toEqual(WHITE);
    expect(s.at(102, 202)).toEqual(RED);
    expect(s.at(218, 278)).toEqual(RED);
    expect(s.at(180, 80)).toEqual(BLUE);

    // repeated moves fold into one transform
    for (let i = 0; i < 5; i++) await engine.moveImage(0, "img-0", [10 + i, 200, 70 + i, 240]);
    const content = engine.context.doc.loadPage(0).getObject().get("Contents").readStream().asString();
    expect(content.match(/PEImg/g)).toHaveLength(1);
    expect(await rects(engine)).toEqual([[14, 200, 74, 240], [150, 60, 210, 100]]);

    await undoable(engine, () => engine.deleteImage(0, "img-0"));
    expect(await rects(engine)).toEqual([[150, 60, 210, 100]]);
    s = await shot(engine, 0);
    expect(s.at(40, 220)).toEqual(WHITE);
    expect(pageText(engine)).toBe("keep me");
    // the deleted picture is not in the exported file any more
    const out = new mupdf.PDFDocument(await engine.exportPdf());
    let images = 0;
    for (let i = 1; i < out.countObjects(); i++) {
      const o = out.newIndirect(i).resolve();
      if (o.isDictionary() && o.get("Subtype").isName() && o.get("Subtype").asName() === "Image") images++;
    }
    expect(images).toBe(1);
  });

  it("moves an image out of its clipping path and takes a crop along", async () => {
    const clipped = `q 20 280 200 80 re W n ${draw("Red", 20, 300, 60, 40)} 0 1 0 rg 190 350 20 10 re f Q`;
    // cropped: only the left half of the image shows
    const cropped = `q 20 150 30 40 re W n ${draw("Blue", 20, 150, 60, 40)} Q ${label("after", 20, 40)}`;
    const engine = await open(fixture(`${clipped}\n${cropped}`));
    expect(await rects(engine)).toEqual([[20, 60, 80, 100], [20, 210, 50, 250]]);
    await undoable(engine, () => engine.moveImage(0, "img-0", [200, 300, 260, 340]));
    await undoable(engine, () => engine.moveImage(0, "img-1", [100, 100, 160, 180]));
    const s = await shot(engine, 0, "images-clip");
    expect(s.at(202, 302)).toEqual(RED);
    expect(s.at(258, 338)).toEqual(RED);
    expect(s.at(102, 102)).toEqual(BLUE);
    expect(s.at(158, 178)).toEqual(BLUE);
    expect(s.at(162, 140)).toEqual(WHITE);
    // what followed inside the clip group is still drawn with its state
    expect(s.at(200, 45)).toEqual([0, 255, 0]);
    expect(await rects(engine)).toEqual([[200, 300, 260, 340], [100, 100, 160, 180]]);
    expect(pageText(engine)).toBe("after");
    // and again, from inside the new wrappers
    await undoable(engine, () => engine.moveImage(0, "img-1", [10, 330, 40, 390]));
    expect(await rects(engine)).toEqual([[200, 300, 260, 340], [10, 330, 40, 390]]);
  });

  it("escapes a clip set outside every q", async () => {
    const engine = await open(fixture(`0 200 300 200 re W n ${draw("Red", 20, 300, 60, 40)}`));
    await undoable(engine, () => engine.moveImage(0, "img-0", [100, 300, 160, 340]));
    expect((await shot(engine, 0)).at(130, 320)).toEqual(RED);
    expect(await rects(engine)).toEqual([[100, 300, 160, 340]]);
  });

  it("edits images inside shared forms by copying the form", async () => {
    const content = `q 1 0 0 1 0 0 cm /Fm Do Q q 1 0 0 1 0 -200 cm /Fm Do Q`;
    const engine = await open(
      fixture(content, (doc, x) => {
        x.Fm = doc.addStream(`${draw("Red", 20, 300, 60, 40)} 0 g 100 300 10 10 re f`, {
          Type: "XObject", Subtype: "Form", BBox: [0, 250, 150, 400],
          Resources: { XObject: { Red: x.Red } },
        });
      }),
    );
    expect(await rects(engine)).toEqual([[20, 60, 80, 100], [20, 260, 80, 300]]);
    // far outside the form's bounding box
    await undoable(engine, () => engine.moveImage(0, "img-1", [200, 20, 260, 60]));
    let s = await shot(engine, 0, "images-form");
    expect(s.at(30, 80), "the other instance is untouched").toEqual(RED);
    expect(s.at(30, 280)).toEqual(WHITE);
    expect(s.at(230, 40)).toEqual(RED);
    expect(s.at(105, 295)).toEqual([0, 0, 0]);
    await undoable(engine, () => engine.deleteImage(0, "img-0"));
    s = await shot(engine, 0);
    expect(s.at(30, 80)).toEqual(WHITE);
    expect(s.at(230, 40)).toEqual(RED);
  });

  it("handles inline images", async () => {
    const inline = "q 60 0 0 40 20 300 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID ff0000ff0000ff0000ff0000> EI Q";
    const engine = await open(fixture(`${inline} ${label("text", 20, 40)}`));
    expect(await rects(engine)).toEqual([[20, 60, 80, 100]]);
    await undoable(engine, () => engine.moveImage(0, "img-0", [100, 100, 160, 140]));
    expect((await shot(engine, 0)).at(130, 120)).toEqual(RED);
    await undoable(engine, () => engine.replaceImage(0, "img-0", solid(0, 0, 255)));
    expect((await shot(engine, 0)).at(130, 120)).toEqual(BLUE);
    await undoable(engine, () => engine.deleteImage(0, "img-0"));
    expect(await rects(engine)).toEqual([]);
    expect(pageText(engine)).toBe("text");
  });

  it("replaces an image keeping its place and the new picture's shape", async () => {
    const engine = await open(fixture(`${draw("Red", 20, 300, 80, 80)} ${draw("Red", 150, 100, 80, 40)}`, undefined, 90));
    const before = await rects(engine);
    await undoable(engine, () => engine.replaceImage(0, "img-1", marked()));
    const s = await shot(engine, 0, "images-replace");
    const [x0, y0, x1, y1] = before[1]!;
    // 90 degree page: the box is 40 wide and 80 tall on screen; a 2:1 picture is letterboxed and upright
    expect([x1! - x0!, y1! - y0!]).toEqual([40, 80]);
    const middle = (y0! + y1!) / 2;
    expect(s.at(x0! + 2, middle - 8)).toEqual([0, 0, 0]);
    expect(s.at(x0! + 2, middle + 8)).toEqual([0, 200, 0]);
    expect(s.at(x1! - 3, middle)).toEqual([0, 0, 200]);
    expect(s.at((x0! + x1!) / 2, y0! + 5)).toEqual(WHITE);
    expect(await engine.listImages(0)).toHaveLength(2);
    expect(s.at((before[0]![0]! + before[0]![2]!) / 2, (before[0]![1]! + before[0]![3]!) / 2)).toEqual(RED);
  });

  it("keeps the tilt of a rotated placement", async () => {
    const engine = await open(fixture("q 70.7 70.7 -70.7 70.7 150 150 cm /Red Do Q"));
    await undoable(engine, () => engine.replaceImage(0, "img-0", solid(0, 0, 255, 8, 8)));
    const s = await shot(engine, 0);
    // centre of the diamond blue, corner of its bounding box white
    expect(s.at(150, 400 - 220)).toEqual(BLUE);
    expect(s.at(85, 400 - 285)).toEqual(WHITE);
  });

  it("shows a replacement upright over a normally placed image", async () => {
    const engine = await open(fixture(draw("Red", 20, 200, 200, 100)));
    await engine.replaceImage(0, "img-0", marked());
    const s = await shot(engine, 0);
    expect(s.at(25, 105)).toEqual([0, 0, 0]);
    expect(s.at(25, 195)).toEqual([0, 200, 0]);
    expect(s.at(215, 105)).toEqual([0, 0, 200]);
  });

  it("honours the camera orientation of JPEG photos", async () => {
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
    pm.clear(255);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pm.getPixels().set([0, 0, 0], (y * 40 + x) * 3);
    const jpeg = pm.asJPEG(95, false).slice();
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const photo = Uint8Array.from([...jpeg.slice(0, 2), 0xff, 0xe1, 0, body.length + 2, ...body, ...jpeg.slice(2)]);
    expect(exifOrientation(photo)).toBe(6);
    expect(exifOrientation(jpeg)).toBe(1);

    const engine = await open(fixture(""));
    // a phone held upright: displayed 20 x 40, the stored top-left corner ends up top-right
    await engine.addObject({ kind: "image", page: 0, rect: [20, 20, 120, 220], data: photo });
    await engine.insertImagesAsPages([photo], 1);
    const s = await shot(engine, 0, "images-exif");
    expect(s.at(110, 30)[0]).toBeLessThan(40);
    expect(s.at(30, 30)[0]).toBeGreaterThan(215);
    const second = await shot(engine, 1);
    expect(second.width).toBe(421);
    expect(second.height).toBe(842);
    expect(second.at(second.width - 20, 20)[0]).toBeLessThan(40);
  });

  it("rejects unknown ids and bad data", async () => {
    const engine = await open(fixture(draw("Red", 20, 300, 60, 40)));
    await expect(engine.deleteImage(0, "img-7")).rejects.toThrow(/no longer/);
    await expect(engine.replaceImage(0, "img-0", new Uint8Array([1, 2, 3]))).rejects.toThrow(/PNG or JPEG/);
    expect((await shot(engine, 0)).at(30, 80)).toEqual(RED);
    expect(everything(await engine.exportPdf()).length).toBeGreaterThan(100);
  });
});
