"""Latin documents written by ReportLab (and PyMuPDF): standard-14, TrueType subsets, CFF, columns,
justified text, rotated pages and text, shared form XObjects, AcroForm fields, images and a multi-page file."""

import io
import math

import numpy as np
import pymupdf
from PIL import Image, ImageDraw
from reportlab import rl_config
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

import fonts
from common import OUT, line, register

rl_config.invariant = 1
W, H = 420.0, 595.0


def _canvas(doc_id: str, **kwargs):
    return rl_canvas.Canvas(str(OUT / f"{doc_id}.pdf"), pagesize=(W, H), pageCompression=1, invariant=1, **kwargs)


def _metrics(text, font, size):
    ascent, descent = pdfmetrics.getAscentDescent(font, size)
    return pdfmetrics.stringWidth(text, font, size), ascent, descent


def draw(c, out: list, x: float, y: float, text: str, font="Helvetica", size=13.0, color=None, record=True,
         height=H, **info):
    """Draw one line with its baseline at (x, y) in PDF coordinates and record the expected line."""
    c.setFont(font, size)
    if color is not None:
        c.setFillColorRGB(*color)
    c.drawString(x, y, text)
    if record:
        width, ascent, descent = _metrics(text, font, size)
        out.append(line(text, [x, height - y - ascent, x + width, height - y - descent], lang="en", script="Latin",
                        dir="ltr", size=size, color=list(color) if color is not None else None,
                        bold="Bold" in font, italic=("Italic" in font or "Oblique" in font), **info))
    if color is not None:
        c.setFillColorRGB(0, 0, 0)


def _register(doc_id, pages, tags, edits=None, **extra):
    register(doc_id, pages, producer=extra.pop("producer", "reportlab"), language=extra.pop("language", "English"),
             script="Latin", tags=tags, edits=edits, **extra)


def standard14():
    c = _canvas("en-standard14")
    lines: list = []
    draw(c, lines, 40, 540, "Annual report of the garden society", "Helvetica-Bold", 18)
    draw(c, lines, 40, 505, "Members met on the first Sunday of each month.", "Helvetica", 12)
    draw(c, lines, 40, 480, "The treasurer recorded 1,284.50 in donations.", "Times-Roman", 13)
    draw(c, lines, 40, 455, "Volunteers planted forty apple saplings.", "Times-Italic", 13)
    draw(c, lines, 40, 430, "ledger_total = sum(rows) # monthly", "Courier", 11)
    draw(c, lines, 40, 405, "Heading in blue with a regular weight", "Helvetica", 14, color=(0.05, 0.2, 0.7))
    draw(c, lines, 40, 380, "Warning text printed in a deep red", "Times-Bold", 14, color=(0.7, 0.05, 0.05))
    c.setFillColorCMYK(0.8, 0.1, 0.9, 0.1)
    draw(c, lines, 40, 355, "Green ink specified in CMYK colour space", "Helvetica-Oblique", 13)
    c.setFillGray(0.4)
    draw(c, lines, 40, 330, "Grey footnote set at nine points", "Helvetica", 9)
    c.setFillColorRGB(0, 0, 0)
    draw(c, lines, 40, 300, "Prices: £4.20, €5.10 and $6.00 (approx.)", "Helvetica", 12)
    draw(c, lines, 40, 275, "The next meeting is on Monday.", "Helvetica", 13)
    c.setFont("Helvetica", 13)
    c.drawRightString(380, 245, "Right aligned total: 9,876")
    w, a, d = _metrics("Right aligned total: 9,876", "Helvetica", 13)
    lines.append(line("Right aligned total: 9,876", [380 - w, H - 245 - a, 380, H - 245 - d], lang="en", script="Latin",
                      dir="ltr", size=13, align="right"))
    c.drawCentredString(210, 220, "A centred closing remark")
    w, a, d = _metrics("A centred closing remark", "Helvetica", 13)
    lines.append(line("A centred closing remark", [210 - w / 2, H - 220 - a, 210 + w / 2, H - 220 - d], lang="en",
                      script="Latin", dir="ltr", size=13, align="center"))
    c.setStrokeColorRGB(0.3, 0.3, 0.3)
    c.line(40, 200, 380, 200)
    c.save()
    _register("en-standard14", [{"kind": "text", "lines": lines}], ["text", "standard14"],
              edits=[{"page": 0, "line": 10, "newText": "The next meeting is on Friday afternoon."},
                     {"page": 0, "line": 5, "newText": "Heading in blue with a lighter weight"}])


