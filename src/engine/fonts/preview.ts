/**
 * Turns a font program embedded in a PDF into a font file a browser accepts (FontFace). PDF subsets often
 * lack the tables browsers insist on (cmap, name, OS/2, post) or are bare CFF programs; those tables are
 * written here, with a cmap that holds exactly the characters the caller can vouch for.
 */
import { buildSfnt, cffSummary, fontInfo, readTables, sfntKind } from "./sfnt";

export interface RebuildRequest {
  /** the embedded program: TrueType, OpenType or bare CFF */
  program: Uint8Array;
  /** code point -> glyph id */
  map: Map<number, number>;
  /** advances the document uses, glyph id -> fraction of the em; they win over the program's own */
  widths: Map<number, number>;
  /** advance of any other glyph of a bare CFF program, fraction of the em */
  advance?: (glyph: number) => number;
  name: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** fractions of the em; used when the program does not say */
  ascent: number;
  descent: number;
  /** width of a word space (fraction of the em), used when the subset has no space glyph */
  space?: number;
}

const writer = (length: number) => {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  return {
    bytes,
    u16: (at: number, v: number) => view.setUint16(at, v & 0xffff),
    i16: (at: number, v: number) => view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(v)))),
    u32: (at: number, v: number) => view.setUint32(at, v >>> 0),
  };
};

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** a standalone font with glyph ids unchanged, or null when the program cannot be carried over */
export function rebuildFont(request: RebuildRequest): Uint8Array | null {
  const { program } = request;
  const kind = sfntKind(program);
  if (kind === "woff") return null;
  let source: Map<string, Uint8Array>;
  let bare: ReturnType<typeof cffSummary> = null;
  if (kind) source = readTables(program, 0);
  else {
    bare = cffSummary(program);
    if (!bare) return null;
    source = new Map([["CFF ", program]]);
  }
  const trueType = source.has("glyf") && source.has("loca");
  const cff = !trueType ? source.get("CFF ") : undefined;
  if (!trueType && !cff) return null;
  bare ??= cff ? cffSummary(cff) : null;
  if (cff && !bare) return null;

  const info = kind ? fontInfo(program) : null;
  const head = source.get("head");
  const unitsPerEm = head && head.length >= 54 ? view(head).getUint16(18) || 1000 : (bare?.unitsPerEm ?? 1000);
  const oldHmtx = source.get("hmtx");
  const oldMaxp = source.get("maxp");
  const oldHhea = source.get("hhea");

  const tables = new Map<string, Uint8Array>();
  let glyphs: number;
  /** glyphs that draw nothing */
  const empty: number[] = [];
  let long = false;
  if (trueType) {
    const loca = source.get("loca")!;
    const glyf = source.get("glyf")!;
    long = !!head && head.length >= 54 && view(head).getInt16(50) === 1;
    const entries = Math.floor(loca.length / (long ? 4 : 2));
    const declared = oldMaxp && oldMaxp.length >= 6 ? view(oldMaxp).getUint16(4) : entries - 1;
    glyphs = Math.min(declared, entries - 1);
    if (glyphs < 1) return null;
    // offsets that run backwards or past the end would get the whole font rejected
    const out = writer((glyphs + 1) * 4);
    let last = 0;
    for (let i = 0; i <= glyphs; i++) {
      const raw = long ? view(loca).getUint32(i * 4) : view(loca).getUint16(i * 2) * 2;
      const at = Math.max(last, Math.min(glyf.length, raw));
      out.u32(i * 4, at);
      if (i && at === last) empty.push(i - 1);
      last = at;
    }
    tables.set("loca", out.bytes);
    tables.set("glyf", glyf);
    for (const tag of ["cvt ", "fpgm", "prep"]) {
      const t = source.get(tag);
      if (t) tables.set(tag, t);
    }
    if (oldMaxp && oldMaxp.length >= 32 && view(oldMaxp).getUint32(0) === 0x00010000) {
      const maxp = oldMaxp.slice(0, 32);
      view(maxp).setUint16(4, glyphs);
      tables.set("maxp", maxp);
    } else {
      const maxp = writer(32);
      maxp.u32(0, 0x00010000);
      maxp.u16(4, glyphs);
      for (let at = 6; at < 32; at += 2) maxp.u16(at, 0x4000);
      maxp.u16(14, 2);
      maxp.u16(30, 16);
      tables.set("maxp", maxp.bytes);
    }
  } else {
    glyphs = bare!.glyphs;
    tables.set("CFF ", cff!);
    const maxp = writer(6);
    maxp.u32(0, 0x00005000);
    maxp.u16(4, glyphs);
    tables.set("maxp", maxp.bytes);
  }
  // shaping rules the subset kept are still right, as glyph ids do not change
  for (const tag of ["GSUB", "GPOS", "GDEF"]) {
    const t = source.get(tag);
    if (t) tables.set(tag, t);
  }

  const map = new Map([...request.map].filter(([cp, g]) => cp > 0 && cp <= 0x10ffff && g > 0 && g < glyphs));
  if (!map.size) return null;
  const widths = new Map(request.widths);
  if (!map.has(32) && request.space) {
    const used = new Set(map.values());
    const blank = empty.find((g) => g > 0 && !used.has(g));
    if (blank !== undefined) {
      map.set(32, blank);
      if (!map.has(160)) map.set(160, blank);
      widths.set(blank, request.space);
    }
  }

  /* ---------- metrics ---------- */
  const oldMetrics = oldHhea && oldHhea.length >= 36 ? view(oldHhea).getUint16(34) : 0;
  const hmtx = writer(glyphs * 4);
  let widest = 0;
  for (let g = 0; g < glyphs; g++) {
    let advance: number | undefined;
    let bearing = 0;
    if (oldHmtx && oldMetrics) {
      const k = Math.min(g, oldMetrics - 1);
      if (k * 4 + 4 <= oldHmtx.length) advance = view(oldHmtx).getUint16(k * 4);
      const at = g < oldMetrics ? g * 4 + 2 : oldMetrics * 4 + (g - oldMetrics) * 2;
      if (at + 2 <= oldHmtx.length) bearing = view(oldHmtx).getInt16(at);
    }
    const wanted = widths.get(g);
    if (wanted !== undefined) advance = Math.round(wanted * unitsPerEm);
    else if (advance === undefined) advance = Math.round((request.advance?.(g) ?? 0.5) * unitsPerEm);
    advance = Math.max(0, Math.min(65535, advance));
    widest = Math.max(widest, advance);
    hmtx.u16(g * 4, advance);
    hmtx.i16(g * 4 + 2, bearing);
  }
  tables.set("hmtx", hmtx.bytes);

  const plausible = (v: number, low: number, high: number) => v > low * unitsPerEm && v < high * unitsPerEm;
  let ascent = info?.ascent ?? 0;
  let descent = info?.descent ?? 0;
  if (!plausible(ascent, 0.5, 1.6)) ascent = request.ascent * unitsPerEm;
  if (!plausible(-descent, 0.05, 0.8)) descent = -Math.abs(request.descent) * unitsPerEm;
  const hhea = writer(36);
  hhea.u32(0, 0x00010000);
  hhea.i16(4, ascent);
  hhea.i16(6, descent);
  hhea.u16(10, widest);
  hhea.i16(16, widest);
  hhea.i16(18, 1);
  hhea.u16(34, glyphs);
  tables.set("hhea", hhea.bytes);

  const box = info?.bbox.some(Boolean) ? info.bbox : bare?.bbox.some(Boolean) ? bare.bbox : [0, descent, unitsPerEm, ascent];
  const h = writer(54);
  h.u32(0, 0x00010000);
  h.u32(4, 0x00010000);
  h.u32(12, 0x5f0f3cf5);
  h.u16(16, 3);
  h.u16(18, unitsPerEm);
  for (let i = 0; i < 4; i++) h.i16(36 + i * 2, box[i]!);
  h.u16(44, (request.bold ? 1 : 0) | (request.italic ? 2 : 0));
  h.u16(46, 8);
  h.i16(48, 2);
  h.i16(50, trueType ? 1 : 0);
  tables.set("head", h.bytes);

  tables.set("cmap", cmapTable(map));
  tables.set("name", nameTable(request));

  const points = [...map.keys()].sort((a, b) => a - b);
  const os2 = writer(96);
  os2.u16(0, 4);
  os2.i16(2, unitsPerEm / 2);
  os2.u16(4, request.bold ? 700 : 400);
  os2.u16(6, 5);
  const sizes = [0.65, 0.6, 0, 0.075, 0.65, 0.6, 0, 0.35, 0.05, 0.26];
  sizes.forEach((v, i) => os2.i16(10 + i * 2, v * unitsPerEm));
  os2.u16(62, request.bold || request.italic ? (request.bold ? 32 : 0) | (request.italic ? 1 : 0) : 64);
  os2.u16(64, Math.min(0xffff, points[0]!));
  os2.u16(66, Math.min(0xffff, points[points.length - 1]!));
  os2.i16(68, ascent);
  os2.i16(70, descent);
  os2.u16(74, Math.max(0, Math.min(65535, Math.round(Math.max(ascent, box[3]!)))));
  os2.u16(76, Math.max(0, Math.min(65535, Math.round(Math.max(-descent, -box[1]!)))));
  os2.i16(86, info?.capHeight ? info.capHeight * 0.72 : unitsPerEm * 0.5);
  os2.i16(88, info?.capHeight ?? unitsPerEm * 0.7);
  os2.u16(92, 32);
  os2.u16(94, 2);
  tables.set("OS/2", os2.bytes);

  const post = writer(32);
  post.u32(0, 0x00030000);
  post.u32(4, Math.round((info?.italicAngle ?? 0) * 65536) >>> 0);
  post.i16(8, info?.underlinePosition ?? -unitsPerEm * 0.1);
  post.i16(10, info?.underlineThickness ?? unitsPerEm * 0.05);
  post.u32(12, request.mono ? 1 : 0);
  tables.set("post", post.bytes);

  return buildSfnt(cff ? 0x4f54544f : 0x00010000, tables);
}

