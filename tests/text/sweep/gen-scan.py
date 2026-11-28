"""Scans: pages of the printed documents turned into pictures, with the OCR result a recogniser would give
(taken from the known layout), so that every recognised box can be swept too.

  python tests/text/sweep/gen-scan.py [outDir]      (run gen-html.mjs first)
"""
import json
import os
import sys

import pymupdf

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".tmp/boxes/pdfs")

for source, dpi in [("html-invoice", 150), ("html-gdocs", 200), ("html-certificate", 150), ("html-form-printed", 150), ("html-on-images", 150), ("html-hindi", 200)]:
    original = pymupdf.open(os.path.join(OUT, source + ".pdf"))
    truth = json.load(open(os.path.join(OUT, source + ".json"), encoding="utf-8"))
    page = original[0]
    scan = pymupdf.open()
    target = scan.new_page(width=page.rect.width, height=page.rect.height)
    pix = page.get_pixmap(dpi=dpi)
    target.insert_image(target.rect, stream=pix.tobytes("jpg", jpg_quality=85))
    name = "scan-" + source[5:]
    scan.save(os.path.join(OUT, name + ".pdf"), deflate=True)
    segments = [s for s in truth["pages"][0]["segments"] if s.get("rect")]
    json.dump({"producer": f"scan {dpi} dpi", "ocr": True, "pages": [{"segments": segments}]}, open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(name, len(segments))

# a "searchable" scan, as phone scanner apps make them: the picture with invisible text over it
original = pymupdf.open(os.path.join(OUT, "html-gdocs.pdf"))
truth = json.load(open(os.path.join(OUT, "html-gdocs.json"), encoding="utf-8"))
page = original[0]
scan = pymupdf.open()
target = scan.new_page(width=page.rect.width, height=page.rect.height)
target.insert_image(target.rect, stream=page.get_pixmap(dpi=180).tobytes("jpg", jpg_quality=85))
segments = [s for s in truth["pages"][0]["segments"] if s.get("rect") and s["text"].isascii()]
for s in segments:
    x0, y0, x1, y1 = s["rect"]
    size = (y1 - y0) * 0.82
    width = pymupdf.get_text_length(s["text"], "helv", size) or 1
    base = pymupdf.Point(x0, y1 - (y1 - y0) * 0.22)
    target.insert_text(base, s["text"], fontsize=size, fontname="helv", render_mode=3, morph=(base, pymupdf.Matrix((x1 - x0) / width, 1)))
scan.save(os.path.join(OUT, "scan-searchable.pdf"), deflate=True)
json.dump({"producer": "searchable scan", "pages": [{"segments": [{"text": s["text"], "rect": s["rect"]} for s in segments]}]}, open(os.path.join(OUT, "scan-searchable.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("scan-searchable", len(segments))