def truetype():
    for name, file in [("DejaVu", "DejaVuSans"), ("DejaVu-Bold", "DejaVuSans-Bold"),
                       ("DejaVuSerif", "DejaVuSerif"), ("DejaVuSerif-Italic", "DejaVuSerif-Italic"),
                       ("DejaVuMono", "DejaVuSansMono")]:
        pdfmetrics.registerFont(TTFont(name, str(fonts.dejavu(file))))
    c = _canvas("en-truetype")
    lines: list = []
    draw(c, lines, 40, 540, "Field notes from the river survey", "DejaVu-Bold", 17)
    draw(c, lines, 40, 505, "Water level rose by 42 centimetres overnight.", "DejaVu", 12)
    draw(c, lines, 40, 478, "Three herons rested near the old stone bridge.", "DejaVuSerif", 12)
    draw(c, lines, 40, 451, "Samples were labelled before sunrise.", "DejaVuSerif-Italic", 12)
    draw(c, lines, 40, 424, "id=R-17 temp=18.4 pH=7.2", "DejaVuMono", 11)
    draw(c, lines, 40, 397, "Coloured remark about the muddy path", "DejaVu", 13, color=(0.55, 0.15, 0.5))
    draw(c, lines, 40, 370, "Accented words: café, naïve, señor, Zürich", "DejaVu", 12)
    draw(c, lines, 40, 343, "The next visit is on Monday.", "DejaVu", 13)
    c.save()
    _register("en-truetype", [{"kind": "text", "lines": lines}], ["text", "truetype", "subset"],
              edits=[{"page": 0, "line": 7, "newText": "The next visit is on Friday, quite early!"},
                     {"page": 0, "line": 0, "newText": "Field notes from the forest survey"}])


def cff():
    path = fonts.cff_path("Latin")
    face = pymupdf.Font(fontfile=str(path))
    pdf = pymupdf.open()
    page = pdf.new_page(width=W, height=H)
    page.insert_font(fontname="NSerif", fontfile=str(path))
    lines = []
    texts = ["A note set in an OpenType CFF font", "Glyph outlines here use cubic curves.",
             "Digits 0123456789 and punctuation ;:!?", "Quiet “curly quotes” and an en dash – too.",
             "The next lesson is on Monday."]
    for i, text in enumerate(texts):
        size, y = 14, 70 + i * 34
        page.insert_text((40, y), text, fontname="NSerif", fontsize=size)
        lines.append(line(text, [40, y - face.ascender * size, 40 + face.text_length(text, size), y - face.descender * size],
                          lang="en", script="Latin", dir="ltr", size=size))
    pdf.save(OUT / "en-cff.pdf", garbage=3, deflate=True)
    pdf.close()
    _register("en-cff", [{"kind": "text", "lines": lines}], ["text", "cff"], producer="pymupdf",
              edits=[{"page": 0, "line": 4, "newText": "The next lesson is on Friday at noon."}])


