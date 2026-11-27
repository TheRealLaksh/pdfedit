# PDFEdit handoff

## Project
Free, public, no-login PDF editor that edits existing text in any language while keeping its look, entirely in
the browser. For Laksh (owner) and anyone on the web. Phone use matters most, desktop equally polished.

## Links
- Live (target): https://pdfedit.lakshpradhwani.com (Cloudflare Pages project `pdfedit`)
- Repo: https://github.com/TheRealLaksh/pdfedit (public, AGPL-3.0)
- Local: `C:\dev\pdfedit`
- Build brief: `docs/MODULES.md`

## Stack, run, test, deploy
Vite + React 19 + TypeScript, zustand, MuPDF.js (wasm, in a worker), HarfBuzz, tesseract.js.
`npm run dev` (port 5180), `npm run typecheck`, `npm test`, `npm run e2e`, `npm run build`,
`npm run deploy` (wrangler, already logged in on this PC; DNS for lakshpradhwani.com is on Cloudflare).

## Code map
- `src/engine/` engine (worker): `engine.ts` router + undo, `types.ts` contract, `content/` stream parser,
  `text/` existing-text editing, `fonts/` shaping + embedding, `ocr/` scanned pages, `ops/` objects/pages/forms/export
- `src/ocr/` tesseract on the main thread; `src/store/` app state; `src/ui/viewer/`, `src/ui/shell/`
- `tests/` fixtures, unit, integration, e2e

## Status
- 27 Nov 2026: scaffold and contracts done; module build by 7 parallel agents running.
- FONTS landed: about 40 scripts shaped and embedded, 83 tests pass. Limits: no WOFF/CFF2, emoji monochrome.
- OPS landed (127 tests) and SHELL landed (start screen, panels, PWA). Never `saveToBuffer` the live engine doc:
  it corrupts undo (ops copies objects instead, `ops/clone.ts`).
- SHELL not verified: real devices / iOS keyboard, touch drag-reorder, user-font upload, SW update across deploys.

## Next steps
1. Build the 7 modules (TEXT, FONTS, OCR, OPS, VIEWER, SHELL, TESTS).
2. Integrate, then 3-4 testing agents; fix findings.
3. Deploy to Cloudflare Pages, attach pdfedit.lakshpradhwani.com, verify live.
4. Email the summary and URL to work@lakshpradhwani.com (Laksh asked for this on 27 Nov).

## Open questions / waiting on others
- None. Laksh is away and gave full authority to finish (27 Nov).

## Decisions not to undo
- Engine MuPDF (AGPL), so the repo is public. OCR is free, in-browser only (no paid APIs).
- Hosting: Cloudflare Pages (Laksh chose it over Vercel in the question round, although the first message said Vercel).
- Public, no login; files never uploaded.
- Edits keep the original look; unchanged characters keep original glyphs; missing glyphs get the closest free
  font with a notice and a font upload option.
- Nothing that hides a file was edited: no faked metadata, no signature workarounds.
- Small commits, pushed after each (Laksh, 27 Nov session only; ask again next session).

## Session log
- 2026-11-27: Q&A with Laksh, repo created, scaffold + contracts written, agents dispatched.

<!-- handoff:auto:start -->
## Auto: repo state

_Refreshed 27 Nov 2026, 10:06 pm IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `41db324` 2026-11-27 22:06 fix(engine): hold calls until the worker has loaded so an early open cannot hang
- `c562164` 2026-11-27 21:51 docs: handoff status for operations and shell
- `08908b8` 2026-11-27 21:50 feat(shell): start screen, editor chrome, panels and dialogs
- `942591c` 2026-11-27 21:50 feat(shell): design tokens, app icons and PWA assets
- `8e1236b` 2026-11-27 21:50 fix(store): stay busy until overlapping calls all finish
- `02ee33c` 2026-11-27 21:50 feat(ops): added objects, images, forms, page tools, redaction and export
- `9c783bf` 2026-11-27 21:49 fix(engine): drop MuPDF's font cache after every mutation, undo and redo
- `fda0c3d` 2026-11-27 21:49 feat(fonts): font catalog, HarfBuzz shaping and embedding for all scripts
- `2613fab` 2026-11-27 21:14 feat(app): shared store, design tokens and entry point
- `34797a1` 2026-11-27 21:14 feat(engine): engine router, journal undo and worker bridge
- `0b80a57` 2026-11-27 21:14 feat(engine): content stream tokenizer and page helpers
- `dacf1be` 2026-11-27 21:14 feat(engine): contract, context and geometry helpers
- `a7cf22a` 2026-11-27 21:13 docs: readme, module brief and handoff automation
- `239e715` 2026-11-27 21:13 chore: project setup, tooling and AGPL licence

### Uncommitted changes at refresh time

```
M src/engine/ocr/index.ts
 M src/engine/text/index.ts
 M src/ocr/index.ts
A  src/ui/viewer/Overlays.tsx
A  src/ui/viewer/PageCanvas.tsx
A  src/ui/viewer/PageView.tsx
M  src/ui/viewer/Viewer.tsx
A  src/ui/viewer/canvasRegistry.ts
A  src/ui/viewer/context.ts
A  src/ui/viewer/device.ts
A  src/ui/viewer/editor/Dock.tsx
A  src/ui/viewer/editor/Preview.tsx
A  src/ui/viewer/editor/StyleBar.tsx
A  src/ui/viewer/editor/TextEditor.tsx
A  src/ui/viewer/editor/controller.ts
A  src/ui/viewer/editor/textMetrics.ts
A  src/ui/viewer/geometry.ts
A  src/ui/viewer/layers/DrawLayer.tsx
A  src/ui/viewer/layers/EditTextLayer.tsx
A  src/ui/viewer/layers/PlaceLayer.tsx
A  src/ui/viewer/layers/RedactionLayer.tsx
A  src/ui/viewer/layers/SelectLayer.tsx
A  src/ui/viewer/layers/StaticLayers.tsx
A  src/ui/viewer/layers/pointer.ts
A  src/ui/viewer/pageData.ts
A  src/ui/viewer/renderQueue.ts
A  src/ui/viewer/useViewport.ts
A  src/ui/viewer/viewer.css
A  src/ui/viewer/viewerApi.ts
A  src/ui/viewer/viewerStore.ts
?? playwright.config.ts
?? src/engine/ocr/edit.ts
?? src/engine/ocr/fit.ts
?? src/engine/ocr/ink.ts
?? src/engine/ocr/pdf.ts
?? src/engine/ocr/recognised.ts
?? src/engine/ocr/searchable.ts
?? src/engine/ocr/state.ts
?? src/engine/ocr/style.ts
?? src/engine/text/analyze.ts
?? src/engine/text/cmap.ts
?? src/engine/text/color.ts
?? src/engine/text/diff.ts
?? src/engine/text/edit.ts
?? src/engine/text/encode.ts
?? src/engine/text/encodings.ts
?? src/engine/text/fallback.ts
?? src/engine/text/interpret.ts
?? src/engine/text/layout.ts
?? src/engine/text/pdffont.ts
?? src/engine/text/probe.ts
?? src/engine/text/rewrite.ts
?? src/engine/text/search.ts
?? src/engine/text/unicode.ts
?? src/ocr/convert.ts
?? src/ocr/detect.ts
?? src/ocr/languages.ts
?? src/ocr/preprocess.ts
?? src/ocr/tess.ts
?? tests/e2e/
?? tests/fixtures/
?? tests/integration/
?? tests/ocr/
?? tests/text/
```
<!-- handoff:auto:end -->
