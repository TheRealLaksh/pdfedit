/** PDF CMap programs: ToUnicode maps and Type0 encoding CMaps. */
import { parseContent, type Operand } from "../content/tokenizer";

export interface CodeRange {
  lo: Uint8Array;
  hi: Uint8Array;
}

export interface CidRange {
  len: number;
  lo: number;
  hi: number;
  cid: number;
}

export interface CMapData {
  codespaces: CodeRange[];
  /** code -> Unicode (ToUnicode maps) */
  unicode: Map<number, string>;
  cidRanges: CidRange[];
  vertical: boolean;
  useCMap?: string;
}

export function codeValue(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

export function utf16beToString(bytes: Uint8Array): string {
  if (bytes.length === 1) return String.fromCharCode(bytes[0]!);
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return s;
}

const str = (o: Operand | undefined): Uint8Array | null => (o && o.type === "string" ? o.value : null);

export function parseCMap(data: Uint8Array): CMapData {
  const out: CMapData = { codespaces: [], unicode: new Map(), cidRanges: [], vertical: false };
  let ops;
  try {
    ops = parseContent(data);
  } catch {
    return out;
  }
  for (let k = 0; k < ops.length; k++) {
    const { op, operands } = ops[k]!;
    switch (op) {
      case "endcodespacerange":
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const lo = str(operands[i]);
          const hi = str(operands[i + 1]);
          if (lo && hi && lo.length === hi.length && lo.length > 0 && lo.length <= 4) out.codespaces.push({ lo, hi });
        }
        break;
      case "endbfchar":
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const src = str(operands[i]);
          const dst = operands[i + 1]!;
          if (!src) continue;
          if (dst.type === "string") out.unicode.set(codeValue(src), utf16beToString(dst.value));
        }
        break;
      case "endbfrange":
        for (let i = 0; i + 2 < operands.length; i += 3) {
          const lo = str(operands[i]);
          const hi = str(operands[i + 1]);
          const dst = operands[i + 2]!;
          if (!lo || !hi) continue;
          const a = codeValue(lo);
          const b = Math.min(codeValue(hi), a + 65535);
          if (dst.type === "array") {
            for (let c = a; c <= b && c - a < dst.value.length; c++) {
              const d = str(dst.value[c - a]);
              if (d) out.unicode.set(c, utf16beToString(d));
            }
          } else if (dst.type === "string") {
            const base = utf16beToString(dst.value);
            if (!base) continue;
            const head = base.slice(0, -1);
            const last = base.charCodeAt(base.length - 1);
            for (let c = a; c <= b; c++) {
              const u = last + (c - a);
              if (u > 0xffff) break;
              out.unicode.set(c, head + String.fromCharCode(u));
            }
          }
        }
        break;
      case "endcidrange":
      case "endnotdefrange":
        if (op === "endnotdefrange") break;
        for (let i = 0; i + 2 < operands.length; i += 3) {
          const lo = str(operands[i]);
          const hi = str(operands[i + 1]);
          const cid = operands[i + 2];
          if (lo && hi && cid?.type === "number")
            out.cidRanges.push({ len: lo.length, lo: codeValue(lo), hi: codeValue(hi), cid: cid.value });
        }
        break;
      case "endcidchar":
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const src = str(operands[i]);
          const cid = operands[i + 1];
          if (src && cid?.type === "number") {
            const v = codeValue(src);
            out.cidRanges.push({ len: src.length, lo: v, hi: v, cid: cid.value });
          }
        }
        break;
      case "usecmap": {
        const n = operands[operands.length - 1];
        if (n?.type === "name") out.useCMap = n.value;
        break;
      }
      case "def": {
        const n = operands[0];
        const v = operands[1];
        if (n?.type === "name" && n.value === "WMode" && v?.type === "number") out.vertical = v.value === 1;
        break;
      }
    }
  }
  return out;
}

