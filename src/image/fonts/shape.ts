/**
 * Text in one face of the image font list (or an uploaded font) to positioned glyph outlines, using the
 * engine's HarfBuzz layout, so every script is shaped, ordered and given fallback fonts the same way as
 * in PDF editing.
 */
import type { AssetLoader, EngineContext } from "../../engine/context";
import type { Face } from "../../engine/fonts/face";
import { layoutText } from "../../engine/fonts/layout";
import { fontInfo } from "../../engine/fonts/sfnt";
import { embolden, flatten, parsePath, type Path } from "../outline";
import type { Pt } from "../types";
import { familyByKey, nearestWeight } from "./catalog";

export interface FaceRef {
  /** family key or "user:..." */
  font: string;
  weight: number;
  italic: boolean;
}

export interface ShapedGlyph {
  path: Path;
  /** units of the layout (size 100) per font unit */
  scale: number;
  x: number;
  /** y down from the baseline */
  y: number;
  /** index into clusters */
  cluster: number;
}

export interface Cluster {
  /** UTF-16 range of the text */
  start: number;
  end: number;
  /** where the pen stands before this cluster, at size 100 */
  pen: number;
  /** horizontal ink extent at size 100 (x1 < x0 for blank clusters) */
  x0: number;
  x1: number;
  /** position among the clusters from left to right */
  order: number;
  /** word number from left to right */
  word: number;
  space: boolean;
}

export interface Shaped {
  text: string;
  glyphs: ShapedGlyph[];
  clusters: Cluster[];
  words: number;
  /** tight ink box at size 100: x0, y0 (up is negative), x1, y1 */
  ink: [number, number, number, number];
  /** the font has real italic outlines (otherwise the caller slants) */
  realItalic: boolean;
  missing: string[];
  rtl: boolean;
}

export interface Placement {
  /** origin of the baseline in the frame */
  ox: number;
  oy: number;
  /** font size in frame pixels */
  size: number;
  stretch: number;
  /** extra pixels between neighbouring letters */
  spacing: number;
  /** sideways slant, as x per y */
  shear: number;
  /** extra offset per word, left to right */
  wordShift?: readonly number[];
}

export interface UserFont {
  name: string;
  bytes: Uint8Array;
}

const paths = new WeakMap<Face, Map<number, Path>>();

function glyphPath(face: Face, gid: number): Path {
  let map = paths.get(face);
  if (!map) paths.set(face, (map = new Map()));
  let path = map.get(gid);
  if (!path) map.set(gid, (path = parsePath(face.hbFont.glyphToPath(gid))));
  return path;
}

export class Fonts {
  readonly users = new Map<string, UserFont>();
  private cache = new Map<string, Promise<Shaped>>();

  constructor(private assets: AssetLoader) {}

  addUserFont(name: string, bytes: Uint8Array): { key: string; family: string; weight: number; italic: boolean } {
    const info = fontInfo(bytes);
    if (!info || info.outlines === "none" || info.outlines === "cff2") throw new Error("This file is not a usable TrueType or OpenType font.");
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
    const key = `user:${(h >>> 0).toString(36)}`;
    this.users.set(key, { name, bytes });
    return { key, family: info.family || name.replace(/\.[a-z0-9]+$/i, ""), weight: info.weight, italic: info.italic };
  }

  /** the font file behind a reference */
  async bytes(ref: FaceRef): Promise<Uint8Array> {
    const user = this.users.get(ref.font);
    if (user) return user.bytes;
    const family = familyByKey(ref.font) ?? familyByKey("arimo")!;
    return this.assets.bytes(family.url(nearestWeight(family.weights, ref.weight), ref.italic));
  }

  shape(ref: FaceRef, text: string): Promise<Shaped> {
    const key = `${ref.font}\u0000${ref.weight}\u0000${ref.italic ? 1 : 0}\u0000${text}`;
    let job = this.cache.get(key);
    if (!job) {
      job = this.build(ref, text);
      this.cache.set(key, job);
      job.catch(() => this.cache.delete(key));
      if (this.cache.size > 600) this.cache.delete(this.cache.keys().next().value!);
    }
    return job;
  }

