"""Realistic documents from PDF libraries (reportlab, PyMuPDF) and Microsoft Office, each with a JSON
file listing the pieces of text a reader sees as separate. Everything is made up.

  python tests/text/sweep/gen-py.py [outDir] [--no-office]
"""
import json
import os
import sys

sys.dont_write_bytecode = True
from gen_design import design_docs  # noqa: E402

OUT = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), ".tmp/boxes/pdfs"))
os.makedirs(OUT, exist_ok=True)
FONTS = "C:/Windows/Fonts/"


def save(name, producer, pages):
    """pages: list of lists of strings or dicts {text, flow, size, bold, italic}"""
    data = {"producer": producer, "pages": [{"segments": [s if isinstance(s, dict) else {"text": s} for s in p]} for p in pages]}
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(name, "+".join(str(len(p)) for p in pages))


def flow(text, **kw):
    return {"text": text, "flow": True, **kw}


# ---------------------------------------------------------------- reportlab
def reportlab_docs():
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    pdfmetrics.registerFont(TTFont("Calibri", FONTS + "calibri.ttf"))
    pdfmetrics.registerFont(TTFont("CalibriB", FONTS + "calibrib.ttf"))
    pdfmetrics.registerFont(TTFont("Georgia", FONTS + "georgia.ttf"))
    W, H = A4

    # canvas invoice with standard fonts
    c = canvas.Canvas(os.path.join(OUT, "rl-invoice.pdf"), pagesize=A4)
    seg = []

    def put(x, y, text, font="Helvetica", size=10, mode="l", color=colors.black, **kw):
        c.setFont(font, size)
        c.setFillColor(color)
        {"l": c.drawString, "r": c.drawRightString, "c": c.drawCentredString}[mode](x, y, text, **kw)
        seg.append(text)

    put(50, H - 60, "TAX INVOICE", "Helvetica-Bold", 22, color=colors.darkblue)
    put(W - 50, H - 55, "Original for Recipient", mode="r", size=8)
    put(50, H - 90, "Nimbus Traders", "Helvetica-Bold", 12)
    put(50, H - 105, "14 Market Street, Jaipur 302001")
    put(W - 50, H - 90, "Invoice # NT/26-27/0188", mode="r")
    put(W - 50, H - 105, "Dated: 12-Nov-2026", mode="r")
    cols = [50, 80, 300, 360, 450, 545]
    y = H - 150
    c.setFillColor(colors.lightgrey)
    c.rect(48, y - 5, W - 96, 18, fill=1, stroke=0)
    for x, t, m in zip(cols, ["Sr", "Particulars", "HSN", "Qty", "Rate", "Amount"], "lllrrr"):
        put(x if m == "l" else x + (0 if x == 545 else 30), y, t, "Helvetica-Bold", 9, m)
    items = ["Cotton bedsheet", "Pillow cover set", "Bath towel large", "Curtain fabric (m)", "Table runner", "Cushion", "Door mat", "Kitchen apron"]
    for i, name in enumerate(items):
        y -= 18
        for x, t, m in [(50, str(i + 1), "l"), (80, name, "l"), (300, str(6302 + i), "l"), (390, str((i * 3) % 11 + 1), "r"), (480, f"{199 + i * 55}.00", "r"), (545, f"{(199 + i * 55) * ((i * 3) % 11 + 1):,}.00", "r")]:
            put(x, y, t, size=9, mode=m)
        c.line(48, y - 5, W - 48, y - 5)
    put(450, y - 30, "Grand Total", "Helvetica-Bold", 11, "r")
    put(545, y - 30, "12,874.00", "Helvetica-Bold", 11, "r")
    put(50, y - 70, "Bank transfer only. Goods once sold will not be taken back.", "Helvetica-Oblique", 8)
    put(W - 50, 90, "For Nimbus Traders", mode="r")
    put(W - 50, 50, "Authorised Signatory", mode="r")
    put(W / 2, 25, "This is a computer generated invoice", mode="c", size=7, color=colors.grey)
    c.save()
    save("rl-invoice", "reportlab canvas", [seg])

    # canvas form with leaders, char spacing, rotation, boxes
    c = canvas.Canvas(os.path.join(OUT, "rl-form.pdf"), pagesize=A4)
    seg = []
    put(W / 2, H - 60, "ADMISSION FORM", "Times-Bold", 18, "c", charSpace=3)
    put(W / 2, H - 80, "Session 2027-28", "Times-Italic", 11, "c")
    y = H - 120
    for label in ["Name of Student", "Date of Birth", "Class Applied For", "Previous School", "Blood Group", "Mobile Number"]:
        put(60, y, label + " " + "." * 70, "Times-Roman", 11)
        y -= 26
    for label in ["Signature", "Place"]:
        put(60, y, label + ": " + "_" * 30, "Times-Roman", 11)
        put(340, y, "Date: " + "_" * 20, "Times-Roman", 11)
        y -= 26
    # one letter per box
    put(60, y - 10, "PAN", "Helvetica-Bold", 10)
    for i, ch in enumerate("ABCDE1234F"):
        c.rect(110 + i * 20, y - 15, 20, 18)
    t = c.beginText(116, y - 10)
    t.setFont("Courier", 11)
    t.setCharSpace(20 - 6.6)
    t.textOut("ABCDE1234F")
    t.setCharSpace(0)
    c.drawText(t)
    seg.append({"text": "ABCDE1234F"})
    y -= 60
    t = c.beginText(60, y)
    t.setFont("Times-Roman", 11)
    t.setLeading(15)
    for line in ["I certify that the information furnished above is correct and complete.", "I understand that admission may be cancelled if any detail is found false.", "I agree to follow the rules of the school as amended from time to time."]:
        t.textLine(line)
        seg.append(line)
    c.drawText(t)
    c.saveState()
    c.translate(40, 300)
    c.rotate(90)
    put(0, 0, "Do not write in this margin", "Helvetica", 9)
    c.restoreState()
    c.saveState()
    c.translate(300, 300)
    c.rotate(30)
    c.setFillAlpha(0.25)
    put(0, 0, "SPECIMEN", "Helvetica-Bold", 60, "c", colors.red)
    c.restoreState()
    put(60, 150, "Spaced reference code", "Courier-Bold", 12, charSpace=5)
    put(60, 120, "Fee: Rs. 25,000/- (Rupees twenty five thousand)", "Times-BoldItalic", 12)
    c.save()
    save("rl-form", "reportlab canvas", [seg])

    # platypus report: justified paragraphs, tables with tight cells
    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    body.alignment = 4
    body.fontName = "Calibri"
    body.fontSize = 11
    body.leading = 14
    head = styles["Heading1"]
    head.fontName = "CalibriB"
    paras = [
        "The committee reviewed the annual accounts and found them to be a fair reflection of the financial position of the society at the close of the year. Membership grew steadily and collections improved in every quarter.",
        "Expenditure on maintenance rose because the lifts in both towers were overhauled and the terrace was waterproofed before the monsoon. These are one time costs which are not expected to recur for several years.",
    ]
    data = [["Head", "Budget", "Actual", "Variance"], ["Security", "4,80,000", "4,92,500", "-12,500"], ["Housekeeping", "3,60,000", "3,41,200", "18,800"], ["Electricity", "2,40,000", "2,66,950", "-26,950"], ["Lift upkeep", "1,50,000", "3,02,000", "-1,52,000"], ["Total", "12,30,000", "14,02,650", "-1,72,650"]]
    table = Table(data, colWidths=[140, 80, 80, 80])
    table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("FONT", (0, 0), (-1, 0), "CalibriB", 10), ("FONT", (0, 1), (-1, -1), "Calibri", 10), ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("BACKGROUND", (0, 0), (-1, 0), colors.lightblue)]))
    tight = Table([[f"R{r}C{c_}" for c_ in range(12)] for r in range(14)], colWidths=[34] * 12)
    tight.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), "Helvetica", 7), ("GRID", (0, 0), (-1, -1), 0.25, colors.grey), ("LEFTPADDING", (0, 0), (-1, -1), 1), ("RIGHTPADDING", (0, 0), (-1, -1), 1)]))

    def decorate(cv, d):
        cv.setFont("Helvetica", 8)
        cv.drawString(50, H - 30, "Green Meadows Housing Society")
        cv.drawRightString(W - 50, H - 30, "Annual Report 2025-26")
        cv.drawCentredString(W / 2, 25, f"Page {d.page}")

    doc = SimpleDocTemplate(os.path.join(OUT, "rl-report.pdf"), pagesize=A4)
    doc.build([Paragraph("Annual Report", head)] + [Paragraph(p, body) for p in paras] + [Spacer(1, 14), table, Spacer(1, 20), tight], onFirstPage=decorate)
    save("rl-report", "reportlab platypus", [["Green Meadows Housing Society", "Annual Report 2025-26", "Annual Report", flow(paras[0]), flow(paras[1])] + [x for row in data for x in row] + [f"R{r}C{c_}" for r in range(14) for c_ in range(12)] + ["Page 1"]])

    # a certificate with centred lines on landscape
    c = canvas.Canvas(os.path.join(OUT, "rl-certificate.pdf"), pagesize=landscape(A4))
    W2, H2 = landscape(A4)
    seg = []
    c.setStrokeColor(colors.goldenrod)
    c.setLineWidth(4)
    c.rect(25, 25, W2 - 50, H2 - 50)
    for text, y, font, size, extra in [("CERTIFICATE OF PARTICIPATION", 470, "Times-Bold", 30, {"charSpace": 1.5}), ("Presented to", 420, "Times-Italic", 14, {}), ("Rohan Deshpande", 370, "Georgia", 40, {}), ("for taking part in the Inter College Robotics Meet", 320, "Times-Roman", 16, {}), ("held at Pune on 14 and 15 February 2026", 296, "Times-Roman", 16, {})]:
        put(W2 / 2, y, text, font, size, "c", **extra)
    put(150, 120, "Convenor", "Helvetica", 11, "c")
    put(W2 - 150, 120, "Principal", "Helvetica", 11, "c")
    c.save()
    save("rl-certificate", "reportlab canvas", [seg])


