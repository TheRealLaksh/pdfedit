/**
 * "Make it under N KB": pictures are re-encoded smaller, one step at a time, until the file fits. Text,
 * drawings and fonts are never touched, and no page is turned into a picture.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { parseContent } from "../content/tokenizer";
import { IDENTITY, multiply } from "../geom";
import type { Matrix } from "../types";
import { inspectPage } from "./guard";
import { readPageContent, streamBytes } from "./shared";
import { formState, walk, xobjectOf, type GraphicsState } from "./walk";

export interface Step {
  /** most pixels per inch a picture keeps at the size it is shown */
  dpi: number;
  /** JPEG quality */
  quality: number;
}

/** gentlest first */
export const STEPS: Step[] = [
  { dpi: 220, quality: 82 },
  { dpi: 170, quality: 76 },
  { dpi: 150, quality: 65 },
  { dpi: 125, quality: 55 },
  { dpi: 100, quality: 48 },
  { dpi: 80, quality: 40 },
  { dpi: 60, quality: 32 },
  { dpi: 45, quality: 25 },
];

/** pictures smaller than this (bytes) are left alone: there is nothing to win */
const SMALL = 3000;
const MOST_PIXELS = 60_000_000;

export interface Shrunk {
  bytes: Uint8Array;
  reached: boolean;
  /** pictures that were re-encoded */
  images: number;
  /** the step used; absent when no picture was touched */
  step?: Step;
}

/**
 * `base` is the unencrypted export. `save` writes a document with the final settings (password and all).
 * The steps are searched by halving, so only about three of them are tried.
 */
export function shrinkToSize(
  ctx: EngineContext,
  base: Uint8Array,
  maxBytes: number,
  save: (doc: MuPDF.PDFDocument) => Uint8Array,
): Shrunk {
  const attempt = (step: Step | null): { bytes: Uint8Array; images: number } => {
    const doc = new ctx.mupdf.PDFDocument(base);
    try {
      dropExtras(doc);
      const images = step ? recompress(ctx, doc, step) : 0;
      return { bytes: save(doc), images };
    } finally {
      doc.destroy();
      ctx.mupdf.emptyStore();
    }
  };

  const plain = attempt(null);
  if (plain.bytes.length <= maxBytes) return { ...plain, reached: true };
  let smallest: Shrunk = { ...plain, reached: false };
  let fitting: Shrunk | null = null;
  let low = 0;
  let high = STEPS.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const step = STEPS[middle]!;
    const result = attempt(step);
    const entry: Shrunk = { ...result, reached: result.bytes.length <= maxBytes, step };
    if (result.bytes.length < smallest.bytes.length) smallest = { ...entry, reached: false };
    // nothing to re-encode at all: further steps cannot help
    if (!result.images && middle === STEPS.length - 1) break;
    if (entry.reached) {
      fitting = entry;
      high = middle - 1;
    } else low = middle + 1;
  }
  return fitting ?? smallest;
}

/** page thumbnails and private data of the program that made the file are not part of the document */
function dropExtras(doc: MuPDF.PDFDocument): void {
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    page.delete("Thumb");
    page.delete("PieceInfo");
  }
}

/** longest side, in points, at which each image object is shown */
function shownSizes(doc: MuPDF.PDFDocument): Map<number, [number, number]> {
  const sizes = new Map<number, [number, number]>();
  let forms = 5000;
  for (let i = 0; i < doc.countPages(); i++) {
    // pages that cannot be walked safely keep the cautious default
    if (inspectPage(doc, i).redact) continue;
    const page = doc.loadPage(i);
    try {
      const toPage = page.getTransform() as Matrix;
      const visit = (content: Uint8Array, resources: MuPDF.PDFObject, state: GraphicsState, seen: number[]) => {
        walk(content, parseContent(content), resources, toPage, state, {
          object(at) {
            const x = xobjectOf(at.operation, resources);
            if (!x || !x.object.isIndirect()) return;
            const number = x.object.asIndirect();
            if (x.subtype === "Image") {
              const m = multiply(at.state.ctm, toPage);
              const width = Math.hypot(m[0], m[1]);
              const height = Math.hypot(m[2], m[3]);
              const before = sizes.get(number) ?? [0, 0];
              sizes.set(number, [Math.max(before[0], width), Math.max(before[1], height)]);
            } else if (x.subtype === "Form") {
              if (seen.length >= 12 || seen.includes(number) || forms-- <= 0) return;
              const own = x.object.get("Resources");
              visit(streamBytes(x.object), own.isDictionary() ? own : resources, formState(x.object, at.state, toPage), [
                ...seen,
                number,
              ]);
            }
          },
        });
      };
      visit(readPageContent(page), page.getObject().getInheritable("Resources"), { ctm: [...IDENTITY], clip: null, lineWidth: 1 }, []);
    } catch {
      /* a broken page: its pictures keep the cautious default */
    } finally {
      page.destroy();
    }
  }
  return sizes;
}

const isImage = (o: MuPDF.PDFObject) => {
  const subtype = o.get("Subtype");
  return subtype.isName() && subtype.asName() === "Image";
};

