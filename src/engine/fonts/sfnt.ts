/**
 * Minimal synchronous SFNT (TrueType / OpenType / TTC) reader: names, metrics, cmap coverage,
 * collection extraction and the CID map of CID-keyed CFF fonts. Shaping itself is HarfBuzz's job.
 */

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const tagAt = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

export function sfntKind(bytes: Uint8Array): "sfnt" | "ttc" | "woff" | null {
  if (bytes.length < 12) return null;
  const tag = tagAt(bytes, 0);
  if (tag === "ttcf") return "ttc";
  if (tag === "OTTO" || tag === "true" || tag === "typ1") return "sfnt";
  if (tag === "wOFF" || tag === "wOF2") return "woff";
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return "sfnt";
  return null;
}

export function faceCount(bytes: Uint8Array): number {
  const kind = sfntKind(bytes);
  if (kind === "ttc") return view(bytes).getUint32(8);
  return kind === "sfnt" ? 1 : 0;
}

function directoryOffset(bytes: Uint8Array, index: number): number {
  if (sfntKind(bytes) !== "ttc") return 0;
  return view(bytes).getUint32(12 + 4 * index);
}

export function readTables(bytes: Uint8Array, index = 0): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = view(bytes);
  const base = directoryOffset(bytes, index);
  if (base + 12 > bytes.length) return out;
  const count = dv.getUint16(base + 4);
  for (let i = 0; i < count; i++) {
    const at = base + 12 + i * 16;
    if (at + 16 > bytes.length) break;
    const offset = dv.getUint32(at + 8);
    const length = dv.getUint32(at + 12);
    if (offset > bytes.length) continue;
    out.set(tagAt(bytes, at), bytes.subarray(offset, Math.min(bytes.length, offset + length)));
  }
  return out;
}

/** a standalone font file for one face of a collection (returns the input for plain fonts) */
export function extractFace(bytes: Uint8Array, index: number): Uint8Array {
  if (sfntKind(bytes) !== "ttc") return bytes;
  const tables = readTables(bytes, index);
  const base = directoryOffset(bytes, index);
  const version = view(bytes).getUint32(base);
  return buildSfnt(version, tables);
}

export function buildSfnt(version: number, tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const pad = (n: number) => (n + 3) & ~3;
  const total = 12 + tags.length * 16 + tags.reduce((n, t) => n + pad(tables.get(t)!.length), 0);
  const out = new Uint8Array(total);
  const dv = view(out);
  dv.setUint32(0, version);
  dv.setUint16(4, tags.length);
  const pow = 2 ** Math.floor(Math.log2(tags.length || 1));
  dv.setUint16(6, pow * 16);
  dv.setUint16(8, Math.log2(pow));
  dv.setUint16(10, tags.length * 16 - pow * 16);
  let offset = 12 + tags.length * 16;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    out.set(data, offset);
    let sum = 0;
    for (let k = 0; k < pad(data.length); k += 4) sum = (sum + dv.getUint32(offset + k)) >>> 0;
    const at = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[at + k] = tag.charCodeAt(k);
    dv.setUint32(at + 4, sum);
    dv.setUint32(at + 8, offset);
    dv.setUint32(at + 12, data.length);
    offset += pad(data.length);
  });
  return out;
}

export interface FontInfo {
  family: string;
  subfamily: string;
  postScriptName: string;
  unitsPerEm: number;
  bbox: [number, number, number, number];
  italicAngle: number;
  ascent: number;
  descent: number;
  capHeight: number;
  underlinePosition: number;
  underlineThickness: number;
  weight: number;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  numGlyphs: number;
  outlines: "truetype" | "cff" | "cff2" | "none";
  variable: boolean;
  /** variable font with a weight axis */
  weightAxis: boolean;
}

function readNames(table: Uint8Array | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!table || table.length < 6) return out;
  const dv = view(table);
  const count = dv.getUint16(2);
  const strings = dv.getUint16(4);
  const rank = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > table.length) break;
    const platform = dv.getUint16(at);
    const language = dv.getUint16(at + 4);
    const id = dv.getUint16(at + 6);
    const length = dv.getUint16(at + 8);
    const offset = strings + dv.getUint16(at + 10);
    if (offset + length > table.length) continue;
    let text = "";
    let score = 0;
    if (platform === 3 || platform === 0) {
      for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(dv.getUint16(offset + k));
      score = platform === 3 && language === 0x409 ? 3 : 2;
    } else {
      for (let k = 0; k < length; k++) text += String.fromCharCode(table[offset + k]!);
      score = 1;
    }
    if (text && score > (rank.get(id) ?? 0)) {
      rank.set(id, score);
      out.set(id, text);
    }
  }
  return out;
}

