/**
 * Where lettering sits on plain ground (pages, cards, buttons, pills, chips), found from the pixels
 * alone: flat areas of one colour are grounds, the small shapes enclosed by a ground are marks, and
 * marks in a row are a piece of text. The recogniser's own layout analysis passes over short labels on
 * coloured shapes and joins neighbours; this does not. Photographs have no flat ground, so give nothing.
 */
import { components } from "./raster";
import type { Picture } from "./types";

export interface Region {
  /** upright box around the marks, in picture pixels */
  box: [number, number, number, number];
  color: [number, number, number];
  ground: [number, number, number];
  /** separate shapes it is made of */
  marks: number;
}

/** larger pictures are looked at in a smaller copy */
const LOOK = 1600;
/** neighbours of one flat area differ by less than this per channel, and from where it started */
const STEP = 15;
const DRIFT = 36;
const MIN_GROUND = 110;
/** colour distance from the ground that counts as a mark */
const MARK = 54;
/** tallest lettering looked for here (larger is found by the page reading), in pixels of the copy */
const TALL = 70;
const MAX_REGIONS = 220;

/** every n-th block averaged */
function reduce(p: Picture, n: number): Picture {
  if (n <= 1) return p;
  const width = Math.floor(p.width / n);
  const height = Math.floor(p.height / n);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) sum += p.data[((y * n + j) * p.width + x * n + i) * 4 + c]!;
        data[(y * width + x) * 4 + c] = sum / (n * n);
      }
  return { width, height, data };
}

interface Ground {
  area: number;
  box: [number, number, number, number];
  color: [number, number, number];
}

/** flat areas: `label` holds 0 or the number of the ground (index + 1) */
function grounds({ data, width: w, height: h }: Picture): { label: Int32Array; list: Ground[] } {
  const label = new Int32Array(w * h);
  const seen = new Uint8Array(w * h);
  const list: Ground[] = [];
  const stack = new Int32Array(w * h);
  const members = new Int32Array(w * h);
  const apart = (i: number, j: number) =>
    Math.max(Math.abs(data[i * 4]! - data[j * 4]!), Math.abs(data[i * 4 + 1]! - data[j * 4 + 1]!), Math.abs(data[i * 4 + 2]! - data[j * 4 + 2]!));
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const seed = y * w + x;
      // an area starts only where the surroundings are flat, so that its colour is not that of an edge
      if (seen[seed] || apart(seed, seed - 1) > STEP || apart(seed, seed + 1) > STEP || apart(seed, seed - w) > STEP || apart(seed, seed + w) > STEP) continue;
      let top = 0;
      let count = 0;
      stack[top++] = seed;
      seen[seed] = 1;
      let [x0, y0, x1, y1] = [x, y, x, y];
      const sum = [0, 0, 0];
      while (top) {
        const i = stack[--top]!;
        const cx = i % w;
        const cy = (i - cx) / w;
        members[count++] = i;
        for (let c = 0; c < 3; c++) sum[c]! += data[i * 4 + c]!;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        for (const j of [cx > 0 ? i - 1 : -1, cx < w - 1 ? i + 1 : -1, cy > 0 ? i - w : -1, cy < h - 1 ? i + w : -1]) {
          if (j < 0 || seen[j] || apart(i, j) > STEP || apart(seed, j) > DRIFT) continue;
          seen[j] = 1;
          stack[top++] = j;
        }
      }
      if (count < MIN_GROUND || x1 - x0 < 11 || y1 - y0 < 7) continue;
      list.push({ area: count, box: [x0, y0, x1 + 1, y1 + 1], color: sum.map((s) => s / count) as Ground["color"] });
      for (let k = 0; k < count; k++) label[members[k]!] = list.length;
    }
  return { label, list };
}

interface Mark {
  box: [number, number, number, number];
  color: [number, number, number];
  area: number;
}

