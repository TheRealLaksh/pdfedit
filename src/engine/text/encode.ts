/**
 * Drawing new text with the document's own fonts: which codes really produce a character, and which glyph
 * sequences of already drawn words can be copied for scripts that need shaping.
 */
import type * as MuPDF from "mupdf";
import { concatBytes, encodeLatin1 } from "../content/tokenizer";
import type { EngineContext } from "../context";
import * as fonts from "../fonts";
import type { FontInspection } from "../fonts/types";
import type { Analysis } from "./analyze";
import type { Glyph } from "./interpret";
import { toFrame, type LineModel, type Unit } from "./layout";
import type { Code, PdfFont } from "./pdffont";
import { isMarkOnly, normalizeGlyphText } from "./unicode";

/** one glyph of a piece of new text, positioned relative to the piece's left baseline point */
export interface NewGlyph {
  font: PdfFont;
  code: Code;
  du: number;
  dv: number;
  /** size relative to the reference glyph */
  scale: number;
  /** glyphs sharing this object are wrapped in one ActualText span */
  actual?: { text: string };
}

export interface NewPiece {
  text: string;
  glyphs: NewGlyph[];
  /** advance in page units */
  width: number;
  /** the font tables alone would not give `text` back, so ActualText is needed */
  needsActualText: boolean;
}

