/**
 * Image clean-up before recognition. Everything is plain typed-array code so it runs identically in the
 * browser and in node. Every geometric step records a matrix that maps the processed pixel back to the
 * pixel of the original render (geom.ts convention: apply(m, p)).
 */
import { IDENTITY, multiply } from "../engine/geom";
import type { Matrix } from "../engine/types";

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Prepared {
  image: Gray;
  /** processed pixel -> original render pixel */
  toSource: Matrix;
}

/** above this many pixels the page is halved first (memory and speed on phones) */
const MAX_PIXELS = 18_000_000;

export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const a = rgba[j + 3]!;
    let v = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
    if (a !== 255) v = ((v * a + 255 * (255 - a)) / 255) | 0;
    data[i] = v;
  }
  return { data, width, height };
}

/** integer box downscale */
export function shrink(image: Gray, factor: number): Gray {
  if (factor <= 1) return image;
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const data = new Uint8Array(width * height);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        let at = (y * factor + dy) * image.width + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += image.data[at++]!;
      }
      data[y * width + x] = (sum / area) | 0;
    }
  }
  return { data, width, height };
}

export function histogram(image: Gray, step = 1): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < image.data.length; i += step) h[image.data[i]!]!++;
  return h;
}

export function percentile(hist: Uint32Array, p: number): number {
  let total = 0;
  for (const v of hist) total += v;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc >= total * p) return i;
  }
  return 255;
}

export function otsu(hist: Uint32Array): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i]!;
    sum += i * hist[i]!;
  }
  let w = 0;
  let s = 0;
  let best = -1;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    w += hist[i]!;
    if (!w) continue;
    const rest = total - w;
    if (!rest) break;
    s += i * hist[i]!;
    const d = s / w - (sum - s) / rest;
    const between = w * rest * d * d;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/** light text on a dark page becomes dark text on a light page */
export function invertIfDark(image: Gray): Gray {
  if (percentile(histogram(image, 7), 0.5) >= 100) return image;
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - image.data[i]!;
  return { ...image, data };
}

/**
 * Divide by the local paper brightness: removes coloured paper, shadows and gradients without
 * binarising (the recogniser likes smooth glyph edges). Dark areas (banners) are left alone.
 */
export function flattenBackground(image: Gray): Gray {
  const { width, height } = image;
  const cell = Math.max(16, Math.round(Math.max(width, height) / 90));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const grid = new Float32Array(cols * rows);
  const hist = new Uint32Array(256);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      hist.fill(0);
      const y1 = Math.min(height, (r + 1) * cell);
      const x1 = Math.min(width, (c + 1) * cell);
      for (let y = r * cell; y < y1; y += 2) for (let x = c * cell; x < x1; x++) hist[image.data[y * width + x]!]!++;
      grid[r * cols + c] = percentile(hist, 0.9);
    }
  }
  // median of the 3x3 neighbourhood removes cells fooled by a picture or a thick heading
  const smooth = new Float32Array(grid.length);
  const near: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      near.length = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) near.push(grid[rr * cols + cc]!);
        }
      }
      near.sort((a, b) => a - b);
      const median = near[near.length >> 1]!;
      smooth[r * cols + c] = median < 90 ? 255 : median;
    }
  }
  const out = new Uint8Array(image.data.length);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.max(0, y / cell - 0.5));
    const r0 = Math.floor(gy);
    const r1 = Math.min(rows - 1, r0 + 1);
    const fy = gy - r0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(cols - 1, Math.max(0, x / cell - 0.5));
      const c0 = Math.floor(gx);
      const c1 = Math.min(cols - 1, c0 + 1);
      const fx = gx - c0;
      const top = smooth[r0 * cols + c0]! * (1 - fx) + smooth[r0 * cols + c1]! * fx;
      const bottom = smooth[r1 * cols + c0]! * (1 - fx) + smooth[r1 * cols + c1]! * fx;
      const bg = Math.max(60, top * (1 - fy) + bottom * fy);
      const v = (image.data[y * width + x]! * 255) / bg;
      out[y * width + x] = v > 255 ? 255 : v;
    }
  }
  return { data: out, width, height };
}

