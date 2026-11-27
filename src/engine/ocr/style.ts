/** Cheap style estimates for recognised lines: size from the box height, weight, serif and alignment. */
import type { Align, FontStyle } from "../types";
import type { Ink, LineShape } from "./ink";
import type { LineMeta } from "./state";

interface Extent {
  above: number;
  below: number;
}

/**
 * How far the ink of a line of this text reaches above and below the baseline, in ems. Measured on
 * common fonts of each script.
 */
export function expectedExtent(text: string): Extent {
  if (/[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text)) return { above: 0.87, below: 0.07 };
  if (/[\u0900-\u097F]/.test(text)) {
    const high = /[\u0901\u0902\u093F\u0940\u0945-\u094C]/.test(text);
    const low = /[\u0941-\u0944\u094D\u093C\u0956\u0957\u0962\u0963]/.test(text);
    return { above: high ? 0.83 : 0.72, below: low ? 0.31 : 0.18 };
  }
  if (/[\u0980-\u0A7F]/.test(text)) return { above: 0.84, below: 0.26 };
  if (/[\u0600-\u08FF]/.test(text)) return { above: 0.76, below: 0.3 };
  if (/[\u0590-\u05FF]/.test(text)) return { above: 0.64, below: 0.12 };
  if (/[\u0B80-\u0BFF]/.test(text)) return { above: 0.85, below: /[\u0BB1\u0BB4\u0BC1\u0BC2\u0B9E]/.test(text) ? 0.36 : 0.2 };
  if (/[\u0E00-\u0EFF]/.test(text)) return { above: 0.85, below: 0.22 };
  if (/[\u0A80-\u0DFF\u1000-\u109F\u1780-\u17FF]/.test(text)) return { above: 0.82, below: 0.26 };
  const tall = /[\p{Lu}\p{Nd}bdfhijklt!?()[\]{}/\\|$%&#@'"бёйф\u03B2\u03B4\u03B6\u03B8\u03BB\u03BE]/u.test(text);
  const low = /[gjpqy();,@$Qруфцщд\u03B2\u03B3\u03B6\u03B7\u03BC\u03BE\u03C1\u03C6\u03C7\u03C8]/.test(text);
  const accents = /[ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝĆČĎĚŇŘŠŤŮŽЙЁ]/.test(text);
  return { above: accents ? 0.92 : tall ? 0.74 : 0.54, below: low ? 0.22 : 0.012 };
}

export function estimateSize(text: string, asc: number, desc: number): number {
  const e = expectedExtent(text);
  return Math.max(3, (asc + Math.max(0, desc)) / (e.above + e.below));
}

const latinLike = (text: string) => /^[\u0000-ԯḀ-⃏℀-⅏]*$/.test(text);

/**
 * Serif guess for Latin, Greek and Cyrillic. Serifs are feet: where a thin upright stroke meets the
 * baseline it becomes much wider, which sans stems never do.
 */
export function looksSerif(text: string, ink: Ink, width: number, shape: LineShape): boolean | null {
  const m = ink.metrics;
  if (!m || !latinLike(text) || text.replace(/\s/g, "").length < 8) return null;
  const height = Math.max(4, -m.p1);
  /** ink runs along a row parallel to the baseline, as [from, to] */
  const runs = (b: number): [number, number][] => {
    const out: [number, number][] = [];
    let start = -1;
    for (let a = Math.floor(m.aFrom) - 1; a <= m.aTo + 2; a++) {
      const px = Math.floor(shape.ox + shape.ux * a + shape.vx * b);
      const py = Math.floor(shape.oy + shape.uy * a + shape.vy * b);
      const i = py * width + px;
      const on = px >= 0 && px < width && i >= 0 && i < ink.letters.length && ink.letters[i] === 1;
      if (on && start < 0) start = a;
      else if (!on && start >= 0) {
        out.push([start, a]);
        start = -1;
      }
    }
    return out;
  };
  const stem = Math.max(2, m.stroke * 1.5);
  let uprights = 0;
  let footed = 0;
  // the lowest rows of ink against the rows a little higher up
  const upper = [-height * 0.2, -height * 0.24].flatMap((b) => runs(Math.round(b)));
  const lower = [0, 1, 2, 3].map((k) => runs(Math.round(-height * 0.07) + k - 1));
  for (const [from, to] of upper) {
    if (to - from > stem * 1.6) continue;
    let widest = 0;
    let shared = false;
    for (const row of lower) {
      for (const [f, t] of row) {
        if (t <= from || f >= to) continue;
        // a bowl joins two uprights at the bottom: that is not a foot
        if (upper.filter(([x, y]) => y > f && x < t && Math.abs(x - from) > stem * 1.5).length > 1) shared = true;
        else widest = Math.max(widest, t - f);
      }
    }
    if (shared || !widest) continue;
    uprights++;
    if (widest > (to - from) * 1.75) footed++;
  }
  return uprights >= 6 ? footed / uprights > 0.5 : null;
}

export function familyFor(serif: boolean): FontStyle["family"] {
  return serif ? "Times New Roman" : "Arial";
}

/** give lines of the same print the same size */
export function snapSizes(lines: LineMeta[]): void {
  const sorted = [...lines].sort((a, b) => a.style.size - b.style.size);
  let group: LineMeta[] = [];
  const flush = () => {
    if (!group.length) return;
    const size = Math.round(group[group.length >> 1]!.style.size * 2) / 2;
    for (const l of group) l.style.size = size;
    group = [];
  };
  for (const line of sorted) {
    if (group.length && line.style.size > group[0]!.style.size * 1.14) flush();
    group.push(line);
  }
  flush();
}

/** a line is bold when its strokes are clearly heavier than the rest of the page's */
export function markBold(lines: LineMeta[], strokes: (number | null)[]): void {
  const ratios = lines.map((l, i) => (strokes[i] ? strokes[i]! / l.style.size : null));
  const known = ratios.filter((r): r is number => r !== null).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor((known.length - 1) * 0.45)]! : 0;
  lines.forEach((line, i) => {
    const r = ratios[i];
    if (r === null || r === undefined) return;
    // regular type runs about 0.06 to 0.08 em thick, bold 0.085 to 0.13
    line.style.bold = r > 0.097 || (known.length >= 3 && r > typical * 1.24 && r > 0.07);
  });
}

