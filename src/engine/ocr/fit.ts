/**
 * Matching new type to scanned ink: the recognised text is typeset in a few candidate styles, each is
 * rendered and measured the same way as the scan, and the closest one gives font, size, stretch and
 * baseline position.
 */
import { emptyState, type EngineContext } from "../context";
import { writeText, planText } from "../fonts";
import type { TextStyle } from "../types";
import { analyzeInk, GRID_ROWS, type InkMetrics } from "./ink";
import type { Fit, LineMeta } from "./state";
import { estimateSize } from "./style";

export interface Measured {
  /** the original ink, in points relative to the line frame */
  metrics: InkMetrics;
  /** pixels per point along and across the line */
  sa: number;
  sb: number;
}

export interface FitResult {
  fit: Fit;
  style: TextStyle;
}

const REF_SIZE = 100;

/** families with metric compatible free substitutes; other scripts only differ between sans and serif */
const LATIN_FAMILIES = [
  { family: "Arial", serif: false, mono: false },
  { family: "Times New Roman", serif: true, mono: false },
  { family: "Calibri", serif: false, mono: false },
  { family: "Cambria", serif: true, mono: false },
  { family: "Verdana", serif: false, mono: false },
  { family: "Courier New", serif: false, mono: true },
];

export function originalFont(style: TextStyle) {
  return { name: style.family, bold: style.bold, italic: style.italic, serif: style.serif, mono: style.mono };
}

export function fallbackFit(line: LineMeta): FitResult {
  const size = estimateSize(line.text, line.frame.asc, line.frame.desc);
  return {
    style: { ...line.style },
    fit: { size, hscale: 100, drop: 0, inkFrom: 0, inkTo: line.frame.width, lead: 0, trail: 0 },
  };
}

interface Reference {
  metrics: InkMetrics;
  advance: number;
}

export class Fitter {
  private scratch: EngineContext | null = null;

  /** `used`: families already matched on this page */
  constructor(
    private ctx: EngineContext,
    private used = new Set<string>(),
  ) {}

  destroy(): void {
    this.scratch?.doc.destroy();
    this.scratch = null;
  }

  /** a throw-away document, so that trial settings leave no fonts behind in the user's file */
  private context(): EngineContext {
    return (this.scratch ??= { ...this.ctx, doc: new this.ctx.mupdf.PDFDocument(), state: emptyState(), cache: new Map() });
  }

