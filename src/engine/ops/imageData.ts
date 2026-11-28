/**
 * Turning user supplied image files into PDF image XObjects. Camera (EXIF) orientation is applied to the
 * placement and then every piece of metadata is left behind: no GPS position, camera, date, comment,
 * thumbnail or appended file travels into the PDF.
 */
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

const startsWith = (data: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => data[at + i] === c.charCodeAt(0));

/**
 * A JPEG with only what is needed to show it: the picture data, its tables, the colour profile and the two
 * markers that say how to read the colours. Everything else (EXIF with GPS, XMP, IPTC, comments, maker
 * notes, embedded thumbnails, and whatever phones append after the end: videos, second pictures) is dropped.
 * Returns null when the data is not a JPEG that can be walked.
 */
export function stripJpeg(data: Uint8Array): Uint8Array | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [data.subarray(0, 2)];
  let at = 2;
  let scanned = false;
  let jfif = false;
  while (at < data.length) {
    if (data[at] !== 0xff) {
      // stray bytes between segments are skipped, as decoders do
      at++;
      continue;
    }
    const marker = data[at + 1];
    if (marker === undefined) break;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd9) break;
    // markers without a length
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (at + 4 > data.length) break;
    const length = (data[at + 2]! << 8) | data[at + 3]!;
    if (length < 2) break;
    let end = Math.min(data.length, at + 2 + length);
    const body = at + 4;
    if (marker === 0xda) {
      // the compressed data runs to the next marker that is not a restart or a stuffed byte
      while (end < data.length) {
        if (data[end] === 0xff) {
          const next = data[end + 1];
          if (next !== undefined && next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        end++;
      }
      parts.push(data.subarray(at, end));
      scanned = true;
    } else if (marker === 0xe0) {
      if (!jfif && startsWith(data, body, "JFIF\0") && length >= 16) {
        jfif = true;
        // the density stays, the thumbnail goes
        const header = data.slice(at, at + 18);
        header[2] = 0;
        header[3] = 16;
        header[16] = 0;
        header[17] = 0;
        parts.push(header);
      }
    } else if (marker === 0xe2) {
      if (startsWith(data, body, "ICC_PROFILE\0")) parts.push(data.subarray(at, end));
    } else if (marker === 0xee) {
      if (startsWith(data, body, "Adobe")) parts.push(data.subarray(at, at + Math.min(end - at, 16)));
    } else if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe || (marker >= 0xf0 && marker <= 0xfd))) {
      parts.push(data.subarray(at, end));
    }
    at = end;
  }
  if (!scanned) return null;
  parts.push(Uint8Array.of(0xff, 0xd9));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** the image to put into the file: built only from pixels, or from a JPEG stripped of everything personal */
function cleanImage(ctx: EngineContext, data: Uint8Array, image: MuPDF.Image): MuPDF.Image {
  const stripped = stripJpeg(data);
  if (stripped) return new ctx.mupdf.Image(stripped);
  // other formats are stored as pixels: nothing from the file (text chunks, EXIF boxes) can follow
  const pixmap = image.toPixmap();
  try {
    return new ctx.mupdf.Image(pixmap);
  } finally {
    pixmap.destroy();
  }
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
    if (!ref) {
      const clean = cleanImage(ctx, data, image);
      try {
        ref = ctx.doc.addImage(clean);
      } finally {
        clean.destroy();
      }
    }
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
