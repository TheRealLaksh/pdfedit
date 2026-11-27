"""Hand written PDFs: awkward but legal text operators, Type 3 fonts, broken encodings, odd page trees."""

import io
import random

import pymupdf
from fontTools.pens.basePen import BasePen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

import fonts
from common import OUT, line, register
from rawpdf import Pdf, pdf_string, simple_document, to_unicode_cmap

W, H = 420.0, 595.0
BASE = {"F1": "Helvetica", "F2": "Times-Roman", "F3": "Courier", "F4": "Helvetica-Bold"}
PM_NAME = {"F1": "helv", "F2": "tiro", "F3": "cour", "F4": "hebo"}


def _resources(pdf: Pdf, extra: str = "") -> str:
    refs = {
        name: pdf.add(f"<< /Type /Font /Subtype /Type1 /BaseFont /{base} /Encoding /WinAnsiEncoding >>")
        for name, base in BASE.items()
    }
    entries = " ".join(f"/{n} {r} 0 R" for n, r in refs.items())
    return f"<< /Font << {entries} >> {extra} >>"


def width(text: str, font: str, size: float) -> float:
    return pymupdf.get_text_length(text, fontname=PM_NAME[font], fontsize=size)


def box(x: float, y: float, text: str, font: str, size: float, w: float | None = None, height: float = H) -> list:
    return [x, height - y - 0.8 * size, x + (w if w is not None else width(text, font, size)), height - y + 0.22 * size]


def latin(text: str, rect: list, size: float, **info) -> dict:
    return line(text, rect, lang="en", script="Latin", dir="ltr", size=size, **info)


def _write(doc_id: str, data: bytes):
    (OUT / f"{doc_id}.pdf").write_bytes(data)


def _register(doc_id, pages, tags, edits=None, **extra):
    register(doc_id, pages, producer="handwritten", language=extra.pop("language", "English"),
             script=extra.pop("script", "Latin"), tags=tags, edits=edits, **extra)


