/** Geometry, the rasteriser, background rebuilding, the export note and box handling. */
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { detectText, guessAlign, merge, pieces } from "../../src/image/detect";
import { rebuild } from "../../src/image/erase";
import { homography, insideQuad, invert, isUsableQuad, project, rectQuad, rotateQuad } from "../../src/image/geometry";
import { addNote, NOTE } from "../../src/image/metadata";
import { Coverage, embolden, flatten, parsePath } from "../../src/image/outline";
import type { Quad4, TextBox } from "../../src/image/types";
import type { OcrLine, Rect } from "../../src/engine/types";

describe("geometry", () => {
  const quad: Quad4 = [[10, 20], [210, 40], [190, 120], [20, 90]];
  it("maps the upright frame onto any quad and back", () => {
    const m = homography(200, 70, quad);
    const corners: [number, number][] = [[0, 0], [200, 0], [200, 70], [0, 70]];
    corners.forEach((c, i) => {
      const [x, y] = project(m, ...c);
      expect(x).toBeCloseTo(quad[i]![0], 6);
      expect(y).toBeCloseTo(quad[i]![1], 6);
      const back = project(invert(m), x, y);
      expect(back[0]).toBeCloseTo(c[0], 6);
      expect(back[1]).toBeCloseTo(c[1], 6);
    });
  });
  it("rejects quads that cannot hold text", () => {
    expect(isUsableQuad(quad)).toBe(true);
    expect(isUsableQuad([[0, 0], [100, 50], [100, 0], [0, 50]])).toBe(false);
    expect(isUsableQuad(rectQuad(0, 0, 2, 2))).toBe(false);
    expect(insideQuad(rotateQuad(rectQuad(0, 0, 100, 20), 0.1), [50, 10])).toBe(true);
  });
});

describe("rasteriser", () => {
  const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
  const square = [[[2.25, 3], [12.75, 3], [12.75, 8.5], [2.25, 8.5]] as [number, number][]];
  it("covers exactly the area of a polygon, also when it leaves the grid", () => {
    const inside = new Coverage(20, 12);
    inside.add(square);
    expect(sum(inside.finish())).toBeCloseTo(10.5 * 5.5, 3);
    const clipped = new Coverage(10, 12);
    clipped.add(square);
    expect(sum(clipped.finish())).toBeCloseTo((10 - 2.25) * 5.5, 3);
  });
  it("makes outlines heavier and lighter, holes included", () => {
    // a ring: outer clockwise, inner the other way round
    const ring = parsePath("M0,0L20,0L20,20L0,20ZM5,5L5,15L15,15L15,5Z");
    const contours = flatten(ring, (x, y) => [x + 5, y + 5]);
    const area = (by: number) => {
      const c = new Coverage(32, 32);
      c.add(embolden(contours, by));
      return sum(c.finish());
    };
    expect(area(0)).toBeCloseTo(300, 2);
    expect(area(1)).toBeCloseTo(22 * 22 - 8 * 8, 1);
    expect(area(-1)).toBeCloseTo(18 * 18 - 12 * 12, 1);
  });
});

describe("background", () => {
  const W = 120;
  const H = 40;
  const scene = (ground: (x: number, y: number) => number[]) => {
    const rgb = new Float32Array(W * H * 3);
    const hole = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const ink = x % 10 < 4 && y > 10 && y < 30;
        const c = ink ? [10, 10, 10] : ground(x, y);
        rgb.set(c, (y * W + x) * 3);
        if (ink) hole[y * W + x] = 1;
      }
    return { rgb, hole };
  };
  const worst = (out: Float32Array, hole: Uint8Array, ground: (x: number, y: number) => number[]) => {
    let w = 0;
    for (let i = 0; i < W * H; i++) {
      const truth = ground(i % W, Math.floor(i / W));
      for (let c = 0; c < 3; c++) {
        if (hole[i]) w = Math.max(w, Math.abs(out[i * 3 + c]! - truth[c]!));
      }
    }
    return w;
  };
  it("restores a gradient exactly", () => {
    const ground = (x: number, y: number) => [200 - x * 0.6, 120 + y, 90 + x * 0.4];
    const { rgb, hole } = scene(ground);
    const fill = rebuild(rgb, W, H, hole, new Uint8Array(W * H), [0, 0, 0]);
    expect(fill.method).toBe("surface");
    expect(worst(fill.rgb, hole, ground)).toBeLessThan(1.5);
    for (let i = 0; i < W * H; i++) if (!hole[i]) expect(fill.rgb[i * 3]).toBe(rgb[i * 3]);
  });
  it("carries stripes on through the removed letters", () => {
    const ground = (_x: number, y: number) => (Math.floor(y / 6) % 2 ? [180, 90, 60] : [225, 200, 170]);
    const { rgb, hole } = scene(ground);
    const fill = rebuild(rgb, W, H, hole, new Uint8Array(W * H), [0, 0, 0]);
    expect(fill.method).toBe("patches");
    let wrong = 0;
    let total = 0;
    for (let i = 0; i < W * H; i++) {
      if (!hole[i]) continue;
      total++;
      if (Math.abs(fill.rgb[i * 3]! - ground(i % W, Math.floor(i / W))[0]!) > 20) wrong++;
    }
    expect(wrong / total).toBeLessThan(0.06);
  });
});

