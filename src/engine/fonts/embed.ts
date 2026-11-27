/**
 * Embeds fonts as Type0 / Identity-H. One PDF font per font program and document, grown as new glyphs
 * are used. TrueType: a CID per (glyph, text) pair with a CIDToGIDMap, so ToUnicode is exact even when
 * one glyph stands for different text. CFF: CIDs are fixed by the font program.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import type { Face } from "./face";
import { subsetFont } from "./hb";
import { FILLER } from "./layout";
import type { Source } from "./resolve";
import { cffGidToCid, readTables } from "./sfnt";

/** cid, glyph, text, declared width when it differs from the font's */
type Entry = [cid: number, glyph: number, text: string, width?: number];

/** kept in ctx.state so it follows undo and redo together with the PDF objects */
interface FontRecord {
  name: string;
  /** object numbers */
  type0: number;
  cidFont: number;
  descriptor: number;
  file: number;
  toUnicode: number;
  cidToGid: number;
  /** in order of first use */
  entries: Entry[];
}

export interface EmbeddedFont {
  object: MuPDF.PDFObject;
  /**
   * Two byte character code to show this glyph, and the advance the viewer will use for it (thousandths
   * of the font size, exactly as written to /W). `declared` asks for another advance (TrueType only).
   */
  code(glyph: number, text: string, declared?: number): { cid: number; width: number };
  /** write the font program and maps if new glyphs were used; true when the font changed */
  flush(): Promise<boolean>;
}

const records = (ctx: EngineContext) => (ctx.state.extra.fonts ??= {}) as Record<string, FontRecord>;

const cffMaps = new WeakMap<Face, Map<number, number> | null>();
function cidMapOf(face: Face): Map<number, number> | null {
  let map = cffMaps.get(face);
  if (map === undefined) {
    const cff = readTables(face.bytes).get("CFF ");
    map = cff ? cffGidToCid(cff) : null;
    cffMaps.set(face, map);
  }
  return map;
}

function baseName(key: string, face: Face): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.imul(h ^ (i + 7), 0x01000193) >>> 0;
  }
  const name = (face.info.postScriptName || face.info.family || "Font").replace(/^[A-Z]{6}\+/, "").replace(/[^A-Za-z0-9_.-]/g, "");
  return `${tag}+${name || "Font"}`;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function stillThere(doc: MuPDF.PDFDocument, record: FontRecord): boolean {
  if (record.type0 >= doc.countObjects()) return false;
  const base = doc.newIndirect(record.type0).get("BaseFont");
  return base.isName() && base.asName() === record.name;
}

function createRecord(ctx: EngineContext, key: string, face: Face): FontRecord {
  const doc = ctx.doc;
  const info = face.info;
  const cff = info.outlines === "cff";
  const name = baseName(key, face);
  const k = 1000 / info.unitsPerEm;
  const flags = (info.mono ? 1 : 0) | (info.serif ? 2 : 0) | 4 | (info.italic ? 64 : 0);

  const stream = (extra?: string) => {
    const dict = doc.newDictionary();
    dict.put("Filter", doc.newName("FlateDecode"));
    if (extra) dict.put("Subtype", doc.newName(extra));
    return doc.addRawStream(new Uint8Array(), dict);
  };
  const file = stream(cff ? "OpenType" : undefined);
  const toUnicode = stream();

  const descriptor = doc.addObject(doc.newDictionary());
  descriptor.put("Type", doc.newName("FontDescriptor"));
  descriptor.put("FontName", doc.newName(name));
  descriptor.put("Flags", flags);
  const box = doc.newArray();
  for (const v of info.bbox) box.push(Math.round(v * k));
  descriptor.put("FontBBox", box);
  descriptor.put("ItalicAngle", info.italicAngle);
  descriptor.put("Ascent", Math.round(info.ascent * k));
  descriptor.put("Descent", Math.round(info.descent * k));
  descriptor.put("CapHeight", Math.round(info.capHeight * k));
  descriptor.put("StemV", info.bold ? 120 : 80);
  descriptor.put(cff ? "FontFile3" : "FontFile2", file);

  const system = doc.newDictionary();
  system.put("Registry", doc.newString("Adobe"));
  system.put("Ordering", doc.newString("Identity"));
  system.put("Supplement", 0);
  const cidFont = doc.addObject(doc.newDictionary());
  cidFont.put("Type", doc.newName("Font"));
  cidFont.put("Subtype", doc.newName(cff ? "CIDFontType0" : "CIDFontType2"));
  cidFont.put("BaseFont", doc.newName(name));
  cidFont.put("CIDSystemInfo", system);
  cidFont.put("FontDescriptor", descriptor);
  cidFont.put("DW", 1000);

  let cidToGid = 0;
  if (!cff) {
    const map = stream();
    cidFont.put("CIDToGIDMap", map);
    cidToGid = map.asIndirect();
  }

  const type0 = doc.addObject(doc.newDictionary());
  type0.put("Type", doc.newName("Font"));
  type0.put("Subtype", doc.newName("Type0"));
  type0.put("BaseFont", doc.newName(name));
  type0.put("Encoding", doc.newName("Identity-H"));
  const descendants = doc.newArray();
  descendants.push(cidFont);
  type0.put("DescendantFonts", descendants);
  type0.put("ToUnicode", toUnicode);

  return {
    name,
    type0: type0.asIndirect(),
    cidFont: cidFont.asIndirect(),
    descriptor: descriptor.asIndirect(),
    file: file.asIndirect(),
    toUnicode: toUnicode.asIndirect(),
    cidToGid,
    entries: [],
  };
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0").toUpperCase();

function utf16Hex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += hex4(text.charCodeAt(i));
  return out;
}