def positioning():
    pdf = Pdf()
    tint = pdf.add("<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.9 0.6 0 0] /N 1 >>")
    resources = _resources(pdf, f"/ColorSpace << /CS1 [/Separation /SpotBlue /DeviceCMYK {tint} 0 R] >>")
    ops, lines = [], []
    y = 560.0

    def add(text, w=None, font="F1", size=13.0, x=40.0, **info):
        lines.append(latin(text, box(x, y, text, font, size, w), size, **info))

    # 1. one glyph per text object
    text, x = "Every glyph is placed on its own", 40.0
    for ch in text:
        if ch != " ":
            ops.append(f"BT /F1 13 Tf {x:.3f} {y} Td {pdf_string(ch)} Tj ET")
        x += width(ch, "F1", 13)
    add(text, tags=["per-glyph"])
    # 2. words drawn out of order
    y -= 30
    text, x, words = "Words arrive here in a shuffled order", 40.0, []
    for word in text.split(" "):
        words.append((x, word))
        x += width(word + " ", "F1", 13)
    random.Random(5).shuffle(words)
    for wx, word in words:
        ops.append(f"BT /F1 13 Tf 1 0 0 1 {wx:.3f} {y} Tm {pdf_string(word)} Tj ET")
    add(text, tags=["shuffled"])
    # 3. no space characters at all: gaps come from TJ adjustments
    y -= 30
    parts = "Gaps here come only from kerning numbers".split(" ")
    gap = 300
    array = f" {-gap} ".join(pdf_string(p) for p in parts)
    ops.append(f"BT /F1 13 Tf 40 {y} Td [{array}] TJ ET")
    add(" ".join(parts), w=sum(width(p, "F1", 13) for p in parts) + (len(parts) - 1) * gap / 1000 * 13, tags=["tj-space"])
    # 4. kerning inside words must not create spaces
    y -= 30
    ops.append(f"BT /F1 13 Tf 40 {y} Td [(Tig) 18 (ht ker) -12 (ning stays inside w) 20 (ords)] TJ ET")
    add("Tight kerning stays inside words", tags=["tj-kern"])
    # 5. ' and " operators
    y -= 30
    ops.append(f"BT /F1 13 Tf 18 TL 40 {y + 18} Td (Moved down by the quote operator) ' "
               f"0 0 (Second line from the double quote) \" ET")
    add("Moved down by the quote operator", tags=["quote-op"])
    y -= 18
    add("Second line from the double quote", tags=["quote-op"])
    # 6. horizontal scale and character spacing
    y -= 32
    text = "Squeezed text with extra letter spacing"
    ops.append(f"BT /F1 13 Tf 80 Tz 1.2 Tc 40 {y} Td {pdf_string(text)} Tj 100 Tz 0 Tc ET")
    add(text, w=(width(text, "F1", 13) + 1.2 * len(text)) * 0.8, tags=["tz-tc"])
    # 7. size coming from the transformation matrix
    y -= 30
    text = "Scaled up by the transformation matrix"
    ops.append(f"q 2 0 0 2 0 0 cm BT /F2 6.5 Tf 20 {y / 2} Td {pdf_string(text)} Tj ET Q")
    add(text, font="F2", tags=["ctm"])
    # 8. flipped coordinate system, as several generators write it
    y -= 30
    text = "Written inside a flipped coordinate system"
    ops.append(f"q 1 0 0 -1 0 {H} cm BT /F1 13 Tf 1 0 0 -1 40 {H - y} Tm {pdf_string(text)} Tj ET Q")
    add(text, tags=["flipped"])
    # 9. a spot colour
    y -= 30
    text = "Ink from a separation colour space"
    ops.append(f"q /CS1 cs 1 scn BT /F1 13 Tf 40 {y} Td {pdf_string(text)} Tj ET Q")
    add(text, tags=["separation"])
    # 10. fake bold: the same words painted twice
    y -= 30
    text = "Fake bold painted two times"
    for dx in (0, 0.35):
        ops.append(f"BT /F1 13 Tf {40 + dx} {y} Td {pdf_string(text)} Tj ET")
    add(text, tags=["double-paint"])
    # 11. ActualText wrapping a whole line
    y -= 30
    text = "Marked content carries actual text"
    ops.append(f"/Span << /ActualText {pdf_string(text)} >> BDC BT /F1 13 Tf 40 {y} Td {pdf_string(text)} Tj ET EMC")
    add(text, tags=["actualtext"])
    # 12. stroke render mode
    y -= 30
    text = "Outlined bold made with a stroke"
    ops.append(f"q 0.35 w 0.2 0.2 0.2 RG BT /F1 13 Tf 2 Tr 40 {y} Td {pdf_string(text)} Tj ET Q")
    add(text, tags=["stroke"])
    # 13. one BT, several lines with Td/T*, and graphics drawn between them
    y -= 30
    ops.append(f"BT /F2 13 Tf 18 TL 40 {y} Td (First of three chained lines) Tj T* (Middle of three chained lines) Tj "
               f"T* (Last of three chained lines) Tj ET")
    for chained in ("First of three chained lines", "Middle of three chained lines", "Last of three chained lines"):
        add(chained, font="F2", tags=["chained"])
        y -= 18
    ops.append(f"0.9 0.3 0.1 RG 1 w 40 {y} m 380 {y} l S")
    _write("positioning", simple_document([{"content": "\n".join(ops)}], resources, pdf))

    def index(text):
        return next(i for i, item in enumerate(lines) if item["text"] == text)

    _register("positioning", [{"kind": "text", "lines": lines}], ["text", "positioning", "stress"], edits=[
        {"page": 0, "line": 0, "newText": "Every glyph is placed on its side"},
        {"page": 0, "line": 2, "newText": "Gaps here come only from spacing numbers"},
        {"page": 0, "line": index("Scaled up by the transformation matrix"), "newText": "Scaled down by the transformation matrix"},
        {"page": 0, "line": index("Written inside a flipped coordinate system"), "newText": "Printed inside a flipped coordinate system"},
        {"page": 0, "line": index("Marked content carries actual text"), "newText": "Marked content carries fresh words"},
        {"page": 0, "line": index("Middle of three chained lines"), "newText": "Centre of three chained lines"},
        {"page": 0, "line": index("Fake bold painted two times"), "newText": "Fake bold painted one time"},
        {"page": 0, "line": index("Ink from a separation colour space"), "newText": "Paint from a separation colour space"},
    ])