/** Split off the next character code from a string, honouring the codespace ranges. */
export function nextCode(codespaces: CodeRange[], bytes: Uint8Array, pos: number): { code: number; length: number } {
  let shortest = 4;
  for (let len = 1; len <= 4; len++) {
    for (const r of codespaces) {
      if (r.lo.length !== len) continue;
      if (len < shortest) shortest = len;
      if (pos + len > bytes.length) continue;
      let ok = true;
      for (let i = 0; i < len; i++) {
        const b = bytes[pos + i]!;
        if (b < r.lo[i]! || b > r.hi[i]!) {
          ok = false;
          break;
        }
      }
      if (ok) return { code: codeValue(bytes.subarray(pos, pos + len)), length: len };
    }
  }
  const length = Math.max(1, Math.min(codespaces.length ? shortest : 1, bytes.length - pos));
  return { code: codeValue(bytes.subarray(pos, pos + length)), length };
}

const range = (lo: number[], hi: number[]): CodeRange => ({ lo: Uint8Array.from(lo), hi: Uint8Array.from(hi) });

/** Codespace and Unicode decoding for the predefined (named) CMaps we do not ship tables for. */
export function predefinedCMap(name: string): { codespaces: CodeRange[]; decode?: (code: number, length: number) => string } {
  const two = [range([0, 0], [255, 255])];
  const textDecoder = (label: string) => {
    let dec: TextDecoder | null = null;
    try {
      dec = new TextDecoder(label);
    } catch {
      return undefined;
    }
    return (code: number, length: number) => {
      const b = new Uint8Array(length);
      for (let i = length - 1, v = code; i >= 0; i--, v = Math.floor(v / 256)) b[i] = v & 255;
      const s = dec!.decode(b);
      return s.includes("\uFFFD") ? "" : s;
    };
  };
  if (/^Identity/.test(name)) return { codespaces: two };
  if (/UCS2|UTF16/.test(name))
    return {
      codespaces: /UTF16/.test(name)
        ? [range([0, 0], [0xd7, 0xff]), range([0xd8, 0, 0xdc, 0], [0xdb, 0xff, 0xdf, 0xff]), range([0xe0, 0], [0xff, 0xff])]
        : two,
      decode: (code, length) => {
        if (length === 4) return String.fromCharCode(Math.floor(code / 65536), code % 65536);
        return String.fromCharCode(code);
      },
    };
  if (/UTF32/.test(name))
    return { codespaces: [range([0, 0, 0, 0], [0, 0x10, 0xff, 0xff])], decode: (c) => (c <= 0x10ffff ? String.fromCodePoint(c) : "") };
  if (/UTF8/.test(name)) {
    const d = textDecoder("utf-8");
    return {
      codespaces: [
        range([0], [0x7f]),
        range([0xc2, 0x80], [0xdf, 0xbf]),
        range([0xe0, 0x80, 0x80], [0xef, 0xbf, 0xbf]),
        range([0xf0, 0x80, 0x80, 0x80], [0xf4, 0xbf, 0xbf, 0xbf]),
      ],
      decode: d,
    };
  }
  if (/RKSJ/.test(name))
    return {
      codespaces: [range([0], [0x80]), range([0x81, 0x40], [0x9f, 0xfc]), range([0xa0], [0xdf]), range([0xe0, 0x40], [0xfc, 0xfc])],
      decode: textDecoder("shift_jis"),
    };
  const dbcs = [range([0], [0x80]), range([0x81, 0x40], [0xfe, 0xfe])];
  if (/^(GB|GBK|GBpc|GBT)/.test(name)) return { codespaces: dbcs, decode: textDecoder("gbk") };
  if (/^(B5|ETen|HKscs|CNS)/.test(name)) return { codespaces: dbcs, decode: textDecoder("big5") };
  if (/^KSC/.test(name)) return { codespaces: dbcs, decode: textDecoder("euc-kr") };
  if (/^EUC/.test(name))
    return {
      codespaces: [range([0], [0x80]), range([0x8e, 0xa0], [0x8e, 0xdf]), range([0xa1, 0xa1], [0xfe, 0xfe])],
      decode: textDecoder("euc-jp"),
    };
  return { codespaces: two };
}