const rawLength = (o: MuPDF.PDFObject) => {
  const data = o.readRawStream();
  const length = data.getLength();
  data.destroy();
  return length;
};

function recompress(ctx: EngineContext, doc: MuPDF.PDFDocument, step: Step): number {
  const sizes = shownSizes(doc);
  // pictures shown by patterns or annotations only: assume they fill the largest page
  let largest = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const box = doc.findPage(i).getInheritable("MediaBox");
    if (box.isArray() && box.length === 4)
      largest = Math.max(largest, Math.abs(box.get(2).asNumber() - box.get(0).asNumber()), Math.abs(box.get(3).asNumber() - box.get(1).asNumber()));
  }
  largest ||= 842;

  const count = doc.countObjects();
  const images: number[] = [];
  const masks = new Set<number>();
  for (let n = 1; n < count; n++) {
    const object = doc.newIndirect(n);
    if (!object.isStream() || !isImage(object)) continue;
    images.push(n);
    for (const key of ["SMask", "Mask"]) {
      const mask = object.get(key);
      if (mask.isStream() && mask.isIndirect()) masks.add(mask.asIndirect());
    }
  }

  let changed = 0;
  for (const number of images) {
    if (masks.has(number)) continue;
    const object = doc.newIndirect(number);
    try {
      const target = targetSize(object, sizes.get(number) ?? [largest, largest], step.dpi);
      if (!target) continue;
      const soft = object.get("SMask");
      // a matte ties the colours to the mask pixel for pixel
      if (soft.isStream() && !soft.get("Matte").isNull()) continue;
      const before = rawLength(object);
      const picture = soft.isStream() ? soft : null;
      if (before + (picture ? rawLength(picture) : 0) < SMALL) continue;
      let done = reencode(ctx, doc, object, target, step.quality, false);
      if (picture) done = reencode(ctx, doc, picture, target, Math.max(70, step.quality + 15), true) || done;
      if (done) changed++;
    } catch {
      /* a picture that cannot be decoded stays as it is */
    }
  }
  return changed;
}

/** pixel size the picture should have at this step; null for pictures that must not be touched */
function targetSize(object: MuPDF.PDFObject, shown: [number, number], dpi: number): [number, number] | null {
  const flag = object.get("ImageMask");
  if (flag.isBoolean() && flag.asBoolean()) return null;
  // black and white scans are already tiny, and JPEG would ruin them
  const bits = object.get("BitsPerComponent");
  if (bits.isNumber() && bits.asNumber() === 1) return null;
  // colour keyed transparency does not survive lossy compression
  if (object.get("Mask").isArray()) return null;
  const width = object.get("Width").asNumber();
  const height = object.get("Height").asNumber();
  if (!(width > 0 && height > 0) || width * height > MOST_PIXELS) return null;
  const scale = Math.min(1, Math.max((shown[0] * dpi) / 72 / width, (shown[1] * dpi) / 72 / height));
  return [Math.max(Math.min(width, 16), Math.round(width * scale)), Math.max(Math.min(height, 16), Math.round(height * scale))];
}

function reencode(
  ctx: EngineContext,
  doc: MuPDF.PDFDocument,
  object: MuPDF.PDFObject,
  [width, height]: [number, number],
  quality: number,
  isMask: boolean,
): boolean {
  const { mupdf } = ctx;
  // decoded without its masks: they stay separate and are handled on their own
  const kept = (["SMask", "Mask"] as const).flatMap((key) => {
    const value = object.get(key);
    return value.isNull() ? [] : [[key, value] as const];
  });
  for (const [key] of kept) object.delete(key);
  let image: MuPDF.Image | null = null;
  let pixmap: MuPDF.Pixmap | null = null;
  let device: MuPDF.DrawDevice | null = null;
  try {
    image = doc.loadImage(object);
    const gray = isMask || !!image.getColorSpace()?.isGray();
    pixmap = new mupdf.Pixmap(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
    pixmap.clear(255);
    if (isMask) {
      // a mask is a table of numbers: no colour management on the way
      const own = image.toPixmap();
      const plain = new mupdf.Image(own);
      device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      device.fillImage(plain, [width, 0, 0, height, 0, 0], 1);
      device.close();
      plain.destroy();
      own.destroy();
    } else {
      device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      device.fillImage(image, [width, 0, 0, height, 0, 0], 1);
      device.close();
    }
    const encoded = pixmap.asJPEG(quality, false).slice();
    if (encoded.length > rawLength(object) * 0.9) return false;
    object.put("Width", width);
    object.put("Height", height);
    object.put("ColorSpace", doc.newName(gray ? "DeviceGray" : "DeviceRGB"));
    object.put("BitsPerComponent", 8);
    object.delete("Decode");
    object.delete("DecodeParms");
    object.writeRawStream(encoded);
    object.put("Filter", doc.newName("DCTDecode"));
    return true;
  } finally {
    for (const [key, value] of kept) object.put(key, value);
    device?.destroy();
    pixmap?.destroy();
    image?.destroy();
  }
}
