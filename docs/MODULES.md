# Module specification (build brief)

## Product
A free, public, no-login PDF editor at **pdfedit.lakshpradhwani.com**. Everything runs in the browser; the
file never leaves the device. Phone use matters MORE than desktop (both must be excellent). Calm minimal
design: neutral surfaces, ONE accent colour, light + dark, Phosphor icons, **no emojis**, no decorative
gradients, no scroll animations.

The headline feature: tap any existing text in a PDF, change it, and it keeps the **exact same font, style,
colour, size and position**. It must work for every language and every kind of PDF (any producer, scanned,
broken fonts, password protected, damaged, huge, rotated).

Hard line: edits should look native, but never add anything meant to hide that a file was changed (no faked
dates or producer, no signature workarounds). Signed PDFs show a warning. Export sets ModDate to now.

## Architecture
- `src/engine/engine.ts` (lead-owned) runs in a web worker, wraps every mutation in a MuPDF journal
  operation (so undo/redo is automatic: modules must NOT call beginOperation/endOperation/undo).
- `src/engine/types.ts` is the contract; `src/engine/context.ts` the module context; `src/store/index.ts`
  the UI state and actions. Helpers: `src/engine/geom.ts`, `src/engine/content/{tokenizer,page}.ts`.
- Libraries: `mupdf` 1.28 (AGPL, wasm; types in `node_modules/mupdf/dist/mupdf.d.ts`), `harfbuzzjs` 1.x
  (new API, read `node_modules/harfbuzzjs/dist/harfbuzz.d.ts`), `tesseract.js` 7, `bidi-js`, React 19,
  zustand 5, `@phosphor-icons/react`.
- Gotchas: `saveToBuffer(...).asUint8Array()` is a VIEW into wasm memory, `.slice()` it. Saving with
  `garbage` renumbers objects: to export, save plain, reopen a clone, then save the clone with options.
  Never mutate a content stream or resource dictionary that another page may share (use content/page.ts).
- State that must follow undo goes in `ctx.state` (cloneable, small). Bytes go in `ctx.blobs`.

## Rules for every module agent
1. Edit ONLY the files in your ownership list. Others are being written in parallel RIGHT NOW in the same
   folder; their stubs throw "not implemented" until they land. Write your own tests so they do not depend on
   unfinished modules (or mock them with `vi.mock`), then re-run integrated at the end if they have landed.
2. Do not run `npm install`, do not run any git command, do not edit package.json, configs, types.ts,
   context.ts, engine.ts or the store. If the contract truly needs a change, make your module work without it
   and describe the exact change in your final report. If you need a new npm package, say so in the report.
3. Keep exported signatures exactly as in the stubs (you may add exports).
4. Verify: `npx tsc --noEmit` (ignore errors in files you do not own, but yours must be clean) and
   `npx vitest run tests/<yourfolder>`. Test with real generated PDFs and check results by rendering pages
   with MuPDF and by extracting text, not just "no exception". Save debug PNGs under `.tmp/<yourfolder>/`
   and LOOK at them with the Read tool.
5. Temporary files go in `.tmp/<yourfolder>/` only. Never start a long-running server without stopping it.
6. Final report: under 400 words: what works (verified how), what does not, contract changes wanted.

## Modules

### TEXT: `src/engine/text/**`, `tests/text/**`  (the core, highest quality bar)
- `analyzePage`: parse the page content streams (and nested Form XObjects) with your own interpreter: graphics
  and text state, CTM, Tm, Tj/TJ/'/", fonts (Type1, TrueType, Type0/CID Identity and other CMaps, Type3),
  encodings + Differences, ToUnicode CMaps, widths. Group glyphs into visual lines (handle PDFs that draw one
  glyph or one word per operator, out of order, with TJ kerning as spaces, rotated text, columns/tables: do
  not merge separate columns or cells). Produce logical-order Unicode (RTL via bidi, Indic pre-base matras
  re-ordered), quads in page space, per-span style (colour from whatever colour space), alignment guess,
  stable ids. `MuPDF` structured text (`page.toStructuredText().walk`) is a good cross-check / fallback for
  Unicode when your decoding fails. Set `kind` (scanned / garbled / mixed / empty): detect broken encodings
  (PUA, replacement chars, legacy Indic fonts such as Kruti Dev / Chanakya / DevLys, invalid matra sequences).
  Must be synchronous and fast (a 20k-glyph page under ~300ms); cache in ctx.cache.
