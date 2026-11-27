"""Documents printed by headless Chromium (Skia PDF backend): real browser shaping for every script."""

import base64
import html

from playwright.sync_api import sync_playwright

import fonts
from common import OUT, line, register
from content import LANGUAGES, MIXED_LINES

PX = 0.75  # CSS pixel -> PDF point
PAGE_W, PAGE_H = 560, 794

SCRIPT_FONT = {
    "Latin": "Latin", "Greek": "Latin", "Cyrillic": "Latin", "Devanagari": "Devanagari", "Bengali": "Bengali",
    "Tamil": "Tamil", "Telugu": "Telugu", "Gujarati": "Gujarati", "Gurmukhi": "Gurmukhi", "Kannada": "Kannada",
    "Malayalam": "Malayalam", "Oriya": "Oriya", "Arabic": "Arabic", "Hebrew": "Hebrew", "Thai": "Thai",
    "Han": "CJK", "Japanese": "CJK", "Hangul": "CJK",
}
LANG_TAG = {"zh": "zh-CN"}

# per line: (size px, bold, colour)
STYLES = [
    (24, True, "#17171a"),
    (17, False, "#17171a"),
    (17, False, "#1f4e9c"),
    (15, False, "#17171a"),
    (17, False, "#17171a"),
    (16, False, "#8b1e1e"),
    (19, False, "#17171a"),
    (17, False, "#1d6b45"),
]

COLLECT = """
() => {
  const K = 0.75;
  const pages = [...document.querySelectorAll('.pg')];
  return pages.map((pg) => {
    const o = pg.getBoundingClientRect();
    const box = (l, t, r, b) => [(l - o.left) * K, (t - o.top) * K, (r - o.left) * K, (b - o.top) * K];
    const out = [];
    for (const el of pg.querySelectorAll('[data-line]')) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const b = range.getBoundingClientRect();
      const s = getComputedStyle(el);
      out.push({ order: +el.dataset.line, text: el.textContent, rect: box(b.left, b.top, b.right, b.bottom),
        size: parseFloat(s.fontSize) * K, bold: +s.fontWeight >= 600, color: s.color,
        dir: s.direction, tag: el.dataset.tag || null, width: b.width, over: b.right > o.right + 1 || b.left < o.left - 1 });
    }
    // wrapped paragraphs: split into visual lines by asking where each word landed
    for (const el of pg.querySelectorAll('[data-para]')) {
      const node = el.firstChild;
      const text = node.textContent;
      const s = getComputedStyle(el);
      const lines = [];
      for (const m of text.matchAll(/\\S+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const b = range.getBoundingClientRect();
        let current = lines[lines.length - 1];
        if (!current || Math.abs(current.top - b.top) > b.height / 2) {
          current = { top: b.top, words: [], l: b.left, t: b.top, r: b.right, b: b.bottom };
          lines.push(current);
        }
        current.words.push(m[0]);
        current.l = Math.min(current.l, b.left); current.r = Math.max(current.r, b.right);
        current.t = Math.min(current.t, b.top); current.b = Math.max(current.b, b.bottom);
      }
      lines.forEach((l, i) => out.push({ order: +el.dataset.para * 100 + i, text: l.words.join(' '),
        rect: box(l.l, l.t, l.r, l.b), size: parseFloat(s.fontSize) * K, bold: false, color: s.color,
        dir: s.direction, tag: 'paragraph', align: i === lines.length - 1 ? null : 'justify', over: false }));
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  });
}
"""


def _rgb(css: str) -> list[float]:
    parts = css[css.index("(") + 1 : css.index(")")].split(",")[:3]
    return [round(int(p) / 255, 3) for p in parts]


def _face(key: str, cff: bool) -> str:
    path = fonts.cff_path(key) if cff else fonts.ttf_path(key)
    kind = "opentype" if cff else "truetype"
    data = base64.b64encode(path.read_bytes()).decode()
    return f"@font-face{{font-family:'{key}';src:url(data:font/{path.suffix[1:]};base64,{data}) format('{kind}');}}"


def _stack(primary: str, others: list[str]) -> str:
    names = [primary] + [o for o in others if o != primary]
    return ",".join(f"'{n}'" for n in names)


def _document(body: str, faces: list[str], cff: bool = False) -> str:
    css = "".join(_face(k, cff) for k in faces)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{css}
