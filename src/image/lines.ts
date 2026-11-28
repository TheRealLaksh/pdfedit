/**
 * Whole lines: the first reading of a picture can stop short of the end of a line, or misread it. Each box
 * is grown along its baseline over neighbouring ink of the same colour and height, and cut out for a
 * second, closer reading of that line alone.
 */
import { angleOf, centre, quadSize } from "./geometry";
import { clamp, components, quantile, sample } from "./raster";
import type { Picture, Pt, Quad4 } from "./types";

/** the upright frame of a line: u along the reading direction from its start, v downwards from its top */
interface Frame {
  width: number;
  height: number;
  toImage: (u: number, v: number) => Pt;
  toFrame: (p: Pt) => Pt;
}

function frameOf(quad: Quad4): Frame {
  const { width, height } = quadSize(quad);
  const a = angleOf(quad);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [cx, cy] = centre(quad);
  return {
    width,
    height,
    toImage: (u, v) => [cx + (u - width / 2) * c - (v - height / 2) * s, cy + (u - width / 2) * s + (v - height / 2) * c],
    toFrame: ([x, y]) => [(x - cx) * c + (y - cy) * s + width / 2, (y - cy) * c - (x - cx) * s + height / 2],
  };
}

export interface Ink {
  ground: [number, number, number];
  color: [number, number, number];
  /** colour distance between the two */
  contrast: number;
}

/** the colour of the ground and of the lettering inside a box; null when they can hardly be told apart */
export function inkOf(picture: Picture, quad: Quad4): Ink | null {
  const f = frameOf(quad);
  const step = Math.max(1, Math.sqrt((f.width * f.height) / 20_000));
  const at = (u: number, v: number) => {
    const [x, y] = f.toImage(u, v);
    return [0, 1, 2].map((c) => sample(picture.data, picture.width, picture.height, x, y, 4, c)) as [number, number, number];
  };
  const pixels: [number, number, number][] = [];
  for (let v = step / 2; v < f.height; v += step) for (let u = step / 2; u < f.width; u += step) pixels.push(at(u, v));
  if (pixels.length < 16) return null;
  // the ground is what runs along the edges: heavy lettering can fill most of a tight box
  const edges: [number, number, number][] = [];
  for (let u = 0.5; u < f.width; u += step) edges.push(at(u, 0.5), at(u, f.height - 0.5));
  for (let v = 0.5; v < f.height; v += step) edges.push(at(0.5, v), at(f.width - 0.5, v));
  const ground = [0, 1, 2].map((c) => quantile(edges.map((p) => p[c]!), 0.5)) as Ink["ground"];
  const away = pixels.map((p) => Math.hypot(p[0] - ground[0], p[1] - ground[1], p[2] - ground[2]));
  const strong = quantile(away, 0.97) * 0.75;
  const solid = pixels.filter((_, i) => away[i]! >= strong);
  const color = [0, 1, 2].map((c) => solid.reduce((s, p) => s + p[c]!, 0) / Math.max(1, solid.length)) as Ink["color"];
  const contrast = Math.hypot(color[0] - ground[0], color[1] - ground[1], color[2] - ground[2]);
  return contrast < 40 ? null : { ground, color, contrast };
}

const alike = (a: Ink, b: Ink) => Math.hypot(a.color[0] - b.color[0], a.color[1] - b.color[1], a.color[2] - b.color[2]) < Math.max(a.contrast, b.contrast) * 0.45;

/** a word space is well under this share of the line height, the gap between table columns above it */
const GAP = 0.8;
/** dots and other tiny marks must sit closer, so that bullets and specks stay outside */
const SMALL_GAP = 0.45;

export interface Grown {
  quad: Quad4;
  /** indexes of other boxes that turned out to be part of this line */
  absorbed: number[];
  /** length added at both ends, in line heights */
  added: number;
}

/**
 * Extends `quads[index]` over the ink that carries the line on at either end. It stops at wide gaps, at
 * anything taller than the line (rules, frames, pictures), at ink of another colour and at other lines;
 * a box of the same line that it reaches is taken in. `taken` boxes are ignored.
 */
