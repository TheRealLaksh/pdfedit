/**
 * Separates the letters of one line from whatever lies behind them: paper, flat colour, gradients or a
 * photograph. Works on colour, not only on lightness, so coloured lettering on coloured ground is found.
 */
import { homography, invert, project, quadSize, type Mat3 } from "../geometry";
import { clamp, components, dilate, quantile } from "../raster";
import { pushPull } from "../erase";
import type { Picture, Pt, Quad4, Rgb } from "../types";

export interface Segmentation {
  quad: Quad4;
  /** size of the line's upright frame */
  width: number;
  height: number;
  /** frame to picture, and back */
  toImage: Mat3;
  toFrame: Mat3;
  /** the part of the picture looked at */
  x: number;
  y: number;
  w: number;
  h: number;
  /** w*h*3 */
  rgb: Float32Array;
  /** background colour estimated under every pixel, w*h*3 */
  ground: Float32Array;
  /** frame coordinates of every pixel centre */
  u: Float32Array;
  v: Float32Array;
  /** how far each pixel is covered by this line's letters, 0..1 */
  alpha: Float32Array;
  /** pixels that belong to this line's letters, soft edges included */
  letters: Uint8Array;
  /** ink that is not this line's (other lines, rules, art): never erased, never copied */
  other: Uint8Array;
  color: Rgb;
  paper: Rgb;
  /** colour distance between letters and ground */
  contrast: number;
  /** noise of the background per channel, levels */
  noise: Rgb;
  busy: boolean;
  blank: boolean;
  /** screen text smoothing with coloured edges */
  subpixel: boolean;
  /** a hard drop shadow behind the letters */
  shadow: Shadow | null;
}

export interface Shadow {
  /** offset in picture pixels */
  dx: number;
  dy: number;
  color: Rgb;
}

/** looks for an offset copy of the letters that is darker than the ground */
function findShadow(rgb: Float32Array, ground: Float32Array, letters: Uint8Array, w: number, h: number, height: number): Shadow | null {
  const reach = clamp(Math.round(height * 0.07), 2, 9);
  const near = dilate(letters, w, h, 1);
  const around = dilate(letters, w, h, reach + 2);
  const dark = new Float32Array(w * h);
  const light = (a: Float32Array, i: number) => a[i * 3]! * 0.3 + a[i * 3 + 1]! * 0.59 + a[i * 3 + 2]! * 0.11;
  let total = 0;
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (near[i] || !around[i]) continue;
    dark[i] = light(ground, i) - light(rgb, i);
    total += dark[i]!;
    count++;
  }
  if (count < 40) return null;
  let best: [number, number] | null = null;
  let value = 0;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 2) continue;
      let sum = 0;
      let n = 0;
      let hits = 0;
      for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y++)
        for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x++) {
          const i = y * w + x;
          if (near[i] || !letters[(y - dy) * w + x - dx]) continue;
          sum += dark[i]!;
          n++;
          if (dark[i]! > 28) hits++;
        }
      if (n < 30 || hits < n * 0.72) continue;
      const rest = (total - sum) / Math.max(1, count - n);
      const score = sum / n - Math.max(0, rest);
      if (score > value) {
        value = score;
        best = [dx, dy];
      }
    }
  }
  if (!best || value < 30) return null;
  const [dx, dy] = best;
  const samples: number[][] = [[], [], []];
  for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y++)
    for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x++) {
      const i = y * w + x;
      if (near[i] || !letters[(y - dy) * w + x - dx] || dark[i]! <= 28) continue;
      for (let c = 0; c < 3; c++) samples[c]!.push(rgb[i * 3 + c]!);
    }
  return { dx, dy, color: samples.map((s) => Math.round(quantile(s, 0.35))) as Rgb };
}

/**
 * Coloured fringes on the sides of letters, as screens draw text: the first colour of a screen pixel leads
 * on one side of a stroke and trails on the other.
 */
