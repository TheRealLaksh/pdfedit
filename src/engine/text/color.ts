/** Enough of the PDF colour model to report the on-screen RGB of any text colour. */
import type * as MuPDF from "mupdf";
import { parseContent, type Operation } from "../content/tokenizer";
import type { RGB } from "../types";

type Fn = (input: number[]) => number[];

export interface Space {
  /** number of colour components */
  n: number;
  toRGB: (c: number[]) => RGB;
  initial: number[];
}

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

export const GRAY: Space = { n: 1, toRGB: (c) => [clamp(c[0] ?? 0), clamp(c[0] ?? 0), clamp(c[0] ?? 0)], initial: [0] };
export const RGBSPACE: Space = { n: 3, toRGB: (c) => [clamp(c[0] ?? 0), clamp(c[1] ?? 0), clamp(c[2] ?? 0)], initial: [0, 0, 0] };
export const CMYK: Space = {
  n: 4,
  toRGB: (c) => {
    const k = clamp(c[3] ?? 0);
    return [(1 - clamp(c[0] ?? 0)) * (1 - k), (1 - clamp(c[1] ?? 0)) * (1 - k), (1 - clamp(c[2] ?? 0)) * (1 - k)];
  },
  initial: [0, 0, 0, 1],
};
const PATTERN: Space = { n: 0, toRGB: () => [0.3, 0.3, 0.3], initial: [] };

const nums = (o: MuPDF.PDFObject): number[] => {
  const out: number[] = [];
  if (o.isArray()) for (let i = 0; i < o.length; i++) out.push(o.get(i).asNumber());
  return out;
};

function labToRGB(L: number, a: number, b: number): RGB {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const g = (t: number) => (t > 6 / 29 ? t * t * t : (t - 4 / 29) * (108 / 841));
  const X = 0.9505 * g(fx);
  const Y = g(fy);
  const Z = 1.089 * g(fz);
  const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
  return lin.map((v) => clamp(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)) as RGB;
}

export function loadSpace(obj: MuPDF.PDFObject, resources: MuPDF.PDFObject | null, depth = 0): Space {
  if (depth > 6 || obj.isNull()) return GRAY;
  if (obj.isName()) {
    const name = obj.asName();
    if (name === "DeviceGray" || name === "CalGray" || name === "G") return GRAY;
    if (name === "DeviceRGB" || name === "CalRGB" || name === "RGB") return RGBSPACE;
    if (name === "DeviceCMYK" || name === "CMYK") return CMYK;
    if (name === "Pattern") return PATTERN;
    const res = resources?.get("ColorSpace", name);
    if (res && !res.isNull()) return loadSpace(res, resources, depth + 1);
    return GRAY;
  }
  if (!obj.isArray() || obj.length === 0) return GRAY;
  const kind = obj.get(0).isName() ? obj.get(0).asName() : "";
  switch (kind) {
    case "CalGray":
      return GRAY;
    case "CalRGB":
      return RGBSPACE;
    case "Lab":
      return { n: 3, toRGB: (c) => labToRGB(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0), initial: [0, 0, 0] };
    case "ICCBased": {
      const stream = obj.get(1);
      const n = stream.get("N").isNumber() ? stream.get("N").asNumber() : 3;
      return n === 1 ? GRAY : n === 4 ? CMYK : RGBSPACE;
    }
    case "Indexed":
    case "I": {
      const base = loadSpace(obj.get(1), resources, depth + 1);
      const lookup = obj.get(3);
      let table: Uint8Array = new Uint8Array();
      if (lookup.isStream()) table = lookup.readStream().asUint8Array().slice();
      else if (lookup.isString()) table = lookup.asByteString();
      return {
        n: 1,
        toRGB: (c) => {
          const i = Math.round(c[0] ?? 0) * base.n;
          const parts: number[] = [];
          for (let k = 0; k < base.n; k++) parts.push((table[i + k] ?? 0) / 255);
          return base.toRGB(parts);
        },
        initial: [0],
      };
    }
    case "Separation":
    case "DeviceN": {
      const names = obj.get(1);
      const n = kind === "Separation" ? 1 : names.isArray() ? names.length : 1;
      const alt = loadSpace(obj.get(2), resources, depth + 1);
      const fn = loadFunction(obj.get(3));
      return {
        n,
        toRGB: (c) => {
          if (!fn) {
            const t = 1 - clamp(c[0] ?? 1);
            return [t, t, t];
          }
          return alt.toRGB(fn(c));
        },
        initial: new Array(n).fill(1),
      };
    }
    case "Pattern":
      if (obj.length > 1) {
        const base = loadSpace(obj.get(1), resources, depth + 1);
        return { n: base.n, toRGB: base.toRGB, initial: base.initial };
      }
      return PATTERN;
    default:
      return GRAY;
  }
}