const far = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** the shapes enclosed by one ground that could be letters */
function marksOn(p: Picture, label: Int32Array, list: Ground[], id: number): Mark[] {
  const ground = list[id - 1]!;
  const [gx0, gy0, gx1, gy1] = ground.box;
  const w = gx1 - gx0;
  const h = gy1 - gy0;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y + gy0) * p.width + x + gx0;
      if (label[i] === id) continue;
      if (Math.hypot(p.data[i * 4]! - ground.color[0], p.data[i * 4 + 1]! - ground.color[1], p.data[i * 4 + 2]! - ground.color[2]) > MARK) mask[y * w + x] = 1;
    }
  const found = components(mask, w, h);
  const out: Mark[] = [];
  for (let n = 1; n < found.box.length; n++) {
    const [x0, y0, x1, y1] = found.box[n]!;
    const tall = y1 - y0;
    const wide = x1 - x0;
    // what reaches the border of the ground comes from outside it
    if (x0 === 0 || y0 === 0 || x1 === w || y1 === h) continue;
    if (tall > TALL || found.area[n]! < 2 || wide > Math.max(24, tall * 24)) continue;
    // rules, underlines and bars
    if ((tall <= 4 && wide >= 16 && wide > tall * 6) || (wide <= 3 && tall > 24 && tall > wide * 14)) continue;
    // letters have bare ground above or below them (beside them are other letters)
    let bare = 0;
    let looked = 0;
    for (const y of [y0 - 3, y0 - 2, y1 + 1, y1 + 2]) {
      if (y < 0 || y >= h) continue;
      for (let x = x0; x < x1; x++) {
        looked++;
        if (!mask[y * w + x]) bare++;
      }
    }
    if (bare < looked * 0.6) continue;
    // shapes with flat ground of their own are pictures, buttons and boxes, not letters
    let flat = 0;
    const colours: { d: number; at: number }[] = [];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (found.label[y * w + x] !== n) continue;
        const i = (y + gy0) * p.width + x + gx0;
        const other = label[i]!;
        if (other && other !== id && list[other - 1]!.area > Math.max(MIN_GROUND * 2, wide * tall * 0.4)) flat++;
        colours.push({ d: (p.data[i * 4]! - ground.color[0]) ** 2 + (p.data[i * 4 + 1]! - ground.color[1]) ** 2 + (p.data[i * 4 + 2]! - ground.color[2]) ** 2, at: i * 4 });
      }
    if (flat > found.area[n]! * 0.5) continue;
    // the ink colour: the part furthest from the ground, as thin strokes are pale at their edges
    colours.sort((a, b) => b.d - a.d);
    const strong = colours.slice(0, Math.max(1, Math.round(colours.length * 0.3)));
    const color = [0, 1, 2].map((c) => strong.reduce((s, q) => s + p.data[q.at + c]!, 0) / strong.length) as Mark["color"];
    out.push({ box: [x0 + gx0, y0 + gy0, x1 + gx0, y1 + gy0], color, area: found.area[n]! });
  }
  return out;
}

interface Row {
  box: [number, number, number, number];
  marks: Mark[];
  color: [number, number, number];
  weight: number;
}