# ---------------------------------------------------------------- PyMuPDF
def pymupdf_docs():
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    seg = []

    def put(x, y, text, size=11, font="helv", **kw):
        page.insert_text((x, y), text, fontsize=size, fontname=font, **kw)
        seg.append(text)

    put(50, 60, "Salary Slip - October 2026", 18, "hebo")
    put(50, 85, "Employee: Kavya Nair")
    put(330, 85, "Employee ID: EMP0421")
    put(50, 102, "Department: Finance")
    put(330, 102, "Days paid: 31")
    y = 140
    for a, b, c_, d in [("Earnings", "Amount", "Deductions", "Amount"), ("Basic", "42,000", "Provident fund", "5,040"), ("House rent", "16,800", "Professional tax", "200"), ("Special", "9,200", "Income tax", "3,150"), ("Gross", "68,000", "Total", "8,390")]:
        bold = "hebo" if a in ("Earnings", "Gross") else "helv"
        for x, t in zip((55, 200, 305, 480), (a, b, c_, d)):
            put(x, y, t, 10, bold)
        for x in (50, 190, 300, 470, 545):
            page.draw_line((x, y - 13), (x, y + 6))
        page.draw_line((50, y + 6), (545, y + 6))
        y += 19
    put(50, y + 20, "Net pay: Rs 59,610", 14, "tibo", color=(0, 0.4, 0))
    put(50, y + 60, "Rotated stamp", 20, "heit", morph=(pymupdf.Point(50, y + 60), pymupdf.Matrix(1, 0, 0, 1, 0, 0).prerotate(-20)), color=(0.8, 0, 0))
    # an embedded TrueType font through TextWriter
    writer = pymupdf.TextWriter(page.rect)
    face = pymupdf.Font(fontfile=FONTS + "cambriab.ttf") if os.path.exists(FONTS + "cambriab.ttf") else pymupdf.Font("tibo")
    for i, t in enumerate(["Remarks from the manager", "Consistently delivered the monthly close two days early.", "Approved for the annual performance bonus."]):
        writer.append((50, 420 + i * 18), t, font=face, fontsize=12)
        seg.append(t)
    writer.write_text(page)
    page.insert_text((50, 500), "Tracked", fontsize=12)
    seg.append("Tracked")
    # one word at a time, as many generators do
    x = 50.0
    words = "Every single word on this line is drawn by its own operator".split()
    for w in words:
        page.insert_text((x, 530), w, fontsize=11, fontname="tiro")
        x += pymupdf.get_text_length(w + " ", "tiro", 11)
    seg.append(" ".join(words))
    # one letter at a time
    x = 50.0
    for ch in "Letter by letter placement":
        if ch != " ":
            page.insert_text((x, 555), ch, fontsize=12, fontname="helv")
        x += pymupdf.get_text_length(ch, "helv", 12)
    seg.append("Letter by letter placement")
    page.insert_textbox(pymupdf.Rect(50, 580, 545, 660), "This justified block was produced by a text box. It has several lines which should each be one editable box, with the words spread to both margins as a word processor would set them on paper.", fontsize=11, fontname="tiro", align=3)
    seg.append(flow("This justified block was produced by a text box. It has several lines which should each be one editable box, with the words spread to both margins as a word processor would set them on paper."))
    doc.save(os.path.join(OUT, "mu-payslip.pdf"), garbage=3, deflate=True)
    save("mu-payslip", "PyMuPDF insert_text", [seg])

    doc = pymupdf.open()
    page = doc.new_page()
    seg = []
    page.insert_htmlbox(pymupdf.Rect(40, 40, 555, 400), """<h2>Notice to residents</h2><p>Water supply will be <b>interrupted</b> on <i>Sunday</i> from 10 AM to 2 PM.</p>
<p style="font-family:sans-serif">पानी की आपूर्ति रविवार को सुबह 10 बजे से दोपहर 2 बजे तक बंद रहेगी।</p><p>Office: <span style="color:blue">+91 90000 11111</span></p><ul><li>Store enough water.</li><li>Close all taps.</li></ul>""")
    seg += ["Notice to residents", flow("Water supply will be interrupted on Sunday from 10 AM to 2 PM."), flow("पानी की आपूर्ति रविवार को सुबह 10 बजे से दोपहर 2 बजे तक बंद रहेगी।"), "Office: +91 90000 11111", "Store enough water.", "Close all taps."]
    shape = page.new_shape()
    shape.draw_rect(pymupdf.Rect(40, 450, 555, 560))
    shape.finish(fill=(0.1, 0.1, 0.35), color=None)
    shape.commit()
    page.insert_text((60, 490), "White heading on a dark panel", fontsize=22, fontname="hebo", color=(1, 1, 1))
    page.insert_text((60, 525), "Outlined words", fontsize=26, fontname="hebo", color=(1, 0.8, 0), render_mode=2, fill=(1, 1, 1))
    seg += ["White heading on a dark panel", "Outlined words"]
    page.insert_text((60, 600), "Page rotated text follows below", fontsize=12)
    seg.append("Page rotated text follows below")
    second = doc.new_page(width=842, height=595)
    second.insert_text((60, 60), "Landscape sheet on a rotated page", fontsize=16)
    second.insert_text((60, 90), "Second line of the sheet", fontsize=12)
    second.set_rotation(90)
    doc.subset_fonts()
    doc.save(os.path.join(OUT, "mu-notice.pdf"), garbage=3, deflate=True)
    save("mu-notice", "PyMuPDF htmlbox", [seg, ["Landscape sheet on a rotated page", "Second line of the sheet"]])