def story():
    """MuPDF's own HTML layout engine: a second complex-script producer with different ToUnicode habits."""
    items = [
        ("en", "Latin", "ltr", "Notes written by a different engine"),
        ("hi", "Devanagari", "ltr", "विद्यार्थी क्षेत्रीय भाषा में लिखते हैं।"),
        ("ta", "Tamil", "ltr", "நூலகம் தினமும் காலை திறக்கும்."),
        ("bn", "Bengali", "ltr", "শিক্ষার্থীরা বিজ্ঞানের বই পড়ে।"),
        ("ar", "Arabic", "rtl", "يمكن للطلاب استعارة الكتب."),
        ("he", "Hebrew", "rtl", "תלמידים קוראים ספרים."),
        ("zh", "Han", "ltr", "学生可以借阅科学书籍。"),
        ("ru", "Cyrillic", "ltr", "Студенты читают новые книги."),
    ]
    pdf = pymupdf.open()
    page = pdf.new_page(width=W, height=H)
    for i, (lang, _script, direction, text) in enumerate(items):
        box = pymupdf.Rect(40, 40 + i * 60, 380, 80 + i * 60)
        page.insert_htmlbox(box, f'<div lang="{lang}" dir="{direction}" style="font-size:15px">{text}</div>', scale_low=1)
    pdf.subset_fonts()
    pdf.save(OUT / "story-multiscript.pdf", garbage=3, deflate=True)
    pdf.close()
    pdf = pymupdf.open(OUT / "story-multiscript.pdf")
    boxes = []
    for i in range(len(items)):
        band = pymupdf.Rect(0, 36 + i * 60, W, 90 + i * 60)
        found = pymupdf.Rect()
        for block in pdf[0].get_text("dict")["blocks"]:
            for text_line in block.get("lines", []):
                r = pymupdf.Rect(text_line["bbox"])
                if band.contains((r.tl + r.br) * 0.5):
                    found |= r
        if found.is_empty:
            raise RuntimeError(f"story line {i} produced no text")
        boxes.append(list(found))
    pdf.close()
    lines = [line(t, boxes[i], lang=lang, script=script, dir=d, size=15) for i, (lang, script, d, t) in enumerate(items)]
    register("story-multiscript", [{"kind": "text", "lines": lines}], producer="mupdf-story", language="Story (mixed)",
             script="Mixed", tags=["text", "story", "mixed"],
             edits=[{"page": 0, "line": 0, "newText": "Notes written by another engine"}])


def columns_table():
    c = _canvas("columns-table")
    lines: list = []
    draw(c, lines, 40, 550, "Two columns and a price table", "Helvetica-Bold", 16)
    left = ["Morning market opens at six", "and the bakers arrive first", "with warm loaves of bread",
            "stacked in wooden crates.", "Flower sellers follow them."]
    right = ["Evening market is quieter", "with lamps along the wall", "and the smell of roasting",
             "corn drifting past stalls.", "Closing bell rings at nine."]
    for i, (a, b) in enumerate(zip(left, right)):
        y = 515 - i * 16
        draw(c, lines, 40, y, a, "Times-Roman", 12, tags=["column"])
        draw(c, lines, 232, y, b, "Times-Roman", 12, tags=["column"])
    rows = [["Product", "Quantity", "Unit price", "Amount"], ["Rice", "12", "58.00", "696.00"],
            ["Lentils", "5", "112.00", "560.00"], ["Jaggery", "3", "74.50", "223.50"], ["Total", "20", "-", "1479.50"]]
    xs = [40, 140, 225, 315]
    top = 390
    c.setStrokeColorRGB(0.4, 0.4, 0.4)
    for r in range(len(rows) + 1):
        c.line(36, top - r * 22 + 15, 392, top - r * 22 + 15)
    for x in [36, 136, 221, 311, 392]:
        c.line(x, top + 15, x, top - len(rows) * 22 + 15)
    for r, row in enumerate(rows):
        for col, cell in enumerate(row):
            draw(c, lines, xs[col], top - r * 22, cell, "Helvetica-Bold" if r == 0 else "Helvetica", 11, tags=["cell"])
    c.save()
    target = next(i for i, item in enumerate(lines) if item["text"] == "112.00")
    _register("columns-table", [{"kind": "text", "lines": lines}], ["text", "table", "columns"],
              edits=[{"page": 0, "line": target, "newText": "118.75"},
                     {"page": 0, "line": 1, "newText": "Morning market opens at five"}])


def justified():
    c = _canvas("en-justified")
    lines: list = []
    paragraph = [
        "The old clock tower stands at the centre of the town and",
        "its bell has marked every hour since the winter when the",
        "railway first reached the valley. Children still count the",
        "strokes on their way to school, and shopkeepers open the",
        "shutters when the eighth one fades into the morning air.",
    ]
    x, width, size, font = 40, 340, 12.5, "Times-Roman"
    c.setFont(font, size)
    for i, text in enumerate(paragraph):
        y = 520 - i * 18
        last = i == len(paragraph) - 1
        natural = pdfmetrics.stringWidth(text, font, size)
        spacing = 0 if last else (width - natural) / text.count(" ")
        t = c.beginText(x, y)
        t.setFont(font, size)
        t.setWordSpace(spacing)
        t.textOut(text)
        t.setWordSpace(0)
        c.drawText(t)
        _, ascent, descent = _metrics(text, font, size)
        lines.append(line(text, [x, H - y - ascent, x + (natural if last else width), H - y - descent], lang="en",
                          script="Latin", dir="ltr", size=size, align=None if last else "justify", tags=["paragraph"]))
    c.save()
    _register("en-justified", [{"kind": "text", "lines": lines}], ["text", "justified"],
              edits=[{"page": 0, "line": 1, "newText": "its bell has chimed every hour since the winter when the"}])


