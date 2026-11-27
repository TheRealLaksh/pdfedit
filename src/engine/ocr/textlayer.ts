/**
 * Invisible text for scans, the way OCR engines write it: a tiny embedded font without any drawings, one
 * code per character and an exact map back to Unicode. No shaping is involved, so every script comes
 * out of copy and search exactly as recognised, the file stays small and nothing has to be downloaded.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { num } from "../geom";
import type { Frame } from "./state";

/** advance of every character, thousandths of the font size; the word space is half as wide */
const ADVANCE = 500;
const SPACE = ADVANCE / 2;
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

export interface TextLayer {
  /**
   * Operators writing `text` between `from` and `to` along the baseline of `frame` (PDF space), with a
   * real space after it (in reading direction) when `space` is set.
   */
  word(text: string, frame: Frame, from: number, to: number, space?: boolean): string;
  /** write the maps and return the font resource dictionary for the form that holds the operators */
  resources(): MuPDF.PDFObject;
}

export function textLayer(ctx: EngineContext): TextLayer {
  const codes = new Map<string, number>();
  const code = (char: string) => {
    let c = codes.get(char);
    if (c === undefined) codes.set(char, (c = codes.size + 1));
    return c.toString(16).padStart(4, "0");
  };
  return {
    word(text, frame, from, to, space) {
      const chars = [...text];
      if (!chars.length || to <= from) return "";
      // the type fills the height of the line, so that selection highlights cover the letters
      const size = Math.max(1, frame.asc + frame.desc);
      const step = (to - from) / chars.length;
      const stretch = (100 * step) / ((ADVANCE / 1000) * size);
      const { u, up } = frame;
      // the font box runs from a fifth below its baseline to four fifths above
      const lift = size * 0.2 - frame.desc;
      const at = (along: number) =>
        `${num(u.x)} ${num(u.y)} ${num(up.x)} ${num(up.y)} ${num(frame.o[0] + u.x * along + up.x * lift)} ${num(frame.o[1] + u.y * along + up.y * lift)} Tm`;
      // The space shares the word's text matrix: a squeezed space of its own would look like much smaller
      // type to text extraction, which then starts a new line after combining marks.
      let body: string;
      // right to left words are written in reading order, each character left of the one before
      if (RTL.test(text)) {
        body = chars.map((c, i) => `${at(to - (i + 1) * step)} <${code(c)}> Tj`).join("\n");
        if (space) body += `\n${at(from - (step * SPACE) / ADVANCE)} <${code(" ")}> Tj`;
      } else body = `${at(from)} <${chars.map(code).join("")}${space ? code(" ") : ""}> Tj`;
      return `BT 3 Tr /F0 ${num(size)} Tf ${num(stretch)} Tz\n${body}\nET\n`;
    },
    resources() {
      const doc = ctx.doc;
      const fonts = doc.newDictionary();
      fonts.put("F0", buildFont(ctx, codes));
      const resources = doc.newDictionary();
      resources.put("Font", fonts);
      return resources;
    },
  };
}

function buildFont(ctx: EngineContext, codes: Map<string, number>): MuPDF.PDFObject {
  const doc = ctx.doc;
  const name = "PEBLNK+Invisible";
  const program = emptyTrueType();
  const fileDict = doc.newDictionary();
  fileDict.put("Length1", program.length);
  const file = doc.addStream(program, fileDict);

  const descriptor = doc.newDictionary();
  descriptor.put("Type", doc.newName("FontDescriptor"));
  descriptor.put("FontName", doc.newName(name));
  descriptor.put("Flags", 5);
  const box = doc.newArray();
  for (const v of [0, -200, ADVANCE, 800]) box.push(v);
  descriptor.put("FontBBox", box);
  descriptor.put("ItalicAngle", 0);
  descriptor.put("Ascent", 800);
  descriptor.put("Descent", -200);
  descriptor.put("CapHeight", 800);
  descriptor.put("StemV", 80);
  descriptor.put("FontFile2", file);

  // every code shows the same empty glyph
  const map = new Uint8Array((codes.size + 1) * 2);
  for (let i = 1; i <= codes.size; i++) map[i * 2 + 1] = 1;

  const system = doc.newDictionary();
  system.put("Registry", doc.newString("Adobe"));
  system.put("Ordering", doc.newString("Identity"));
  system.put("Supplement", 0);
  const cid = doc.newDictionary();
  cid.put("Type", doc.newName("Font"));
  cid.put("Subtype", doc.newName("CIDFontType2"));
  cid.put("BaseFont", doc.newName(name));
  cid.put("CIDSystemInfo", system);
  cid.put("FontDescriptor", doc.addObject(descriptor));
  cid.put("DW", ADVANCE);
  const space = codes.get(" ");
  if (space !== undefined) {
    const widths = doc.newArray();
    const one = doc.newArray();
    one.push(SPACE);
    widths.push(space);
    widths.push(one);
    cid.put("W", widths);
  }
  cid.put("CIDToGIDMap", doc.addStream(map, doc.newDictionary()));

  const descendants = doc.newArray();
  descendants.push(doc.addObject(cid));
  const font = doc.newDictionary();
  font.put("Type", doc.newName("Font"));
  font.put("Subtype", doc.newName("Type0"));
  font.put("BaseFont", doc.newName(name));
  font.put("Encoding", doc.newName("Identity-H"));
  font.put("DescendantFonts", descendants);
  font.put("ToUnicode", doc.addStream(toUnicode(codes), doc.newDictionary()));
  return doc.addObject(font);
}