def offset_cropbox():
    """MediaBox that does not start at zero, a smaller CropBox, and the same again on a turned page."""
    pdf = Pdf()
    resources = _resources(pdf)
    media, crop = (50, 40, 470, 635), (70, 60, 450, 615)
    boxes = f"/CropBox [{' '.join(map(str, crop))}]"
    texts = ["Cropped sheet with a shifted origin", "The margin note sits near the left edge.", "Delivery is due on Monday."]
    pages, raw = [], []
    for rotation in (0, 90):
        ops, lines = [], []
        for i, text in enumerate(texts):
            size, X, Y = 13, 30, 60 + i * 30  # page space baseline start
            w = width(text, "F1", size)
            if rotation == 0:
                ops.append(f"BT /F1 {size} Tf {crop[0] + X} {crop[3] - Y} Td {pdf_string(text)} Tj ET")
            else:
                ops.append(f"BT /F1 {size} Tf 0 1 -1 0 {crop[0] + Y} {crop[1] + X} Tm {pdf_string(text)} Tj ET")
            lines.append(latin(text, [X, Y - 0.8 * size, X + w, Y + 0.22 * size], size))
        raw.append({"content": "\n".join(ops), "media": f"[{' '.join(map(str, media))}]",
                    "extra": boxes + (f" /Rotate {rotation}" if rotation else "")})
        pages.append({"kind": "text", "lines": lines})
    _write("offset-cropbox", simple_document(raw, resources, pdf))
    _register("offset-cropbox", pages, ["text", "cropbox", "rotated-page"],
              edits=[{"page": p, "line": 2, "newText": "Delivery is due on Friday."} for p in (0, 1)])


def shared_content():
    """Two pages that point at the very same content stream and inherit one resource dictionary."""
    pdf = Pdf()
    resources = _resources(pdf)
    texts = ["This stream is used by two pages", "Editing one page must leave the other alone."]
    ops = [f"BT /F1 13 Tf 40 {520 - i * 30} Td {pdf_string(t)} Tj ET" for i, t in enumerate(texts)]
    ref = pdf.stream("\n".join(ops))
    pages = [{"contents_ref": ref, "content": ""}, {"contents_ref": ref, "content": ""}]
    _write("shared-content", simple_document(pages, resources, pdf))
    expected = [{"kind": "text", "lines": [latin(t, box(40, 520 - i * 30, t, "F1", 13), 13) for i, t in enumerate(texts)]}
                for _ in range(2)]
    _register("shared-content", expected, ["text", "shared-content"],
              edits=[{"page": 0, "line": 0, "newText": "This stream was used by two pages", "onlyThisPage": True}])


class _PdfPen(BasePen):
    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.ops: list[str] = []

    def _moveTo(self, p):
        self.ops.append(f"{p[0]:.0f} {p[1]:.0f} m")

    def _lineTo(self, p):
        self.ops.append(f"{p[0]:.0f} {p[1]:.0f} l")

    def _curveToOne(self, a, b, c):
        self.ops.append(f"{a[0]:.0f} {a[1]:.0f} {b[0]:.0f} {b[1]:.0f} {c[0]:.0f} {c[1]:.0f} c")

    def _closePath(self):
        self.ops.append("h")