const scriptOf = (s: string): string => {
  const scripts = ["Latin", "Greek", "Cyrillic", "Hebrew", "Arabic", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar", "Georgian", "Hangul", "Ethiopic", "Khmer", "Hiragana", "Katakana", "Han", "Armenian"];
  for (const name of scripts) if (new RegExp(`\\p{Script=${name}}`, "u").test(s)) return name === "Hiragana" || name === "Katakana" ? "Han" : name;
  return "Common";
};

export class Encoder {
  private observed = new Map<string, Glyph>();
  private fontsOnPage: PdfFont[] = [];
  private kerning = new Map<string, number>();
  private inspections = new Map<PdfFont, Promise<FontInspection | null>>();
  private tops = new Map<PdfFont, { char: string; top: number; bottom: number }[]>();
  private words: Map<string, Clone[]> | null = null;
  private aksharas: Map<string, Clone[]> | null = null;

  constructor(
    private ctx: EngineContext,
    private analysis: Analysis,
  ) {
    const seen = new Set<PdfFont>();
    for (const g of analysis.interp?.glyphs ?? []) {
      const font = g.show.font;
      seen.add(font);
      if (g.invisible || g.actual || !g.unicode) continue;
      const key = `${font.id}|${normalizeGlyphText(g.unicode).normalize("NFC")}`;
      if (!this.observed.has(key)) this.observed.set(key, g);
    }
    this.fontsOnPage = [...seen];
    for (const m of analysis.models) {
      for (let i = 1; i < m.visual.length; i++) {
        const a = m.visual[i - 1]!;
        const b = m.visual[i]!;
        if (a.glyphs.length !== 1 || b.glyphs.length !== 1 || !a.text.trim() || !b.text.trim()) continue;
        const x = a.glyphs[0]!;
        const y = b.glyphs[0]!;
        if (x.show.font !== y.show.font || Math.abs(x.size - y.size) > 0.01) continue;
        const [ua] = toFrame(x.origin, m.ex, m.ey);
        const [ub] = toFrame(y.origin, m.ex, m.ey);
        const k = (ub - ua - x.advance) / x.size;
        if (Math.abs(k) > 0.004 && Math.abs(k) < 0.16) this.kerning.set(`${x.show.font.id}|${x.code.code}|${y.code.code}`, k);
      }
    }
  }

  /** Tf size, relative to the operator hosting `ref`, at which `font` looks as large as the text around it */
  scaleFor(font: PdfFont, ref: Glyph): number {
    if (font === ref.show.font) return 1;
    const sample = this.analysis.interp?.glyphs.find((g) => g.show.font === font && g.size > 0);
    return sample ? (ref.size / sample.size) * (em(sample) / (em(ref) || 1)) : 1;
  }

  /** extra space (in ems) the producer put between two glyphs of a font */
  kern(font: PdfFont, a: Code, b: Code): number {
    return this.kerning.get(`${font.id}|${a.code}|${b.code}`) ?? 0;
  }

  /** document fonts worth trying for `text`, best first */
  candidates(text: string, ref: Glyph, line: LineModel): PdfFont[] {
    const out: PdfFont[] = [];
    const push = (f: PdfFont) => !out.includes(f) && out.push(f);
    const script = scriptOf(text);
    const lineGlyphs = line.units.flatMap((u) => u.glyphs);
    const refScript = scriptOf(ref.unicode || "");
    if (script === "Common" || script === refScript) push(ref.show.font);
    // another font of the same line that already writes this script in the same style
    if (script !== "Common")
      for (const g of lineGlyphs.slice().sort((a, b) => Math.abs(a.seq - ref.seq) - Math.abs(b.seq - ref.seq)))
        if (g.unicode && scriptOf(g.unicode) === script && g.show.font.flags.bold === ref.show.font.flags.bold) push(g.show.font);
    push(ref.show.font);
    // other subsets of the very same typeface
    for (const f of this.fontsOnPage) if (f.name === ref.show.font.name) push(f);
    return out;
  }

  async encode(grapheme: string, font: PdfFont): Promise<{ code: Code; actual: boolean } | null> {
    const text = grapheme.normalize("NFC");
    const seen = this.observed.get(`${font.id}|${text}`);
    if (seen) return { code: seen.code, actual: false };
    const blank = !text.trim();
    for (const code of font.codesFor(text)) {
      const probe = font.probe(code);
      if (!probe) continue;
      if (!blank && !probe.ink) continue;
      if (!blank && probe.gid === 0 && font.embedded && font.subtype !== "Type3") continue;
      if (!font.composite && !font.toUnicode.has(code.code) && probe.unicode && probe.unicode.normalize("NFC") !== text) continue;
      if (!font.hasExplicitWidth(code)) {
        if (font.composite) {
          // the glyph is there but its advance is not listed: take it from the font program
          const info = await this.inspect(font);
          const gid = font.gidForCid(font.cid(code));
          if (!info || !font.identityCid) continue;
          this.addWidth(font, font.cid(code), info.advance(gid) / info.unitsPerEm);
        } else continue;
      }
      if (!(font.width(code) > 0) && !isMarkOnly(text)) continue;
      return { code, actual: !font.toUnicode.has(code.code) && font.unicode(code).normalize("NFC") !== text };
    }
    return this.fromProgram(text, font);
  }

  /** a CID keyed TrueType program may still hold glyphs the PDF never referenced */
  private async fromProgram(text: string, font: PdfFont): Promise<{ code: Code; actual: boolean } | null> {
    if (!font.identityCid || [...text].length !== 1) return null;
    const descendant = font.obj.get("DescendantFonts").get(0);
    if (!descendant.get("Subtype").isName() || descendant.get("Subtype").asName() !== "CIDFontType2") return null;
    const info = await this.inspect(font);
    const cp = text.codePointAt(0)!;
    if (!info || !info.hasUnicode(cp)) return null;
    const gid = info.glyphForUnicode(cp);
    if (!gid || (text.trim() && !info.hasGlyphOutline(gid))) return null;
    const cid = font.cidForGid(gid);
    if (cid === null || cid > 0xffff) return null;
    const code: Code = { code: cid, length: 2 };
    if (!font.hasExplicitWidth(code)) this.addWidth(font, cid, info.advance(gid) / info.unitsPerEm);
    const probe = font.probe(code);
    if (!probe || (text.trim() && !probe.ink)) return null;
    const mapped = this.addToUnicode(font, cid, text);
    return { code, actual: !mapped };
  }

  /** how the letters of a document font stand, so that a substitute can be fitted to them */
  async heights(ref: Glyph): Promise<{ char: string; top: number; bottom: number }[]> {
    const name = ref.show.font.name;
    let list = this.tops.get(ref.show.font);
    if (list) return list;
    list = [];
    const seen = new Set<string>();
    const scripts = new Map<string, number>();
    for (const g of this.analysis.interp?.glyphs ?? []) {
      const font = g.show.font;
      const char = g.unicode;
      if (font.name !== name || g.invisible || g.actual || seen.has(char) || [...char].length !== 1 || !/\p{L}/u.test(char)) continue;
      const script = scriptOf(char);
      // a handful of letters per script settles the median
      if ((scripts.get(script) ?? 0) >= 16) continue;
      const info = await this.inspect(font);
      const gid = info?.ink ? font.probe(g.code)?.gid : undefined;
      const ink = gid ? info!.ink!(gid) : null;
      if (!ink) continue;
      seen.add(char);
      scripts.set(script, (scripts.get(script) ?? 0) + 1);
      list.push({ char, top: ink[0] / info!.unitsPerEm, bottom: ink[1] / info!.unitsPerEm });
    }
    this.tops.set(ref.show.font, list);
    return list;
  }

  private inspect(font: PdfFont): Promise<FontInspection | null> {
    let p = this.inspections.get(font);
    if (!p) {
      const bytes = font.fontFile();
      p = bytes
        ? Promise.resolve()
            .then(() => fonts.inspectFont(bytes))
            .catch(() => null)
        : Promise.resolve(null);
      this.inspections.set(font, p);
    }
    return p;
  }

  /** additive change to the font dictionary: existing text is unaffected */
  private addWidth(font: PdfFont, cid: number, width: number): void {
    const doc = this.ctx.doc;
    const descendant = font.obj.get("DescendantFonts").get(0);
    let w: MuPDF.PDFObject = descendant.get("W");
    if (!w.isArray()) {
      descendant.put("W", doc.newArray());
      w = descendant.get("W");
    }
    const entry = doc.newArray();
    entry.push(doc.newInteger(Math.round(width * 1000)));
    w.push(doc.newInteger(cid));
    w.push(entry);
    font.setWidth(cid, Math.round(width * 1000) / 1000);
  }

  private addToUnicode(font: PdfFont, code: number, text: string): boolean {
    const stream = font.obj.get("ToUnicode");
    if (!stream.isStream()) return false;
    const old = stream.readStream().asUint8Array().slice();
    let at = -1;
    const marker = "endcmap";
    for (let i = old.length - marker.length; i >= 0 && at < 0; i--) {
      let k = 0;
      while (k < marker.length && old[i + k] === marker.charCodeAt(k)) k++;
      if (k === marker.length) at = i;
    }
    if (at < 0) return false;
    const hex = (v: number) => v.toString(16).padStart(4, "0").toUpperCase();
    let dst = "";
    for (let i = 0; i < text.length; i++) dst += hex(text.charCodeAt(i));
    const add = encodeLatin1(`1 beginbfchar\n<${hex(code)}> <${dst}>\nendbfchar\n`);
    stream.writeStream(concatBytes([old.subarray(0, at), add, old.subarray(at)]));
    font.learn({ code, length: 2 }, text);
    return true;
  }

  /* ---------- copying words and syllables that are already drawn ---------- */

  private index(): void {
    if (this.words) return;
    this.words = new Map();
    this.aksharas = new Map();
    const add = (map: Map<string, Clone[]>, key: string, clone: Clone) => {
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      if (list.length < 8) list.push(clone);
    };
    for (const m of this.analysis.models) {
      if (!m.line.editable) continue;
      let word: Unit[] = [];
      const flush = () => {
        if (!word.length) return;
        const text = word.map((u) => u.text).join("");
        add(this.words!, text, { units: word, line: m });
        // syllables, where syllable boundaries coincide with glyph cluster boundaries
        const cuts = new Set<number>();
        let at = 0;
        for (const s of syllables(text)) cuts.add((at += s.length));
        let from = 0;
        let acc = "";
        let length = 0;
        for (let i = 0; i < word.length; i++) {
          acc += word[i]!.text;
          length += word[i]!.text.length;
          if (cuts.has(length)) {
            const units = word.slice(from, i + 1);
            if (syllables(acc).length === 1) add(this.aksharas!, acc, { units, line: m });
            from = i + 1;
            acc = "";
          }
        }
        word = [];
      };
      for (const u of m.units) {
        if (!u.text.trim() || !u.glyphs.length || u.text.includes("\uFFFD")) flush();
        else word.push(u);
      }
      flush();
    }
  }

  /** reproduce a whole word (or build it from whole syllables) out of glyphs the document already draws */
  clone(word: string, ref: Glyph): NewPiece | null {
    this.index();
    const font = ref.show.font;
    const best = (list: Clone[] | undefined): Clone | null => {
      let found: Clone | null = null;
      let score = Infinity;
      for (const c of list ?? []) {
        const g = c.units[0]!.glyphs[0]!;
        const f = g.show.font;
        if (f.flags.bold !== font.flags.bold || f.flags.italic !== font.flags.italic) continue;
        const s = (f === font ? 0 : f.name === font.name ? 1 : 100) + Math.abs(g.size - ref.size) / ref.size;
        if (s < score) {
          score = s;
          found = c;
        }
      }
      return score < 100 ? found : null;
    };
    const parts: Clone[] = [];
    const whole = best(this.words!.get(word));
    if (whole) parts.push(whole);
    else {
      const list = syllables(word);
      if (list.length < 1 || !/[\u0900-\u0DFF]/.test(word)) return null;
      for (const s of list) {
        const c = best(this.aksharas!.get(s));
        if (!c) return null;
        parts.push(c);
      }
    }
    const glyphs: NewGlyph[] = [];
    let width = 0;
    for (const part of parts) {
      const { line } = part;
      const left = Math.min(...part.units.map((u) => u.u0));
      const right = Math.max(...part.units.map((u) => u.u1));
      const sample = part.units.flatMap((u) => u.glyphs).reduce((a, b) => (b.size > a.size ? b : a));
      const ratio = ref.size / sample.size;
      for (const u of part.units) {
        const only = u.glyphs.length === 1 ? u.glyphs[0]! : null;
        const actual = only && only.show.font.unicode(only.code).normalize("NFC") === u.text ? undefined : { text: u.text };
        for (const g of u.glyphs) {
          const [gu, gv] = toFrame(g.origin, line.ex, line.ey);
          glyphs.push({
            actual,
            font: g.show.font,
            code: g.code,
            du: width + (gu - left) * ratio,
            // heights are measured from the line, so that raised marks stay raised
            dv: (gv - (Math.abs(u.v - line.baseline) > 0.3 * u.size ? u.v : line.baseline)) * ratio,
            scale: (em(g) * ratio) / (em(ref) || 1),
          });
        }
      }
      width += (right - left) * ratio;
    }
    return { text: word, glyphs, width, needsActualText: false };
  }
}

/** page length of one unit of Tf size (Type3 fonts do not draw their em in that unit) */
const em = (g: Glyph) => Math.abs(g.show.size) * g.unit;

interface Clone {
  units: Unit[];
  line: LineModel;
}

/** orthographic syllables of Indic text (everything else: one per character) */
export function syllables(word: string): string[] {
  return (
    word.match(
      /(?:(?:[\u0915-\u0939\u0958-\u095F\u0995-\u09B9\u09DC-\u09DF\u09F0\u09F1\u0A15-\u0A39\u0A59-\u0A5E\u0A95-\u0AB9\u0B15-\u0B39\u0B5C-\u0B5F\u0B71\u0B95-\u0BB9\u0C15-\u0C39\u0C95-\u0CB9\u0D15-\u0D39\u0D9A-\u0DC6][\u093C\u09BC\u0A3C\u0ABC\u0B3C\u0CBC]?[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D\u0DCA][\u200C\u200D]?)*[^\p{M}])\p{M}*/gu,
    ) ?? [...word]
  );
}
