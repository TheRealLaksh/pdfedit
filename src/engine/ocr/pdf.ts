/** PDF plumbing: rendering a region of a page on the scan's own pixel grid, images, forms, the layer. */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { addResource, appendPageContent, ownResources, readPageContent } from "../content/page";
import { parseContent } from "../content/tokenizer";
import { apply, invert, num, rectFromPoints } from "../geom";
import type { Matrix, Point, Rect } from "../types";
import type { LineShape, Patch, Raster } from "./ink";
import { applyVec, frameQuad, type Frame, type WordSpan } from "./state";

export interface PlacedImage {
  /** unit square (0,0 = first pixel of the first row) -> page space */
  matrix: Matrix;
  width: number;
  height: number;
  gray: boolean;
}

export function placedImages(ctx: EngineContext, page: number): PlacedImage[] {
  const p = ctx.doc.loadPage(page);
  const out: PlacedImage[] = [];
  const text = p.toStructuredText("preserve-images");
  text.walk({
    onImageBlock(_bbox, transform, image) {
      const space = image.getColorSpace();
      out.push({
        matrix: [...transform] as Matrix,
        width: image.getWidth(),
        height: image.getHeight(),
        gray: !!space && space.isGray() && !image.getImageMask(),
      });
    },
  });
  text.destroy();
  p.destroy();
  return out;
}

/** share of the page covered by pictures (largest single one, or tiles added up) */
export function imageCoverage(ctx: EngineContext, page: number): number {
  const p = ctx.doc.loadPage(page);
  const [x0, y0, x1, y1] = p.getBounds();
  p.destroy();
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const cells = new Uint8Array(40 * 40);
  for (const image of placedImages(ctx, page)) {
    const m = image.matrix;
    const r = rectFromPoints([apply(m, [0, 0]), apply(m, [1, 0]), apply(m, [0, 1]), apply(m, [1, 1])]);
    // scans cut into strips add up; stacked layers must not count twice
    if (((r[2] - r[0]) * (r[3] - r[1])) / area < 0.01) continue;
    for (let j = 0; j < 40; j++) {
      for (let i = 0; i < 40; i++) {
        const x = x0 + ((i + 0.5) / 40) * (x1 - x0);
        const y = y0 + ((j + 0.5) / 40) * (y1 - y0);
        if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) cells[j * 40 + i] = 1;
      }
    }
  }
  return cells.reduce((s, v) => s + v, 0) / cells.length;
}

export interface Grid {
  /** page space -> pixel space */
  toPixel: Matrix;
  gray: boolean;
  /** pixel bounds of the picture, if the grid follows one */
  limit: Rect | null;
}

const MIN_DENSITY = 150 / 72;
const MAX_DENSITY = 600 / 72;

/**
 * The pixel grid to work on at a spot: that of the finest picture there, so that patch pixels land
 * exactly on scan pixels. Without a picture, a plain 300 dpi grid.
 */
export function gridAt(images: PlacedImage[], spot: Point): Grid {
  let best: Grid | null = null;
  let bestDensity = 0;
  for (const image of images) {
    const inverse = invert(image.matrix);
    const unit = apply(inverse, spot);
    if (unit[0] < -0.01 || unit[0] > 1.01 || unit[1] < -0.01 || unit[1] > 1.01) continue;
    const toPixel: Matrix = [
      inverse[0] * image.width,
      inverse[1] * image.height,
      inverse[2] * image.width,
      inverse[3] * image.height,
      inverse[4] * image.width,
      inverse[5] * image.height,
    ];
    const density = Math.sqrt(Math.abs(toPixel[0] * toPixel[3] - toPixel[1] * toPixel[2]));
    if (density <= bestDensity) continue;
    bestDensity = density;
    // keep whole multiples so that the picture's pixel edges stay pixel edges
    let k = 1;
    if (density > MAX_DENSITY) k = 1 / Math.ceil(density / MAX_DENSITY);
    else if (density < MIN_DENSITY) k = Math.ceil(MIN_DENSITY / density);
    best = {
      toPixel: toPixel.map((v) => v * k) as Matrix,
      gray: image.gray,
      limit: [0, 0, Math.floor(image.width * k), Math.floor(image.height * k)],
    };
  }
  return best ?? { toPixel: [300 / 72, 0, 0, 300 / 72, 0, 0], gray: false, limit: null };
}