export function grow(picture: Picture, quads: readonly Quad4[], index: number, taken: ReadonlySet<number> = new Set()): Grown {
  const quad = quads[index]!;
  const same: Grown = { quad, absorbed: [], added: 0 };
  const ink = inkOf(picture, quad);
  if (!ink) return same;
  const f = frameOf(quad);
  const h = f.height;
  // as far as the picture reaches along the line
  const corners = ([[0, 0], [picture.width, 0], [picture.width, picture.height], [0, picture.height]] as Pt[]).map((p) => f.toFrame(p)[0]);
  const from = Math.floor(Math.max(Math.min(...corners), -h * 40));
  const to = Math.ceil(Math.min(Math.max(...corners), f.width + h * 40));
  const top = -Math.ceil(h * 0.8);
  const w = Math.max(1, to - from);
  const rows = Math.ceil(h * 1.8) - top;
  const mask = new Uint8Array(w * rows);
  const axis = ink.color.map((c, i) => c - ink.ground[i]!);
  const length = ink.contrast * ink.contrast;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < w; x++) {
      const [px, py] = f.toImage(from + x + 0.5, top + y + 0.5);
      if (px < 0 || py < 0 || px >= picture.width || py >= picture.height) continue;
      let dot = 0;
      let square = 0;
      for (let c = 0; c < 3; c++) {
        const d = sample(picture.data, picture.width, picture.height, px, py, 4, c) - ink.ground[c]!;
        dot += d * axis[c]!;
        square += d * d;
      }
      const along = dot / length;
      // on the way from the ground to the ink colour, and not far beside it
      if (along > 0.4 && square - along * along * length < length * 0.2) mask[y * w + x] = 1;
    }

  type Part = [number, number, number, number];
  const glyphs: Part[] = [];
  const blockers: Part[] = [];
  const found = components(mask, w, rows);
  for (let id = 1; id < found.box.length; id++) {
    const [x0, y0, x1, y1] = found.box[id]!;
    const part: Part = [x0 + from, y0 + top, x1 + from, y1 + top];
    const [, v0, , v1] = part;
    const tall = v1 - v0;
    if (found.area[id]! < Math.max(3, h * h * 0.004)) continue;
    // underlines and strike-through lines are not letters
    if (x1 - x0 > h * 2.5 && tall < h * 0.14) continue;
    if (v0 >= -h * 0.5 && v1 <= h * 1.45 && tall <= h * 1.6) {
      if (v1 > h * 0.08 && v0 < h * 0.95) glyphs.push(part);
    } else if (v0 < h * 0.75 && v1 > h * 0.25) blockers.push(part);
  }

  const others = quads.flatMap((q, i) => {
    if (i === index || taken.has(i)) return [];
    const points = q.map(f.toFrame);
    const u = points.map((p) => p[0]);
    const v = points.map((p) => p[1]);
    const box: Part = [Math.min(...u), Math.min(...v), Math.max(...u), Math.max(...v)];
    const shared = Math.min(h, box[3]) - Math.max(0, box[1]);
    if (shared <= Math.min(h, box[3] - box[1]) * 0.2) return [];
    const ratio = quadSize(q).height / h;
    const its = inkOf(picture, q);
    const line = shared > Math.min(h, box[3] - box[1]) * 0.65 && ratio > 0.65 && ratio < 1.55 && Math.abs(angleOf(q) - angleOf(quad)) < 0.05 && !!its && alike(ink, its);
    return [{ index: i, box, line }];
  });

  let [u0, v0, u1, v1] = [0, 0, f.width, h];
  const absorbed: number[] = [];
  const take = (p: Part) => {
    u0 = Math.min(u0, p[0]);
    v0 = Math.min(v0, p[1]);
    u1 = Math.max(u1, p[2]);
    v1 = Math.max(v1, p[3]);
  };
  for (const side of [1, -1] as const) {
    // mirrored for the start of the line, so that "further" always means larger
    const flip = (p: Part): Part => (side > 0 ? p : [-p[2], p[1], -p[0], p[3]]);
    const queue = glyphs.map((p) => ({ p, at: flip(p) })).sort((a, b) => a.at[0] - b.at[0]);
    for (;;) {
      const edge = side > 0 ? u1 : -u0;
      const next = queue.find(({ at }) => {
        if (at[2] <= edge + 0.5) return false;
        const small = Math.max(at[2] - at[0], at[3] - at[1]) < h * 0.3;
        return at[0] <= edge + h * (small ? SMALL_GAP : GAP);
      });
      const line = others.find((o) => o.line && !absorbed.includes(o.index) && flip(o.box)[2] > edge && flip(o.box)[0] <= edge + h * GAP);
      const reach = next ? next.at[0] : line ? flip(line.box)[0] : null;
      if (reach === null) break;
      const blocked = blockers.some((b) => {
        const at = flip(b);
        return at[2] > edge + 1 && at[0] < Math.max(reach, edge) + 1;
      });
      if (blocked) break;
      if (line && (!next || flip(line.box)[0] <= next.at[2])) {
        absorbed.push(line.index);
        take(line.box);
        continue;
      }
      const mid = (next!.p[0] + next!.p[2]) / 2;
      const foreign = others.some((o) => !o.line && mid > o.box[0] && mid < o.box[2] && next!.p[1] < o.box[3] && next!.p[3] > o.box[1]);
      if (foreign) break;
      take(next!.p);
    }
  }
  const added = (u1 - u0 - f.width) / h;
  if (added * h < 0.5 && !absorbed.length) return same;
  // only the ends that moved get a margin: the rest of the box stays as it was read
  const a = u0 < 0 ? u0 - 1 : 0;
  const z = u1 > f.width ? u1 + 1 : f.width;
  const grownQuad = ([[a, v0], [z, v0], [z, v1], [a, v1]] as Pt[]).map(([u, v]) => {
    const [x, y] = f.toImage(u, v);
    return [clamp(x, 0, picture.width), clamp(y, 0, picture.height)] as Pt;
  }) as Quad4;
  return { quad: grownQuad, absorbed, added };
}