  private async build(ref: FaceRef, text: string): Promise<Shaped> {
    const family = familyByKey(ref.font);
    const bytes = await this.bytes(ref);
    const id = `user:image-face`;
    // the layout module draws with the chosen file and falls back to others for characters it lacks
    const ctx = { assets: this.assets, userFonts: new Map([[id, { name: family?.name ?? "font", bytes }]]) } as unknown as EngineContext;
    const layout = await layoutText(ctx, {
      text,
      style: { family: family?.name ?? "Arial", bold: false, italic: false, serif: family?.category === "serif", mono: family?.category === "mono", size: 100, color: [0, 0, 0], fontChoice: id },
    });
    const glyphs: ShapedGlyph[] = [];
    const clusters: Cluster[] = [];
    let at = 0;
    for (let i = 0; i < layout.glyphs.length; ) {
      const first = layout.glyphs[i]!;
      const count = first.actual?.glyphs ?? 1;
      const part = first.actual?.text ?? first.text;
      const cluster: Cluster = { start: at, end: at + part.length, pen: 0, x0: Infinity, x1: -Infinity, order: 0, word: 0, space: !part.trim() };
      at += part.length;
      let left = Infinity;
      for (let k = 0; k < count; k++, i++) {
        const g = layout.glyphs[i]!;
        const path = glyphPath(g.face, g.gid);
        const scale = g.size / g.face.info.unitsPerEm;
        glyphs.push({ path, scale, x: g.x, y: -g.y, cluster: clusters.length });
        left = Math.min(left, g.x);
        for (const contour of flatten(path, (px, py) => [g.x + px * scale, -g.y - py * scale])) {
          for (const [x] of contour) {
            if (x < cluster.x0) cluster.x0 = x;
            if (x > cluster.x1) cluster.x1 = x;
          }
        }
      }
      cluster.pen = Number.isFinite(left) ? left : 0;
      if (cluster.x1 < cluster.x0) cluster.x0 = cluster.x1 = cluster.pen;
      clusters.push(cluster);
    }
    const visual = [...clusters].sort((a, b) => a.x0 + a.x1 - b.x0 - b.x1);
    let word = 0;
    let gap = false;
    visual.forEach((c, order) => {
      c.order = order;
      if (c.space) gap = true;
      else if (gap) {
        word++;
        gap = false;
      }
      c.word = word;
    });
    const ink: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const g of glyphs)
      for (const contour of flatten(g.path, (px, py) => [g.x + px * g.scale, g.y - py * g.scale]))
        for (const [x, y] of contour) {
          if (x < ink[0]) ink[0] = x;
          if (y < ink[1]) ink[1] = y;
          if (x > ink[2]) ink[2] = x;
          if (y > ink[3]) ink[3] = y;
        }
    if (!Number.isFinite(ink[0])) ink.splice(0, 4, 0, -70, 0, 0);
    return {
      text: layout.text,
      glyphs,
      clusters,
      words: word + 1,
      ink,
      realItalic: !!family?.italic || !!this.users.get(ref.font),
      missing: layout.missing,
      rtl: layout.rtl,
    };
  }
}

/** where the pen stands in the frame before a cluster */
export function clusterPen(shaped: Shaped, p: Placement, index: number): number {
  const c = shaped.clusters[index]!;
  return p.ox + c.pen * (p.size / 100) * p.stretch + c.order * p.spacing + (p.wordShift?.[c.word] ?? 0);
}

/** where a cluster's ink starts and ends in the frame, after placement */
export function clusterSpan(shaped: Shaped, p: Placement, index: number): [number, number] {
  const c = shaped.clusters[index]!;
  const s = p.size / 100;
  const shift = c.order * p.spacing + (p.wordShift?.[c.word] ?? 0);
  return [p.ox + c.x0 * s * p.stretch + shift, p.ox + c.x1 * s * p.stretch + shift];
}

/**
 * The polygons of the placed text, one group per glyph, mapped through `map` (frame to target pixels).
 * `only` limits drawing to some clusters.
 */
export function outlines(
  shaped: Shaped,
  p: Placement,
  thickness: number,
  map: (u: number, v: number) => Pt,
  only?: (cluster: number) => boolean,
): Pt[][][] {
  const s = p.size / 100;
  const out: Pt[][][] = [];
  for (const g of shaped.glyphs) {
    if (only && !only(g.cluster)) continue;
    const c = shaped.clusters[g.cluster]!;
    const shift = c.order * p.spacing + (p.wordShift?.[c.word] ?? 0);
    let contours = flatten(g.path, (px, py) => {
      const y = (g.y - py * g.scale) * s;
      return [p.ox + (g.x + px * g.scale) * s * p.stretch - p.shear * y + shift, p.oy + y];
    });
    if (thickness) contours = embolden(contours, thickness);
    out.push(contours.map((contour) => contour.map(([u, v]) => map(u, v))));
  }
  return out;
}
