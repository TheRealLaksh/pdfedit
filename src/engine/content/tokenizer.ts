/**
 * PDF content stream parser. Keeps byte offsets so callers can splice operators in place and leave
 * every other byte of the page untouched.
 */

export type Operand =
  | { type: "number"; value: number }
  | { type: "name"; value: string }
  | { type: "string"; value: Uint8Array; hex: boolean }
  | { type: "array"; value: Operand[] }
  | { type: "dict"; value: Record<string, Operand> }
  | { type: "bool"; value: boolean }
  | { type: "null" };

export interface Operation {
  op: string;
  operands: Operand[];
  /** byte offset of the first operand (or the operator when it has none) */
  start: number;
  /** byte offset just past the operator */
  end: number;
}

const isSpace = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) =>
  c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const isRegular = (c: number) => !isSpace(c) && !isDelim(c);

const latin1 = (b: Uint8Array, s: number, e: number) => {
  let out = "";
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]!);
  return out;
};

export function parseContent(bytes: Uint8Array): Operation[] {
  const ops: Operation[] = [];
  const n = bytes.length;
  let i = 0;
  let operands: Operand[] = [];
  let start = -1;

  const skip = () => {
    while (i < n) {
      const c = bytes[i]!;
      if (isSpace(c)) i++;
      else if (c === 37) while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
      else break;
    }
  };

  const readWord = () => {
    const s = i;
    while (i < n && isRegular(bytes[i]!)) i++;
    return latin1(bytes, s, i);
  };

  const readName = (): string => {
    i++; // '/'
    return readWord().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  };

  const readLiteral = (): Uint8Array => {
    i++; // '('
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      let c = bytes[i++]!;
      if (c === 92) {
        const e = bytes[i++]!;
        if (e === 110) out.push(10);
        else if (e === 114) out.push(13);
        else if (e === 116) out.push(9);
        else if (e === 98) out.push(8);
        else if (e === 102) out.push(12);
        else if (e === 13) {
          if (bytes[i] === 10) i++;
        } else if (e === 10) {
          /* line continuation */
        } else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && bytes[i]! >= 48 && bytes[i]! <= 55; k++) v = v * 8 + (bytes[i++]! - 48);
          out.push(v & 255);
        } else out.push(e);
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) break;
      else if (c === 13) {
        if (bytes[i] === 10) i++;
        c = 10;
      }
      out.push(c);
    }
    return Uint8Array.from(out);
  };

  const readHex = (): Uint8Array => {
    i++; // '<'
    let hex = "";
    while (i < n && bytes[i] !== 62) {
      const ch = String.fromCharCode(bytes[i++]!);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    i++; // '>'
    if (hex.length % 2) hex += "0";
    const out = new Uint8Array(hex.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16);
    return out;
  };

  /** returns an operand, or an operator keyword as a string, or null for stray delimiters */
  const readToken = (): Operand | string | null => {
    const c = bytes[i]!;
    if (c === 47) return { type: "name", value: readName() };
    if (c === 40) return { type: "string", value: readLiteral(), hex: false };
    if (c === 60) {
      if (bytes[i + 1] === 60) {
        i += 2;
        const dict: Record<string, Operand> = {};
        for (;;) {
          skip();
          if (i >= n) break;
          if (bytes[i] === 62) {
            i += 2;
            break;
          }
          const k = readToken();
          if (!k || typeof k === "string" || k.type !== "name") continue;
          skip();
          const v = readToken();
          if (v && typeof v !== "string") dict[k.value] = v;
        }
        return { type: "dict", value: dict };
      }
      return { type: "string", value: readHex(), hex: true };
    }
    if (c === 91) {
      i++;
      const arr: Operand[] = [];
      for (;;) {
        skip();
        if (i >= n) break;
        if (bytes[i] === 93) {
          i++;
          break;
        }
        const v = readToken();
        if (v && typeof v !== "string") arr.push(v);
      }
      return { type: "array", value: arr };
    }
    if (isDelim(c)) {
      i++;
      return null;
    }
    const word = readWord();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) || /^[+-]{1,2}[\d.]+$/.test(word)) {
      return { type: "number", value: parseFloat(word.replace(/^--/, "")) || 0 };
    }
    if (word === "true" || word === "false") return { type: "bool", value: word === "true" };
    if (word === "null") return { type: "null" };
    return word;
  };

  for (;;) {
    skip();
    if (i >= n) break;
    const tokenStart = i;
    const t = readToken();
    if (t === null) continue;
    if (start < 0) start = tokenStart;
    if (typeof t !== "string") {
      operands.push(t);
      continue;
    }
    if (t === "BI") {
      // inline image: BI <dict entries> ID <binary> EI, returned as one operation
      const dict: Record<string, Operand> = {};
      for (;;) {
        skip();
        if (i >= n) break;
        const k = readToken();
        if (k === "ID") break;
        if (!k || typeof k === "string" || k.type !== "name") continue;
        skip();
        const v = readToken();
        if (v && typeof v !== "string") dict[k.value] = v;
      }
      if (isSpace(bytes[i]!)) i++;
      const len = dict.L ?? dict.Length;
      if (len?.type === "number") i += len.value;
      while (i < n) {
        if (
          bytes[i] === 69 &&
          bytes[i + 1] === 73 &&
          (i + 2 >= n || !isRegular(bytes[i + 2]!)) &&
          (isSpace(bytes[i - 1]!) || len)
        )
          break;
        i++;
      }
      i = Math.min(n, i + 2);
      ops.push({ op: "BI", operands: [{ type: "dict", value: dict }], start, end: i });
    } else {
      ops.push({ op: t, operands, start, end: i });
    }
    operands = [];
    start = -1;
  }
  return ops;
}

/** Replace byte ranges. Edits must not overlap. */
export function spliceContent(
  bytes: Uint8Array,
  edits: { start: number; end: number; replacement: string | Uint8Array }[],
): Uint8Array {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) throw new Error("Overlapping content edits");
    parts.push(bytes.subarray(pos, e.start));
    const rep = typeof e.replacement === "string" ? encodeLatin1(e.replacement) : e.replacement;
    parts.push(encodeLatin1("\n"), rep, encodeLatin1("\n"));
    pos = e.end;
  }
  parts.push(bytes.subarray(pos));
  return concatBytes(parts);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** content streams are bytes; operator text is ASCII/latin-1 */
export function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

export function hexString(bytes: Uint8Array | number[]): string {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s + ">";
}