/** alignment from how a line sits among its neighbours; angles are ignored beyond the line frames */
export function detectAlign(lines: LineMeta[], pageWidth: number, rects: [number, number, number, number][]): Align[] {
  return lines.map((line, i) => {
    const r = rects[i]!;
    const size = line.style.size;
    const near = rects.filter(
      (o, j) =>
        j !== i && Math.abs(o[1] - r[1]) < size * 3.2 && Math.min(o[2], r[2]) - Math.max(o[0], r[0]) > Math.min(o[2] - o[0], r[2] - r[0]) * 0.4,
    );
    const tol = size * 0.7;
    const left = near.filter((o) => Math.abs(o[0] - r[0]) < tol).length;
    const right = near.filter((o) => Math.abs(o[2] - r[2]) < tol).length;
    const centre = near.filter((o) => Math.abs(o[0] + o[2] - r[0] - r[2]) < tol * 2).length;
    const rtl = line.dir === "rtl";
    // justified setting only makes sense for running text, not for table columns
    if (left >= 2 && right >= 2 && r[2] - r[0] > pageWidth * 0.3 && line.text.includes(" ")) return "justify";
    // columns of figures line up on the right
    if (right && /^[\p{Sc}\p{Nd}\s.,%()+\-]+$/u.test(line.text)) return "right";
    if (rtl && right) return "right";
    if (left && left >= right && left >= centre) return "left";
    if (right && right > left && right >= centre) return "right";
    if (centre) return "center";
    const middle = (r[0] + r[2]) / 2;
    if (Math.abs(middle - pageWidth / 2) < pageWidth * 0.02 && r[2] - r[0] < pageWidth * 0.7) return "center";
    return rtl ? "right" : "left";
  });
}