/** share of pixels that are lonely specks, plus the grain of the paper */
export function noiseLevel(image: Gray): { speckle: number; grain: number } {
  const { data, width, height } = image;
  let speckles = 0;
  let seen = 0;
  let grainSum = 0;
  let grainCount = 0;
  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      const i = y * width + x;
      const v = data[i]!;
      const l = data[i - 1]!;
      const r = data[i + 1]!;
      const u = data[i - width]!;
      const d = data[i + width]!;
      seen++;
      const lo = Math.min(l, r, u, d);
      const hi = Math.max(l, r, u, d);
      if ((v < lo - 90 && lo > 150) || (v > hi + 90 && hi < 110)) speckles++;
      if (lo > 190 && v > 190) {
        grainSum += Math.abs(4 * v - l - r - u - d) / 4;
        grainCount++;
      }
    }
  }
  return { speckle: seen ? speckles / seen : 0, grain: grainCount ? grainSum / grainCount : 0 };
}

export function median3(image: Gray): Gray {
  const { data, width, height } = image;
  const out = data.slice();
  const v = new Uint8Array(9);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      // flat paper needs no sorting
      if (data[i]! > 235 && data[i - 1]! > 235 && data[i + 1]! > 235) continue;
      let n = 0;
      for (let dy = -width; dy <= width; dy += width) for (let dx = -1; dx <= 1; dx++) v[n++] = data[i + dy + dx]!;
      for (let a = 1; a < 9; a++) {
        const t = v[a]!;
        let b = a - 1;
        while (b >= 0 && v[b]! > t) {
          v[b + 1] = v[b]!;
          b--;
        }
        v[b + 1] = t;
      }
      out[i] = v[4]!;
    }
  }
  return { data: out, width, height };
}

/**
 * Baseline tilt in degrees (positive = text runs downwards to the right), from the sharpness of the
 * horizontal projection profile. 0 when no clear angle exists.
 */
export function estimateSkew(image: Gray, limit = 12): number {
  const small = shrink(image, Math.max(1, Math.round(image.width / 1000)));
  const threshold = Math.min(otsu(histogram(small)), 190);
  const xs: number[] = [];
  const ys: number[] = [];
  let dark = 0;
  for (let i = 0; i < small.data.length; i++) if (small.data[i]! < threshold) dark++;
  if (dark < 200 || dark > small.data.length * 0.45) return 0;
  const keep = Math.max(1, Math.floor(dark / 50_000));
  let n = 0;
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      if (small.data[y * small.width + x]! < threshold && n++ % keep === 0) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  const span = small.height + small.width;
  const bins = new Float64Array(span * 2);
  const score = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const p = ys[i]! - xs[i]! * t + small.width;
      const b = Math.floor(p);
      const f = p - b;
      bins[b] = bins[b]! + (1 - f);
      bins[b + 1] = bins[b + 1]! + f;
    }
    let s = 0;
    for (let i = 1; i < bins.length; i++) {
      const d = bins[i]! - bins[i - 1]!;
      s += d * d;
    }
    return s;
  };
  let best = 0;
  let bestScore = score(0);
  const zero = bestScore;
  const search = (from: number, to: number, step: number) => {
    for (let a = from; a <= to + 1e-9; a += step) {
      const s = score(a);
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
  };
  search(-limit, limit, 0.5);
  search(best - 0.4, best + 0.4, 0.1);
  search(best - 0.08, best + 0.08, 0.02);
  if (Math.abs(best) < 0.15 || Math.abs(best) >= limit - 0.05 || bestScore < zero * 1.03) return 0;
  return best;
}

/** rotate so that a baseline tilted by `degrees` becomes horizontal */
export function deskew(image: Gray, degrees: number): Prepared {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const { width, height } = image;
  const w = Math.ceil(Math.abs(width * cos) + Math.abs(height * sin));
  const h = Math.ceil(Math.abs(width * sin) + Math.abs(height * cos));
  // new -> old: rotate by +a about the centres
  const toSource: Matrix = [
    cos,
    sin,
    -sin,
    cos,
    width / 2 - (w / 2) * cos + (h / 2) * sin,
    height / 2 - (w / 2) * sin - (h / 2) * cos,
  ];
  const data = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    let sx = (y + 0.5) * toSource[2] + 0.5 * toSource[0] + toSource[4] - 0.5;
    let sy = (y + 0.5) * toSource[3] + 0.5 * toSource[1] + toSource[5] - 0.5;
    for (let x = 0; x < w; x++, sx += cos, sy += sin) {
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) continue;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * width + x0;
      const right = x0 + 1 < width ? 1 : 0;
      const down = y0 + 1 < height ? width : 0;
      const top = image.data[i]! * (1 - fx) + image.data[i + right]! * fx;
      const bottom = image.data[i + down]! * (1 - fx) + image.data[i + down + right]! * fx;
      data[y * w + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return { image: { data, width: w, height: h }, toSource };
}

/** turn the image clockwise by a quarter-turn multiple */
export function turn(image: Gray, degrees: 0 | 90 | 180 | 270): Prepared {
  if (degrees === 0) return { image, toSource: [...IDENTITY] };
  const { width, height } = image;
  const swap = degrees !== 180;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const toSource: Matrix =
    degrees === 90 ? [0, -1, 1, 0, 0, height] : degrees === 180 ? [-1, 0, 0, -1, width, height] : [0, 1, -1, 0, width, 0];
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = degrees === 90 ? y : degrees === 180 ? width - 1 - x : width - 1 - y;
      const sy = degrees === 90 ? height - 1 - x : degrees === 180 ? height - 1 - y : x;
      data[y * w + x] = image.data[sy * width + sx]!;
    }
  }
  return { image: { data, width: w, height: h }, toSource };
}