def rotated_pages():
    c = _canvas("rotated-pages")
    pages = []
    for rotation in (0, 90, 180, 270):
        c.setPageRotation(rotation)
        # ReportLab swaps the media box of quarter turned pages, so those display as 420 x 595 again
        user_w, user_h = (H, W) if rotation in (90, 270) else (W, H)
        lines = []
        texts = [f"This page is turned by {rotation} degrees", "Text should read upright on screen.",
                 "The next review is on Monday."]
        for i, text in enumerate(texts):
            size, X, Y = 14, 50, 90 + i * 40  # display coordinates of the baseline start
            c.saveState()
            if rotation == 0:
                c.translate(X, user_h - Y)
            elif rotation == 90:
                c.translate(Y, X)
                c.rotate(90)
            elif rotation == 180:
                c.translate(user_w - X, Y)
                c.rotate(180)
            else:
                c.translate(user_w - Y, user_h - X)
                c.rotate(270)
            c.setFont("Helvetica", size)
            c.drawString(0, 0, text)
            c.restoreState()
            width, ascent, descent = _metrics(text, "Helvetica", size)
            lines.append(line(text, [X, Y - ascent, X + width, Y - descent], lang="en", script="Latin", dir="ltr",
                              size=size, angle=0))
        pages.append({"kind": "text", "lines": lines})
        c.showPage()
    c.save()
    _register("rotated-pages", pages, ["text", "rotated-page"],
              edits=[{"page": p, "line": 2, "newText": "The next review is on Friday."} for p in range(4)])


def rotated_text():
    c = _canvas("rotated-text")
    lines: list = []
    draw(c, lines, 40, 550, "Labels placed at several angles", "Helvetica-Bold", 15)
    specs = [(60, 150, 90, "Vertical axis label reading upward"), (380, 450, -90, "Spine label reading downward"),
             (110, 250, 30, "Banner tilted thirty degrees"), (110, 180, -20, "Stamp tilted downward slightly")]
    for x, y, angle, text in specs:
        size = 13
        c.saveState()
        c.translate(x, y)
        c.rotate(angle)
        c.setFont("Helvetica", size)
        c.drawString(0, 0, text)
        c.restoreState()
        width, ascent, descent = _metrics(text, "Helvetica", size)
        rad = math.radians(angle)
        corners = [(dx * math.cos(rad) - dy * math.sin(rad) + x, dx * math.sin(rad) + dy * math.cos(rad) + y)
                   for dx in (0, width) for dy in (descent, ascent)]
        xs, ys = [p[0] for p in corners], [H - p[1] for p in corners]
        lines.append(line(text, [min(xs), min(ys), max(xs), max(ys)], lang="en", script="Latin", dir="ltr", size=size,
                          angle=round(-rad, 5), origin=[x, H - y], tags=["rotated"]))
    draw(c, lines, 140, 90, "An ordinary caption underneath", "Helvetica", 12)
    c.save()
    _register("rotated-text", [{"kind": "text", "lines": lines}], ["text", "rotated-text"],
              edits=[{"page": 0, "line": 1, "newText": "Vertical axis label reading upwards"},
                     {"page": 0, "line": 3, "newText": "Banner tilted forty degrees"}])


