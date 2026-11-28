"""Layered and letter-by-letter design pages, forms filled by typing over blanks, reused forms."""
import os


def design_docs(OUT, save):
    import pymupdf
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    doc = pymupdf.open()
    page = doc.new_page(width=540, height=720)
    seg = []
    page.draw_rect(page.rect, fill=(0.98, 0.93, 0.86), color=None)
    # a title painted three times: two shadows further off, then the face
    for dx, dy, colour in [(9, 9, (0.2, 0.2, 0.2)), (4.5, 4.5, (0.9, 0.5, 0.2)), (0, 0, (0.1, 0.1, 0.4))]:
        page.insert_text((60 + dx, 90 + dy), "HARVEST FAIR", fontsize=48, fontname="hebo", color=colour)
    seg.append("HARVEST FAIR")
    # an outline painted separately from the fill
    page.insert_text((60, 150), "Open Air Market", fontsize=32, fontname="tibo", render_mode=1, color=(0, 0, 0), border_width=0.12)
    page.insert_text((60, 150), "Open Air Market", fontsize=32, fontname="tibo", color=(1, 0.75, 0))
    seg.append("Open Air Market")
    # every letter on its own, widely tracked
    x = 60.0
    for ch in "ADMIT ONE PERSON":
        if ch != " ":
            page.insert_text((x, 200), ch, fontsize=18, fontname="hebo", color=(0.5, 0, 0))
        x += pymupdf.get_text_length(ch, "hebo", 18) + 8
    seg.append("ADMIT ONE PERSON")
    # letters on a slight wave
    x = 60.0
    for i, ch in enumerate("Wavy greeting"):
        if ch != " ":
            page.insert_text((x, 250 + (1.0 if i % 2 else -1.0)), ch, fontsize=22, fontname="tiit")
        x += pymupdf.get_text_length(ch, "tiit", 22)
    seg.append("Wavy greeting")
    page.insert_text((60, 300), "Overlapping watermark", fontsize=40, fontname="hebo", color=(0.8, 0.8, 0.8))
    page.insert_text((70, 292), "Readable line across it", fontsize=14, fontname="helv")
    seg += ["Overlapping watermark", "Readable line across it"]
    # filled form: the answer typed over the blank
    page.insert_text((60, 360), "Name: ______________________", fontsize=13, fontname="helv")
    page.insert_text((108, 358), "RAHUL VERMA", fontsize=13, fontname="cobo", color=(0, 0, 0.7))
    page.insert_text((60, 390), "Roll No ....................................", fontsize=13, fontname="helv")
    page.insert_text((140, 388), "2026-117", fontsize=13, fontname="cour", color=(0, 0, 0.7))
    seg += ["Name: ______________________", "RAHUL VERMA", "Roll No ....................................", "2026-117"]
    # comb fields
    page.insert_text((60, 440), "PIN", fontsize=12, fontname="hebo")
    for i, ch in enumerate("411045"):
        page.draw_rect(pymupdf.Rect(100 + i * 22, 424, 122 + i * 22, 446), color=(0, 0, 0))
        page.insert_text((107 + i * 22, 440), ch, fontsize=13, fontname="helv")
    seg += ["PIN", {"text": "411045", "cells": True}]
    # price list with right aligned amounts drawn separately
    for i, (item, price) in enumerate([("Jaggery (1 kg)", "120"), ("Cold pressed oil", "460"), ("Forest honey", "1,050")]):
        page.insert_text((60, 490 + i * 24), item, fontsize=14, fontname="helv")
        page.insert_text((480 - pymupdf.get_text_length(price, "hebo", 14), 490 + i * 24), price, fontsize=14, fontname="hebo")
        seg += [item, price]
    page.insert_text((60, 600), "Justified   with   very   wide   gaps", fontsize=11, fontname="helv")
    seg.append("Justified with very wide gaps")
    page.insert_text((500, 690), "Side caption", fontsize=11, fontname="helv", rotate=90)
    seg.append("Side caption")
    # pages built from another page placed as a form (twice), plus their own text
    other = pymupdf.open()
    sheet = other.new_page(width=300, height=200)
    sheet.insert_text((20, 40), "Stamp from a template", fontsize=16, fontname="hebo")
    sheet.insert_text((20, 70), "Reference TPL-9", fontsize=11, fontname="cour")
    second = doc.new_page(width=540, height=720)
    second.show_pdf_page(pymupdf.Rect(40, 40, 340, 240), other, 0)
    second.show_pdf_page(pymupdf.Rect(40, 300, 490, 600), other, 0)
    second.insert_text((40, 660), "Page two own text", fontsize=12)
    third = doc.new_page(width=600, height=400)
    third.insert_text((50, 80), "Cropped page heading", fontsize=18)
    third.insert_text((50, 120), "Body text inside the crop box", fontsize=11)
    third.set_cropbox(pymupdf.Rect(30, 30, 570, 370))
    third.set_rotation(270)
    doc.save(os.path.join(OUT, "mu-design.pdf"), garbage=3, deflate=True)
    save(
        "mu-design",
        "PyMuPDF design",
        [seg, ["Stamp from a template", "Reference TPL-9", "Stamp from a template", "Reference TPL-9", "Page two own text"], ["Cropped page heading", "Body text inside the crop box"]],
    )

    c = canvas.Canvas(os.path.join(OUT, "rl-ledger.pdf"), pagesize=A4)
    W, H = A4
    seg = []
    c.beginForm("head")
    c.setFont("Helvetica-Bold", 13)
    c.drawString(50, H - 50, "Common letterhead")
    c.endForm()
    c.doForm("head")
    seg.append("Common letterhead")
    c.setFont("Courier", 9)
    y = H - 90
    # fixed width report: columns made with runs of spaces
    for row in [
        "DATE        PARTICULARS              DEBIT       CREDIT",
        "01-11-2026  OPENING BALANCE                      42,500.00",
        "03-11-2026  CHEQUE 004512           5,000.00",
        "09-11-2026  NEFT FROM CUSTOMER                   18,250.00",
    ]:
        c.drawString(50, y, row)
        seg.append({"text": " ".join(row.split()), "flow": True})
        y -= 14
    c.setFont("Helvetica", 11)
    for i, (a, b) in enumerate([("Introduction", "1"), ("Method and sources", "6"), ("Results", "14")]):
        c.drawString(50, 600 - i * 20, a)
        x = 52 + c.stringWidth(a, "Helvetica", 11)
        while x < 480:
            c.drawString(x, 600 - i * 20, ".")
            x += 6
        c.drawRightString(500, 600 - i * 20, b)
        seg += [a, b]
    # word by word with wide justification
    x = 50
    for w in "words set one at a time and spread wide across".split():
        c.drawString(x, 500, w)
        x += c.stringWidth(w, "Helvetica", 11) + 11
    seg.append("words set one at a time and spread wide across")
    c.setFont("Times-Roman", 12)
    c.drawString(50, 460, "H")
    c.setFont("Times-Roman", 8)
    c.drawString(58.7, 458, "2")
    c.setFont("Times-Roman", 12)
    c.drawString(63, 460, "O and 10")
    c.setFont("Times-Roman", 8)
    c.drawString(63 + c.stringWidth("O and 10", "Times-Roman", 12), 465, "6")
    seg.append("H2O and 106")
    c.setFont("Helvetica-Bold", 30)
    c.drawString(50, 400, "DROP")
    c.setFont("Helvetica", 12)
    c.drawString(150, 412, "cap style aside")
    c.drawString(150, 398, "second aside line")
    seg += ["DROP", "cap style aside", "second aside line"]
    c.save()
    save("rl-ledger", "reportlab canvas", [seg])