export interface Region extends Raster {
  /** pixel coordinates of the first sample */
  x: number;
  y: number;
  grid: Grid;
}

/** render the page content (no annotations) inside a pixel box of the grid */
export function renderRegion(ctx: EngineContext, page: number, grid: Grid, box: Rect): Region | null {
  let [x0, y0, x1, y1] = [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])];
  if (grid.limit) {
    x0 = Math.max(x0, grid.limit[0]);
    y0 = Math.max(y0, grid.limit[1]);
    x1 = Math.min(x1, grid.limit[2]);
    y1 = Math.min(y1, grid.limit[3]);
  }
  if (x1 - x0 < 4 || y1 - y0 < 4 || (x1 - x0) * (y1 - y0) > 24_000_000) return null;
  const mupdf = ctx.mupdf;
  const pix = new mupdf.Pixmap(grid.gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [x0, y0, x1, y1], false);
  pix.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const p = ctx.doc.loadPage(page);
  p.runPageContents(device, grid.toPixel);
  device.close();
  const width = pix.getWidth();
  const height = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const stride = pix.getStride();
  const samples = pix.getPixels();
  const data = new Uint8Array(width * height * n);
  for (let y = 0; y < height; y++) data.set(samples.subarray(y * stride, y * stride + width * n), y * width * n);
  device.destroy();
  pix.destroy();
  p.destroy();
  return { width, height, n, data, x: x0, y: y0, grid };
}

/** pixel box around a frame (page space) with margins given in line heights */
export function boxAround(frame: Frame, toPixel: Matrix, marginAlong: number, marginAcross: number): Rect {
  const h = frame.asc + frame.desc;
  const wide: Frame = {
    ...frame,
    o: [frame.o[0] - frame.u.x * h * marginAlong, frame.o[1] - frame.u.y * h * marginAlong],
    width: frame.width + 2 * h * marginAlong,
    asc: frame.asc + h * marginAcross,
    desc: frame.desc + h * marginAcross,
  };
  const q = frameQuad(wide);
  return rectFromPoints([
    apply(toPixel, [q[0], q[1]]),
    apply(toPixel, [q[2], q[3]]),
    apply(toPixel, [q[4], q[5]]),
    apply(toPixel, [q[6], q[7]]),
  ]);
}

/** the line in the coordinates of a rendered region. Also returns pixels per point along and across */
export function shapeIn(region: Region, frame: Frame, words: WordSpan[]) {
  const m = region.grid.toPixel;
  const o = apply(m, frame.o);
  const u = applyVec(m, frame.u);
  const up = applyVec(m, frame.up);
  const sa = Math.hypot(u.x, u.y);
  const sb = Math.hypot(up.x, up.y);
  const shape: LineShape = {
    ox: o[0] - region.x,
    oy: o[1] - region.y,
    ux: u.x / sa,
    uy: u.y / sa,
    vx: -up.x / sb,
    vy: -up.y / sb,
    a0: 0,
    a1: frame.width * sa,
    b0: -frame.asc * sb,
    b1: frame.desc * sb,
    words: words.map((w) => ({ a0: w.from * sa, a1: w.to * sa, b0: -w.asc * sb, b1: w.desc * sb })),
  };
  return { shape, sa, sb };
}

/* ---------- PDF objects ---------- */

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function imageDict(ctx: EngineContext, width: number, height: number, space: "DeviceGray" | "DeviceRGB", filter: string) {
  const doc = ctx.doc;
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Image"));
  dict.put("Width", width);
  dict.put("Height", height);
  dict.put("ColorSpace", doc.newName(space));
  dict.put("BitsPerComponent", 8);
  dict.put("Filter", doc.newName(filter));
  return dict;
}

/** the colour samples as a high quality JPEG, like the scan around them (raw grain barely compresses) */
function jpeg(ctx: EngineContext, patch: Patch): Uint8Array {
  const mupdf = ctx.mupdf;
  const space = patch.n === 1 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const pix = new mupdf.Pixmap(space, [0, 0, patch.width, patch.height], false);
  const out = pix.getPixels();
  const stride = pix.getStride();
  const row = patch.width * patch.n;
  for (let y = 0; y < patch.height; y++) out.set(patch.color.subarray(y * row, (y + 1) * row), y * stride);
  const bytes = pix.asJPEG(92).slice();
  pix.destroy();
  return bytes;
}