def xobjects():
    c = _canvas("xobject-shared")
    c.beginForm("badge")
    c.setFont("Helvetica-Oblique", 10)
    c.drawString(0, 0, "Nested badge inside the letterhead")
    c.endForm()
    c.beginForm("letterhead")
    c.setFont("Helvetica-Bold", 15)
    c.drawString(40, 550, "Shared letterhead of the cooperative")
    c.setFont("Helvetica", 10)
    c.drawString(40, 532, "Reused on every page through one form")
    c.saveState()
    c.translate(40, 512)
    c.doForm("badge")
    c.restoreState()
    c.endForm()
    pages = []
    for number, body in enumerate(["First page body about the spring harvest.", "Second page body about the autumn fair."]):
        c.doForm("letterhead")
        lines = []
        for text, y, font, size in [("Shared letterhead of the cooperative", 550, "Helvetica-Bold", 15),
                                    ("Reused on every page through one form", 532, "Helvetica", 10),
                                    ("Nested badge inside the letterhead", 512, "Helvetica-Oblique", 10)]:
            width, ascent, descent = _metrics(text, font, size)
            lines.append(line(text, [40, H - y - ascent, 40 + width, H - y - descent], lang="en", script="Latin",
                              dir="ltr", size=size, tags=["xobject"]))
        draw(c, lines, 40, 440, body, "Times-Roman", 13)
        draw(c, lines, 40, 415, f"Sheet number {number + 1}", "Times-Roman", 11)
        pages.append({"kind": "text", "lines": lines})
        c.showPage()
    c.save()
    _register("xobject-shared", pages, ["text", "xobject"],
              edits=[{"page": 0, "line": 0, "newText": "Shared letterhead of the collective", "onlyThisPage": True},
                     {"page": 0, "line": 2, "newText": "Nested label inside the letterhead", "onlyThisPage": True}])


def forms():
    c = _canvas("forms")
    lines: list = []
    form = c.acroForm
    draw(c, lines, 40, 550, "Membership application form", "Helvetica-Bold", 16)
    draw(c, lines, 40, 505, "Full name", "Helvetica", 11)
    form.textfield(name="full_name", x=150, y=498, width=220, height=22, value="", fontName="Helvetica", fontSize=11)
    draw(c, lines, 40, 455, "About you", "Helvetica", 11)
    form.textfield(name="about", x=150, y=410, width=220, height=60, value="", fieldFlags="multiline",
                   fontName="Helvetica", fontSize=11, maxlen=400)
    draw(c, lines, 40, 375, "Send newsletter", "Helvetica", 11)
    form.checkbox(name="newsletter", x=150, y=368, size=18, checked=False, buttonStyle="check")
    draw(c, lines, 40, 335, "Plan", "Helvetica", 11)
    form.radio(name="plan", value="basic", selected=True, x=150, y=328, size=18)
    form.radio(name="plan", value="family", selected=False, x=230, y=328, size=18)
    draw(c, lines, 172, 332, "Basic", "Helvetica", 10)
    draw(c, lines, 252, 332, "Family", "Helvetica", 10)
    draw(c, lines, 40, 295, "City", "Helvetica", 11)
    form.choice(name="city", x=150, y=288, width=120, height=20, value="Pune", options=["Pune", "Delhi", "Kochi"],
                fontName="Helvetica", fontSize=11)
    draw(c, lines, 40, 245, "Interest", "Helvetica", 11)
    form.listbox(name="interest", x=150, y=200, width=120, height=60, value="Gardening",
                 options=["Gardening", "Reading", "Cycling"], fontName="Helvetica", fontSize=11)
    draw(c, lines, 40, 170, "Reference code", "Helvetica", 11)
    form.textfield(name="reference", x=150, y=163, width=120, height=22, value="REF-0042", fieldFlags="readOnly",
                   fontName="Helvetica", fontSize=11)
    c.save()

    def box(x, y, w, h):
        return [x, H - y - h, x + w, H - y]

    fields = [
        {"name": "full_name", "type": "text", "value": "", "rect": box(150, 498, 220, 22)},
        {"name": "about", "type": "text", "value": "", "multiline": True, "rect": box(150, 410, 220, 60)},
        {"name": "newsletter", "type": "checkbox", "checked": False, "rect": box(150, 368, 18, 18)},
        {"name": "plan", "type": "radio", "values": ["basic", "family"], "value": "basic", "rect": box(150, 328, 18, 18)},
        {"name": "city", "type": "combobox", "value": "Pune", "options": ["Pune", "Delhi", "Kochi"],
         "rect": box(150, 288, 120, 20)},
        {"name": "interest", "type": "listbox", "value": "Gardening", "options": ["Gardening", "Reading", "Cycling"],
         "rect": box(150, 200, 120, 60)},
        {"name": "reference", "type": "text", "value": "REF-0042", "readOnly": True, "rect": box(150, 163, 120, 22)},
    ]
    _register("forms", [{"kind": "text", "lines": lines}], ["text", "forms"], fields=fields,
              edits=[{"page": 0, "line": 0, "newText": "Membership renewal form"}])