- `editLines`: change ONLY the targeted glyphs; every other byte of page content stays. Highest fidelity
  order: (1) unchanged glyphs keep their original codes and positions (diff old/new text; for complex scripts
  diff by whole words); (2) new characters use the ORIGINAL embedded font when it can truly encode them and
  the glyph exists in the subset (use fonts.inspectFont); (3) otherwise fonts.writeText with originalFont
  hint and `colorOps` reusing the original colour operators, inserted at the same z-position, same graphics
  state, correct BT/ET restoration so following text does not move. Honour style overrides (size, colour,
  bold, italic, family, underline, spacing), align (keep the right edge for right-aligned and the centre for
  centred lines; justified keeps width via word spacing), offset (move), fit=shrink, deletion (text ""),
  adding characters at the end. Text clipping modes, Tr, ActualText / marked content (update or remove stale
  ActualText), text inside shared Form XObjects (copy on write), Type3 and unparseable cases (fall back to
  MuPDF redaction of the glyph quads with images and line art untouched, then writeText).
- `findText` / `replaceText`: across all pages, case / whole word, Unicode normalisation (NFC), matches
  spanning spans; must include OCR lines (get lines via `ocr.mergePageText(ctx, analyzePage(ctx, p))`, and
  send "ocr:" line edits to `ocr.editOcrLines`).

### FONTS: `src/engine/fonts/**` (not types.ts), `tests/fonts/**`
- A catalog covering essentially all scripts: Latin/Greek/Cyrillic, Devanagari, Bengali, Gurmukhi, Gujarati,
  Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala, Arabic (and Nastaliq for Urdu), Hebrew, Thai, Lao,
  Khmer, Myanmar, Tibetan, Georgian, Armenian, Ethiopic, CJK (SC/TC/JP/KR), maths and symbols. Fonts are
  downloaded on demand through `ctx.assets.bytes(url)` from cdn.jsdelivr.net (must be real TTF/OTF, verify
  every URL actually returns 200 and is a font; pin versions). Include metric-compatible substitutes:
  Arial/Helvetica to Arimo or Liberation Sans, Times to Tinos, Courier to Cousine, Calibri to Carlito,
  Cambria to Caladea, plus matching for common families (Roboto, Open Sans, Lato, Montserrat, Poppins,
  Mukta, Hind, Georgia -> Gelasio, Verdana-like, etc.). Real bold/italic files where they exist, else
  synthetic bold (Tr 2 stroke) / oblique (skew).
- Shaping with HarfBuzz, itemised by script + bidi level (bidi-js) + font fallback per cluster; correct
  Indic reordering and conjuncts, Arabic joining, RTL visual order, combining marks, emoji-free fallback.
- Embedding: Type0 / CIDFontType2 (or CIDFontType0 for CFF) with Identity-H, correct /W, FontDescriptor,
  ToUnicode, and /ActualText marked content so that copy/paste and search return the logical text. Subset
  with harfbuzz-subset (keeping glyph ids) or leave full and let export call `doc.subsetFonts()`; keep output
  files small. Reuse one embedded font object per document (ctx.cache is cleared per mutation, so store
  object numbers in ctx.state.extra.fonts and respect undo). Position glyphs exactly using HarfBuzz offsets.
