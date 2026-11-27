"""Encrypted, damaged and scanned variants built from documents generated earlier, plus raw image assets."""

import copy
import io
import math
import re

import numpy as np
import pymupdf
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter

import fonts
from common import FIXTURES, OUT, documents, register

PASSWORD = "test1234"


def _source(doc_id: str) -> dict:
    return next(d for d in documents if d["id"] == doc_id)


def passwords():
    source = _source("en-truetype")
    variants = [
        ("password-aes256", pymupdf.PDF_ENCRYPT_AES_256, PASSWORD),
        ("password-rc4", pymupdf.PDF_ENCRYPT_RC4_128, PASSWORD),
        ("owner-only", pymupdf.PDF_ENCRYPT_AES_128, ""),
    ]
    for doc_id, method, user in variants:
        pdf = pymupdf.open(OUT / source["file"])
        pdf.save(OUT / f"{doc_id}.pdf", encryption=method, user_pw=user, owner_pw="fixture-owner-password",
                 permissions=pymupdf.PDF_PERM_PRINT, deflate=True)
        pdf.close()
        register(doc_id, copy.deepcopy(source["pages"]), producer="pymupdf", language="English", script="Latin",
                 tags=["text", "encrypted"] + ([] if user else ["owner-only"]), password=user or None,
                 edits=copy.deepcopy(source["edits"][:1]))


def damaged():
    source = _source("en-standard14")
    data = (OUT / source["file"]).read_bytes()
    # 1. startxref points nowhere and the table entries are scrambled
    broken = re.sub(rb"startxref\s+\d+", b"startxref\n999999", data)
    broken = re.sub(rb"(\d{10}) 00000 n", lambda m: b"%010d 00000 n" % (int(m.group(1)) + 7), broken)
    (OUT / "damaged-xref.pdf").write_bytes(broken)
    # 2. the download stopped before the cross reference table
    cut = data[: data.rindex(b"\nxref")] + b"\n"
    (OUT / "damaged-truncated.pdf").write_bytes(cut)
    for doc_id in ("damaged-xref", "damaged-truncated"):
        register(doc_id, copy.deepcopy(source["pages"]), producer="reportlab", language="English", script="Latin",
                 tags=["text", "damaged"], edits=copy.deepcopy(source["edits"][:1]), repaired=True)


def _scan_image(source_id: str, dpi: int, skew: float, seed: int) -> Image.Image:
    pdf = pymupdf.open(OUT / f"{source_id}.pdf")
    page = pdf[0]
    height = min(page.rect.height, 450)  # the text sits in the upper part; keep the files small
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, clip=pymupdf.Rect(0, 0, page.rect.width, page.rect.height))
    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    pdf.close()
    del height
    rng = np.random.default_rng(seed)
    array = np.asarray(image).astype(np.float32) / 255.0
    h, w = array.shape[:2]
    # off-white paper with a soft lighting gradient and grain
    paper = np.array([0.965, 0.95, 0.915], dtype=np.float32)
    gradient = (1.0 - 0.07 * np.linspace(0, 1, h)[:, None, None]) * (1.0 - 0.04 * np.linspace(0, 1, w)[None, :, None])
    array = array * paper * gradient
    array += rng.normal(0, 0.012, (h, w, 1))
    image = Image.fromarray((np.clip(array, 0, 1) * 255).astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(0.5))
    if skew:
        corner = image.getpixel((5, 5))
        image = image.rotate(skew, resample=Image.BICUBIC, fillcolor=corner)
    return image


def _rotate_rect(r, skew, width, height):
    """PIL rotates counter clockwise on screen around the centre."""
    rad = math.radians(skew)
    cx, cy = width / 2, height / 2
    points = []
    for x, y in ((r[0], r[1]), (r[2], r[1]), (r[0], r[3]), (r[2], r[3])):
        dx, dy = x - cx, y - cy
        points.append((cx + dx * math.cos(rad) + dy * math.sin(rad), cy - dx * math.sin(rad) + dy * math.cos(rad)))
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return [round(v, 2) for v in (min(xs), min(ys), max(xs), max(ys))]