export function loadFunction(obj: MuPDF.PDFObject, depth = 0): Fn | null {
  if (depth > 6 || obj.isNull()) return null;
  if (obj.isArray()) {
    const list: Fn[] = [];
    for (let i = 0; i < obj.length; i++) {
      const f = loadFunction(obj.get(i), depth + 1);
      if (!f) return null;
      list.push(f);
    }
    return (x) => list.map((f) => f(x)[0] ?? 0);
  }
  const type = obj.get("FunctionType").isNumber() ? obj.get("FunctionType").asNumber() : -1;
  const domain = nums(obj.get("Domain"));
  const rng = nums(obj.get("Range"));
  const clampTo = (v: number, bounds: number[], i: number) =>
    bounds.length > 2 * i + 1 ? Math.min(bounds[2 * i + 1]!, Math.max(bounds[2 * i]!, v)) : v;
  const finish = (out: number[]) => out.map((v, i) => clampTo(v, rng, i));
  if (type === 2) {
    const c0 = obj.get("C0").isNull() ? [0] : nums(obj.get("C0"));
    const c1 = obj.get("C1").isNull() ? [1] : nums(obj.get("C1"));
    const N = obj.get("N").isNumber() ? obj.get("N").asNumber() : 1;
    return (x) => {
      const t = Math.pow(clampTo(x[0] ?? 0, domain, 0), N);
      return finish(c0.map((a, i) => a + t * ((c1[i] ?? 1) - a)));
    };
  }
  if (type === 3) {
    const fns = obj.get("Functions");
    const list: (Fn | null)[] = [];
    for (let i = 0; i < fns.length; i++) list.push(loadFunction(fns.get(i), depth + 1));
    const bounds = nums(obj.get("Bounds"));
    const encode = nums(obj.get("Encode"));
    return (x) => {
      const v = clampTo(x[0] ?? 0, domain, 0);
      let k = 0;
      while (k < bounds.length && v >= bounds[k]!) k++;
      const lo = k === 0 ? (domain[0] ?? 0) : bounds[k - 1]!;
      const hi = k === bounds.length ? (domain[1] ?? 1) : bounds[k]!;
      const e0 = encode[2 * k] ?? 0;
      const e1 = encode[2 * k + 1] ?? 1;
      const t = hi === lo ? e0 : e0 + ((v - lo) * (e1 - e0)) / (hi - lo);
      return finish(list[k]?.([t]) ?? [0]);
    };
  }
  if (type === 0 && obj.isStream()) {
    const data = obj.readStream().asUint8Array().slice();
    const size = nums(obj.get("Size"));
    const bps = obj.get("BitsPerSample").asNumber();
    const outputs = rng.length / 2;
    const max = Math.pow(2, bps) - 1;
    const decode = obj.get("Decode").isNull() ? rng : nums(obj.get("Decode"));
    const sample = (index: number) => {
      const bit = index * bps;
      let v = 0;
      for (let i = 0; i < bps; i++) {
        const b = bit + i;
        v = v * 2 + (((data[b >> 3] ?? 0) >> (7 - (b & 7))) & 1);
      }
      return v;
    };
    // nearest sample is plenty for a colour swatch
    return (x) => {
      let index = 0;
      let stride = 1;
      for (let d = 0; d < size.length; d++) {
        const lo = domain[2 * d] ?? 0;
        const hi = domain[2 * d + 1] ?? 1;
        const t = (clampTo(x[d] ?? 0, domain, d) - lo) / (hi - lo || 1);
        index += Math.round(t * (size[d]! - 1)) * stride;
        stride *= size[d]!;
      }
      const out: number[] = [];
      for (let o = 0; o < outputs; o++) {
        const a = decode[2 * o] ?? 0;
        const b = decode[2 * o + 1] ?? 1;
        out.push(a + (sample(index * outputs + o) / max) * (b - a));
      }
      return finish(out);
    };
  }
  if (type === 4 && obj.isStream()) {
    let source = new TextDecoder("latin1").decode(obj.readStream().asUint8Array().slice());
    source = source.replace(/[{}]/g, (c) => ` ${c === "{" ? "brace_open" : "brace_close"} `);
    const ops = parseContent(new TextEncoder().encode(source + " end_program"));
    const program = buildProgram(ops);
    const outputs = rng.length / 2;
    return (x) => {
      const stack: Value[] = x.map((v, i) => clampTo(v, domain, i));
      try {
        execute(program, stack, 0);
      } catch {
        return new Array(outputs).fill(0);
      }
      return finish(stack.slice(-outputs).map((v) => Number(v)));
    };
  }
  return null;
}

/* ---------- type 4 (PostScript calculator) ---------- */

type Item = number | string | Item[];
type Value = number | boolean | Item[];