- User fonts (TTF/OTF/TTC); user font that matches the original family name is preferred automatically.
- Works both in the web worker and in node tests (load harfbuzz wasm in both). Tests may download fonts and
  cache them in `.tmp/fonts-cache/` through a custom AssetLoader: export a node helper for other tests in
  `tests/fonts/nodeAssets.ts`.

### OCR: `src/ocr/**`, `src/engine/ocr/**`, `tests/ocr/**`
- Main thread: all tesseract languages in OCR_LANGUAGES (code, name, nativeName, script); `recognizePage`
  with preprocessing (grayscale, deskew-tolerant, adaptive threshold where it helps), automatic script and
  language detection when `languages` is empty (OSD or a cheap multi-pass), multi-language, progress, abort,
  worker reuse. Language data from the jsdelivr CDN (CSP only allows self and cdn.jsdelivr.net: configure
  workerPath/corePath/langPath accordingly and verify the URLs return 200).
- Engine: store results in ctx.state.ocr; `mergePageText` returns editable lines with ids "ocr:..." (for
  kind garbled, OCR lines replace the broken content lines), style estimated (size from glyph height, ink
  colour, bold, serif guess).
- `editOcrLines`: make the edit look native on a scan: sample the background around and under the line,
  build an image patch that removes only the ink (inpaint, keep paper texture / gradient / ruled lines where
  possible), place it over the line, then draw the new text with fonts.writeText matched in size, weight and
  colour and baseline-aligned. Handle rotated pages and rotated /Rotate. Garbled-text pages: remove the real
  text operators under the line (MuPDF redaction, images untouched) instead of patching an image. Re-editing
  the same line must replace the previous patch/text, not stack visibly.
- `makeSearchable`: invisible text layer (renderMode 3) placed over words.

### OPS: `src/engine/ops/**`, `tests/ops/**`
- Everything in the stub. Added objects are real page content wrapped in marked content so they can be
  re-written on update and removed (z-order stable); keep the registry in ctx.state.objects, image bytes in
  ctx.blobs. Text objects are multi-line, wrapped to the rect width, any script (use fonts.writeText /
  planText). Highlight uses multiply blend. Rotation and opacity respected. Works on rotated pages and pages
  with unusual crop boxes (page space is what the user sees).
- Existing images: find image XObjects / inline images with their placement (including inside forms), move,
  resize, delete, replace without touching anything else (use content/tokenizer + page helpers).
- Forms: all AcroForm field types incl. Indic/CJK values (generate appearances with a suitable font when
  Helvetica cannot draw the value), radio groups, comboboxes; flatten.
- Pages: keep ctx.state.ocr keys and object page indices correct after delete/reorder/insert/duplicate.
  insertPdf handles passwords; keep links and form fields where possible.
- Redaction must truly delete text, image pixels and vector art under the rects (verify by extraction).
- Export: password (AES-256), compress (garbage, compress, subset fonts), flatten, page subset, PNG/JPEG,
  plain text in reading order for any script. Keep existing encryption off unless a password is given.

### VIEWER: `src/ui/viewer/**`  (CSS in that folder)
- Export `Viewer` from Viewer.tsx. Virtualised continuous page list (1000+ pages OK), renders through
  `engine.renderPage` at devicePixelRatio with an LRU of ImageBitmaps keyed by page+revision+scale; tiles or
  clip rendering at deep zoom (never exceed ~16M pixel canvases, iOS). Smooth pinch zoom, ctrl+wheel zoom,
  pan; honour store.zoom ("fit"), scrollRequest, currentPage.
- Edit-text tool: show tappable line boxes (hit target at least 44px high on touch, nearest-line picking),
  tap opens an inline editor exactly over the line, matching size, colour, weight, direction (dir="auto"),
  rotated text too; floating style bar (font from engine.listFonts, size, colour, bold, italic, underline,
  align, shrink-to-fit, delete, move by drag handle / nudge), docked above the on-screen keyboard on phones
  using visualViewport (the field must never be hidden by the keyboard). Commit on Done / Enter / tap away,
  Esc cancels; only send changed properties. On scanned or garbled pages show a clear "Recognise text on this
  page" prompt that calls store.runOcr.