function hasSubpixel(rgb: Float32Array, ground: Float32Array, alpha: Float32Array, letters: Uint8Array, color: number[], paper: number[]): boolean {
  const span = [0, 1, 2].map((c) => Math.abs(color[c]! - paper[c]!));
  const first = span[0]! >= 70 ? 0 : -1;
  const second = span[2]! >= 70 ? 2 : span[1]! >= 70 ? 1 : -1;
  if (first < 0 || second < 0) return false;
  let rising = 0;
  let risingCount = 0;
  let falling = 0;
  let fallingCount = 0;
  for (let i = 1; i < alpha.length - 1; i++) {
    const a = alpha[i]!;
    if (a < 0.12 || a > 0.88 || !letters[i]) continue;
    const slope = alpha[i + 1]! - alpha[i - 1]!;
    if (Math.abs(slope) < 0.3) continue;
    const one = (rgb[i * 3 + first]! - ground[i * 3 + first]!) / (color[first]! - ground[i * 3 + first]! || 1);
    const two = (rgb[i * 3 + second]! - ground[i * 3 + second]!) / (color[second]! - ground[i * 3 + second]! || 1);
    if (slope > 0) {
      rising += one - two;
      risingCount++;
    } else {
      falling += one - two;
      fallingCount++;
    }
  }
  if (risingCount < 20 || fallingCount < 20) return false;
  const limit = second === 2 ? 0.1 : 0.06;
  return rising / risingCount < -limit && falling / fallingCount > limit;
}

const distance = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
  Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);

/** representative colours of a set of pixels (k-means with a deterministic start) */
function clusters(rgb: Float32Array, pixels: Int32Array, k: number): Float32Array {
  const step = Math.max(1, Math.floor(pixels.length / 4000));
  const set: number[] = [];
  for (let i = 0; i < pixels.length; i += step) set.push(pixels[i]! * 3);
  const centres = new Float32Array(k * 3);
  const mean = [0, 0, 0];
  for (const i of set) for (let c = 0; c < 3; c++) mean[c]! += rgb[i + c]! / set.length;
  // farthest point start
  const near = new Float32Array(set.length).fill(Infinity);
  let pick = 0;
  let far = -1;
  set.forEach((i, n) => {
    const d = distance(rgb, i, mean, 0);
    if (d > far) {
      far = d;
      pick = n;
    }
  });
  for (let c = 0; c < k; c++) {
    for (let j = 0; j < 3; j++) centres[c * 3 + j] = rgb[set[pick]! + j]!;
    far = -1;
    set.forEach((i, n) => {
      near[n] = Math.min(near[n]!, distance(rgb, i, centres, c * 3));
      if (near[n]! > far) {
        far = near[n]!;
        pick = n;
      }
    });
  }
  const sum = new Float64Array(k * 3);
  const count = new Float64Array(k);
  for (let it = 0; it < 12; it++) {
    sum.fill(0);
    count.fill(0);
    for (const i of set) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = distance(rgb, i, centres, c * 3);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      count[best]!++;
      for (let j = 0; j < 3; j++) sum[best * 3 + j]! += rgb[i + j]!;
    }
    for (let c = 0; c < k; c++) if (count[c]) for (let j = 0; j < 3; j++) centres[c * 3 + j] = sum[c * 3 + j]! / count[c]!;
  }
  return centres;
}