# ---------------------------------------------------------------- Microsoft Office
def office_docs():
    import win32com.client
    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.shared import Inches, Pt, RGBColor
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from pptx import Presentation
    from pptx.dml.color import RGBColor as PColor
    from pptx.util import Emu, Inches as PInches, Pt as PPt

    src = os.path.join(OUT, "..", "office")
    os.makedirs(src, exist_ok=True)
    src = os.path.abspath(src)

    def word_resume():
        d = Document()
        seg = []

        def p(text, style=None, align=None, size=None, bold=None, color=None, is_flow=False):
            para = d.add_paragraph(style=style)
            run = para.add_run(text)
            if size:
                run.font.size = Pt(size)
            if bold is not None:
                run.bold = bold
            if color:
                run.font.color.rgb = RGBColor.from_string(color)
            if align is not None:
                para.alignment = align
            seg.append(flow(text) if is_flow else text)
            return para

        d.sections[0].header.paragraphs[0].text = "Curriculum Vitae\t\tSneha Rao"
        seg.extend(["Curriculum Vitae", "Sneha Rao"])
        d.sections[0].footer.paragraphs[0].text = "References available on request"
        p("Sneha Rao", size=26, bold=True, color="1F3864", align=WD_ALIGN_PARAGRAPH.CENTER)
        p("Chartered Accountant | Hyderabad | sneha.rao@example.com", align=WD_ALIGN_PARAGRAPH.CENTER)
        d.add_heading("Profile", level=1)
        seg.append("Profile")
        p("Accountant with eight years of experience in audit and taxation for manufacturing and retail clients. Known for closing difficult audits on time and for explaining findings in plain language to owners who do not read balance sheets every day.", align=WD_ALIGN_PARAGRAPH.JUSTIFY, is_flow=True)
        d.add_heading("Experience", level=1)
        seg.append("Experience")
        para = d.add_paragraph()
        para.paragraph_format.tab_stops.add_tab_stop(Inches(6), 2)
        para.add_run("Audit Manager, Verma & Associates").bold = True
        para.add_run("\t2021 – Present")
        seg.extend(["Audit Manager, Verma & Associates", "2021 – Present"])
        for t in ["Led statutory audits for fourteen companies.", "Introduced a checklist that cut review notes by half.", "Trained six article assistants."]:
            p(t, style="List Bullet")
        d.add_heading("Qualifications", level=1)
        seg.append("Qualifications")
        t = d.add_table(rows=4, cols=3)
        t.style = "Light Grid Accent 1"
        for r, row in enumerate([("Examination", "Year", "Result"), ("CA Final", "2018", "First attempt"), ("B.Com (Hons)", "2015", "78.4%"), ("Class XII", "2012", "91%")]):
            for c_, v in enumerate(row):
                t.cell(r, c_).text = v
                seg.append(v)
        para = d.add_paragraph()
        for text, kw in [("Mixed: ", {}), ("bold", {"bold": True}), (", ", {}), ("italic", {"italic": True}), (", ", {}), ("underlined", {"underline": True}), (" and ", {}), ("large", {"size": 18}), (" text in one line.", {})]:
            run = para.add_run(text)
            for k, v in kw.items():
                if k == "size":
                    run.font.size = Pt(v)
                else:
                    setattr(run, k, v)
        seg.append("Mixed: bold, italic, underlined and large text in one line.")
        p("Declaration: I hereby declare that the above statements are true.")
        p("Place: ____________\t\t\t\tSignature: ____________")
        seg.pop()
        seg.extend(["Place: ____________", "Signature: ____________"])
        seg.append("References available on request")
        return d, [seg]

    def word_letter():
        d = Document()
        style = d.styles["Normal"]
        style.font.name = "Times New Roman"
        style.font.size = Pt(12)
        seg = []

        def p(text, align=None, is_flow=False, font=None):
            para = d.add_paragraph()
            run = para.add_run(text)
            if font:
                run.font.name = font
                rpr = run._element.get_or_add_rPr()
                fonts = rpr.get_or_add_rFonts()
                fonts.set("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}cs", font)
            if align is not None:
                para.alignment = align
            seg.append(flow(text) if is_flow else text)

        p("Ref. No. EDU/2026/114", WD_ALIGN_PARAGRAPH.LEFT)
        p("Date: 28 November 2026", WD_ALIGN_PARAGRAPH.RIGHT)
        p("OFFICE ORDER", WD_ALIGN_PARAGRAPH.CENTER)
        for t in [
            "In continuation of the order dated 4 October, it is hereby notified that the office will observe revised working hours from the first day of December until further orders are issued by the competent authority.",
            "All heads of sections are requested to bring the contents of this order to the notice of the staff working under them and to ensure that public counters remain open without a break during the revised hours.",
        ]:
            p(t, WD_ALIGN_PARAGRAPH.JUSTIFY, True)
        p("कार्यालय का समय सुबह साढ़े नौ बजे से शाम छह बजे तक रहेगा।", font="Mangal")
        p("This order issues with the approval of the Director.", is_flow=True)
        p("Sd/-", WD_ALIGN_PARAGRAPH.RIGHT)
        p("(R. K. Menon)", WD_ALIGN_PARAGRAPH.RIGHT)
        p("Deputy Secretary", WD_ALIGN_PARAGRAPH.RIGHT)
        p("Copy to:")
        for t in ["All section heads", "Accounts branch", "Notice board"]:
            d.add_paragraph(t, style="List Number")
            seg.append(t)
        d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        sec = d.add_paragraph("Annexure A")
        sec.alignment = WD_ALIGN_PARAGRAPH.CENTER
        seg2 = ["Annexure A"]
        t = d.add_table(rows=6, cols=5)
        t.style = "Table Grid"
        for r, row in enumerate([("Sl.", "Name", "Designation", "Shift", "Room")] + [(str(i), n, g, s, r_) for i, (n, g, s, r_) in enumerate([("A. Khan", "Assistant", "Morning", "12"), ("B. Das", "Clerk", "Evening", "14"), ("C. Pillai", "Officer", "Morning", "3"), ("D. Roy", "Clerk", "Morning", "14"), ("E. Gill", "Peon", "Evening", "1")], 1)]):
            for c_, v in enumerate(row):
                t.cell(r, c_).text = v
                seg2.append(v)
        return d, [seg, seg2]

    word = win32com.client.DispatchEx("Word.Application")
    word.Visible = False
    word.DisplayAlerts = 0
    try:
        for name, make in [("word-resume", word_resume), ("word-letter", word_letter)]:
            d, pages = make()
            docx = os.path.join(src, name + ".docx")
            d.save(docx)
            w = word.Documents.Open(docx, ReadOnly=True)
            w.ExportAsFixedFormat(os.path.join(OUT, name + ".pdf"), 17)
            w.Close(False)
            save(name, "Microsoft Word", pages)
    finally:
        word.Quit()

    # slides
    prs = Presentation()
    prs.slide_width, prs.slide_height = PInches(13.333), PInches(7.5)
    blank = prs.slide_layouts[6]
    pages = []
    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = "Customer Research Findings"
    s.placeholders[1].text = "What we heard from forty interviews"
    pages.append(["Customer Research Findings", "What we heard from forty interviews"])
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "Three themes"
    s.placeholders[1].text = "Setup takes too long\nPricing is hard to understand\nPeople want it on their phones"
    pages.append(["Three themes", "Setup takes too long", "Pricing is hard to understand", "People want it on their phones"])
    s = prs.slides.add_slide(blank)
    seg = []
    for x, y, text, size, bold, color in [(1, 0.6, "Key numbers", 40, True, "1F4E79"), (1, 2, "72%", 66, True, "C00000"), (5.5, 2, "4.1", 66, True, "2E7D32"), (10, 2, "18 min", 54, True, "6A1B9A"), (1, 3.6, "finish setup", 18, False, "333333"), (5.5, 3.6, "average rating", 18, False, "333333"), (10, 3.6, "to first value", 18, False, "333333")]:
        box = s.shapes.add_textbox(PInches(x), PInches(y), PInches(3), PInches(1))
        run = box.text_frame.paragraphs[0].add_run()
        run.text = text
        run.font.size = PPt(size)
        run.font.bold = bold
        run.font.color.rgb = PColor.from_string(color)
        seg.append(text)
    box = s.shapes.add_textbox(PInches(1), PInches(5), PInches(8), PInches(1))
    run = box.text_frame.paragraphs[0].add_run()
    run.text = "S P A C E D   F O O T N O T E"
    run.font.size = PPt(14)
    seg.append(run.text)
    table = s.shapes.add_table(2, 4, PInches(1), PInches(5.8), PInches(11), PInches(0.8)).table
    for r, row in enumerate([("Plan", "Free", "Team", "Business"), ("Users", "1", "10", "100")]):
        for c_, v in enumerate(row):
            table.cell(r, c_).text = v
            seg.append(v)
    rot = s.shapes.add_textbox(PInches(11), PInches(0.8), PInches(2), PInches(0.6))
    rot.text_frame.text = "Draft"
    rot.rotation = 20
    # PowerPoint paints a turned text box as shapes, so there is no text to find
    pages.append(seg)
    pptx = os.path.join(src, "ppt-deck.pptx")
    prs.save(pptx)
    ppt = win32com.client.DispatchEx("PowerPoint.Application")
    try:
        pres = ppt.Presentations.Open(pptx, True, False, False)
        pres.SaveAs(os.path.join(OUT, "ppt-deck.pdf"), 32)
        pres.Close()
        save("ppt-deck", "Microsoft PowerPoint", pages)
    finally:
        ppt.Quit()

    # spreadsheet statement
    wb = Workbook()
    ws = wb.active
    ws.title = "Statement"
    seg = []
    for col, w in zip("ABCDEF", [12, 34, 12, 12, 12, 14]):
        ws.column_dimensions[col].width = w
    ws["A1"] = "Ledger Statement - Sharma General Stores"
    ws["A1"].font = Font(bold=True, size=14)
    ws.merge_cells("A1:F1")
    ws["A1"].alignment = Alignment(horizontal="center")
    seg.append(ws["A1"].value)
    thin = Side(style="thin")
    rows = [("Date", "Particulars", "Voucher", "Debit", "Credit", "Balance")]
    for i in range(32):
        rows.append((f"{i % 28 + 1:02d}-11-2026", ["Cash sales", "Purchase from supplier", "Electricity charges", "Shop rent", "Bank deposit"][i % 5], f"V-{500 + i}", f"{i * 137 + 250:,}.00" if i % 2 else "-", "-" if i % 2 else f"{i * 91 + 1200:,}.00", f"{52000 + i * 411:,}.00 Dr"))
    for r, row in enumerate(rows, 3):
        for c_, v in enumerate(row, 1):
            cell = ws.cell(r, c_, v)
            cell.border = Border(top=thin, bottom=thin, left=thin, right=thin)
            if r == 3:
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = PatternFill("solid", fgColor="305496")
            if c_ > 3:
                cell.alignment = Alignment(horizontal="right")
            seg.append(v)
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.oddFooter.center.text = "Page &P of &N"
    seg.append("Page 1 of 1")
    xlsx = os.path.join(src, "excel-ledger.xlsx")
    wb.save(xlsx)
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    try:
        book = excel.Workbooks.Open(xlsx, ReadOnly=True)
        book.ExportAsFixedFormat(0, os.path.join(OUT, "excel-ledger.pdf"))
        book.Close(False)
        save("excel-ledger", "Microsoft Excel", [seg])
    finally:
        excel.Quit()


reportlab_docs()
pymupdf_docs()
design_docs(OUT, save)
if "--no-office" not in sys.argv:
    office_docs()