def type3():
    face = TTFont(str(fonts.dejavu("DejaVuSerif")))
    cmap, glyphs, metrics = face.getBestCmap(), face.getGlyphSet(), face["hmtx"]
    units = face["head"].unitsPerEm
    texts = ["A Type 3 font drawn from outlines", "Glyphs are tiny content streams.", "The next show is on Monday."]
    chars = sorted(set("".join(texts)) | set("abcdefghijklmnopqrstuvwxyz"))
    pdf = Pdf()
    procs, widths, differences = [], [], []
    codes = {ch: ord(ch) for ch in chars}
    first, last = min(codes.values()), max(codes.values())
    for code in range(first, last + 1):
        ch = chr(code)
        if ch not in codes:
            widths.append(0)
            continue
        name = cmap[code]
        advance = metrics[name][0]
        pen = _PdfPen(glyphs)
        glyphs[name].draw(pen)
        body = f"{advance} 0 -100 -500 {units} {units} d1\n" + "\n".join(pen.ops) + ("\nf" if pen.ops else "")
        procs.append((name, pdf.stream(body)))
        widths.append(advance)
        differences.append(f"{code} /{name}")
    cmap_ref = pdf.stream(to_unicode_cmap([(codes[c], c) for c in chars], 1))
    char_procs = " ".join(f"/{n} {r} 0 R" for n, r in procs)
    font = pdf.add(
        f"<< /Type /Font /Subtype /Type3 /Name /T3 /FontBBox [-100 -500 {units} {units}] "
        f"/FontMatrix [{1 / units:.10f} 0 0 {1 / units:.10f} 0 0] /FirstChar {first} /LastChar {last} "
        f"/Widths [{' '.join(map(str, widths))}] /Encoding << /Type /Encoding /Differences [{' '.join(differences)}] >> "
        f"/CharProcs << {char_procs} >> /Resources << /ProcSet [/PDF] >> /ToUnicode {cmap_ref} 0 R >>"
    )
    ops, lines = [], []
    for i, text in enumerate(texts):
        size, y = 15, 520 - i * 34
        ops.append(f"BT /T3 {size} Tf 40 {y} Td {pdf_string(text)} Tj ET")
        w = sum(metrics[cmap[ord(c)]][0] for c in text) / units * size
        lines.append(latin(text, box(40, y, text, "F1", size, w), size))
    _write("type3-latin", simple_document([{"content": "\n".join(ops)}], f"<< /Font << /T3 {font} 0 R >> >>", pdf))
    _register("type3-latin", [{"kind": "text", "lines": lines}], ["text", "type3"],
              edits=[{"page": 0, "line": 2, "newText": "The next show is on Friday."}])


# A rough model of the Kruti Dev layout: each ASCII key shows a Devanagari glyph.
KRUTI_KEYS = {
    "H": "भ", "k": "ा", "j": "र", "r": "त", "g": "ह", "e": "म", "s": "े", "n": "द", "'": "श", "S": "ै", "A": "।",
    "i": "प", "q": "ु", "L": "स", "d": "क", "y": "ल", ";": "य", "t": "ज", "l": "स", "c": "ब", "[": "ख", "=": "त",
    "v": "अ", "x": "ग", "h": "ी", "B": "ठ", "o": "व", "w": "ू", "Q": "फ", "K": "ज", "a": "ं", "f": "ि", "u": "न",
    "R": "त", "T": "ज", "M": "ड", "|": "द", "F": "थ", "Z": "र",
}