@page{{size:{PAGE_W}px {PAGE_H}px;margin:0}}
html,body{{margin:0;padding:0;background:#fff}}
.pg{{position:relative;width:{PAGE_W}px;height:{PAGE_H - 1}px;overflow:hidden;break-after:page}}
.l{{position:absolute;white-space:pre;line-height:1.5;font-synthesis:weight style;font-kerning:normal}}
.p{{position:absolute;line-height:1.7;text-align:justify}}
table{{position:absolute;border-collapse:collapse;table-layout:fixed}}
td{{border:1px solid #888;padding:8px 10px;font-size:14px;line-height:1.5;white-space:pre;overflow:hidden}}
</style></head><body>{body}</body></html>"""


def _span(order: int, text: str, top: int, size: int, bold: bool, color: str, family: str, direction: str,
          lang: str, side: str | None = None, tag: str | None = None, extra: str = "") -> str:
    side = side or ("right:36px" if direction == "rtl" else "left:36px")
    weight = 700 if bold else 400
    tag_attr = f' data-tag="{tag}"' if tag else ""
    return (f'<div class="l" data-line="{order}"{tag_attr} lang="{lang}" dir="{direction}" style="top:{top}px;{side};'
            f'font-size:{size}px;font-weight:{weight};color:{color};font-family:{family};{extra}">{html.escape(text)}</div>')


class Printer:
    def __init__(self):
        self._pw = sync_playwright().start()
        self.browser = self._pw.chromium.launch()
        self.page = self.browser.new_page(viewport={"width": PAGE_W, "height": PAGE_H})
        self.page.emulate_media(media="print")

    def close(self):
        self.browser.close()
        self._pw.stop()

    def print(self, doc_id: str, markup: str):
        self.page.set_content(markup, wait_until="load")
        self.page.evaluate("async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; }")
        info = self.page.evaluate(COLLECT)
        self.page.pdf(path=str(OUT / f"{doc_id}.pdf"), width=f"{PAGE_W}px", height=f"{PAGE_H}px", print_background=True,
                      margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
        for page in info:
            for item in page:
                if item.get("over"):
                    raise RuntimeError(f"{doc_id}: line does not fit on the page: {item['text']}")
        return info


def _lines(info_page, lang: str, script: str, overrides: dict | None = None) -> list[dict]:
    out = []
    for item in info_page:
        tags = [item["tag"]] if item.get("tag") else None
        out.append(line(item["text"], item["rect"], lang=lang, script=script, dir=item["dir"],
                        size=round(item["size"], 2), bold=item["bold"], color=_rgb(item["color"]),
                        tags=tags, align=item.get("align")))
    return out


def language_documents(printer: Printer):
    for block in LANGUAGES:
        lang, script, direction = block["id"], block["script"], block["dir"]
        key = SCRIPT_FONT[script]
        family = _stack(key, ["Latin"])
        texts = block["lines"] + block.get("extra", [])
        body = ['<div class="pg">']
        for i, text in enumerate(texts):
            size, bold, color = STYLES[i % len(STYLES)]
            tag = "bidi" if i >= 7 else None
            body.append(_span(i, text, 48 + i * 52, size, bold, color, family, direction, LANG_TAG.get(lang, lang), tag=tag))
        body.append("</div>")
        faces = sorted({key, "Latin"})
        variants = [("chromium", False)]
        if lang in ("hi", "bn", "ar"):
            variants.append(("type3", True))  # CFF source fonts: Skia writes them as Type 3
        for suffix, cff in variants:
            doc_id = f"{lang}-{suffix}"
            info = printer.print(doc_id, _document("".join(body), faces, cff))
            register(
                doc_id, [{"kind": "text", "lines": _lines(info[0], lang, script)}],
                producer="chromium" if not cff else "chromium-cff",
                language=block["language"], script=script,
                tags=["text", "chromium"] + (["rtl"] if direction == "rtl" else []) + (["cff"] if cff else []),
                edits=[{"page": 0, "line": 6, "newText": block["edit"]}],
            )


def mixed_documents(printer: Printer):
    faces = ["Latin", "Devanagari", "Bengali", "Arabic", "Hebrew", "CJK", "Thai"]
    family = ",".join(f"'{f}'" for f in faces)
    body = ['<div class="pg">']
    for i, text in enumerate(MIXED_LINES):
        body.append(_span(i, text, 50 + i * 54, 17, False, "#17171a", family, "ltr", "en"))
    body.append("</div>")
    info = printer.print("mixed-chromium", _document("".join(body), faces))
    register("mixed-chromium", [{"kind": "text", "lines": _lines(info[0], "mul", "Mixed")}], producer="chromium",
             language="Mixed", script="Mixed", tags=["text", "chromium", "mixed"],
             edits=[{"page": 0, "line": 1, "newText": "Room 48 है on the third floor."}])

    # table with three languages, plus two free columns that share baselines
    family = "'Latin','Devanagari','Arabic'"
    rows = [
        ["Item", "विवरण", "السعر"],
        ["Notebook", "कॉपी", "40 درهما"],
        ["Blue pen", "नीली कलम", "12 درهما"],
        ["Ruler", "पटरी", "8 دراهم"],
    ]
    body = ['<div class="pg">', '<table style="left:36px;top:40px;width:486px">']
    order = 0
    for r, row in enumerate(rows):
        body.append("<tr>")
        for c, cell in enumerate(row):
            direction = "rtl" if c == 2 else "ltr"
            weight = 700 if r == 0 else 400
            body.append(f'<td dir="{direction}" style="width:140px;font-family:{family};font-weight:{weight}">'
                        f'<span data-line="{order}" data-tag="cell" dir="{direction}">{html.escape(cell)}</span></td>')
            order += 1
        body.append("</tr>")
    body.append("</table>")
    left = ["The left column talks about", "rain that arrived early and", "filled the village pond to", "the brim within two days."]
    right = ["The right column lists the", "seeds that were handed out", "to every household before", "the planting week began."]
    for i, (a, b) in enumerate(zip(left, right)):
        body.append(_span(100 + i * 2, a, 330 + i * 26, 15, False, "#17171a", "'Latin'", "ltr", "en", side="left:36px", tag="column"))
        body.append(_span(101 + i * 2, b, 330 + i * 26, 15, False, "#17171a", "'Latin'", "ltr", "en", side="left:300px", tag="column"))
    body.append("</div>")
    info = printer.print("table-chromium", _document("".join(body), ["Latin", "Devanagari", "Arabic"]))
    register("table-chromium", [{"kind": "text", "lines": _lines(info[0], "mul", "Mixed")}], producer="chromium",
             language="Table (mixed)", script="Mixed", tags=["text", "chromium", "table", "columns"],
             edits=[{"page": 0, "line": 3, "newText": "Notepad"}])

    paragraphs = [
        ("en", "ltr", "'Latin'", "The reading room stays open late during the examination month so that "
         "students who travel from the nearby villages can finish their work, borrow a second book and still "
         "catch the last bus home without any hurry at all."),
        ("hi", "ltr", "'Devanagari','Latin'", "परीक्षा के महीने में पढ़ने का कमरा देर तक खुला रहता है ताकि आसपास के "
         "गाँवों से आने वाले विद्यार्थी अपना काम पूरा कर सकें, दूसरी किताब ले सकें और आराम से घर जाने वाली आख़िरी बस पकड़ सकें।"),
        ("ar", "rtl", "'Arabic','Latin'", "تبقى قاعة القراءة مفتوحة حتى وقت متأخر خلال شهر الامتحانات حتى يتمكن "
         "الطلاب القادمون من القرى المجاورة من إنهاء أعمالهم واستعارة كتاب ثان واللحاق بالحافلة الأخيرة دون استعجال."),
    ]
    body = ['<div class="pg">']
    for i, (lang, direction, family, text) in enumerate(paragraphs):
        body.append(f'<div class="p" data-para="{i + 1}" lang="{lang}" dir="{direction}" style="left:50px;width:460px;'
                    f'top:{40 + i * 220}px;font-size:16px;font-family:{family}">{html.escape(text)}</div>')
    body.append("</div>")
    info = printer.print("justified-chromium", _document("".join(body), ["Latin", "Devanagari", "Arabic"]))
    lines = _lines(info[0], "mul", "Mixed")
    register("justified-chromium", [{"kind": "text", "lines": lines}], producer="chromium", language="Justified (mixed)",
             script="Mixed", tags=["text", "chromium", "justified"],
             edits=[{"page": 0, "line": 1, "replace": ["students", "pupils"]}] if "students" in lines[1]["text"] else
                   [{"page": 0, "line": 0, "replace": ["reading", "study"]}])

    # vertical Japanese (Identity glyphs placed top to bottom)
    columns = ["図書館は毎朝九時に開きます。", "土曜日にお話会があります。", "館内ではお静かに願います。"]
    body = ['<div class="pg">']
    for i, text in enumerate(columns):
        body.append(f'<div class="l" data-line="{i}" data-tag="vertical" lang="ja" style="top:60px;left:{420 - i * 70}px;'
                    f'font-size:20px;font-family:\'CJK\';writing-mode:vertical-rl;color:#17171a">{html.escape(text)}</div>')
    body.append("</div>")
    info = printer.print("ja-vertical-chromium", _document("".join(body), ["CJK"]))
    register("ja-vertical-chromium", [{"kind": "text", "lines": _lines(info[0], "ja", "Japanese")}], producer="chromium",
             language="Japanese vertical", script="Japanese", tags=["text", "chromium", "vertical"])


def build():
    printer = Printer()
    try:
        language_documents(printer)
        mixed_documents(printer)
    finally:
        printer.close()
