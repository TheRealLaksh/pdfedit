/** A PDF font dictionary as the text engine needs it: code splitting, widths, Unicode both ways, metrics. */
import type * as MuPDF from "mupdf";
import { codeValue, nextCode, parseCMap, predefinedCMap, type CidRange, type CodeRange } from "./cmap";
import { baseEncoding, glyphNameToUnicode } from "./encodings";
import { probeCodes, type Probe } from "./probe";

export interface Code {
  code: number;
  length: number;
}

export interface FontFlags {
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

export class PdfFont {
  readonly subtype: string;
  /** BaseFont without the ABCDEF+ subset prefix */
  readonly name: string;
  readonly composite: boolean;
  readonly flags: FontFlags;
  /** em fractions: ascent positive, descent negative */
  readonly ascent: number;
  readonly descent: number;
  /** multiply the Tf size by this to get the visual em size (only differs from 1 for Type3) */
  readonly emScale: number;
  vertical = false;
  readonly embedded: boolean;
  /** CID = GID, and codes are two byte CIDs: new glyphs can be addressed from the font program */
  readonly identityCid: boolean;

  readonly toUnicode: Map<number, string>;
  private codespaces: CodeRange[] = [];
  private cidRanges: CidRange[] = [];
  private decodeNamed?: (code: number, length: number) => string;
  private encodingTable: string[] | null = null;
  private widths = new Map<number, number>();
  private defaultWidth = 0;
  private widthsKnown = true;
  private vmetrics = new Map<number, number>();
  private defaultVertical = -1;
  private probes = new Map<number, Probe | null>();
  private descriptor: MuPDF.PDFObject | null = null;
  private cidToGid: Uint8Array | null = null;
  private reverse: Map<string, Code[]> | null = null;