function toUnicodeCMap(entries: Entry[]): string {
  const lines = entries.filter(([cid]) => cid !== 0).map(([cid, , text]) => `<${hex4(cid)}> <${utf16Hex(text)}>`);
  let body = "";
  for (let i = 0; i < lines.length; i += 100) {
    const chunk = lines.slice(i, i + 100);
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

export function embeddedFont(ctx: EngineContext, source: Source, face: Face): EmbeddedFont {
  const doc = ctx.doc;
  const all = records(ctx);
  let record = all[source.key];
  if (!record || !stillThere(doc, record)) record = all[source.key] = createRecord(ctx, source.key, face);
  const rec = record;
  const cff = face.info.outlines === "cff";
  const cids = cff ? cidMapOf(face) : null;

  const keyOf = (gid: number, text: string, w?: number) => (cff ? String(gid) : `${gid}:${w ?? ""}:${text}`);
  const codes = new Map(rec.entries.map(([cid, gid, text, w]) => [keyOf(gid, text, w), cid]));
  const widths = new Map<number, number>();
  const width = (gid: number) => {
    let w = widths.get(gid);
    if (w === undefined) {
      w = Math.round((face.hbFont.glyphHAdvance(gid) * 1e7) / face.info.unitsPerEm) / 1e4;
      widths.set(gid, w);
    }
    return w;
  };
  let dirty = rec.entries.length === 0;

  const font: EmbeddedFont = {
    object: doc.newIndirect(rec.type0),
    code(gid, text, declared) {
      let override = cff || declared === undefined ? undefined : Math.round(declared * 1e4) / 1e4;
      if (override !== undefined && Math.abs(override - width(gid)) < 0.01) override = undefined;
      const key = keyOf(gid, text, override);
      let cid = codes.get(key);
      if (cid === undefined) {
        cid = cff ? (cids ? (cids.get(gid) ?? 0) : gid) : rec.entries.length + 1;
        if (cid > 0xffff) throw new Error("Too many different glyphs for one font");
        rec.entries.push(override === undefined ? [cid, gid, text] : [cid, gid, text, override]);
        codes.set(key, cid);
        dirty = true;
      } else if (cff && text !== FILLER) {
        // one code per glyph: a real character replaces a mapping that said "nothing"
        const entry = rec.entries.find((e) => e[1] === gid);
        if (entry && entry[2] === FILLER) {
          entry[2] = text;
          dirty = true;
        }
      }
      return { cid, width: override ?? width(gid) };
    },
    async flush() {
      if (!dirty) return false;
      // the plain glyph of every character written gets a code too, so later edits can reuse the font
      const known = new Set(rec.entries.map((e) => e[1]));
      for (const text of rec.entries.map((e) => e[2]))
        for (const ch of text) {
          const plain = ch === FILLER ? 0 : face.glyph(ch.codePointAt(0)!);
          if (!plain || known.has(plain)) continue;
          known.add(plain);
          font.code(plain, ch);
        }
      dirty = false;
      const entries = [...rec.entries].sort((a, b) => a[0] - b[0]);
      const glyphs = new Set(entries.map((e) => e[1]));
      const unicodes = new Set<number>();
      for (const [, gid, text] of entries)
        for (const ch of text) {
          const cp = ch.codePointAt(0)!;
          if (face.glyph(cp) === gid || glyphs.has(face.glyph(cp))) unicodes.add(cp);
        }
      let program: Uint8Array;
      try {
        const axes = face.info.variable ? (source.axes ?? {}) : undefined;
        program = await subsetFont(face.bytes, { glyphs, unicodes, axes });
      } catch (e) {
        console.warn("Embedding the whole font", e);
        program = face.bytes;
      }
      const file = doc.newIndirect(rec.file);
      file.put("Length1", program.length);
      file.writeRawStream(await deflate(program));
      doc.newIndirect(rec.toUnicode).writeRawStream(await deflate(new TextEncoder().encode(toUnicodeCMap(entries))));

      const w = doc.newArray();
      let group: MuPDF.PDFObject | null = null;
      let next = -1;
      for (const [cid, gid, , declared] of entries) {
        if (cid !== next || !group) {
          group = doc.newArray();
          w.push(cid);
          w.push(group);
          group = w.get(w.length - 1);
        }
        group.push(doc.newReal(declared ?? width(gid)));
        next = cid + 1;
      }
      doc.newIndirect(rec.cidFont).put("W", w);

      if (rec.cidToGid) {
        const map = new Uint8Array(((entries.at(-1)?.[0] ?? 0) + 1) * 2);
        for (const [cid, gid] of entries) {
          map[cid * 2] = gid >> 8;
          map[cid * 2 + 1] = gid & 255;
        }
        doc.newIndirect(rec.cidToGid).writeRawStream(await deflate(map));
      }
      return true;
    },
  };
  return font;
}
