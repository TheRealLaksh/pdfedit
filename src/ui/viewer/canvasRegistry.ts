/** The base canvas of every mounted page, so the editor can read the paper colour around a line. */
import type { Rect } from "../../engine/types";

const canvases = new Map<number, HTMLCanvasElement>();

export function registerCanvas(page: number, canvas: HTMLCanvasElement | null) {
  if (canvas) canvases.set(page, canvas);
  else canvases.delete(page);
}

/** a picture of one region as it is on screen, to carry along while something is dragged */
export function snapshot(page: number, pageWidth: number, rect: Rect): string | null {
  const canvas = canvases.get(page);
  if (!canvas || canvas.width < 2) return null;
  const k = canvas.width / pageWidth;
  const w = Math.max(1, Math.round((rect[2] - rect[0]) * k));
  const h = Math.max(1, Math.round((rect[3] - rect[1]) * k));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, rect[0] * k, rect[1] * k, w, h, 0, 0, w, h);
  try {
    return out.toDataURL();
  } catch {
    return null;
  }
}

/** most common colour inside `rect` (page points): the background behind the text */
export function samplePaper(page: number, pageWidth: number, rect: Rect): string {
  const canvas = canvases.get(page);
  if (!canvas || canvas.width < 2) return "#ffffff";
  const k = canvas.width / pageWidth;
  const x = Math.max(0, Math.floor((rect[0] - 2) * k));
  const y = Math.max(0, Math.floor((rect[1] - 1) * k));
  const w = Math.min(canvas.width - x, Math.ceil((rect[2] - rect[0] + 4) * k));
  const h = Math.min(canvas.height - y, Math.ceil((rect[3] - rect[1] + 2) * k));
  if (w < 1 || h < 1) return "#ffffff";
  try {
    const { data } = canvas.getContext("2d")!.getImageData(x, y, w, h);
    const bins = new Map<number, [number, number, number, number]>();
    const step = 4 * Math.max(1, Math.floor((w * h) / 6000));
    for (let i = 0; i + 2 < data.length; i += step) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key);
      if (bin) {
        bin[0]++;
        bin[1] += r;
        bin[2] += g;
        bin[3] += b;
      } else bins.set(key, [1, r, g, b]);
    }
    let best: [number, number, number, number] | null = null;
    for (const bin of bins.values()) if (!best || bin[0] > best[0]) best = bin;
    if (!best) return "#ffffff";
    const [n, r, g, b] = best;
    return `rgb(${Math.round(r / n)} ${Math.round(g / n)} ${Math.round(b / n)})`;
  } catch {
    return "#ffffff";
  }
}