function buildProgram(ops: Operation[]): Item[] {
  const root: Item[] = [];
  const stack: Item[][] = [root];
  for (const o of ops) {
    const top = () => stack[stack.length - 1]!;
    for (const a of o.operands) {
      if (a.type === "number") top().push(a.value);
      else if (a.type === "bool") top().push(a.value ? "true" : "false");
    }
    if (o.op === "brace_open") {
      const block: Item[] = [];
      top().push(block);
      stack.push(block);
    } else if (o.op === "brace_close") {
      if (stack.length > 1) stack.pop();
    } else if (o.op !== "end_program") top().push(o.op);
  }
  // the outermost braces wrap the whole program
  return root.length === 1 && Array.isArray(root[0]) ? root[0] : root;
}

function execute(program: Item[], s: Value[], depth: number): void {
  if (depth > 32 || s.length > 100) throw new Error("function too deep");
  const pop = () => Number(s.pop() ?? 0);
  const popAny = () => s.pop() ?? 0;
  for (const item of program) {
    if (typeof item === "number" || Array.isArray(item)) {
      s.push(item);
      continue;
    }
    let a: number, b: number;
    switch (item) {
      case "add": s.push(pop() + pop()); break;
      case "sub": b = pop(); a = pop(); s.push(a - b); break;
      case "mul": s.push(pop() * pop()); break;
      case "div": b = pop(); a = pop(); s.push(b ? a / b : 0); break;
      case "idiv": b = pop(); a = pop(); s.push(b ? Math.trunc(a / b) : 0); break;
      case "mod": b = pop(); a = pop(); s.push(b ? a % b : 0); break;
      case "neg": s.push(-pop()); break;
      case "abs": s.push(Math.abs(pop())); break;
      case "ceiling": s.push(Math.ceil(pop())); break;
      case "floor": s.push(Math.floor(pop())); break;
      case "round": s.push(Math.round(pop())); break;
      case "truncate": case "cvi": s.push(Math.trunc(pop())); break;
      case "cvr": break;
      case "sqrt": s.push(Math.sqrt(pop())); break;
      case "exp": b = pop(); a = pop(); s.push(Math.pow(a, b)); break;
      case "ln": s.push(Math.log(pop())); break;
      case "log": s.push(Math.log10(pop())); break;
      case "sin": s.push(Math.sin((pop() * Math.PI) / 180)); break;
      case "cos": s.push(Math.cos((pop() * Math.PI) / 180)); break;
      case "atan": b = pop(); a = pop(); s.push(((Math.atan2(a, b) * 180) / Math.PI + 360) % 360); break;
      case "dup": { const v = popAny(); s.push(v, v); break; }
      case "pop": s.pop(); break;
      case "exch": { const y = popAny(); const x = popAny(); s.push(y, x); break; }
      case "copy": { const n = pop(); if (n > 0) s.push(...s.slice(-n)); break; }
      case "index": { const n = pop(); s.push(s[s.length - 1 - n] ?? 0); break; }
      case "roll": {
        const j = pop();
        const n = pop();
        if (n > 0 && n <= s.length) {
          const part = s.splice(s.length - n, n);
          const k = ((j % n) + n) % n;
          s.push(...part.slice(n - k), ...part.slice(0, n - k));
        }
        break;
      }
      case "eq": s.push(popAny() === popAny()); break;
      case "ne": s.push(popAny() !== popAny()); break;
      case "gt": b = pop(); a = pop(); s.push(a > b); break;
      case "ge": b = pop(); a = pop(); s.push(a >= b); break;
      case "lt": b = pop(); a = pop(); s.push(a < b); break;
      case "le": b = pop(); a = pop(); s.push(a <= b); break;
      case "and": { const y = popAny(); const x = popAny(); s.push(typeof x === "boolean" ? x && !!y : Number(x) & Number(y)); break; }
      case "or": { const y = popAny(); const x = popAny(); s.push(typeof x === "boolean" ? x || !!y : Number(x) | Number(y)); break; }
      case "xor": { const y = popAny(); const x = popAny(); s.push(typeof x === "boolean" ? x !== !!y : Number(x) ^ Number(y)); break; }
      case "not": { const x = popAny(); s.push(typeof x === "boolean" ? !x : ~Number(x)); break; }
      case "bitshift": b = pop(); a = pop(); s.push(b >= 0 ? a << b : a >>> -b); break;
      case "true": s.push(true); break;
      case "false": s.push(false); break;
      case "if": { const block = popAny(); const cond = popAny(); if (cond && Array.isArray(block)) execute(block, s, depth + 1); break; }
      case "ifelse": {
        const no = popAny();
        const yes = popAny();
        const cond = popAny();
        const block = cond ? yes : no;
        if (Array.isArray(block)) execute(block, s, depth + 1);
        break;
      }
    }
  }
}
