"""Free-licensed fonts for the corpus, taken from locally installed Python packages (no downloads).

- Noto fonts (SIL OFL) and Droid Sans Fallback (Apache 2.0) are compiled into the PyMuPDF wheel.
- DejaVu fonts (free licence) ship with matplotlib.

The Noto faces are CFF flavoured. Browsers and office suites mostly produce TrueType PDFs, so a TrueType
copy is built with fontTools; the CFF originals are used where the corpus wants CFF / Type3 output.
"""

import io
import os
from pathlib import Path

import matplotlib
import pymupdf
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".tmp" / "tests" / "fonts"

# key -> UCDN script constant understood by MuPDF's Noto lookup
NOTO = {
    "Latin": "LATIN",
    "Devanagari": "DEVANAGARI",
    "Bengali": "BENGALI",
    "Tamil": "TAMIL",
    "Telugu": "TELUGU",
    "Gujarati": "GUJARATI",
    "Gurmukhi": "GURMUKHI",
    "Kannada": "KANNADA",
    "Malayalam": "MALAYALAM",
    "Oriya": "ORIYA",
    "Arabic": "ARABIC",
    "Hebrew": "HEBREW",
    "Thai": "THAI",
    "CJK": "HAN",
}


def noto_bytes(key: str) -> bytes:
    code = getattr(pymupdf.mupdf, "UCDN_SCRIPT_" + NOTO[key])
    data = bytes(pymupdf.Font(script=code).buffer)
    if len(data) < 5000:
        raise RuntimeError(f"PyMuPDF has no built-in font for {key}")
    return data


def _to_truetype(data: bytes) -> bytes:
    font = TTFont(io.BytesIO(data), recalcBBoxes=True)
    if "glyf" in font:
        return data
    order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
        glyphs[name] = pen.glyph()
    font["loca"] = newTable("loca")
    glyf = font["glyf"] = newTable("glyf")
    glyf.glyphOrder = order
    glyf.glyphs = glyphs
    del font["CFF "]
    if "VORG" in font:
        del font["VORG"]
    glyf.compile(font)
    hmtx = font["hmtx"]
    for name, glyph in glyf.glyphs.items():
        if hasattr(glyph, "xMin"):
            hmtx[name] = (hmtx[name][0], glyph.xMin)
    maxp = font["maxp"] = newTable("maxp")
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = 0
    maxp.maxComponentDepth = 0
    maxp.numGlyphs = len(order)
    post = font["post"]
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = order
    font.sfntVersion = "\x00\x01\x00\x00"
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def cff_path(key: str) -> Path:
    """The original (CFF) Noto face."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"Noto-{key}.otf"
    if not path.exists():
        path.write_bytes(noto_bytes(key))
    return path


def ttf_path(key: str) -> Path:
    """TrueType flavoured copy of a Noto face (Droid Sans Fallback already is TrueType)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"Noto-{key}.ttf"
    if not path.exists():
        path.write_bytes(_to_truetype(noto_bytes(key)))
    return path


def dejavu(name: str) -> Path:
    path = Path(os.path.dirname(matplotlib.__file__)) / "mpl-data" / "fonts" / "ttf" / f"{name}.ttf"
    if not path.exists():
        raise RuntimeError(f"matplotlib font missing: {path}")
    return path
