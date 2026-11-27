"""A very small PDF writer, for the cases where the corpus needs exact control over the file structure."""

import zlib


class Pdf:
    def __init__(self):
        self.objects: list[bytes | None] = []

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def add(self, body: str, number: int | None = None) -> int:
        number = number or self.reserve()
        self.objects[number - 1] = body.encode("latin-1")
        return number

    def stream(self, data: bytes | str, entries: str = "", number: int | None = None, compress: bool = True) -> int:
        if isinstance(data, str):
            data = data.encode("latin-1")
        raw_length = len(data)
        if compress:
            data = zlib.compress(data, 9)
            entries += " /Filter /FlateDecode"
        entries = entries.replace("{length1}", str(raw_length))
        number = number or self.reserve()
        head = f"<< /Length {len(data)} {entries} >>\nstream\n".encode("latin-1")
        self.objects[number - 1] = head + data + b"\nendstream"
        return number

    def build(self, root: int, info: int | None = None) -> bytes:
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for index, body in enumerate(self.objects, start=1):
            if body is None:
                raise RuntimeError(f"object {index} was reserved but never written")
            offsets.append(len(out))
            out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(self.objects) + 1}\n0000000000 65535 f \n".encode()
        for offset in offsets:
            out += f"{offset:010d} 00000 n \n".encode()
        extra = f" /Info {info} 0 R" if info else ""
        out += f"trailer\n<< /Size {len(self.objects) + 1} /Root {root} 0 R{extra} >>\nstartxref\n{xref}\n%%EOF\n".encode()
        return bytes(out)


def pdf_string(text: str) -> str:
    """A literal string in WinAnsi."""
    data = text.encode("cp1252").decode("latin-1")
    return "(" + data.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def to_unicode_cmap(pairs: list[tuple[int, str]], code_bytes: int) -> str:
    width = code_bytes * 2
    body = []
    for start in range(0, len(pairs), 100):
        chunk = pairs[start : start + 100]
        body.append(f"{len(chunk)} beginbfchar")
        for code, text in chunk:
            body.append(f"<{code:0{width}X}> <{text.encode('utf-16-be').hex().upper()}>")
        body.append("endbfchar")
    low, high = "0" * width, "F" * width
    return "\n".join(
        [
            "/CIDInit /ProcSet findresource begin",
            "12 dict begin",
            "begincmap",
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
            "/CMapName /Adobe-Identity-UCS def",
            "/CMapType 2 def",
            "1 begincodespacerange",
            f"<{low}> <{high}>",
            "endcodespacerange",
            *body,
            "endcmap",
            "CMapName currentdict /CMap defineresource pop",
            "end",
            "end",
        ]
    )


def simple_document(pages: list[dict], resources: str, pdf: Pdf, catalog_extra: str = "") -> bytes:
    """pages: [{content, media?, extra?, contents_ref?}], resources: dictionary shared by (inherited from) /Pages."""
    pages_ref = pdf.reserve()
    kids = []
    for page in pages:
        contents = page.get("contents_ref") or pdf.stream(page["content"])
        media = page.get("media", "[0 0 420 595]")
        extra = page.get("extra", "")
        kids.append(pdf.add(f"<< /Type /Page /Parent {pages_ref} 0 R /MediaBox {media} /Contents {contents} 0 R {extra} >>"))
    pdf.add(
        f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} /Resources {resources} >>",
        pages_ref,
    )
    root = pdf.add(f"<< /Type /Catalog /Pages {pages_ref} 0 R {catalog_extra} >>")
    return pdf.build(root)
