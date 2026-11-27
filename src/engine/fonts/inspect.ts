/** Look inside a font program embedded in a PDF: TrueType / OpenType via HarfBuzz, bare CFF and Type 1 via MuPDF. */
import * as mupdf from "mupdf";
import { loadFace, type Face } from "./face";
import { sfntKind } from "./sfnt";
import type { FontInspection } from "./types";

const WHITESPACE = [9, 10, 13, 32, 160, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b, 0x202f, 0x205f, 0x3000];

export async function inspectFont(bytes: Uint8Array): Promise<FontInspection | null> {
  if (!bytes?.length) return null;
  try {
    if (sfntKind(bytes)) {
      // copy: the caller may hand us a view into wasm memory
      const face = await loadFace(bytes.slice());
      return face ? inspectSfnt(face) : null;
    }
    return inspectWithMuPDF(bytes.slice());
  } catch (e) {
    console.warn("Embedded font could not be inspected", e);
    return null;
  }
}

function inspectSfnt(face: Face): FontInspection {
  const spaces = new Set(WHITESPACE.map((cp) => face.glyph(cp)).filter(Boolean));
  const count = face.info.numGlyphs;
  return {
    unitsPerEm: face.info.unitsPerEm,
    hasUnicode: (cp) => face.glyph(cp) !== 0,
    glyphForUnicode: (cp) => face.glyph(cp),
    hasGlyphOutline: (gid) => gid >= 0 && (!count || gid < count) && (spaces.has(gid) || face.hasOutline(gid)),
    advance: (gid) => face.hbFont.glyphHAdvance(gid),
    ink: (gid) => {
      const e = face.hbFont.glyphExtents(gid);
      return e && e.height ? [e.yBearing, e.yBearing + e.height] : null;
    },
  };
}

/** a font program starts like a Type 1 (PFA / PFB) or a bare CFF */
function looksLikeFont(b: Uint8Array): boolean {
  if (b.length < 32) return false;
  if (b[0] === 0x25 && b[1] === 0x21) return true; // %!
  if (b[0] === 0x80 && b[1] === 1) return true; // PFB
  return b[0] === 1 && b[1] === 0 && b[2]! >= 4 && b[3]! >= 1 && b[3]! <= 4;
}

function inspectWithMuPDF(bytes: Uint8Array): FontInspection | null {
  if (!looksLikeFont(bytes)) return null;
  const font = new mupdf.Font("inspected", bytes);
  const glyph = (cp: number) => font.encodeCharacter(cp);
  const spaces = new Set(WHITESPACE.map(glyph).filter(Boolean));
  const drawn = new Map<number, boolean>();

  /** renders the glyph to see whether it marks the page */
  const inks = (gid: number) => {
    let result = drawn.get(gid);
    if (result === undefined) {
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 96, 96], false);
      pixmap.clear(255);
      const text = new mupdf.Text();
      text.showGlyph(font, [32, 0, 0, -32, 32, 64], gid, 0);
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
      device.close();
      result = pixmap.getPixels().some((v) => v < 200);
      device.destroy();
      text.destroy();
      pixmap.destroy();
      drawn.set(gid, result);
    }
    return result;
  };

  return {
    unitsPerEm: 1000,
    hasUnicode: (cp) => glyph(cp) > 0,
    glyphForUnicode: glyph,
    hasGlyphOutline: (gid) => gid >= 0 && (spaces.has(gid) || inks(gid)),
    advance: (gid) => Math.round(font.advanceGlyph(gid) * 1000),
  };
}

