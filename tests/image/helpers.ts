/** Node helpers of the image editor tests: pictures in and out through MuPDF. */
import * as mupdf from "mupdf";
import type { Patch, Picture, Quad4 } from "../../src/image/types";

export function decode(bytes: Uint8Array): Picture {
  const image = new mupdf.Image(bytes);
  let pixmap = image.toPixmap();
  pixmap = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const n = pixmap.getNumberOfComponents();
  const stride = pixmap.getStride();
  const source = pixmap.getPixels();
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * n;
      const to = (y * width + x) * 4;
      data[to] = source[from]!;
      data[to + 1] = source[from + 1]!;
      data[to + 2] = source[from + 2]!;
      data[to + 3] = n === 4 ? source[from + 3]! : 255;
    }
  return { width, height, data };
}

export function png(picture: Picture): Uint8Array {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, picture.width, picture.height], false);
  const target = pixmap.getPixels();
  const stride = pixmap.getStride();
  for (let y = 0; y < picture.height; y++)
    for (let x = 0; x < picture.width; x++) {
      const from = (y * picture.width + x) * 4;
      const to = y * stride + x * 3;
      target[to] = picture.data[from]!;
      target[to + 1] = picture.data[from + 1]!;
      target[to + 2] = picture.data[from + 2]!;
    }
  return pixmap.asPNG().slice();
}

export const copy = (p: Picture): Picture => ({ width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) });

export function apply(picture: Picture, patch: Patch | null): Picture {
  const out = copy(picture);
  if (!patch) return out;
  for (let y = 0; y < patch.height; y++)
    for (let x = 0; x < patch.width; x++) {
      const j = y * patch.width + x;
      if (!patch.mask[j]) continue;
      const at = ((y + patch.y) * picture.width + x + patch.x) * 4;
      for (let c = 0; c < 4; c++) out.data[at + c] = patch.data[j * 4 + c]!;
    }
  return out;
}

export function crop(picture: Picture, x0: number, y0: number, x1: number, y1: number, zoom = 1): Picture {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(picture.width, Math.ceil(x1));
  y1 = Math.min(picture.height, Math.ceil(y1));
  const width = Math.round((x1 - x0) * zoom);
  const height = Math.round((y1 - y0) * zoom);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.min(x1 - 1, x0 + Math.floor(x / zoom));
      const sy = Math.min(y1 - 1, y0 + Math.floor(y / zoom));
      const from = (sy * picture.width + sx) * 4;
      data.set(picture.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  return { width, height, data };
}

/** several pictures under one another on a magenta ground, so that their edges show */
export function sheet(parts: Picture[], gap = 6): Picture {
  const width = Math.max(...parts.map((p) => p.width));
  const height = parts.reduce((s, p) => s + p.height + gap, 0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 255, 255], i);
  let top = 0;
  for (const p of parts) {
    for (let y = 0; y < p.height; y++) data.set(p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4), (top + y) * width * 4);
    top += p.height + gap;
  }
  return { width, height, data };
}

export const bounds = (q: Quad4) => [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))] as const;