/** height in pixels a line is brought to for the closer reading */
const READ_HEIGHT = 56;

/** one line, upright, at a size the recogniser reads well: dark letters on a white ground */
export function lineImage(picture: Picture, quad: Quad4): Picture {
  const f = frameOf(quad);
  const scale = clamp(READ_HEIGHT / f.height, 0.1, 6);
  const edge = Math.min(2, f.height * 0.08);
  const inner = Math.max(1, Math.round((f.width + edge * 2) * scale));
  const tall = Math.max(1, Math.round((f.height + edge * 2) * scale));
  const pad = Math.round(READ_HEIGHT * 0.45);
  const width = inner + pad * 2;
  const height = tall + pad * 2;
  const ink = inkOf(picture, quad);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  // shrinking averages several samples per pixel
  const n = Math.max(1, Math.ceil(1 / scale));
  for (let y = 0; y < tall; y++)
    for (let x = 0; x < inner; x++) {
      const sum = [0, 0, 0];
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const [px, py] = f.toImage((x + (i + 0.5) / n) / scale - edge, (y + (j + 0.5) / n) / scale - edge);
          for (let c = 0; c < 3; c++) sum[c]! += sample(picture.data, picture.width, picture.height, px, py, 4, c) / (n * n);
        }
      const at = ((y + pad) * width + x + pad) * 4;
      if (ink) {
        const away = Math.hypot(sum[0]! - ink.ground[0], sum[1]! - ink.ground[1], sum[2]! - ink.ground[2]);
        data[at] = data[at + 1] = data[at + 2] = 255 * (1 - Math.min(1, away / ink.contrast));
      } else for (let c = 0; c < 3; c++) data[at + c] = sum[c]!;
    }
  return { width, height, data };
}