/**
 * Store a patch as an image with a soft mask. Returns the image and the matrix (PDF user space) that
 * places it exactly over the pixels it was computed from.
 */
export async function addPatch(ctx: EngineContext, region: Region, patch: Patch, toPdf: Matrix) {
  const { width, height } = patch;
  const mask = ctx.doc.addRawStream(await deflate(patch.alpha), imageDict(ctx, width, height, "DeviceGray", "FlateDecode"));
  const dict = imageDict(ctx, width, height, patch.n === 1 ? "DeviceGray" : "DeviceRGB", "DCTDecode");
  dict.put("SMask", mask);
  const image = ctx.doc.addRawStream(jpeg(ctx, patch), dict);
  const toPage = invert(region.grid.toPixel);
  const left = region.x + patch.x;
  const top = region.y + patch.y;
  const corner = (x: number, y: number) => apply(toPdf, apply(toPage, [x, y]));
  // the image unit square has its first row at the top
  const o = corner(left, top + patch.height);
  const right = corner(left + patch.width, top + patch.height);
  const up = corner(left, top);
  const matrix: Matrix = [right[0] - o[0], right[1] - o[1], up[0] - o[0], up[1] - o[1], o[0], o[1]];
  return { object: image.asIndirect(), matrix };
}

export function addForm(ctx: EngineContext, content: string, resources: MuPDF.PDFObject, marker?: string): MuPDF.PDFObject {
  const doc = ctx.doc;
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Form"));
  const box = doc.newArray();
  for (const v of [-100000, -100000, 100000, 100000]) box.push(v);
  dict.put("BBox", box);
  dict.put("Resources", resources);
  if (marker) dict.put(marker, true);
  return doc.addStream(content, dict);
}

export interface LayerItem {
  /** image drawn with `matrix`, or a form drawn as is */
  object: number;
  matrix?: Matrix;
}

/** one form holding everything, drawn in the given order */
export function buildLayer(ctx: EngineContext, items: LayerItem[], marker: string): MuPDF.PDFObject {
  const doc = ctx.doc;
  const xobjects = doc.newDictionary();
  let content = "";
  items.forEach((item, i) => {
    xobjects.put(`X${i}`, doc.newIndirect(item.object));
    content += item.matrix ? `q ${item.matrix.map(num).join(" ")} cm /X${i} Do Q\n` : `q /X${i} Do Q\n`;
  });
  const resources = doc.newDictionary();
  resources.put("XObject", xobjects);
  return addForm(ctx, content, resources, marker);
}

function isMarked(value: MuPDF.PDFObject, marker: string): boolean {
  return value.isStream() && !value.get(marker).isNull();
}

/** swap the page's layer for `form` (adding it the first time); returns its resource name */
export function setLayer(
  ctx: EngineContext,
  page: number,
  form: MuPDF.PDFObject,
  marker: string,
  previous: string | undefined,
): string {
  const doc = ctx.doc;
  const p = doc.loadPage(page);
  const resources = ownResources(doc, p);
  const xobjects = resources.get("XObject");
  const marked: string[] = [];
  if (!xobjects.isNull()) xobjects.forEach((value, key) => void (isMarked(value, marker) && marked.push(String(key))));
  const reuse = previous && marked.includes(previous) ? previous : marked[0];
  let name: string;
  if (reuse) {
    name = reuse;
    xobjects.put(name, form);
    // copies left behind by other tools must not keep showing old text
    for (const other of marked) if (other !== name) xobjects.put(other, addForm(ctx, "", doc.newDictionary(), marker));
  } else name = addResource(doc, resources, "XObject", marker, form);
  const drawn = parseContent(readPageContent(p)).some(
    (op) => op.op === "Do" && op.operands[0]?.type === "name" && op.operands[0].value === name,
  );
  if (!drawn) appendPageContent(doc, p, `q /${name} Do Q`);
  p.destroy();
  return name;
}

/** render pages without our layer: used so that measurements see the original picture */
export function hideLayer(ctx: EngineContext, page: number, marker: string, name: string | undefined): void {
  if (name) setLayer(ctx, page, addForm(ctx, "", ctx.doc.newDictionary(), marker), marker, name);
}