const nearest = (centres: Float32Array, rgb: Float32Array, i: number) => {
  let best = 0;
  let bd = Infinity;
  for (let c = 0; c < centres.length / 3; c++) {
    const d = distance(rgb, i, centres, c * 3);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
};

export function segment(picture: Picture, quad: Quad4): Segmentation {
  const { width, height } = quadSize(quad);
  const margin = Math.ceil(Math.max(8, height * 0.55));
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x = clamp(Math.floor(Math.min(...xs) - margin), 0, picture.width - 1);
  const y = clamp(Math.floor(Math.min(...ys) - margin), 0, picture.height - 1);
  const w = clamp(Math.ceil(Math.max(...xs) + margin), x + 1, picture.width) - x;
  const h = clamp(Math.ceil(Math.max(...ys) + margin), y + 1, picture.height) - y;
  const size = w * h;
  const toImage = homography(width, height, quad);
  const toFrame = invert(toImage);

  const rgb = new Float32Array(size * 3);
  const u = new Float32Array(size);
  const v = new Float32Array(size);
  const pad = Math.max(1.5, height * 0.06);
  /** 2 = inside the box, 1 = the narrow band around it, 0 = further out */
  const zone = new Uint8Array(size);
  const band = Math.max(3, height * 0.2);
  for (let j = 0, i = 0; j < h; j++) {
    for (let k = 0; k < w; k++, i++) {
      const at = ((j + y) * picture.width + k + x) * 4;
      const a = picture.data[at + 3]! / 255;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = picture.data[at + c]! * a + 255 * (1 - a);
      const p = project(toFrame, k + x + 0.5, j + y + 0.5);
      u[i] = p[0];
      v[i] = p[1];
      if (p[0] >= -pad && p[0] <= width + pad && p[1] >= -pad && p[1] <= height + pad) zone[i] = 2;
      else if (p[0] >= -pad - band && p[0] <= width + pad + band && p[1] >= -pad - band && p[1] <= height + pad + band) zone[i] = 1;
    }
  }

  const inside: number[] = [];
  const around: number[] = [];
  for (let i = 0; i < size; i++) (zone[i] === 2 ? inside : zone[i] === 1 ? around : []).push(i);
  if (around.length < 12) around.push(...inside);

  const K = 5;
  const centres = clusters(rgb, Int32Array.from(inside.length ? inside : around), K);
  const inCount = new Float64Array(K);
  const bandCount = new Float64Array(K);
  for (const i of inside) inCount[nearest(centres, rgb, i * 3)]!++;
  const bandOwn = new Float64Array(K);
  const bandSum = new Float64Array(K * 3);
  for (const i of around) {
    const c = nearest(centres, rgb, i * 3);
    bandCount[c]!++;
    if (distance(rgb, i * 3, centres, c * 3) < 45) {
      bandOwn[c]!++;
      for (let j = 0; j < 3; j++) bandSum[c * 3 + j]! += rgb[i * 3 + j]!;
    }
  }
  // the ground is what surrounds the box
  let groundAt = 0;
  for (let c = 1; c < K; c++) if (bandCount[c]! > bandCount[groundAt]!) groundAt = c;
  const groundColour = [0, 0, 0].map((_, j) => (bandOwn[groundAt] ? bandSum[groundAt * 3 + j]! / bandOwn[groundAt]! : centres[groundAt * 3 + j]!));
  // the letters are the colour that is far from it and much commoner inside the box than around it
  let inkAt = -1;
  let best = 0;
  for (let c = 0; c < K; c++) {
    if (c === groundAt) continue;
    const d = distance(centres, c * 3, groundColour, 0);
    const own = inCount[c]! / Math.max(1, inside.length);
    const outer = bandCount[c]! / Math.max(1, around.length);
    const score = d * d * Math.sqrt(Math.max(0, own - 0.6 * outer)) * Math.min(1, own / 0.03);
    if (score > best) {
      best = score;
      inkAt = c;
    }
  }
  const ink = inkAt < 0 ? groundColour.map((g) => (g > 128 ? 0 : 255)) : [0, 1, 2].map((j) => centres[inkAt * 3 + j]!);
  // further colours of the surroundings (mortar between bricks, a second shade of a design)
  const others: number[] = [];
  for (let c = 0; c < K; c++) if (c !== inkAt && c !== groundAt && bandCount[c]! > around.length * 0.07 && distance(centres, c * 3, groundColour, 0) > 36) others.push(c);

  // first picture of the ground: a robust plane through the surroundings
  const plane = fitPlane(rgb, u, v, around, groundColour);
  let ground = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) for (let c = 0; c < 3; c++) ground[i * 3 + c] = plane(c, u[i]!, v[i]!);

  const raw = new Float32Array(size);
  const off = new Float32Array(size);
  const project3 = () => {
    for (let i = 0; i < size; i++) {
      let dot = 0;
      let len = 0;
      for (let c = 0; c < 3; c++) {
        const d = ink[c]! - ground[i * 3 + c]!;
        dot += (rgb[i * 3 + c]! - ground[i * 3 + c]!) * d;
        len += d * d;
      }
      const a = len > 1 ? dot / len : 0;
      raw[i] = a;
      let r = 0;
      for (let c = 0; c < 3; c++) r += (rgb[i * 3 + c]! - ground[i * 3 + c]! - a * (ink[c]! - ground[i * 3 + c]!)) ** 2;
      off[i] = Math.sqrt(r);
    }
  };
  const isText = (i: number, from: number) => {
    const span = distance(ink, 0, ground, i * 3);
    if (!(span > 14 && raw[i]! > from && off[i]! < Math.max(34, span * 0.55))) return false;
    if (!others.length) return true;
    const mine = distance(rgb, i * 3, ink, 0);
    return others.every((c) => distance(centres, c * 3, ink, 0) < span * 0.3 || mine < distance(rgb, i * 3, centres, c * 3) * 1.1);
  };

  for (let round = 0; round < 3; round++) {
    project3();
    // the true colour of the letters is that of their innermost pixels
    const core: number[] = [];
    const strength: number[] = [];
    for (const i of inside) if (isText(i, 0.5)) {
      core.push(i);
      strength.push(raw[i]!);
    }
    if (core.length >= 4) {
      const lo = quantile(strength, 0.55);
      const hi = quantile(strength, 0.97);
      const sum = [0, 0, 0];
      let n = 0;
      core.forEach((i, k) => {
        if (strength[k]! < lo || strength[k]! > hi) return;
        for (let c = 0; c < 3; c++) sum[c]! += rgb[i * 3 + c]!;
        n++;
      });
      if (n) for (let c = 0; c < 3; c++) ink[c] = sum[c]! / n;
      project3();
    }
    if (round === 2) break;
    const dirty = new Uint8Array(size);
    for (let i = 0; i < size; i++) if (isText(i, 0.12)) dirty[i] = 1;
    const grown = dilate(dirty, w, h, Math.max(1, Math.min(4, Math.round(height * 0.05))));
    let clean = 0;
    for (let i = 0; i < size; i++) if (!grown[i]) clean++;
    if (clean > size * 0.08) ground = pushPull(rgb, w, h, grown);
  }

  // letters: strong pixels, grown into their soft edges
  const strong = new Uint8Array(size);
  const weak = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (isText(i, 0.5)) strong[i] = 1;
    if (isText(i, 0.16)) weak[i] = 1;
  }
  const reach = Math.max(1, Math.min(5, Math.round(height * 0.07)));
  const near = dilate(strong, w, h, reach);
  const all = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (strong[i] || (weak[i] && near[i])) all[i] = 1;

  // which connected pieces belong to this line
  const parts = components(all, w, h);
  const count = parts.area.length;
  const inCore = new Float64Array(count);
  const middle = new Float64Array(count);
  const minU = new Float64Array(count).fill(Infinity);
  const maxU = new Float64Array(count).fill(-Infinity);
  const minV = new Float64Array(count).fill(Infinity);
  const maxV = new Float64Array(count).fill(-Infinity);
  const solid = new Float64Array(count);
  for (let i = 0; i < size; i++) {
    const id = parts.label[i]!;
    if (!id) continue;
    if (zone[i] === 2) inCore[id]!++;
    if (u[i]! >= -pad && u[i]! <= width + pad && v[i]! > height * 0.2 && v[i]! < height * 0.8) middle[id]!++;
    minU[id] = Math.min(minU[id]!, u[i]!);
    maxU[id] = Math.max(maxU[id]!, u[i]!);
    minV[id] = Math.min(minV[id]!, v[i]!);
    maxV[id] = Math.max(maxV[id]!, v[i]!);
    if (strong[i]) solid[id]!++;
  }
  const mine = new Uint8Array(count);
  for (let id = 1; id < count; id++) {
    if (!solid[id]) continue;
    const across = maxU[id]! - minU[id]!;
    const tall = maxV[id]! - minV[id]!;
    // lines and frames that run on past the text
    const rule = (across > height * 1.6 && tall < height * 0.16 && (minU[id]! < -height * 0.5 || maxU[id]! > width + height * 0.5)) ||
      (tall > height * 1.5 && across < height * 0.35);
    if (rule) continue;
    const mostly = inCore[id]! >= parts.area[id]! * 0.7;
    const hangs = middle[id]! > 0 && minV[id]! > -height * 0.4 && maxV[id]! < height * 1.4 && minU[id]! > -height * 0.6 && maxU[id]! < width + height * 0.6;
    if (mostly || hangs) mine[id] = 1;
  }

  const letters = new Uint8Array(size);
  const other = new Uint8Array(size);
  const alpha = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const id = parts.label[i]!;
    if (!id) continue;
    if (mine[id]) letters[i] = 1;
    // a big shape that only passes through the box (art, a frame) keeps what lies outside it
    else if (zone[i] === 2 && inCore[id]! < parts.area[id]! * 0.7 && middle[id]! > parts.area[id]! * 0.5) letters[i] = 1;
    else other[i] = 1;
  }
  const soft = dilate(letters, w, h, 2);
  for (let i = 0; i < size; i++) {
    if (!soft[i] || other[i]) continue;
    const a = clamp(raw[i]!, 0, 1);
    const span = distance(ink, 0, ground, i * 3);
    if (off[i]! < Math.max(40, span * 0.65)) alpha[i] = a < 0.04 ? 0 : a;
    else if (letters[i]) alpha[i] = a * 0.5;
  }

  // noise and detail of the background, where nothing else is
  const busyMask = dilate(all, w, h, 2);
  const residual: number[][] = [[], [], []];
  for (let j = 1; j < h - 1; j += 1) {
    for (let k = 1; k < w - 1; k += 1) {
      const i = j * w + k;
      if (busyMask[i] || !zone[i]) continue;
      for (let c = 0; c < 3; c++) {
        // difference from the mean of the four neighbours: gradients cancel out
        const d = rgb[i * 3 + c]! - (rgb[(i - 1) * 3 + c]! + rgb[(i + 1) * 3 + c]! + rgb[(i - w) * 3 + c]! + rgb[(i + w) * 3 + c]!) / 4;
        residual[c]!.push(Math.abs(d));
      }
    }
  }
  // for white noise the deviation of that difference is sqrt(1.25) times the noise itself
  const noise = residual.map((r) => (r.length > 20 ? (quantile(r, 0.5) * 1.4826) / 1.118 : 0)) as Rgb;
  const misfit: number[] = [];
  for (const i of around) if (!busyMask[i]) misfit.push(Math.hypot(...[0, 1, 2].map((c) => rgb[i * 3 + c]! - plane(c, u[i]!, v[i]!))));
  const busy = misfit.length > 20 && quantile(misfit, 0.75) > 24;

  let found = 0;
  const paper = [0, 0, 0];
  for (let i = 0; i < size; i++) {
    if (!letters[i]) continue;
    found++;
    for (let c = 0; c < 3; c++) paper[c]! += ground[i * 3 + c]!;
  }
  const paperColour = (found ? paper.map((s) => s / found) : groundColour) as Rgb;
  const contrast = distance(ink, 0, paperColour, 0);
  const blank = found < Math.max(6, inside.length * 0.008) || contrast < 18;
  const subpixel = !blank && height < 60 && hasSubpixel(rgb, ground, alpha, letters, ink, paperColour);
  if (subpixel) {
    // with coloured edges each colour reaches its true value at different pixels: take them one by one
    for (let c = 0; c < 3; c++) {
      const values: number[] = [];
      for (let i = 0; i < size; i++) if (letters[i] && alpha[i]! > 0.55) values.push(rgb[i * 3 + c]!);
      if (values.length > 12) ink[c] = quantile(values, ink[c]! < paperColour[c]! ? 0.2 : 0.8);
    }
  }
  const shadow = blank ? null : findShadow(rgb, ground, letters, w, h, height);
  if (shadow) {
    // the shadow leaves with the letters and is no evidence about the ground
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const from = (y - shadow.dy) * w + x - shadow.dx;
        if (y - shadow.dy < 0 || y - shadow.dy >= h || x - shadow.dx < 0 || x - shadow.dx >= w || !letters[from] || letters[i]) continue;
        other[i] = 0;
      }
  }
  return {
    shadow,
    quad, width, height, toImage, toFrame, x, y, w, h, rgb, ground, u, v, alpha, letters, other,
    color: ink.map((c) => Math.round(clamp(c, 0, 255))) as Rgb,
    paper: paperColour.map(Math.round) as Rgb,
    contrast,
    noise,
    busy,
    blank,
    subpixel,
  };
}