def sample_photo(width=240, height=160, seed=1) -> Image.Image:
    rng = np.random.default_rng(seed)
    x = np.linspace(0, 1, width)[None, :, None]
    y = np.linspace(0, 1, height)[:, None, None]
    base = np.concatenate([60 + 150 * x * np.ones_like(y), 80 + 130 * y * np.ones_like(x),
                           200 - 120 * x * y], axis=2)
    base += rng.normal(0, 6, base.shape)
    image = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(image)
    d.ellipse([width * 0.55, height * 0.15, width * 0.85, height * 0.6], fill=(240, 220, 90))
    d.polygon([(0, height), (width * 0.35, height * 0.45), (width * 0.7, height)], fill=(40, 90, 60))
    return image


def images():
    photo = sample_photo()
    jpeg = io.BytesIO()
    sample_photo(300, 200, seed=7).save(jpeg, "JPEG", quality=70)
    jpeg.seek(0)
    logo = Image.new("RGBA", (120, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(logo)
    d.ellipse([8, 8, 112, 112], fill=(30, 110, 200, 210))
    d.rectangle([40, 40, 80, 80], fill=(255, 255, 255, 255))
    c = _canvas("images")
    lines: list = []
    draw(c, lines, 40, 560, "Pictures placed on a single page", "Helvetica-Bold", 15)
    reader = ImageReader(photo)
    c.drawImage(reader, 40, 400, 180, 120)
    c.drawImage(ImageReader(jpeg), 240, 400, 150, 100)
    c.drawImage(ImageReader(logo), 40, 250, 100, 100, mask="auto")
    c.drawImage(reader, 250, 250, 120, 80)  # the same XObject used twice
    c.saveState()
    c.translate(150, 90)
    c.rotate(15)
    c.drawImage(reader, 0, 0, 120, 80)
    c.restoreState()
    draw(c, lines, 40, 385, "Caption for the two pictures above", "Helvetica", 10)
    draw(c, lines, 40, 60, "Text below the pictures must stay put.", "Helvetica", 11)
    c.save()

    def box(x, y, w, h):
        return [x, H - y - h, x + w, H - y]

    placed = [
        {"rect": box(40, 400, 180, 120), "pixelWidth": 240, "pixelHeight": 160},
        {"rect": box(240, 400, 150, 100), "pixelWidth": 300, "pixelHeight": 200},
        {"rect": box(40, 250, 100, 100), "pixelWidth": 120, "pixelHeight": 120},
        {"rect": box(250, 250, 120, 80), "pixelWidth": 240, "pixelHeight": 160},
        {"rect": None, "pixelWidth": 240, "pixelHeight": 160, "rotated": True},
    ]
    _register("images", [{"kind": "text", "lines": lines, "images": placed}], ["text", "images"],
              edits=[{"page": 0, "line": 1, "newText": "Caption for the three pictures above"}])


def multipage():
    c = _canvas("multipage")
    words = ["alpha", "bravo", "charlie", "delta", "echo"]
    pages = []
    for i, word in enumerate(words):
        lines: list = []
        c.bookmarkPage(word)
        c.addOutlineEntry(f"Chapter {word}", word, 0)
        draw(c, lines, 40, 540, f"Chapter {word} of the field guide", "Helvetica-Bold", 16)
        draw(c, lines, 40, 505, f"Page marker {word} appears only here.", "Helvetica", 12)
        draw(c, lines, 40, 480, "A repeated sentence about the weather.", "Helvetica", 12)
        if i == 0:
            draw(c, lines, 40, 440, "Jump to chapter delta", "Helvetica", 12, color=(0.1, 0.2, 0.8))
            c.linkRect("", "delta", (40, 436, 180, 452), relative=0)
        pages.append({"kind": "text", "lines": lines})
        c.showPage()
    c.save()
    _register("multipage", pages, ["text", "multipage", "links"],
              edits=[{"page": 2, "line": 1, "newText": "Page marker charlie was updated here."}])


def build():
    standard14()
    truetype()
    cff()
    story()
    columns_table()
    justified()
    rotated_pages()
    rotated_text()
    xobjects()
    forms()
    images()
    multipage()
