/** Pictures turned into PDF or added to one must not carry their metadata (GPS, camera, comments) along. */
import { deflateSync } from "node:zlib";
import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { Engine } from "../../src/engine/engine";
import { stripJpeg } from "../../src/engine/ops/imageData";
import { open, makePdf, pngBytes, savePng } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const segment = (marker: number, body: Uint8Array) =>
  join(Uint8Array.of(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255), body);

/** an EXIF block with an orientation and strings standing for GPS position and camera data */
function exif(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  const v = new DataView(tiff.buffer);
  v.setUint16(0, 0x4d4d);
  v.setUint16(2, 42);
  v.setUint32(4, 8);
  v.setUint16(8, 1);
  v.setUint16(10, 0x0112);
  v.setUint16(12, 3);
  v.setUint32(14, 1);
  v.setUint16(18, orientation);
  return segment(0xe1, join(ascii("Exif\0\0"), tiff, ascii("SECRET-GPS-18.5204N SECRET-CAMERA-SERIAL")));
}

const SECRET = /SECRET/;

/** left half green, right half blue */
function jpeg(orientation = 6): Uint8Array {
  const image = new mupdf.Image(pngBytes(64, 32, (x) => (x < 32 ? [0, 200, 0] : [0, 0, 200])));
  const plain = image.toPixmap().asJPEG(90, false).slice();
  return join(
    plain.subarray(0, 2),
    segment(0xe0, join(ascii("JFIF\0"), Uint8Array.of(1, 2, 1, 0, 72, 0, 72, 2, 1), ascii("THUMBS"))),
    exif(orientation),
    segment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>SECRET-XMP</x:xmpmeta>")),
    segment(0xe2, ascii("MPF\0SECRET-SECOND-PICTURE")),
    segment(0xed, ascii("Photoshop 3.0\0SECRET-IPTC")),
    segment(0xfe, ascii("SECRET-COMMENT")),
    plain.subarray(2),
    ascii("SECRET-MOTION-PHOTO-VIDEO"),
  );
}

function crc(data: Uint8Array): number {
  let c = ~0;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngWithText(): Uint8Array {
  const base = pngBytes(16, 16, () => [200, 0, 0]);
  const chunk = (type: string, body: Uint8Array) => {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, body.length);
    const data = join(ascii(type), body);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, crc(data));
    return join(head, data, tail);
  };
  // after the 8 byte signature and the 25 byte IHDR
  return join(
    base.subarray(0, 33),
    chunk("tEXt", ascii("Comment\0SECRET-PNG-TEXT")),
    chunk("zTXt", join(ascii("Author\0\0"), new Uint8Array(deflateSync("SECRET-PNG-ZTXT")))),
    chunk("eXIf", ascii("MM\0*SECRET-PNG-EXIF")),
    base.subarray(33),
  );
}

/** the file itself and every stream in it, decoded */
function everythingIn(bytes: Uint8Array): string {
  const doc = new mupdf.PDFDocument(bytes.slice());
  let all = Buffer.from(bytes).toString("latin1");
  for (let i = 1; i < doc.countObjects(); i++) {
    const object = doc.newIndirect(i);
    if (!object.isStream()) continue;
    all += Buffer.from(object.readRawStream().asUint8Array()).toString("latin1");
    try {
      all += Buffer.from(object.readStream().asUint8Array()).toString("latin1");
    } catch {
      /* picture codecs stay raw */
    }
  }
  doc.destroy();
  return all;
}

describe("stripJpeg", () => {
  it("keeps the picture and drops every kind of metadata and appended data", () => {
    const dirty = jpeg();
    const clean = stripJpeg(dirty)!;
    const text = Buffer.from(clean).toString("latin1");
    expect(text).not.toMatch(SECRET);
    expect(text).not.toContain("THUMBS");
    expect([...clean.subarray(-2)]).toEqual([0xff, 0xd9]);
    const before = new mupdf.Image(dirty).toPixmap().getPixels();
    const after = new mupdf.Image(clean).toPixmap().getPixels();
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
    // the density from the JFIF header survives
    expect(new mupdf.Image(clean).getXResolution()).toBe(72);
  });

  it("handles progressive style files and rubbish without failing", () => {
    expect(stripJpeg(Uint8Array.of(1, 2, 3))).toBeNull();
    expect(stripJpeg(Uint8Array.of(0xff, 0xd8, 0xff))).toBeNull();
    for (let cut = 4; cut < 300; cut += 7) expect(() => stripJpeg(jpeg().subarray(0, cut))).not.toThrow();
  });
});

describe("pictures in the PDF carry no metadata", () => {
  const check = async (engine: Engine) => {
    for (const compress of [false, true]) {
      const out = await engine.exportPdf({ compress });
      expect(everythingIn(out)).not.toMatch(SECRET);
    }
  };

  it("images to PDF, with the camera orientation applied", async () => {
    const engine = new Engine();
    const result = await engine.createFromImages([jpeg(6), pngWithText()], "photos.pdf");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const [first] = result.doc.pages;
    // turned a quarter: upright it is taller than wide, green above blue
    expect(first!.height).toBeGreaterThan(first!.width);
    const page = await engine.renderPage(0, 1);
    const at = (x: number, y: number) => [...page.data.subarray((y * page.width + x) * 4, (y * page.width + x) * 4 + 3)];
    expect(at(page.width >> 1, 20)[1]).toBeGreaterThan(150);
    expect(at(page.width >> 1, page.height - 20)[2]).toBeGreaterThan(150);
    savePng(engine.context.doc, 0, "privacy-upright");
    await check(engine);
  });

  it("opening a picture, adding one, replacing one and inserting pages", async () => {
    const opened = await open(jpeg(1));
    await check(opened);
    const engine = await open(makePdf());
    await engine.addObject({ kind: "image", page: 0, rect: [20, 20, 120, 120], data: jpeg(3) });
    await engine.addObject({ kind: "image", page: 0, rect: [20, 150, 120, 250], data: pngWithText() });
    await engine.insertImagesAsPages([jpeg(8)], 1);
    await engine.insertPdf(jpeg(2), 2);
    await check(engine);
    const [image] = await engine.listImages(1);
    await engine.replaceImage(1, image!.id, jpeg(5));
    await check(engine);
  });
});
