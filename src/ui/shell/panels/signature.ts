/** Signature drawing, rendering and local storage helpers. */
import type { Point, RGB } from "../../../engine/types";
import { useStore } from "../../../store";
import { rgbToHex } from "../util";

/** suggested size of a placed signature, in PDF points */
const MAX_WIDTH = 160;
const MAX_HEIGHT = 70;

export interface InkSignature {
  type: "ink";
  id: string;
  paths: Point[][];
  width: number;
  height: number;
  color: RGB;
  strokeWidth: number;
}
export interface ImageSignature {
  type: "image";
  id: string;
  /** data: URL of a PNG */
  url: string;
  width: number;
  height: number;
}
export type Signature = InkSignature | ImageSignature;

/** crop strokes to their bounds and scale them to signature size */
export function inkFromStrokes(strokes: Point[][], color: RGB, pen: number): InkSignature | null {
  const points = strokes.flat();
  if (!points.length) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs) - pen;
  const y0 = Math.min(...ys) - pen;
  const w = Math.max(...xs) + pen - x0;
  const h = Math.max(...ys) + pen - y0;
  const scale = Math.min(MAX_WIDTH / w, MAX_HEIGHT / h);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    type: "ink",
    id: crypto.randomUUID(),
    paths: strokes.map((s) => {
      const path = s.map((p): Point => [round((p[0] - x0) * scale), round((p[1] - y0) * scale)]);
      // a tap is a dot: give it some length
      return path.length > 1 ? path : [path[0]!, [path[0]![0] + 0.3, path[0]![1]]];
    }),
    width: round(w * scale),
    height: round(h * scale),
    color,
    strokeWidth: round(Math.max(0.8, pen * scale)),
  };
}

export function drawStrokes(g: CanvasRenderingContext2D, strokes: Point[][], color: RGB, width: number): void {
  g.strokeStyle = rgbToHex(color);
  g.lineWidth = width;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const stroke of strokes) {
    const first = stroke[0];
    if (!first) continue;
    g.beginPath();
    g.moveTo(first[0], first[1]);
    if (stroke.length === 1) g.lineTo(first[0] + 0.1, first[1]);
    // smooth through the midpoints
    for (let i = 1; i < stroke.length - 1; i++) {
      const [x, y] = stroke[i]!;
      const [nx, ny] = stroke[i + 1]!;
      g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const last = stroke[stroke.length - 1]!;
    if (stroke.length > 1) g.lineTo(last[0], last[1]);
    g.stroke();
  }
}

/** smallest box holding the visible pixels, as a new canvas; null when everything is transparent */
export function trimCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width, height } = source;
  const data = source.getContext("2d")!.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]! > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(source, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Make the paper behind a photographed signature transparent. strength 0..1: higher removes more.
 * The paper brightness is measured, so grey or yellowed paper works too.
 */
export function removeBackground(image: ImageData, strength: number): ImageData {
  const d = image.data;
  const histogram = new Uint32Array(256);
  const light = (i: number) => (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000;
  for (let i = 0; i < d.length; i += 4) histogram[Math.round(light(i))]!++;
  // paper = 80th percentile of brightness
  let paper = 255;
  for (let sum = 0, v = 0; v < 256; v++) {
    sum += histogram[v]!;
    if (sum >= (d.length / 4) * 0.8) {
      paper = v;
      break;
    }
  }
  const from = 8 + strength * 100;
  const soft = 40;
  const out = new ImageData(new Uint8ClampedArray(d), image.width, image.height);
  for (let i = 0; i < d.length; i += 4) {
    const alpha = Math.min(1, Math.max(0, (paper - light(i) - from) / soft));
    out.data[i + 3] = Math.round(d[i + 3]! * alpha);
  }
  return out;
}

export async function applySignature(signature: Signature): Promise<void> {
  const state = useStore.getState();
  state.setTool("signature");
  if (signature.type === "ink") {
    const { paths, width, height, color, strokeWidth } = signature;
    state.setPlacement({ kind: "ink", paths, width, height, color, strokeWidth });
  } else {
    const data = new Uint8Array(await (await fetch(signature.url)).arrayBuffer());
    state.setPlacement({ kind: "image", data, width: signature.width, height: signature.height, label: "Signature" });
  }
  state.openPanel(null);
}

const KEY = "pdfedit.signatures";

export function savedSignatures(): Signature[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Signature[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** newest first, at most four */
export function storeSignatures(list: Signature[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 4)));
    return true;
  } catch {
    return false;
  }
}