/**
 * Erase table borders and other long thin rules before recognition: a border touching a letter is read
 * as part of it. Works on the straightened page; letters never run this far in one straight line.
 */
export function removeRules(image: Gray, dpi: number): Gray {
  const { width, height, data } = image;
  const thick = Math.max(3, Math.round(dpi * 0.035));
  const out = data.slice();
  /** `lines` parallel scan lines of `length` pixels; `along` steps inside a line, `across` to the next */
  const sweep = (source: Uint8Array, lines: number, length: number, along: number, across: number, minimum: number) => {
    for (let k = 0; k < lines; k++) {
      let start = 0;
      for (let t = 0; t <= length; t++) {
        if (t < length && source[k * across + t * along]! < 160) continue;
        if (t - start >= minimum) {
          for (let q = start; q < t; q++) {
            const i = k * across + q * along;
            // how thick is the dark stripe here? solid areas stay
            let before = 0;
            let after = 0;
            while (before <= thick && k - before - 1 >= 0 && source[i - (before + 1) * across]! < 160) before++;
            while (after <= thick && k + after + 1 < lines && source[i + (after + 1) * across]! < 160) after++;
            if (before + after + 1 > thick) continue;
            for (let d = -before - 1; d <= after + 1; d++) if (k + d >= 0 && k + d < lines) out[i + d * across] = 255;
          }
        }
        start = t + 1;
      }
    }
  };
  // vertical rules, then horizontal ones; the second pass reads the result of the first, so that
  // crossings (which are thick in one direction) go too instead of staying behind as dots
  sweep(data, width, height, width, 1, Math.round(dpi * 0.6));
  sweep(out.slice(), height, width, 1, width, Math.round(dpi * 1.5));
  return { data: out, width, height };
}

/** grey level clean-up (no geometry except the size cap) */
export function cleanImage(source: Gray): Prepared {
  let image = source;
  let toSource: Matrix = [...IDENTITY];
  if (image.width * image.height > MAX_PIXELS) {
    const f = Math.ceil(Math.sqrt((image.width * image.height) / MAX_PIXELS));
    image = shrink(image, f);
    toSource = [f, 0, 0, f, 0, 0];
  }
  image = flattenBackground(invertIfDark(image));
  const noise = noiseLevel(image);
  if (noise.speckle > 0.0015 || noise.grain > 9) image = median3(image);
  return { image, toSource };
}

export function straighten(prepared: Prepared): Prepared {
  const angle = estimateSkew(prepared.image);
  if (Math.abs(angle) < 0.25) return prepared;
  const turned = deskew(prepared.image, angle);
  return { image: turned.image, toSource: multiply(turned.toSource, prepared.toSource) };
}

/** Netpbm grey image: trivial to write and read natively by Leptonica */
export function encodePGM(image: Gray): Uint8Array {
  const header = `P5\n${image.width} ${image.height}\n255\n`;
  const out = new Uint8Array(header.length + image.data.length);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(image.data, header.length);
  return out;
}

/** the busiest horizontal band of the page, used for cheap language probes */
export function densestBand(image: Gray, bandHeight: number): Gray {
  const { width, height, data } = image;
  if (height <= bandHeight) return image;
  const rows = new Float64Array(height + 1);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x += 3) if (data[y * width + x]! < 140) n++;
    // very dark rows are pictures or borders, not text
    rows[y + 1] = rows[y]! + (n > width / 6 ? 0 : n);
  }
  let best = 0;
  let at = 0;
  for (let y = 0; y + bandHeight <= height; y += 20) {
    const v = rows[y + bandHeight]! - rows[y]!;
    if (v > best) {
      best = v;
      at = y;
    }
  }
  return { width, height: bandHeight, data: data.slice(at * width, (at + bandHeight) * width) };
}