function toUnicode(codes: Map<string, number>): string {
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const rows = [...codes].map(([char, c]) => {
    let units = "";
    for (let i = 0; i < char.length; i++) units += hex(char.charCodeAt(i));
    return `<${hex(c)}> <${units}>`;
  });
  let body = "";
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar\n`;
  }
  return (
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    body +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
  );
}

/** the smallest sound TrueType font: two glyphs without outlines */
export function emptyTrueType(): Uint8Array {
  const table = (length: number, fill: (v: DataView) => void) => {
    const bytes = new Uint8Array(length);
    fill(new DataView(bytes.buffer));
    return bytes;
  };
  const tables: [string, Uint8Array][] = [
    // one segment that maps nothing
    ["cmap", table(36, (v) => {
      v.setUint16(2, 1);
      v.setUint16(4, 3);
      v.setUint16(6, 1);
      v.setUint32(8, 12);
      v.setUint16(12, 4);
      v.setUint16(14, 24);
      v.setUint16(18, 2);
      v.setUint16(20, 2);
      v.setUint16(26, 0xffff);
      v.setUint16(30, 0xffff);
      v.setUint16(32, 1);
    })],
    ["glyf", new Uint8Array(4)],
    ["head", table(54, (v) => {
      v.setUint32(0, 0x00010000);
      v.setUint32(12, 0x5f0f3cf5);
      v.setUint16(16, 3);
      v.setUint16(18, 1000);
      v.setInt16(38, -200);
      v.setInt16(40, ADVANCE);
      v.setInt16(42, 800);
      v.setUint16(46, 8);
      v.setInt16(48, 2);
    })],
    ["hhea", table(36, (v) => {
      v.setUint32(0, 0x00010000);
      v.setInt16(4, 800);
      v.setInt16(6, -200);
      v.setUint16(10, ADVANCE);
      v.setInt16(18, 1);
      v.setUint16(34, 2);
    })],
    ["hmtx", table(8, (v) => {
      v.setUint16(0, ADVANCE);
      v.setUint16(4, ADVANCE);
    })],
    ["loca", new Uint8Array(6)],
    ["maxp", table(32, (v) => {
      v.setUint32(0, 0x00010000);
      v.setUint16(4, 2);
      v.setUint16(14, 2);
    })],
    ["name", table(6, (v) => v.setUint16(4, 6))],
    ["post", table(32, (v) => v.setUint32(0, 0x00030000))],
  ];
  const padded = (n: number) => (n + 3) & ~3;
  let offset = 12 + tables.length * 16;
  const total = offset + tables.reduce((n, [, b]) => n + padded(b.length), 0);
  const font = new Uint8Array(total);
  const view = new DataView(font.buffer);
  const checksum = (from: number, length: number) => {
    let sum = 0;
    for (let i = from; i < from + padded(length); i += 4) sum = (sum + view.getUint32(i)) >>> 0;
    return sum;
  };
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  view.setUint16(6, 128);
  view.setUint16(8, 3);
  view.setUint16(10, tables.length * 16 - 128);
  let headAt = 0;
  tables.forEach(([tag, bytes], i) => {
    font.set(bytes, offset);
    const entry = 12 + i * 16;
    for (let k = 0; k < 4; k++) font[entry + k] = tag.charCodeAt(k);
    view.setUint32(entry + 4, checksum(offset, bytes.length));
    view.setUint32(entry + 8, offset);
    view.setUint32(entry + 12, bytes.length);
    if (tag === "head") headAt = offset;
    offset += padded(bytes.length);
  });
  view.setUint32(headAt + 8, (0xb1b0afba - checksum(0, total)) >>> 0);
  return font;
}
