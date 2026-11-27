# PDFEdit

Edit the existing text of any PDF, in any language, in your browser. Free, no login, and your file never
leaves your device.

Live: https://pdfedit.lakshpradhwani.com

## Develop

```bash
npm install
npm run dev        # http://localhost:5180
npm test
npm run build
```

## Built with

[MuPDF.js](https://mupdf.com) (AGPL), [HarfBuzz](https://harfbuzz.github.io), [tesseract.js](https://github.com/naptha/tesseract.js),
React, Vite. Fallback fonts are open-licensed fonts loaded on demand.

## Licence

AGPL-3.0-or-later. Editing a digitally signed PDF invalidates its signature, and the app says so.