  constructor(
    private mupdf: typeof MuPDF,
    /** the object as referenced from a resource dictionary */
    readonly obj: MuPDF.PDFObject,
    readonly id: string,
  ) {
    const dict = obj;
    const subtype = nameOf(dict.get("Subtype"));
    this.subtype = subtype;
    this.composite = subtype === "Type0";
    // Type3 fonts often name themselves only in their descriptor
    const described = subtype === "Type3" ? nameOf(dict.get("FontDescriptor", "FontName")) : "";
    const base = nameOf(dict.get("BaseFont")) || described || nameOf(dict.get("Name"));
    this.name = base.replace(/^[A-Z]{6}\+/, "") || (subtype === "Type3" ? "Type3" : "Unknown");

    const tu = dict.get("ToUnicode");
    this.toUnicode = new Map();
    if (tu.isStream()) {
      const map = parseCMap(tu.readStream().asUint8Array().slice());
      for (const [k, v] of map.unicode) {
        const clean = v.replace(/\0/g, "");
        if (clean && clean !== "\uFFFD") this.toUnicode.set(k, clean);
      }
    }

    let descendant: MuPDF.PDFObject | null = null;
    let identity = false;
    if (this.composite) {
      const d = dict.get("DescendantFonts");
      descendant = d.isArray() ? d.get(0) : null;
      const enc = dict.get("Encoding");
      if (enc.isStream()) {
        const map = parseCMap(enc.readStream().asUint8Array().slice());
        this.codespaces = map.codespaces;
        this.cidRanges = map.cidRanges;
        this.vertical = map.vertical || (enc.get("WMode").isNumber() && enc.get("WMode").asNumber() === 1);
        const parent = map.useCMap ?? nameOf(enc.get("UseCMap"));
        if (parent) {
          const p = predefinedCMap(parent);
          if (!this.codespaces.length) this.codespaces = p.codespaces;
          this.decodeNamed = p.decode;
          identity = /^Identity/.test(parent) && !this.cidRanges.length;
        }
        if (!this.codespaces.length) this.codespaces = predefinedCMap("Identity-H").codespaces;
      } else {
        const encName = nameOf(enc) || "Identity-H";
        const p = predefinedCMap(encName);
        this.codespaces = p.codespaces;
        this.decodeNamed = p.decode;
        this.vertical = /-V$/.test(encName);
        identity = /^Identity-[HV]$/.test(encName);
        // other named CMaps map codes to CIDs through tables we do not carry: MuPDF tells us the widths
        if (!identity) this.widthsKnown = false;
      }
      this.descriptor = descendant && !descendant.get("FontDescriptor").isNull() ? descendant.get("FontDescriptor") : null;
    } else {
      this.descriptor = dict.get("FontDescriptor").isNull() ? null : dict.get("FontDescriptor");
    }

    const flagsValue = num(this.descriptor?.get("Flags"), 0);
    const weight = num(this.descriptor?.get("FontWeight"), 0);
    const italicAngle = num(this.descriptor?.get("ItalicAngle"), 0);
    const lname = this.name.toLowerCase();
    const sans = /sans|arial|helvetica|calibri|verdana|tahoma|roboto|inter\b|gothic|segoe/.test(lname);
    this.flags = {
      bold:
        /bold|black|heavy|semibd|demi|cmbx|sfbx|-bd\b|,bd\b/.test(lname) ||
        weight >= 600 ||
        (flagsValue & 262144) !== 0 ||
        (subtype === "Type3" && emboldened(dict)),
      italic: /italic|oblique|kursiv|-it$|-it,|cmti|cmmi|cmsl/.test(lname) || (flagsValue & 64) !== 0 || Math.abs(italicAngle) > 2,
      serif:
        !sans &&
        ((flagsValue & 2) !== 0 ||
          /times|serif|roman|georgia|garamond|cambria|book|minion|palatino|century|caslon|baskerville|tinos|^cm(r|bx|ti)|mincho|simsun|song|charis|doulos|gentium|bitter|merriweather|playfair|libertine/.test(lname)),
      mono: (flagsValue & 1) !== 0 || /courier|mono|consol|menlo|typewriter|^cmtt|cousine/.test(lname),
    };

    const fileOwner = this.descriptor;
    this.embedded =
      subtype === "Type3" ||
      !!fileOwner && ["FontFile", "FontFile2", "FontFile3"].some((k) => fileOwner.get(k).isStream());

    // metrics
    let ascent = num(this.descriptor?.get("Ascent"), 0) / 1000;
    let descent = num(this.descriptor?.get("Descent"), 0) / 1000;
    let emScale = 1;
    if (subtype === "Type3") {
      const fm = numbers(dict.get("FontMatrix"));
      const bbox = numbers(dict.get("FontBBox"));
      const sy = Math.abs(fm[3] ?? 0.001) || 0.001;
      // The usual grids (1000, 2048 ...) mean the Tf size is the em. The font box says nothing then: it
      // covers the tallest marks. Only unusual matrices (bitmap fonts) are sized by the box.
      const conventional = [1000, 1024, 2000, 2048, 4096, 16384].some((upem) => Math.abs(sy * upem - 1) < 0.002);
      const h = bbox.length === 4 ? Math.abs(bbox[3]! - bbox[1]!) * sy : 0;
      emScale = conventional ? 1 : h > 0.05 ? h : sy * 1000;
      // the box does tell how far marks reach above and below the baseline
      const edges = bbox.length === 4 ? [bbox[1]! * (fm[3] ?? 0.001), bbox[3]! * (fm[3] ?? 0.001)] : [0, 0];
      ascent = conventional ? Math.min(1.15, Math.max(...edges)) : 0;
      descent = conventional ? Math.max(-0.5, Math.min(...edges)) : 0;
    }
    if (!(ascent > 0.3 && ascent < 1.6)) ascent = 0.85;
    if (descent > 0) descent = -descent;
    if (!(descent < -0.01 && descent > -0.8)) descent = -0.22;
    this.ascent = ascent;
    this.descent = descent;
    this.emScale = emScale;

    if (this.composite) {
      this.defaultWidth = num(descendant?.get("DW"), 1000) / 1000;
      const w = descendant?.get("W");
      if (w?.isArray()) {
        for (let i = 0; i < w.length; ) {
          const first = w.get(i).asNumber();
          const second = w.get(i + 1);
          if (second.isArray()) {
            for (let k = 0; k < second.length; k++) this.widths.set(first + k, second.get(k).asNumber() / 1000);
            i += 2;
          } else {
            const last = Math.min(second.asNumber(), first + 70000);
            const value = w.get(i + 2).asNumber() / 1000;
            for (let c = first; c <= last; c++) this.widths.set(c, value);
            i += 3;
          }
        }
      }
      if (this.vertical) {
        const dw2 = numbers(descendant!.get("DW2"));
        this.defaultVertical = (dw2[1] ?? -1000) / 1000;
        const w2 = descendant!.get("W2");
        if (w2.isArray()) {
          for (let i = 0; i < w2.length; ) {
            const first = w2.get(i).asNumber();
            const second = w2.get(i + 1);
            if (second.isArray()) {
              for (let k = 0; k * 3 < second.length; k++) this.vmetrics.set(first + k, second.get(k * 3).asNumber() / 1000);
              i += 2;
            } else {
              const value = w2.get(i + 2).asNumber() / 1000;
              for (let c = first; c <= second.asNumber(); c++) this.vmetrics.set(c, value);
              i += 5;
            }
          }
        }
      }
      const map = descendant?.get("CIDToGIDMap");
      if (map && map.isStream()) this.cidToGid = map.readStream().asUint8Array().slice();
      this.identityCid = identity;
    } else {
      this.identityCid = false;
      this.codespaces = [{ lo: Uint8Array.of(0), hi: Uint8Array.of(255) }];
      this.loadSimpleEncoding(dict, flagsValue);
      const first = num(dict.get("FirstChar"), 0);
      const list = dict.get("Widths");
      const scale = subtype === "Type3" ? Math.abs(numbers(dict.get("FontMatrix"))[0] ?? 0.001) : 0.001;
      // MuPDF (what the user sees) only honours a width list that says where it ends
      if (list.isArray() && dict.get("LastChar").isNumber()) {
        this.defaultWidth = num(this.descriptor?.get("MissingWidth"), 0) * scale;
        for (let i = 0; i < list.length; i++) this.widths.set(first + i, list.get(i).asNumber() * scale);
      } else this.widthsKnown = false; // the standard fonts and the like: MuPDF has the metrics
    }
  }