def scans():
    jobs = [
        ("scan-en", "en-chromium", 0.7, "eng"),
        ("scan-hi", "hi-chromium", 0.0, "hin"),
        ("scan-ar", "ar-chromium", 0.0, "ara"),
        ("scan-ru", "ru-chromium", -0.5, "rus"),
        ("scan-zh", "zh-chromium", 0.0, "chi_sim"),
        ("scan-ta", "ta-chromium", 0.0, "tam"),
    ]
    for seed, (doc_id, source_id, skew, tesseract) in enumerate(jobs, start=11):
        source = _source(source_id)
        image = _scan_image(source_id, 170, skew, seed)
        jpeg = io.BytesIO()
        image.save(jpeg, "JPEG", quality=62)
        width, height = source["pages"][0]["width"], source["pages"][0]["height"]
        pdf = pymupdf.open()
        page = pdf.new_page(width=width, height=height)
        page.insert_image(page.rect, stream=jpeg.getvalue())
        pdf.save(OUT / f"{doc_id}.pdf", garbage=3, deflate=True)
        pdf.close()
        lines = copy.deepcopy(source["pages"][0]["lines"])
        for item in lines:
            if skew:
                item["rect"] = _rotate_rect(item["rect"], skew, width, height)
        register(doc_id, [{"kind": "scanned", "lines": lines}], producer="scan", language=source["language"],
                 script=source["script"], tags=["scanned", "ocr"], tesseract=tesseract, skew=skew,
                 edits=copy.deepcopy(source["edits"]))

    # a "searchable" scan: the picture plus invisible text on top
    source = _source("en-truetype")
    image = _scan_image("en-truetype", 150, 0.0, 29)
    jpeg = io.BytesIO()
    image.save(jpeg, "JPEG", quality=62)
    width, height = source["pages"][0]["width"], source["pages"][0]["height"]
    pdf = pymupdf.open()
    page = pdf.new_page(width=width, height=height)
    page.insert_image(page.rect, stream=jpeg.getvalue())
    face = pymupdf.Font("helv")
    for item in source["pages"][0]["lines"]:
        x0, y0, x1, y1 = item["rect"]
        size = item["size"]
        natural = face.text_length(item["text"], size)
        baseline = pymupdf.Point(x0, y1 - 0.236 * size)
        page.insert_text(baseline, item["text"], fontname="helv", fontsize=size, render_mode=3,
                         morph=(baseline, pymupdf.Matrix((x1 - x0) / natural, 1)))
    pdf.save(OUT / "scan-searchable-en.pdf", garbage=3, deflate=True)
    pdf.close()
    lines = copy.deepcopy(source["pages"][0]["lines"])
    register("scan-searchable-en", [{"kind": "mixed", "lines": lines}], producer="scan", language="English",
             script="Latin", tags=["scanned", "searchable"], tesseract="eng",
             edits=[{"page": 0, "line": 7, "newText": "The next visit is on Friday."}])


def assets():
    """Raster files and a small user font used by integration and browser tests."""
    folder = FIXTURES / "assets"
    folder.mkdir(exist_ok=True)
    _scan_image("en-chromium", 110, 0.0, 3).save(folder / "photo-page.jpg", "JPEG", quality=70)
    from reportlab_docs import sample_photo

    sample_photo(320, 220, seed=3).save(folder / "photo.png", "PNG", optimize=True)
    sample_photo(200, 140, seed=9).save(folder / "photo.jpg", "JPEG", quality=75)
    signature = Image.new("RGB", (420, 160), (255, 255, 255))
    d = ImageDraw.Draw(signature)
    points = [(30 + t * 3.6, 80 + 38 * math.sin(t / 7.0) * math.cos(t / 23.0)) for t in range(100)]
    d.line(points, fill=(20, 30, 90), width=5, joint="curve")
    d.line([(50, 125), (370, 112)], fill=(20, 30, 90), width=3)
    signature.save(folder / "signature.png", "PNG", optimize=True)
    # a user font under its own name (DejaVu licence requires renaming modified copies)
    face = TTFont(str(fonts.dejavu("DejaVuSerif")))
    options = Options()
    options.name_IDs = []
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=list(range(32, 127)))
    subsetter.subset(face)
    name = face["name"]
    name.names = []
    for name_id, value in [(1, "Fixture Serif"), (2, "Regular"), (4, "Fixture Serif Regular"), (6, "FixtureSerif-Regular")]:
        name.setName(value, name_id, 3, 1, 0x409)
    face.save(folder / "FixtureSerif.ttf")


def build():
    passwords()
    damaged()
    scans()
    assets()