  private async reference(text: string, style: TextStyle, inkPixels: number): Promise<Reference | null> {
    const sctx = this.context();
    const { doc, mupdf } = sctx;
    const request = { text, style: { ...style, size: REF_SIZE, underline: false, letterSpacing: 0 }, originalFont: originalFont(style) };
    const planned = await planText(sctx, request);
    if (planned.width <= 0 || planned.missing.length > text.length / 3) return null;
    const above = Math.max(planned.ascent, REF_SIZE) + 40;
    const below = Math.max(planned.descent, REF_SIZE * 0.35) + 30;
    const width = planned.width + 100;
    const height = above + below;
    const resources = doc.addObject(doc.newDictionary());
    const written = await writeText(sctx, { ...request, style: { ...request.style, color: [0, 0, 0] }, matrix: [1, 0, 0, 1, 50, below], resources });
    const object = doc.addPage([0, 0, width, height], 0, resources, written.ops);
    doc.insertPage(0, object);
    const page = doc.loadPage(0);
    // render at about the resolution of the scan, so that strokes thicken alike
    const scale = Math.min(Math.max(inkPixels / 85, 0.25), 3, 3600 / width);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false);
    const w = pix.getWidth();
    const h = pix.getHeight();
    const stride = pix.getStride();
    const samples = pix.getPixels();
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) data.set(samples.subarray(y * stride, y * stride + w), y * w);
    pix.destroy();
    page.destroy();
    doc.deletePage(0);
    const ox = 50 * scale;
    const oy = above * scale;
    const box = { a0: 0, a1: planned.width * scale, b0: -planned.ascent * scale, b1: planned.descent * scale };
    const ink = analyzeInk(
      { width: w, height: h, n: 1, data },
      { ...box, ox, oy, ux: 1, uy: 0, vx: 0, vy: 1, words: [{ ...box, a0: -30 * scale, a1: box.a1 + 30 * scale }] },
    );
    const m = ink.metrics;
    if (!m) return null;
    return {
      advance: planned.width,
      metrics: { ...m, aFrom: m.aFrom / scale, aTo: m.aTo / scale, p1: m.p1 / scale, p50: m.p50 / scale, p99: m.p99 / scale, stroke: m.stroke / scale },
    };
  }

  async fit(line: LineMeta, measured: Measured | null): Promise<FitResult> {
    const text = line.text;
    if (!measured) return fallbackFit(line);
    const { metrics: m, sa, sb } = measured;
    const original = {
      from: m.aFrom / sa,
      to: m.aTo / sa,
      p1: m.p1 / sb,
      p50: m.p50 / sb,
      p99: m.p99 / sb,
      stroke: m.stroke / Math.sqrt(sa * sb),
    };
    const width = original.to - original.from;
    const height = original.p99 - original.p1;
    if (width <= 0.5 || height <= 0.5) return fallbackFit(line);

    const latin = /^[\u0000-ԯḀ-⃏℀-⅏]*$/.test(text);
    const bases = (latin ? LATIN_FAMILIES : LATIN_FAMILIES.slice(0, 2)).map(
      (f): TextStyle => ({ ...line.style, family: f.family, serif: f.serif, mono: f.mono, bold: line.style.bold, italic: false }),
    );

    type Best = { style: TextStyle; ref: Reference; score: number };
    const tried: Best[] = [];
    const consider = async (candidate: TextStyle, bias = 0) => {
      const ref = await this.reference(text, candidate, m.p99 - m.p1);
      if (!ref) return;
      const r = ref.metrics;
      const rw = r.aTo - r.aFrom;
      const rh = r.p99 - r.p1;
      if (rw <= 0 || rh <= 0) return;
      const shape = similarity(m, r);
      const widthOff = Math.abs(Math.log(width / height / (rw / rh)));
      const strokeOff = Math.abs(Math.log(original.stroke / height / (r.stroke / rh)));
      // the page-wide guess and the faces already used on this page break near ties
      const prior =
        (candidate.serif === line.style.serif ? 0.012 : 0) +
        (candidate.bold === line.style.bold ? 0.04 : 0) +
        (this.used.has(candidate.family) ? 0.015 : 0) -
        (candidate.mono ? 0.03 : 0);
      tried.push({ style: candidate, ref, score: shape - 0.5 * widthOff - 0.3 * strokeOff + prior + bias });
    };
    const top = (n: number) => [...tried].sort((a, b) => b.score - a.score).slice(0, n);
    try {
      for (const c of bases) await consider(c);
      for (const c of top(2)) await consider({ ...c.style, bold: !c.style.bold });
      // slanted type has to match clearly better: noise alone must not tilt upright text
      for (const c of top(1)) if (latin) await consider({ ...c.style, italic: true }, -0.035);
    } catch {
      // no fonts (offline): fall back to geometry alone
    }
    const chosen = top(1)[0];
    if (!chosen) return fallbackFit(line);
    this.used.add(chosen.style.family);

    const r = chosen.ref.metrics;
    const byHeight = (REF_SIZE * height) / (r.p99 - r.p1);
    const byWidth = (REF_SIZE * width) / (r.aTo - r.aFrom);
    // misread text or too little of it makes the width meaningless
    const trustWidth = line.confidence >= 55 && [...text.replace(/\s/g, "")].length >= 3;
    let size = byHeight;
    let hscale = 100;
    if (trustWidth) {
      const ratio = byWidth / byHeight;
      // a substitute with other proportions: share the difference between size and a gentle stretch
      if (ratio < 0.95 || ratio > 1.05) size = byHeight * Math.min(1.15, Math.max(0.87, Math.sqrt(ratio)));
      hscale = Math.min(112, Math.max(89, (100 * byWidth) / size));
    }
    const k = size / REF_SIZE;
    const drops = [original.p1 - r.p1 * k, original.p50 - r.p50 * k, original.p99 - r.p99 * k].sort((a, b) => a - b);
    return {
      style: { ...chosen.style, size: Math.round(size * 10) / 10 },
      fit: {
        size: Math.round(size * 10) / 10,
        hscale: Math.round(hscale * 10) / 10,
        drop: drops[1]!,
        inkFrom: original.from,
        inkTo: original.to,
        lead: r.aFrom / REF_SIZE,
        trail: (chosen.ref.advance - r.aTo) / REF_SIZE,
      },
    };
  }
}

/** correlation of two ink pictures, window by window so that small spacing differences do not add up */
export function similarity(a: InkMetrics, b: InkMetrics): number {
  const width = a.grid.width;
  const left = blur(a.grid.data, width);
  const right = blur(stretch(b.grid.data, b.grid.width, width), width);
  const window = GRID_ROWS * 2;
  const slack = Math.round(GRID_ROWS * 0.4);
  let total = 0;
  let weight = 0;
  for (let from = 0; from < width; from += window) {
    const to = Math.min(width, from + window);
    if (to - from < 6) break;
    let best = -1;
    for (let shift = -slack; shift <= slack; shift++) best = Math.max(best, correlate(left, right, width, from, to, shift));
    total += best * (to - from);
    weight += to - from;
  }
  return weight ? total / weight : 0;
}

function stretch(data: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(to * GRID_ROWS);
  for (let x = 0; x < to; x++) {
    const s = Math.min(from - 1, Math.max(0, ((x + 0.5) * from) / to - 0.5));
    const x0 = Math.floor(s);
    const x1 = Math.min(from - 1, x0 + 1);
    const f = s - x0;
    for (let y = 0; y < GRID_ROWS; y++) out[y * to + x] = data[y * from + x0]! * (1 - f) + data[y * from + x1]! * f;
  }
  return out;
}

function blur(data: Float32Array, width: number): Float32Array {
  const out = new Float32Array(data.length);
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= GRID_ROWS) continue;
          sum += data[yy * width + xx]!;
          n++;
        }
      }
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

function correlate(a: Float32Array, b: Float32Array, width: number, from: number, to: number, shift: number): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = from; x < to; x++) {
      const bx = x + shift;
      const va = a[y * width + x]!;
      const vb = bx >= 0 && bx < width ? b[y * width + bx]! : 0;
      n++;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  const cov = sab - (sa * sb) / n;
  const da = saa - (sa * sa) / n;
  const db = sbb - (sb * sb) / n;
  return da > 1e-6 && db > 1e-6 ? cov / Math.sqrt(da * db) : 0;
}