/** per channel a + b*u + c*v through the pixels, ignoring those that do not fit */
function fitPlane(rgb: Float32Array, u: Float32Array, v: Float32Array, pixels: number[], start: number[]) {
  let model = start.map((s) => [s, 0, 0]);
  for (let round = 0; round < 4; round++) {
    const limit = [90, 50, 32, 24][round]!;
    const m = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(() => 0);
    const rhs = [0, 1, 2].map(() => [0, 0, 0]);
    for (const i of pixels) {
      let miss = 0;
      for (let c = 0; c < 3; c++) miss += (rgb[i * 3 + c]! - model[c]![0]! - model[c]![1]! * u[i]! - model[c]![2]! * v[i]!) ** 2;
      if (miss > limit * limit) continue;
      const row = [1, u[i]!, v[i]!];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) m[a * 3 + b]! += row[a]! * row[b]!;
        for (let c = 0; c < 3; c++) rhs[c]![a]! += row[a]! * rgb[i * 3 + c]!;
      }
    }
    if (m[0]! < 8) break;
    // a little ridge keeps the slopes sane when the pixels lie in one place
    m[4]! += m[0]! * 4;
    m[8]! += m[0]! * 4;
    const inv = invert(m as Mat3);
    model = rhs.map((r) => [0, 1, 2].map((a) => inv[a * 3]! * r[0]! + inv[a * 3 + 1]! * r[1]! + inv[a * 3 + 2]! * r[2]!));
  }
  return (c: number, pu: number, pv: number) => model[c]![0]! + model[c]![1]! * pu + model[c]![2]! * pv;
}

