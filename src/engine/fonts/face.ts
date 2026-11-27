/** A loaded font program ready for shaping. Cached per byte array, so it is parsed once. */
import type * as HB from "harfbuzzjs";
import { harfbuzz } from "./hb";
import { extractFace, fontInfo, sfntKind, type FontInfo } from "./sfnt";

export interface Face {
  /** standalone sfnt bytes (a collection is split first) */
  bytes: Uint8Array;
  info: FontInfo;
  hbFont: HB.Font;
  /** OpenType script tags with substitution rules */
  gsubScripts: Set<string>;
  /** nominal glyph for a code point, 0 when the cmap has none */
  glyph(codePoint: number): number;
  /** the glyph draws something */
  hasOutline(glyph: number): boolean;
}

const cache = new WeakMap<Uint8Array, Promise<Face | null>>();

export function loadFace(source: Uint8Array, axes?: Record<string, number>): Promise<Face | null> {
  if (axes) return parseFace(source, axes);
  let face = cache.get(source);
  if (!face) {
    face = parseFace(source);
    cache.set(source, face);
    face.catch(() => cache.delete(source));
  }
  return face;
}

async function parseFace(source: Uint8Array, axes?: Record<string, number>): Promise<Face | null> {
  const kind = sfntKind(source);
  if (kind !== "sfnt" && kind !== "ttc") return null;
  const bytes = extractFace(source, 0);
  const info = fontInfo(bytes);
  if (!info || info.outlines === "cff2") return null;
  const hb = await harfbuzz();
  try {
    const face = new hb.Face(new hb.Blob(bytes), 0);
    const hbFont = new hb.Font(face);
    if (axes && info.variable)
      hbFont.setVariations(Object.entries(axes).map(([tag, value]) => new hb.Variation(tag, value)));
    const gsubScripts = new Set<string>(face.getTableScriptTags("GSUB"));
    const glyphs = new Map<number, number>();
    return {
      bytes,
      info,
      hbFont,
      gsubScripts,
      glyph(cp) {
        let g = glyphs.get(cp);
        if (g === undefined) {
          g = hbFont.nominalGlyph(cp) ?? 0;
          glyphs.set(cp, g);
        }
        return g;
      },
      hasOutline(gid) {
        const e = hbFont.glyphExtents(gid);
        if (e && e.width !== 0 && e.height !== 0) return true;
        return info.outlines !== "none" && hbFont.glyphToPath(gid).length > 0;
      },
    };
  } catch (e) {
    console.warn("Font could not be parsed", e);
    return null;
  }
}