- Other tools: add text, shapes, line/arrow, highlight (drag over text snaps to lines), whiteout, redact
  (with confirm), ink drawing (pointer events, pressure ignored OK, smooth), placement of image/signature
  (store.placement), selecting/moving/resizing/rotating/deleting added objects and existing images with
  handles, search highlight rects from store.search. Keyboard shortcuts: undo/redo, delete, arrows to nudge,
  zoom. All touch gestures must not fight page scrolling.

### SHELL: `src/App.tsx`, `src/ui/shell/**`, `src/ui/tokens.css` (add only), `public/**` (not _headers),
`index.html` (head only)
- Start screen: drop zone / choose file (PDF or images), short honest value line, privacy note ("processed on
  your device"), no marketing fluff. Password dialog. Busy overlay. Toasts. Unsaved-changes warning.
- Editor chrome: desktop = top bar (file name, undo/redo, zoom, page indicator, search, Download) + left tool
  rail + right panel; phone = compact top bar + bottom tool bar with a "More" sheet; panels are bottom sheets.
  Hide the bottom bar while store.editing is set. 44px touch targets, safe-area insets, works at 320px.
- Panels (store.panel): pages organiser (thumbnails, drag to reorder incl. touch, multi-select, rotate,
  delete, duplicate, extract, split, insert PDF / images / blank), find & replace, forms filling, export
  (compress, flatten, password, page range, images, text, OCR "make searchable"), OCR (language picker with
  search over OCR_LANGUAGES, auto option, progress, all pages / this page), signature (draw, type, upload with
  background removal; remember locally, optional), stamps (watermark, page numbers), fonts (upload TTF/OTF,
  list), about/privacy (open source AGPL, link https://github.com/TheRealLaksh/pdfedit, limits stated
  honestly, built by Laksh Pradhwani).
- PWA: manifest, icons (svg + png), a careful service worker that caches the app shell and wasm for offline
  use and never serves stale HTML after a deploy. Theme toggle (system/light/dark via data-theme).
  WCAG AA contrast, focus rings, ARIA on dialogs/sheets, full keyboard use, reduced motion.
  Apply the design skills available to you (ui-ux-pro-max, frontend-design, web-design-guidelines).

### TESTS: `tests/fixtures/**`, `tests/e2e/**`, `tests/integration/**`, `playwright.config.ts`
- A generator (node and/or python: `pip install` is allowed for fpdf2, uharfbuzz, reportlab, pypdf, Pillow;
  Playwright Chromium print-to-PDF gives excellent complex-script PDFs) producing a corpus under
  tests/fixtures/pdfs/ (commit it, keep the total under 15 MB) with a manifest.json describing the expected
  text of each: English (standard-14, TrueType subset, CFF), Hindi, Marathi, Bengali, Tamil, Telugu, Gujarati,
  Punjabi, Kannada, Malayalam, Odia, Urdu, Arabic, Hebrew, Chinese, Japanese, Korean, Thai, Russian, Greek,
  mixed scripts, tables/columns, justified text, rotated pages, rotated text, form XObjects, forms, images,
  password protected (user password "test1234"), damaged xref, scanned image-only (several languages),
  legacy broken-encoding font simulation, 300-page file (generate at test time, do not commit if large).
- `tests/integration`: drive `new Engine(nodeAssets)` over the whole corpus: extraction accuracy per script,
  edit round trip (edit a line, re-open the export, assert new text present, old gone, neighbours unchanged,
  and pixel diff confined to the line region). Print a per-language accuracy table.
- Playwright e2e against `npm run dev` (port 5180), desktop and phone (Pixel 7 + iPhone viewport) projects:
  open, edit text, undo, add objects, sign, page ops, password, export download re-opened and verified.
- You own test code only: report bugs with exact reproduction, do not fix product code.