/** picture coordinates of a frame point */
export const framePoint = (s: Segmentation, u: number, v: number): Pt => project(s.toImage, u, v);

/**
 * The box tightened to the letters, and straightened when the first guess was tilted. Returns the new
 * quad, or null when there is nothing to measure.
 */
export function tighten(s: Segmentation, straighten: boolean): Quad4 | null {
  if (s.blank) return null;
  const us: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i < s.alpha.length; i++) {
    if (s.alpha[i]! < 0.5 || !s.letters[i]) continue;
    us.push(s.u[i]!);
    vs.push(s.v[i]!);
  }
  if (us.length < 6) return null;
  let angle = 0;
  if (straighten && s.width > s.height * 4) {
    const bins = new Float64Array(Math.ceil(s.height * 6) + 8);
    const sharpness = (radians: number) => {
      bins.fill(0);
      const sin = Math.sin(radians);
      const cos = Math.cos(radians);
      for (let i = 0; i < us.length; i++) {
        const at = (-sin * (us[i]! - s.width / 2) + cos * (vs[i]! - s.height / 2)) * 1 + bins.length / 2;
        const low = Math.floor(at);
        if (low >= 0 && low + 1 < bins.length) {
          bins[low]! += 1 - (at - low);
          bins[low + 1]! += at - low;
        }
      }
      let sum = 0;
      for (const b of bins) sum += b * b;
      return sum;
    };
    const level = sharpness(0);
    let best = level;
    const degree = Math.PI / 180;
    for (const step of [1, 0.25]) {
      const centre = angle;
      for (let d = -4; d <= 4; d++) {
        const a = centre + d * step * degree;
        if (Math.abs(a) > 6 * degree) continue;
        const value = sharpness(a);
        if (value > best) {
          best = value;
          angle = a;
        }
      }
    }
    if (best < level * 1.04 || Math.abs(angle) < 0.35 * degree) angle = 0;
  }
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const cu = s.width / 2;
  const cv = s.height / 2;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < us.length; i++) {
    const a = cos * (us[i]! - cu) + sin * (vs[i]! - cv);
    const b = -sin * (us[i]! - cu) + cos * (vs[i]! - cv);
    u0 = Math.min(u0, a);
    u1 = Math.max(u1, a);
    v0 = Math.min(v0, b);
    v1 = Math.max(v1, b);
  }
  const pad = Math.round(Math.max(2, (v1 - v0) * 0.12));
  const back = (a: number, b: number) => framePoint(s, cu + cos * a - sin * b, cv + sin * a + cos * b);
  const quad: Quad4 = [back(u0 - 0.5 - pad, v0 - 0.5 - pad), back(u1 + 0.5 + pad, v0 - 0.5 - pad), back(u1 + 0.5 + pad, v1 + 0.5 + pad), back(u0 - 0.5 - pad, v1 + 0.5 + pad)];
  // whole pixels for upright boxes: kept letters then move without being resampled
  if (!angle && Math.abs(s.quad[0][1] - s.quad[1][1]) < 1e-3 && Math.abs(s.quad[0][0] - s.quad[3][0]) < 1e-3)
    return quad.map(([a, b]) => [Math.round(a), Math.round(b)]) as Quad4;
  return quad;
}
