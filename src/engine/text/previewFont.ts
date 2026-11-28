/**
 * A document font as a file the browser can use: which characters the engine could really type with it,
 * the glyph each one needs, and the advances the page gives them.
 */
import * as mupdf from "mupdf";
import { loadFace } from "../fonts/face";
import { rebuildFont } from "../fonts/preview";
import { clusterScript, scriptInfo } from "../fonts/scripts";
import { cffGidToCid, cmapRanges, readTables, sfntKind } from "../fonts/sfnt";
import type { PreviewFont } from "../types";
import { readableName } from "./documentFonts";
import type { Glyph } from "./interpret";
import type { Code, PdfFont } from "./pdffont";

/** codes looked at per font: more than any subset needs, few enough to stay quick */
const MOST_CODES = 3000;
const MOST_FROM_PROGRAM = 20000;

export interface BuiltFont extends PreviewFont {
  coverage: number[];
}

/**
 * `drawn`: glyphs of this font seen on a page (they show best which code stands for which character).
 * `space`: typical width of a word gap, as a fraction of the font size.
 */
export async function buildDocumentFont(font: PdfFont, drawn: Glyph[] = [], space?: number): Promise<BuiltFont | null> {
  if (font.subtype === "Type3" || font.vertical) return null;
  const program = font.fontFile();
  if (!program?.length) return null;
  const sfnt = sfntKind(program);
  // Type 1 programs start with PostScript text: browsers cannot use them
  if (!sfnt && program[0] !== 1) return null;

  const cff = sfnt ? readTables(program).get("CFF ") : program;
  // in a CID keyed program the codes name CIDs, which need not be the glyph numbers
  let byCid: Map<number, number> | null = null;
  if (font.composite && cff) {
    const gidToCid = cffGidToCid(cff);
    if (gidToCid) byCid = new Map([...gidToCid].map(([gid, cid]) => [cid, gid]));
  }
  const glyphOf = (code: Code): number | null => {
    if (!font.composite) return font.probe(code)?.gid ?? null;
    const cid = font.cid(code);
    if (cff) return byCid ? (byCid.get(cid) ?? null) : cid;
    return font.gidForCid(cid);
  };

  const wanted: [Code, string][] = [];
  const seen = new Set<string>();
  const want = (code: Code, text: string) => {
    const nfc = text.normalize("NFC");
    if (seen.has(nfc) || wanted.length >= MOST_CODES || [...nfc].length !== 1) return;
    // private use and replacement characters mean nothing to the person typing
    if (/[\p{Co}\p{Cc}�]/u.test(nfc)) return;
    seen.add(nfc);
    wanted.push([code, nfc]);
  };
  for (const g of drawn) if (!g.invisible && !g.actual && g.unicode) want(g.code, g.unicode);
  for (const [code, text] of font.described()) want(code, text);
  font.probeMany(wanted.map(([code]) => code));

  const map = new Map<number, number>();
  const widths = new Map<number, number>();
  for (const [code, text] of wanted) {
    const probe = font.probe(code);
    const blank = !text.trim();
    if (!probe || (!blank && !probe.ink)) continue;
    const gid = glyphOf(code);
    if (!gid || (font.embedded && probe.gid === 0)) continue;
    map.set(text.codePointAt(0)!, gid);
    if (font.hasExplicitWidth(code)) widths.set(gid, font.width(code));
  }

  const face = sfnt ? await loadFace(program.slice()) : null;
  // the program may hold glyphs the PDF never used: the engine types with those too
  if (face) {
    let budget = MOST_FROM_PROGRAM;
    for (const [from, to] of cmapRanges(program)) {
      for (let cp = from; cp <= to && budget > 0; cp++, budget--) {
        if (map.has(cp)) continue;
        const gid = face.glyph(cp);
        if (gid && (/\p{Zs}/u.test(String.fromCodePoint(cp)) || face.hasOutline(gid))) map.set(cp, gid);
      }
    }
  }

  // scripts that need shaping rules are only usable when the subset kept them
  for (const cp of [...map.keys()]) {
    const tags = scriptInfo(clusterScript(String.fromCodePoint(cp)))?.ot;
    if (tags && !tags.some((t) => face?.gsubScripts.has(t))) map.delete(cp);
  }
  if (![...map.keys()].some((cp) => /[^\s]/u.test(String.fromCodePoint(cp)))) return null;

  let advance: ((gid: number) => number) | undefined;
  let metrics: InstanceType<typeof mupdf.Font> | null = null;
  if (!sfnt) {
    try {
      metrics = new mupdf.Font("preview", program);
      advance = (gid) => metrics!.advanceGlyph(gid);
    } catch {
      metrics = null;
    }
  }
  try {
    const data = rebuildFont({
      program,
      map,
      widths,
      advance,
      space,
      name: font.name,
      ...font.flags,
      ascent: font.ascent,
      descent: font.descent,
    });
    if (!data) return null;
    // what the finished file really maps (glyph numbers past the end were left out)
    const coverage = cmapRanges(data).flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));
    return { data, family: readableName(font.name), coverage };
  } finally {
    metrics?.destroy();
  }
}