  private loadSimpleEncoding(dict: MuPDF.PDFObject, flags: number): void {
    const enc = dict.get("Encoding");
    const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
    let base: string[] | null = null;
    const isSymbol = /^symbol/i.test(this.name);
    const differences: [number, string][] = [];
    if (enc.isName()) base = baseEncoding(enc.asName());
    else if (enc.isDictionary()) {
      base = baseEncoding(nameOf(enc.get("BaseEncoding")));
      const diff = enc.get("Differences");
      if (diff.isArray()) {
        let code = 0;
        for (let i = 0; i < diff.length; i++) {
          const item = diff.get(i);
          if (item.isNumber()) code = item.asNumber();
          else if (item.isName()) differences.push([code++, item.asName()]);
        }
      }
    }
    if (!base) {
      if (isSymbol) base = baseEncoding("SymbolEncoding");
      else if (this.subtype === "Type3" || /dingbat|wingding|webding/i.test(this.name)) base = null;
      else if (!symbolic) base = baseEncoding(this.subtype === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding");
    }
    if (!base && !differences.length) return;
    const table = base ? base.slice() : new Array<string>(256).fill("");
    for (const [code, name] of differences) table[code] = glyphNameToUnicode(name);
    this.encodingTable = table;
  }

  /* ---------- codes ---------- */

  decode(bytes: Uint8Array): Code[] {
    const out: Code[] = [];
    if (!this.composite) {
      for (const b of bytes) out.push({ code: b, length: 1 });
      return out;
    }
    for (let i = 0; i < bytes.length; ) {
      const c = nextCode(this.codespaces, bytes, i);
      out.push(c);
      i += c.length;
    }
    return out;
  }

  codeBytes(c: Code): Uint8Array {
    const out = new Uint8Array(c.length);
    for (let i = c.length - 1, v = c.code; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 255;
    return out;
  }

  cid(c: Code): number {
    if (!this.composite) return c.code;
    for (const r of this.cidRanges) if (r.len === c.length && c.code >= r.lo && c.code <= r.hi) return r.cid + (c.code - r.lo);
    return c.code;
  }

  /** glyph index inside the embedded program, for CID fonts with a TrueType program */
  gidForCid(cid: number): number {
    if (!this.cidToGid) return cid;
    return ((this.cidToGid[2 * cid] ?? 0) << 8) | (this.cidToGid[2 * cid + 1] ?? 0);
  }

  cidForGid(gid: number): number | null {
    if (!this.cidToGid) return gid;
    for (let c = 0; 2 * c + 1 < this.cidToGid.length; c++) if (this.gidForCid(c) === gid) return c;
    return null;
  }

  /* ---------- widths ---------- */

  /** probe all the codes of a string at once when their widths have to come from MuPDF */
  prepare(codes: Code[]): void {
    if (this.widthsKnown) return;
    // a simple font only has 256 codes: ask about all of them at once
    if (!this.composite) {
      if (!this.probes.size) this.probeMany(Array.from({ length: 256 }, (_, code) => ({ code, length: 1 })));
    } else this.probeMany(codes);
  }

  /** horizontal glyph advance as a fraction of the font size */
  width(c: Code): number {
    if (!this.widthsKnown) {
      const p = this.probe(c);
      return p ? Math.abs(p.advance) : this.defaultWidth || 1;
    }
    const w = this.widths.get(this.composite ? this.cid(c) : c.code);
    return w ?? this.defaultWidth;
  }

  hasExplicitWidth(c: Code): boolean {
    return !this.widthsKnown || this.widths.has(this.composite ? this.cid(c) : c.code);
  }

  setWidth(cid: number, width: number): void {
    this.widths.set(cid, width);
  }

  /** vertical displacement (negative) as a fraction of the font size */
  verticalAdvance(c: Code): number {
    if (!this.widthsKnown) {
      const p = this.probe(c);
      if (p && p.advance) return -Math.abs(p.advance);
    }
    return this.vmetrics.get(this.cid(c)) ?? this.defaultVertical;
  }

  /* ---------- probing ---------- */

  probeMany(codes: Code[]): void {
    const todo: Code[] = [];
    const seen = new Set<number>();
    for (const c of codes) {
      if (this.probes.has(c.code) || seen.has(c.code)) continue;
      seen.add(c.code);
      todo.push(c);
    }
    if (!todo.length) return;
    const results = probeCodes(
      this.mupdf,
      this.obj,
      todo.map((c) => this.codeBytes(c)),
      this.vertical,
    );
    todo.forEach((c, i) => this.probes.set(c.code, results[i] ?? null));
  }

  probe(c: Code): Probe | null {
    if (!this.probes.has(c.code)) this.probeMany([c]);
    return this.probes.get(c.code) ?? null;
  }

  /* ---------- Unicode ---------- */

  /** decoding from the font's own tables; "" when they do not say */
  unicode(c: Code): string {
    const mapped = this.toUnicode.get(c.code);
    if (mapped !== undefined) return mapped;
    if (!this.composite) return this.encodingTable?.[c.code] ?? "";
    if (this.decodeNamed) return this.decodeNamed(c.code, c.length);
    return "";
  }

  /** every code the font's tables give a meaning to */
  described(): [Code, string][] {
    const out: [Code, string][] = [];
    for (const [code, text] of this.toUnicode) out.push([{ code, length: this.composite ? this.lengthOf(code) : 1 }, text]);
    if (!this.composite)
      this.encodingTable?.forEach((text, code) => text && !this.toUnicode.has(code) && out.push([{ code, length: 1 }, text]));
    return out;
  }

  /** candidate codes that the font's tables say will read as `text` */
  codesFor(text: string): Code[] {
    if (!this.reverse) {
      this.reverse = new Map();
      const add = (u: string, c: Code) => {
        const key = u.normalize("NFC");
        let list = this.reverse!.get(key);
        if (!list) this.reverse!.set(key, (list = []));
        if (!list.some((x) => x.code === c.code)) list.push(c);
      };
      const length = this.composite ? 2 : 1;
      for (const [code, u] of this.toUnicode) add(u, { code, length: this.composite ? this.lengthOf(code) : length });
      if (!this.composite && this.encodingTable)
        this.encodingTable.forEach((u, code) => u && !this.toUnicode.has(code) && add(u, { code, length }));
    }
    const out = this.reverse.get(text) ?? [];
    // Unicode keyed CMaps can address any character of the font
    if (!out.length && this.composite && this.decodeNamed && text.length === 1 && this.decodeNamed(text.charCodeAt(0), 2) === text)
      return [{ code: text.charCodeAt(0), length: 2 }];
    return out;
  }

  private lengthOf(code: number): number {
    for (const r of this.codespaces) {
      const n = r.lo.length;
      if (code >= codeValue(r.lo) && code <= codeValue(r.hi)) return n;
    }
    return 2;
  }

  /** register an extra code (after adding it to the document's ToUnicode map) */
  learn(c: Code, text: string): void {
    this.toUnicode.set(c.code, text);
    this.reverse = null;
  }

  /** the embedded font program, if any */
  fontFile(): Uint8Array | null {
    if (!this.descriptor) return null;
    for (const key of ["FontFile2", "FontFile3", "FontFile"]) {
      const s = this.descriptor.get(key);
      if (s.isStream()) {
        try {
          return s.readStream().asUint8Array().slice();
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

/**
 * Chromium draws a synthetic bold into Type3 outlines by widening them with a stroke of 1/32 em, which
 * leaves steps of exactly half that width (1/64 em, in whatever units the font matrix uses) in the paths.
 */
function emboldened(dict: MuPDF.PDFObject): boolean {
  const procs = dict.get("CharProcs");
  if (!procs.isDictionary()) return false;
  const matrix = dict.get("FontMatrix");
  const scale = matrix.isArray() ? Math.abs(matrix.get(0).asNumber()) : 0.001;
  const step = 1 / 64 / (scale || 0.001);
  let seen = 0;
  let steps = 0;
  procs.forEach((stream) => {
    if (seen >= 3 || !stream.isStream()) return;
    seen++;
    const source = stream.readStream().asUint8Array();
    let text = "";
    for (let i = 0; i < Math.min(source.length, 4000); i++) text += String.fromCharCode(source[i]!);
    let x = NaN;
    let y = NaN;
    for (const m of text.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]\b/g)) {
      const nx = Number(m[1]);
      const ny = Number(m[2]);
      const dx = Math.abs(nx - x);
      const dy = Math.abs(ny - y);
      if ((Math.abs(dx - step) < 0.02 && dy < 0.02) || (Math.abs(dy - step) < 0.02 && dx < 0.02)) steps++;
      x = nx;
      y = ny;
    }
  });
  return steps >= 4;
}

export function nameOf(o: MuPDF.PDFObject | undefined | null): string {
  return o && o.isName() ? o.asName() : "";
}

function num(o: MuPDF.PDFObject | undefined | null, fallback: number): number {
  return o && o.isNumber() ? o.asNumber() : fallback;
}

function numbers(o: MuPDF.PDFObject): number[] {
  const out: number[] = [];
  if (o.isArray()) for (let i = 0; i < o.length; i++) out.push(num(o.get(i), 0));
  return out;
}