def kruti():
    """Legacy Indic font: the text layer holds Latin keystrokes, only the glyph shapes are Devanagari."""
    texts = [
        ("Hkkjr gekjk ns'k gSA", "भारत हमारा देश है।"),
        ("iqLrdky; jkst lqcg [kqyrk gSA", "पुस्तकालय रोज सुबह खुलता है।"),
        ("vxyh cSBd lkseokj dks gksxhA", "अगली बैठक सोमवार को होगी।"),
        ("fo|kFkhZ foKku dh fdrkcsa ys ldrs gSaA", "विद्यार्थी विज्ञान की किताबें ले सकते हैं।"),
    ]
    source = TTFont(str(fonts.ttf_path("Devanagari")))
    source_map = source.getBestCmap()
    used = sorted({c for t, _ in texts for c in t if c != " "})
    mapping = {}
    for key in used:
        target = KRUTI_KEYS.get(key, "क")
        mapping[ord(key)] = source_map[ord(target)]
    mapping[32] = source_map[32]
    options = Options()
    options.notdef_outline = True
    options.layout_features = []
    subsetter = Subsetter(options)
    subsetter.populate(glyphs=sorted(set(mapping.values())))
    subsetter.subset(source)
    for tag in ("GSUB", "GPOS", "GDEF"):
        if tag in source:
            del source[tag]
    table = CmapSubtable.newSubtable(4)
    table.platformID, table.platEncID, table.language, table.cmap = 3, 1, 0, mapping
    cmap = newTable("cmap")
    cmap.tableVersion, cmap.tables = 0, [table]
    source["cmap"] = cmap
    buffer = io.BytesIO()
    source.save(buffer)
    program = buffer.getvalue()
    units = source["head"].unitsPerEm
    widths = [round(source["hmtx"][mapping[c]][0] * 1000 / units) if c in mapping else 0 for c in range(32, 127)]
    pdf = Pdf()
    file_ref = pdf.stream(program, "/Length1 {length1}")
    name = "ABCDEF+KrutiDev010"
    descriptor = pdf.add(f"<< /Type /FontDescriptor /FontName /{name} /FontFamily (Kruti Dev 010) /Flags 32 "
                         f"/FontBBox [-200 -400 1200 1000] /ItalicAngle 0 /Ascent 900 /Descent -350 /CapHeight 700 "
                         f"/StemV 80 /FontFile2 {file_ref} 0 R >>")
    font = pdf.add(f"<< /Type /Font /Subtype /TrueType /BaseFont /{name} /FirstChar 32 /LastChar 126 "
                   f"/Widths [{' '.join(map(str, widths))}] /Encoding /WinAnsiEncoding /FontDescriptor {descriptor} 0 R >>")
    ops, lines = [], []
    for i, (typed, meant) in enumerate(texts):
        size, y = 18, 520 - i * 42
        ops.append(f"BT /K1 {size} Tf 40 {y} Td {pdf_string(typed)} Tj ET")
        w = sum(widths[ord(c) - 32] for c in typed) / 1000 * size
        lines.append(line(typed, box(40, y, typed, "F1", size, w), lang="hi", script="Latin-legacy", dir="ltr",
                          size=size, intended=meant))
    _write("legacy-krutidev", simple_document([{"content": "\n".join(ops)}], f"<< /Font << /K1 {font} 0 R >> >>", pdf))
    _register("legacy-krutidev", [{"kind": "garbled", "lines": lines}], ["garbled", "legacy"], language="Hindi (legacy font)",
              script="Devanagari")


