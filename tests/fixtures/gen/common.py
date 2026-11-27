"""Shared helpers: output folder and manifest entries."""

import unicodedata
from pathlib import Path

import pymupdf

FIXTURES = Path(__file__).resolve().parents[1]
OUT = FIXTURES / "pdfs"

documents: list[dict] = []


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def rect(values) -> list[float]:
    return [round(float(v), 2) for v in values]


def line(text: str, box, **info) -> dict:
    """One expected visual line. `box` is in page space (displayed page, top-left origin, points)."""
    entry = {"text": nfc(text), "rect": rect(box)}
    entry.update({k: v for k, v in info.items() if v is not None})
    return entry


def register(
    doc_id: str,
    pages: list[dict],
    *,
    producer: str,
    language: str,
    script: str,
    tags: list[str],
    edits: list[dict] | None = None,
    password: str | None = None,
    **extra,
) -> None:
    """pages: [{kind, lines, ...}]. Sizes and rotation are read back from the written file."""
    path = OUT / f"{doc_id}.pdf"
    pdf = pymupdf.open(path)
    if pdf.needs_pass:
        pdf.authenticate(password or "")
    if pdf.page_count != len(pages):
        raise RuntimeError(f"{doc_id}: expected {len(pages)} pages, file has {pdf.page_count}")
    for index, page in enumerate(pages):
        actual = pdf[index]
        page.setdefault("lines", [])
        page["index"] = index
        page["width"] = round(actual.rect.width, 2)
        page["height"] = round(actual.rect.height, 2)
        page["rotate"] = actual.rotation
    pdf.close()
    entry = {
        "id": doc_id,
        "file": f"{doc_id}.pdf",
        "producer": producer,
        "language": language,
        "script": script,
        "tags": tags,
        "password": password,
        "pageCount": len(pages),
        "pages": pages,
        "edits": edits or [],
    }
    entry.update(extra)
    documents.append(entry)