describe("export note", () => {
  const pixmap = () => {
    const p = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 12, 9], false);
    p.clear(200);
    return p;
  };
  const latin = (b: Uint8Array) => Buffer.from(b).toString("latin1");
  const decodes = (b: Uint8Array) => {
    const image = new mupdf.Image(b);
    expect([image.getWidth(), image.getHeight()]).toEqual([12, 9]);
  };

  it("PNG: adds the note, drops other text and EXIF, keeps the picture", () => {
    const source = pixmap().asPNG().slice();
    // a foreign text chunk after the header, as a camera tool might write it
    const extra = Buffer.from("\0\0\0\x0czTXtAuthor\0secre\0\0\0\0", "latin1");
    const dirty = new Uint8Array([...source.subarray(0, 33), ...extra, ...source.subarray(33)]);
    const out = addNote(dirty, "image/png", 12, 9);
    expect(latin(out)).toContain(NOTE);
    expect(latin(out)).toContain("Software\0PDFEdit");
    expect(latin(out)).not.toContain("Author");
    decodes(out);
    expect(new mupdf.Image(out).toPixmap().getPixels()).toEqual(new mupdf.Image(source).toPixmap().getPixels());
  });

  it("JPEG: adds the note and removes EXIF, GPS and IPTC blocks", () => {
    const source = pixmap().asJPEG(90, false).slice();
    const segment = (marker: number, body: string) => [0xff, marker, 0, body.length + 2, ...Buffer.from(body, "latin1")];
    const dirty = new Uint8Array([0xff, 0xd8, ...segment(0xe1, "Exif\0\0GPSLatitude 28.6"), ...segment(0xed, "Photoshop 3.0 By-line"), ...source.subarray(2)]);
    const out = addNote(dirty, "image/jpeg", 12, 9);
    expect(latin(out)).toContain(NOTE);
    expect(latin(out)).not.toContain("Exif");
    expect(latin(out)).not.toContain("GPSLatitude");
    expect(latin(out)).not.toContain("By-line");
    decodes(out);
  });

  it("WebP: becomes an extended file with an XMP note and no EXIF", () => {
    // a 1 x 1 lossless picture
    const body = Buffer.from("WEBPVP8L\x0d\0\0\0\x2f\0\0\0\x10\x07\x10\x11\x11\x88\x88\xfe\x07\0EXIF\x04\0\0\0abcd", "latin1");
    const riff = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([body.length, 0, 0, 0]), body]);
    const out = addNote(new Uint8Array(riff), "image/webp", 1, 1);
    const s = latin(out);
    expect(s).toContain("VP8X");
    expect(s).toContain(NOTE);
    expect(s).not.toContain("EXIF");
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
    // the XMP flag is set
    expect(out[20]! & 0x04).toBe(0x04);
  });

  it("refuses bytes of another kind", () => {
    expect(() => addNote(new Uint8Array(40), "image/png", 1, 1)).toThrow();
  });
});

describe("recognised boxes", () => {
  const word = (text: string, rect: Rect) => ({ text, rect, confidence: 90 });
  const line: OcrLine = { text: "Total 1,200.00", rect: [10, 10, 400, 24], confidence: 90, words: [word("Total", [10, 10, 60, 24]), word("1,200.00", [320, 10, 400, 24])] };
  it("cuts a label from a value far to its right", () => {
    expect(pieces(line, 1, { width: 500, height: 200 }).map((p) => p.text)).toEqual(["Total", "1,200.00"]);
  });
  it("follows the slope of a tilted line", () => {
    const tilted: OcrLine = { ...line, words: [word("Total", [10, 10, 60, 30]), word("sum", [70, 14, 120, 34])], baseline: [[10, 24], [120, 32]] };
    const [found] = pieces(tilted, 1, { width: 500, height: 200 });
    expect(found!.quad[1][1]).toBeGreaterThan(found!.quad[0][1] + 5);
  });
  it("keeps the surer of two overlapping readings", () => {
    const a = { quad: rectQuad(0, 0, 100, 20), text: "l|ght", confidence: 40 };
    const b = { quad: rectQuad(2, 0, 100, 20), text: "light", confidence: 92 };
    expect(merge([a], [b]).map((f) => f.text)).toEqual(["light"]);
  });
  it("guesses which edge stays put", () => {
    const box = (id: string, x0: number, y: number, x1: number, text = "abc"): TextBox => ({ id, text, source: "ocr", quad: rectQuad(x0, y, x1, y + 20) });
    const figures = [box("a", 300, 0, 400, "1,200.00"), box("b", 330, 30, 400, "45.00")];
    expect(guessAlign(figures[0]!, figures, 800)).toBe("right");
    const left = [box("a", 40, 0, 200), box("b", 40, 30, 120)];
    expect(guessAlign(left[0]!, left, 800)).toBe("left");
    const middle = [box("a", 300, 0, 500), box("b", 340, 30, 460)];
    expect(guessAlign(middle[0]!, middle, 800)).toBe("center");
  });
  it("reads a second time where the picture is dark", async () => {
    const data = new Uint8ClampedArray(200 * 100 * 4).fill(20);
    let passes = 0;
    const found = await detectText({ width: 200, height: 100, data }, async () => ({ page: 0, languages: ["eng"], lines: ++passes ? [] : [] }), { languages: [] });
    expect(passes).toBe(2);
    expect(found.boxes).toEqual([]);
  });
});
