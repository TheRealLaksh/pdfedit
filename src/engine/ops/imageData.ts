/** Turning user supplied image files into PDF image XObjects, honouring camera (EXIF) orientation. */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import type { Matrix } from "../types";

export interface LoadedImage {
  ref: MuPDF.PDFObject;
  /** size as displayed (orientation applied) */
  width: number;
  height: number;
  dpi: number;
  /** maps the image's unit square onto the upright unit square */
  orient: Matrix;
}

/** EXIF orientation (1..8) -> matrix on the PDF unit square (v up) */
const ORIENTATIONS: Matrix[] = [
  [1, 0, 0, 1, 0, 0],
  [-1, 0, 0, 1, 1, 0],
  [-1, 0, 0, -1, 1, 1],
  [1, 0, 0, -1, 0, 1],
  [0, -1, -1, 0, 1, 1],
  [0, -1, 1, 0, 0, 1],
  [0, 1, 1, 0, 0, 0],
  [0, 1, -1, 0, 1, 0],
];

export function exifOrientation(data: Uint8Array): number {
  if (data[0] !== 0xff || data[1] !== 0xd8) return 1;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 2;
  while (at + 4 <= data.length && data[at] === 0xff) {
    const marker = data[at + 1]!;
    if (marker === 0xda) break;
    const size = view.getUint16(at + 2);
    // "Exif\0\0" followed by a TIFF header
    if (marker === 0xe1 && at + 18 <= data.length && view.getUint32(at + 4) === 0x45786966) {
      const tiff = at + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > data.length) return 1;
      const count = view.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > data.length) break;
        if (view.getUint16(entry, little) === 0x0112) {
          const value = view.getUint16(entry + 8, little);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    at += 2 + size;
  }
  return 1;
}

export function decodeImage(ctx: EngineContext, data: Uint8Array): MuPDF.Image {
  try {
    const image = new ctx.mupdf.Image(data);
    if (!(image.getWidth() > 0 && image.getHeight() > 0)) throw new Error("empty image");
    return image;
  } catch {
    throw new Error("This image format could not be read. Use a PNG or JPEG file.");
  }
}

/** embed the image (or reuse object number `existing` made from the same bytes) */
export function embedImage(ctx: EngineContext, data: Uint8Array, existing?: number): LoadedImage {
  const image = decodeImage(ctx, data);
  try {
    const orientation = exifOrientation(data);
    const turned = orientation >= 5;
    let ref: MuPDF.PDFObject | null = null;
    if (existing) {
      const candidate = ctx.doc.newIndirect(existing);
      const subtype = candidate.get("Subtype");
      if (subtype.isName() && subtype.asName() === "Image" && candidate.get("Width").asNumber() === image.getWidth())
        ref = candidate;
    }
    ref ??= ctx.doc.addImage(image);
    return {
      ref,
      width: turned ? image.getHeight() : image.getWidth(),
      height: turned ? image.getWidth() : image.getHeight(),
      dpi: image.getXResolution(),
      orient: ORIENTATIONS[orientation - 1]!,
    };
  } finally {
    image.destroy();
  }
}