def _identity_font(doc_id: str, to_unicode: str):
    """Type0 / Identity-H TrueType whose program has no cmap. to_unicode: "none" or "pua"."""
    texts = ["The Unicode map of this font is gone", "Readers can see it but cannot copy it.", "Only recognition can recover it."]
    chars = sorted(set("".join(texts)))
    options = Options()
    options.retain_gids = True
    options.notdef_outline = True
    options.layout_features = []
    face = TTFont(str(fonts.dejavu("DejaVuSans")))
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=[ord(c) for c in chars])
    subsetter.subset(face)
    cmap, order = face.getBestCmap(), face.getGlyphOrder()
    gids = {c: order.index(cmap[ord(c)]) for c in chars}
    units, metrics = face["head"].unitsPerEm, face["hmtx"]
    advance = {c: round(metrics[cmap[ord(c)]][0] * 1000 / units) for c in chars}
    for tag in ("cmap", "GSUB", "GPOS", "GDEF", "kern", "FFTM", "MATH"):
        if tag in face:
            del face[tag]
    face["post"].formatType = 3.0
    buffer = io.BytesIO()
    face.save(buffer)
    pdf = Pdf()
    file_ref = pdf.stream(buffer.getvalue(), "/Length1 {length1}")
    name = "GHIJKL+Unmapped" + to_unicode.title()
    descriptor = pdf.add(f"<< /Type /FontDescriptor /FontName /{name} /Flags 4 /FontBBox [-1021 -463 1793 1232] "
                         f"/ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 /FontFile2 {file_ref} 0 R >>")
    w_array = " ".join(f"{gids[c]} [{advance[c]}]" for c in chars)
    cid = pdf.add(f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} /CIDSystemInfo << /Registry (Adobe) "
                  f"/Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor} 0 R /W [{w_array}] "
                  f"/CIDToGIDMap /Identity >>")
    extra = ""
    if to_unicode == "pua":
        cmap_ref = pdf.stream(to_unicode_cmap([(gids[c], chr(0xE000 + i)) for i, c in enumerate(chars)], 2))
        extra = f"/ToUnicode {cmap_ref} 0 R"
    font = pdf.add(f"<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H "
                   f"/DescendantFonts [{cid} 0 R] {extra} >>")
    ops, lines = [], []
    for i, text in enumerate(texts):
        size, y = 15, 520 - i * 36
        ops.append(f"BT /U1 {size} Tf 40 {y} Td <{''.join(f'{gids[c]:04X}' for c in text)}> Tj ET")
        w = sum(advance[c] for c in text) / 1000 * size
        lines.append(line(text, box(40, y, text, "F1", size, w), lang="en", script="Latin", dir="ltr", size=size, intended=text))
    _write(doc_id, simple_document([{"content": "\n".join(ops)}], f"<< /Font << /U1 {font} 0 R >> >>", pdf))
    _register(doc_id, [{"kind": "garbled", "lines": lines}], ["garbled", to_unicode], language=f"Broken map ({to_unicode})")


def signed_and_empty():
    pdf = Pdf()
    resources = _resources(pdf)
    sig = pdf.add("<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0 0 0] "
                  "/Contents <00> /Reason (Synthetic test fixture, not a real signature) >>")
    pages_ref = pdf.reserve()
    page_ref = pdf.reserve()
    widget = pdf.add(f"<< /Type /Annot /Subtype /Widget /FT /Sig /T (signature1) /Rect [40 380 200 420] /F 132 "
                     f"/V {sig} 0 R /P {page_ref} 0 R >>")
    text = "This document carries a signature field"
    contents = pdf.stream(f"BT /F1 13 Tf 40 520 Td {pdf_string(text)} Tj ET")
    pdf.add(f"<< /Type /Page /Parent {pages_ref} 0 R /MediaBox [0 0 420 595] /Contents {contents} 0 R "
            f"/Annots [{widget} 0 R] >>", page_ref)
    pdf.add(f"<< /Type /Pages /Kids [{page_ref} 0 R] /Count 1 /Resources {resources} >>", pages_ref)
    root = pdf.add(f"<< /Type /Catalog /Pages {pages_ref} 0 R /AcroForm << /Fields [{widget} 0 R] /SigFlags 3 >> >>")
    info = pdf.add("<< /Producer (pdfedit fixture generator) /CreationDate (D:20200101000000Z) "
                   "/ModDate (D:20200101000000Z) /Title (Signed fixture) >>")
    _write("signed-simulated", pdf.build(root, info))
    _register("signed-simulated", [{"kind": "text", "lines": [latin(text, box(40, 520, text, "F1", 13), 13)]}],
              ["text", "signed"], signed=True,
              edits=[{"page": 0, "line": 0, "newText": "This document carried a signature field"}])

    pdf = Pdf()
    _write("empty-page", simple_document([{"content": ""}], "<< >>", pdf))
    _register("empty-page", [{"kind": "empty", "lines": []}], ["empty"], language="None", script="None")


def build():
    positioning()
    offset_cropbox()
    shared_content()
    type3()
    kruti()
    _identity_font("broken-no-tounicode", "none")
    _identity_font("broken-pua", "pua")
    signed_and_empty()
