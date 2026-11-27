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

_Refreshed 27 Nov 2026, 9:49 pm IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `2613fab` 2026-11-27 21:14 feat(app): shared store, design tokens and entry point
- `34797a1` 2026-11-27 21:14 feat(engine): engine router, journal undo and worker bridge
- `0b80a57` 2026-11-27 21:14 feat(engine): content stream tokenizer and page helpers
- `dacf1be` 2026-11-27 21:14 feat(engine): contract, context and geometry helpers
- `a7cf22a` 2026-11-27 21:13 docs: readme, module brief and handoff automation
- `239e715` 2026-11-27 21:13 chore: project setup, tooling and AGPL licence

### Uncommitted changes at refresh time

```
M  HANDOFF.md
 M index.html
 M src/App.tsx
 M src/engine/engine.ts
A  src/engine/fonts/bidi-js.d.ts
A  src/engine/fonts/catalog.data.ts
A  src/engine/fonts/catalog.ts
A  src/engine/fonts/draw.ts
A  src/engine/fonts/embed.ts
A  src/engine/fonts/face.ts
A  src/engine/fonts/hb.ts
M  src/engine/fonts/index.ts
A  src/engine/fonts/inspect.ts
A  src/engine/fonts/layout.ts
A  src/engine/fonts/resolve.ts
A  src/engine/fonts/scripts.ts
A  src/engine/fonts/sfnt.ts
A  src/engine/fonts/user.ts
 M src/engine/ocr/index.ts
 M src/engine/ops/index.ts
 M src/engine/text/index.ts
 M src/ocr/index.ts
 M src/ui/tokens.css
 M src/ui/viewer/Viewer.tsx
A  tests/fonts/catalog.test.ts
A  tests/fonts/chromium.ts
A  tests/fonts/fonts.test.ts
A  tests/fonts/helpers.ts
A  tests/fonts/logical.ts
A  tests/fonts/nodeAssets.ts
A  tests/fonts/samples.ts
A  tests/fonts/scripts.test.ts
?? playwright.config.ts
?? public/icon.svg
?? public/icons/
?? public/manifest.webmanifest
?? public/robots.txt
?? public/sw.js
?? public/theme.js
?? src/engine/ocr/edit.ts
?? src/engine/ocr/fit.ts
?? src/engine/ocr/ink.ts
?? src/engine/ocr/pdf.ts
?? src/engine/ocr/recognised.ts
?? src/engine/ocr/searchable.ts
?? src/engine/ocr/state.ts
?? src/engine/ocr/style.ts
?? src/engine/ops/annots.ts
?? src/engine/ops/clone.ts
?? src/engine/ops/export.ts
?? src/engine/ops/forms.ts
?? src/engine/ops/imageData.ts
?? src/engine/ops/images.ts
?? src/engine/ops/insert.ts
?? src/engine/ops/objects.ts
?? src/engine/ops/pages.ts
?? src/engine/ops/readingOrder.ts
?? src/engine/ops/redact.ts
?? src/engine/ops/redactContent.ts
?? src/engine/ops/shared.ts
?? src/engine/ops/stamps.ts
?? src/engine/ops/state.ts
?? src/engine/ops/textLayout.ts
?? src/engine/ops/walk.ts
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
?? src/ui/shell/
?? src/ui/viewer/Overlays.tsx
?? src/ui/viewer/PageCanvas.tsx
?? src/ui/viewer/PageView.tsx
?? src/ui/viewer/canvasRegistry.ts
?? src/ui/viewer/context.ts
?? src/ui/viewer/device.ts
?? src/ui/viewer/editor/
?? src/ui/viewer/geometry.ts
?? src/ui/viewer/layers/
?? src/ui/viewer/pageData.ts
?? src/ui/viewer/renderQueue.ts
?? src/ui/viewer/useViewport.ts
?? src/ui/viewer/viewer.css
?? src/ui/viewer/viewerApi.ts
?? src/ui/viewer/viewerStore.ts
?? tests/e2e/
?? tests/fixtures/
?? tests/integration/
?? tests/ocr/
?? tests/ops/
?? tests/text/
```
<!-- handoff:auto:end -->