/** marks in a row become one piece; wide gaps, and smaller ones between different colours, part them */
function rows(marks: Mark[]): Row[] {
  const out: Row[] = [];
  const join = (a: Row, b: Row): void => {
    a.box = [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]), Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])];
    const sum = a.weight + b.weight;
    a.color = a.color.map((v, c) => (v * a.weight + b.color[c]! * b.weight) / sum) as Row["color"];
    a.weight = sum;
    a.marks.push(...b.marks);
  };
  const belong = (a: Row, b: Row): boolean => {
    const ha = a.box[3] - a.box[1];
    const hb = b.box[3] - b.box[1];
    const tall = Math.max(ha, hb);
    const low = Math.min(ha, hb);
    const shared = Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]);
    const gap = Math.max(a.box[0], b.box[0]) - Math.min(a.box[2], b.box[2]);
    // dots and accents sit over or under their letters
    if (low < tall * 0.45) {
      if (shared < -tall * 0.22 || gap > tall * 0.5) return false;
    } else if (shared < low * 0.5 || tall > low * 2.4) return false;
    if (gap > tall * 0.72) return false;
    const unlike = far(a.color, b.color);
    return gap <= 1 || unlike < (gap > tall * 0.28 ? 55 : 130);
  };
  for (const mark of [...marks].sort((a, b) => a.box[0] - b.box[0])) {
    let row: Row = { box: [...mark.box], marks: [mark], color: [...mark.color], weight: mark.area };
    // the new mark may close the distance between rows already there
    for (let i = out.length - 1; i >= 0; i--)
      if (belong(out[i]!, row)) {
        join(out[i]!, row);
        row = out.splice(i, 1)[0]!;
      }
    out.push(row);
  }
  return out;
}

/** share of the pixels just outside a box that have the ground's colour */
function bareAround(p: Picture, [x0, y0, x1, y1]: [number, number, number, number], ground: readonly number[]): number {
  let bare = 0;
  let looked = 0;
  const look = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) return;
    const i = (y * p.width + x) * 4;
    looked++;
    if (Math.hypot(p.data[i]! - ground[0]!, p.data[i + 1]! - ground[1]!, p.data[i + 2]! - ground[2]!) <= MARK) bare++;
  };
  for (let x = x0 - 2; x < x1 + 2; x++) {
    look(x, y0 - 2);
    look(x, y1 + 1);
  }
  for (let y = y0 - 1; y < y1 + 1; y++) {
    look(x0 - 2, y);
    look(x1 + 1, y);
  }
  return looked ? bare / looked : 0;
}

export function textRegions(picture: Picture): Region[] {
  const n = Math.max(1, Math.round(Math.max(picture.width, picture.height) / LOOK));
  const small = reduce(picture, n);
  const { label, list } = grounds(small);
  const out: Region[] = [];
  for (let id = 1; id <= list.length; id++) {
    const g = list[id - 1]!;
    for (const row of rows(marksOn(small, label, list, id))) {
      const [x0, y0, x1, y1] = row.box;
      const h = y1 - y0;
      const w = x1 - x0;
      if (h < 6 || h > TALL || w < h * 0.3 || w * h < 24) continue;
      // lettering is meant to be seen: faint shapes are shading
      if (far(row.color, g.color) < 80) continue;
      const ink = row.marks.reduce((s, m) => s + m.area, 0) / (w * h);
      if (ink < 0.1 || ink > 0.9) continue;
      // texture, such as grain or a pattern, is very many tiny shapes
      if (row.marks.length > (w / h) * 7 + 4) continue;
      // lettering stands on its ground: shapes cut out of a busy picture do not
      if (bareAround(small, row.box, g.color) < 0.88) continue;
      out.push({ box: [x0 * n, y0 * n, x1 * n, y1 * n], color: row.color, ground: g.color, marks: row.marks.length });
    }
  }
  // the same marks can be enclosed by two grounds: the larger piece stays
  const area = (r: Region) => (r.box[2] - r.box[0]) * (r.box[3] - r.box[1]);
  const kept: Region[] = [];
  for (const r of out.sort((a, b) => area(b) - area(a))) {
    const covered = kept.some((k) => {
      const wide = Math.min(k.box[2], r.box[2]) - Math.max(k.box[0], r.box[0]);
      const high = Math.min(k.box[3], r.box[3]) - Math.max(k.box[1], r.box[1]);
      return wide > 0 && high > 0 && wide * high > area(r) * 0.6;
    });
    if (!covered) kept.push(r);
  }
  return kept.sort((a, b) => b.marks - a.marks).slice(0, MAX_REGIONS).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}