/** format 4 for the basic plane and format 12 for everything */
function cmapTable(map: Map<number, number>): Uint8Array {
  const entries = [...map].sort((a, b) => a[0] - b[0]);
  const runs: [start: number, end: number, glyph: number][] = [];
  for (const [cp, g] of entries) {
    const last = runs[runs.length - 1];
    if (last && cp === last[1] + 1 && g === last[2] + (cp - last[0])) last[1] = cp;
    else runs.push([cp, cp, g]);
  }
  const basic = runs.filter(([start]) => start < 0xffff).slice(0, 8000);
  const segments: [number, number, number][] = [
    ...basic.map(([s, e, g]) => [s, Math.min(e, 0xfffe), (g - s) & 0xffff] as [number, number, number]),
    [0xffff, 0xffff, 1],
  ];
  const count = segments.length;
  const four = writer(16 + count * 8);
  four.u16(0, 4);
  four.u16(2, four.bytes.length);
  four.u16(6, count * 2);
  const power = 2 ** Math.floor(Math.log2(count));
  four.u16(8, power * 2);
  four.u16(10, Math.log2(power));
  four.u16(12, (count - power) * 2);
  segments.forEach(([start, end, delta], i) => {
    four.u16(14 + i * 2, end);
    four.u16(16 + count * 2 + i * 2, start);
    four.u16(16 + count * 4 + i * 2, delta);
  });
  const twelve = writer(16 + runs.length * 12);
  twelve.u16(0, 12);
  twelve.u32(4, twelve.bytes.length);
  twelve.u32(12, runs.length);
  runs.forEach(([start, end, glyph], i) => {
    twelve.u32(16 + i * 12, start);
    twelve.u32(20 + i * 12, end);
    twelve.u32(24 + i * 12, glyph);
  });
  const out = writer(20 + four.bytes.length + twelve.bytes.length);
  out.u16(2, 2);
  out.u16(4, 3);
  out.u16(6, 1);
  out.u32(8, 20);
  out.u16(12, 3);
  out.u16(14, 10);
  out.u32(16, 20 + four.bytes.length);
  out.bytes.set(four.bytes, 20);
  out.bytes.set(twelve.bytes, 20 + four.bytes.length);
  return out.bytes;
}

function nameTable(request: RebuildRequest): Uint8Array {
  const family = request.name.replace(/[^\x20-\x7e]/g, "").slice(0, 60) || "Document font";
  const style = [request.bold ? "Bold" : "", request.italic ? "Italic" : ""].filter(Boolean).join(" ") || "Regular";
  const postScript = family.replace(/[^A-Za-z0-9-]/g, "") || "DocumentFont";
  const records: [number, string][] = [
    [1, family],
    [2, style],
    [4, `${family} ${style}`],
    [6, postScript],
  ];
  const text = records.reduce((n, [, s]) => n + s.length * 2, 0);
  const strings = 6 + records.length * 12;
  const out = writer(strings + text);
  out.u16(2, records.length);
  out.u16(4, strings);
  let offset = 0;
  records.forEach(([id, value], i) => {
    const at = 6 + i * 12;
    out.u16(at, 3);
    out.u16(at + 2, 1);
    out.u16(at + 4, 0x409);
    out.u16(at + 6, id);
    out.u16(at + 8, value.length * 2);
    out.u16(at + 10, offset);
    for (let k = 0; k < value.length; k++) out.u16(strings + offset + k * 2, value.charCodeAt(k));
    offset += value.length * 2;
  });
  return out.bytes;
}
