# PDFEdit

Edit the existing text of a PDF, in any language, in your browser. Free, no login, and your file never leaves
your device.

Live: https://pdfedit.lakshpradhwani.com

## What it does

- Tap existing text and change it. Unchanged characters keep their original glyphs; new ones use the
  document's own font when it has them, otherwise the closest open font (you can upload the real one).
- Complex scripts are shaped properly (Indic, Arabic, Hebrew, Thai, CJK and more).
- Scanned pages and broken-font PDFs are read with OCR that runs in the browser (about 120 languages).
- Add text, images, signatures, shapes, highlights, ink and whiteout; move or replace existing images.
- True redaction, form filling, find and replace, watermarks and page numbers.
- Reorder, rotate, delete, duplicate, split, merge and extract pages.
- Edit the text inside pictures (photos, screenshots, posters) in a matching font; exports carry a plain
  "Edited with PDFEdit" note and no source metadata.
- Export with compression, flattening or an AES-256 password, or as images and plain text.
- Works on phones, installs as an app and works offline after the first visit.

## Limits

- No paragraph reflow: editing works line by line.
- A substitute font can look slightly different from the original.
- Replaced text on a scan is covered, not erased; use Redact to remove content for good.
- OCR accuracy depends on scan quality and script.
- Editing a digitally signed PDF invalidates its signature, and the app says so.
- XFA forms only show fully in Adobe's software.

## Develop

```bash
npm install
npm run dev        # http://localhost:5180
npm run typecheck
npm test
npm run e2e        # Playwright, desktop and phone
npm run deploy     # Cloudflare Pages
```

The design of the code is described in [docs/MODULES.md](docs/MODULES.md).

## Built with

[MuPDF.js](https://mupdf.com) (AGPL), [HarfBuzz](https://harfbuzz.github.io),
[tesseract.js](https://github.com/naptha/tesseract.js), React and Vite. Fallback fonts are open-licensed fonts
loaded on demand from jsDelivr.

## Licence

AGPL-3.0-or-later.
