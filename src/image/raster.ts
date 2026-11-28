/** Small operations on single channel planes. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** square dilation by `r` pixels */
export function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array<ArrayBuffer> {
  if (r <= 0) return new Uint8Array(src);
  const pass = (input: Uint8Array, lines: number, length: number, step: number, stride: number) => {
    const out = new Uint8Array(input.length);
    for (let k = 0; k < lines; k++) {
      const base = k * stride;
      let reach = -1;
      for (let t = 0; t < length; t++) {
        if (!input[base + t * step]) continue;
        for (let q = Math.max(reach + 1, t - r); q <= Math.min(length - 1, t + r); q++) {
          out[base + q * step] = 1;
          reach = q;
        }
      }
    }
    return out;
  };
  return pass(pass(src, h, w, 1, w), w, h, w, 1);
}

export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/** separable Gaussian blur; edges repeat */
export function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array<ArrayBuffer> {
  if (sigma < 0.12) return new Float32Array(src);
  const k = gaussianKernel(sigma);
  const r = k.length >> 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const used = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w && !any; x++) any = src[row + x] !== 0;
    if (!any) continue;
    used[y] = 1;
    for (let x = 0; x < w; x++) {
      let v = 0;
      if (x >= r && x < w - r) for (let i = -r; i <= r; i++) v += src[row + x + i]! * k[i + r]!;
      else
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          v += src[row + (xx < 0 ? 0 : xx >= w ? w - 1 : xx)]! * k[i + r]!;
        }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let i = -r; i <= r; i++) {
      const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
      if (!used[yy]) continue;
      const weight = k[i + r]!;
      const from = yy * w;
      const to = y * w;
      for (let x = 0; x < w; x++) out[to + x]! += tmp[from + x]! * weight;
    }
  }
  return out;
}

/** bilinear sample (pixel centres at +0.5) with clamped edges */
export function sample(plane: ArrayLike<number>, w: number, h: number, x: number, y: number, n = 1, c = 0): number {
  const fx = clamp(x - 0.5, 0, w - 1);
  const fy = clamp(y - 0.5, 0, h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const top = plane[(y0 * w + x0) * n + c]! * (1 - ax) + plane[(y0 * w + x1) * n + c]! * ax;
  const bottom = plane[(y1 * w + x0) * n + c]! * (1 - ax) + plane[(y1 * w + x1) * n + c]! * ax;
  return top * (1 - ay) + bottom * ay;
}

/** the value below which `q` of the numbers lie */
export function quantile(values: ArrayLike<number>, q: number): number {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

/** small deterministic generator: the same edit always gives the same pixels */
export function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function gaussianNoise(length: number, seed: number): Float32Array<ArrayBuffer> {
  const rnd = random(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(rnd() || 1e-9));
    const a = 2 * Math.PI * rnd();
    out[i] = r * Math.cos(a);
    if (i + 1 < length) out[i + 1] = r * Math.sin(a);
  }
  return out;
}

export interface Components {
  /** 0 = background, 1.. = component */
  label: Int32Array;
  /** per component (index 0 unused) */
  area: number[];
  box: [number, number, number, number][];
}

/** 8-connected components of a mask */
export function components(mask: Uint8Array, w: number, h: number): Components {
  const label = new Int32Array(mask.length);
  const area = [0];
  const box: [number, number, number, number][] = [[0, 0, 0, 0]];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    const id = area.length;
    label[s] = id;
    stack.push(s);
    let count = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !label[j]) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    area.push(count);
    box.push([x0, y0, x1 + 1, y1 + 1]);
  }
  return { label, area, box };
}