export function fontInfo(bytes: Uint8Array, index = 0): FontInfo | null {
  if (!sfntKind(bytes) || sfntKind(bytes) === "woff") return null;
  const t = readTables(bytes, index);
  const head = t.get("head");
  if (!head || head.length < 54) return null;
  const hd = view(head);
  const upem = hd.getUint16(18) || 1000;
  const macStyle = hd.getUint16(44);
  const bbox: [number, number, number, number] = [hd.getInt16(36), hd.getInt16(38), hd.getInt16(40), hd.getInt16(42)];
  const names = readNames(t.get("name"));
  const hhea = t.get("hhea");
  let ascent = hhea && hhea.length >= 8 ? view(hhea).getInt16(4) : bbox[3];
  let descent = hhea && hhea.length >= 8 ? view(hhea).getInt16(6) : bbox[1];
  let weight = macStyle & 1 ? 700 : 400;
  let italic = (macStyle & 2) !== 0;
  let capHeight = Math.round(upem * 0.7);
  let serif = false;
  let mono = false;
  const os2 = t.get("OS/2");
  if (os2 && os2.length >= 64) {
    const d = view(os2);
    weight = d.getUint16(4) || weight;
    const familyClass = d.getInt16(30) >> 8;
    serif = (familyClass >= 1 && familyClass <= 5) || familyClass === 7;
    const panoseFamily = os2[32]!;
    const panoseSerif = os2[33]!;
    if (panoseFamily === 2 && panoseSerif >= 2 && panoseSerif <= 10) serif = true;
    if (panoseFamily === 2 && os2[35] === 9) mono = true;
    italic = italic || (d.getUint16(62) & 1) !== 0;
    if (os2.length >= 90 && d.getUint16(0) >= 2) capHeight = d.getInt16(88) || capHeight;
    if (!ascent && !descent && os2.length >= 72) {
      ascent = d.getInt16(68);
      descent = d.getInt16(70);
    }
  }
  const post = t.get("post");
  let italicAngle = 0;
  let underlinePosition = -upem * 0.1;
  let underlineThickness = upem * 0.05;
  if (post && post.length >= 16) {
    const d = view(post);
    italicAngle = d.getInt32(4) / 65536;
    underlinePosition = d.getInt16(8) || underlinePosition;
    underlineThickness = d.getInt16(10) || underlineThickness;
    mono = mono || d.getUint32(12) !== 0;
  }
  const maxp = t.get("maxp");
  const family = names.get(16) ?? names.get(1) ?? "";
  const subfamily = names.get(17) ?? names.get(2) ?? "";
  if (/serif/i.test(family) && !/sans[- ]?serif/i.test(family)) serif = true;
  if (/mono|courier|consol/i.test(family)) mono = true;
  return {
    family,
    subfamily,
    postScriptName: names.get(6) ?? "",
    unitsPerEm: upem,
    bbox,
    italicAngle,
    ascent,
    descent: -Math.abs(descent),
    capHeight,
    underlinePosition,
    underlineThickness,
    weight,
    bold: weight >= 600 || (macStyle & 1) !== 0,
    italic: italic || italicAngle !== 0,
    serif,
    mono,
    numGlyphs: maxp && maxp.length >= 6 ? view(maxp).getUint16(4) : 0,
    outlines: t.has("glyf") ? "truetype" : t.has("CFF ") ? "cff" : t.has("CFF2") ? "cff2" : "none",
    variable: t.has("fvar"),
    weightAxis: hasAxis(t.get("fvar"), "wght"),
  };
}

function hasAxis(fvar: Uint8Array | undefined, axis: string): boolean {
  if (!fvar || fvar.length < 16) return false;
  const dv = view(fvar);
  const start = dv.getUint16(4);
  const count = dv.getUint16(8);
  const size = dv.getUint16(10);
  for (let i = 0; i < count; i++) {
    const at = start + i * size;
    if (at + 4 <= fvar.length && tagAt(fvar, at) === axis) return true;
  }
  return false;
}

/** code point ranges covered by the best Unicode cmap, as [start, end] inclusive */
export function cmapRanges(bytes: Uint8Array, index = 0): [number, number][] {
  const cmap = readTables(bytes, index).get("cmap");
  if (!cmap || cmap.length < 4) return [];
  const dv = view(cmap);
  const n = dv.getUint16(2);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < n; i++) {
    const at = 4 + i * 8;
    if (at + 8 > cmap.length) break;
    const platform = dv.getUint16(at);
    const encoding = dv.getUint16(at + 2);
    const offset = dv.getUint32(at + 4);
    if (offset + 4 > cmap.length) continue;
    const format = dv.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    const score = unicode && format === 12 ? 3 : unicode && format === 4 ? 2 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  if (best < 0) return [];
  const out: [number, number][] = [];
  if (bestScore === 3) {
    const groups = dv.getUint32(best + 12);
    for (let i = 0; i < groups; i++) {
      const at = best + 16 + i * 12;
      if (at + 12 > cmap.length) break;
      out.push([dv.getUint32(at), dv.getUint32(at + 4)]);
    }
  } else {
    const segs = dv.getUint16(best + 6) / 2;
    for (let i = 0; i < segs; i++) {
      const endAt = best + 14 + i * 2;
      const startAt = best + 16 + segs * 2 + i * 2;
      if (startAt + 2 > cmap.length) break;
      const end = dv.getUint16(endAt);
      const start = dv.getUint16(startAt);
      if (start !== 0xffff && end >= start) out.push([start, end]);
    }
  }
  return out;
}

/* ---------- CFF ---------- */

interface Index {
  items: [number, number][];
  end: number;
}

function cffIndex(b: Uint8Array, at: number): Index {
  const count = (b[at]! << 8) | b[at + 1]!;
  if (!count) return { items: [], end: at + 2 };
  const size = b[at + 2]!;
  const off = (i: number) => {
    let v = 0;
    for (let k = 0; k < size; k++) v = v * 256 + b[at + 3 + i * size + k]!;
    return v;
  };
  const data = at + 3 + (count + 1) * size - 1;
  const items: [number, number][] = [];
  for (let i = 0; i < count; i++) items.push([data + off(i), data + off(i + 1)]);
  return { items, end: data + off(count) };
}

function cffDict(b: Uint8Array, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let stack: number[] = [];
  let i = start;
  while (i < end) {
    const c = b[i]!;
    if (c <= 21) {
      let op = c;
      i++;
      if (c === 12) op = 1200 + b[i++]!;
      out.set(op, stack);
      stack = [];
    } else if (c === 28) {
      stack.push((((b[i + 1]! << 8) | b[i + 2]!) << 16) >> 16);
      i += 3;
    } else if (c === 29) {
      stack.push((b[i + 1]! << 24) | (b[i + 2]! << 16) | (b[i + 3]! << 8) | b[i + 4]!);
      i += 5;
    } else if (c === 30) {
      i++;
      while (i < end) {
        const v = b[i++]!;
        if ((v & 15) === 15 || v >> 4 === 15) break;
      }
      stack.push(0);
    } else if (c < 247) {
      stack.push(c - 139);
      i++;
    } else if (c < 251) {
      stack.push((c - 247) * 256 + b[i + 1]! + 108);
      i += 2;
    } else {
      stack.push(-(c - 251) * 256 - b[i + 1]! - 108);
      i += 2;
    }
  }
  return out;
}

/** For a CID-keyed CFF table: gid -> CID. null for name-keyed fonts (there CID = glyph id). */
export function cffGidToCid(cff: Uint8Array): Map<number, number> | null {
  try {
    const names = cffIndex(cff, cff[2]!);
    const tops = cffIndex(cff, names.end);
    const top = tops.items[0];
    if (!top) return null;
    const dict = cffDict(cff, top[0], top[1]);
    if (!dict.has(1230)) return null;
    const charset = dict.get(15)?.[0] ?? 0;
    const charStrings = dict.get(17)?.[0];
    if (charStrings === undefined || charset <= 2) return null;
    const glyphs = (cff[charStrings]! << 8) | cff[charStrings + 1]!;
    const out = new Map<number, number>([[0, 0]]);
    const format = cff[charset]!;
    let at = charset + 1;
    const u16 = () => {
      const v = (cff[at]! << 8) | cff[at + 1]!;
      at += 2;
      return v;
    };
    let gid = 1;
    while (gid < glyphs && at < cff.length) {
      if (format === 0) out.set(gid++, u16());
      else {
        const first = u16();
        const left = format === 1 ? cff[at++]! : u16();
        for (let k = 0; k <= left && gid < glyphs; k++) out.set(gid++, first + k);
      }
    }
    return out;
  } catch {
    return null;
  }
}
