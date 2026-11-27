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
- VIEWER landed, checked in Chromium and WebKit emulation; no real-device keyboard test, no unit tests.
  Wanted: one-step undo for multi-line highlight / multi-page redaction.
- TEXT landed: 709/709 integration + text tests; corpus extraction 407/411 lines exact. Limits: no paragraph
  reflow, search stops at line breaks, 21k-glyph pages take 290-700 ms, stacked vertical CJK loses typed spaces.
- TESTS landed: 60-file multi-language corpus, integration and Playwright e2e suites.

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

_Refreshed 27 Nov 2026, 10:30 pm IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `46f08ff` 2026-11-27 22:30 feat(text): edit existing text in place, keeping the document's fonts, colours and positions
- `5ce54d9` 2026-11-27 22:24 fix(viewer): safe document close, 44px size buttons and undo while typing
- `126fec4` 2026-11-27 22:22 fix(ops): keep stroke state on redaction, order rotated text, quiet export after undo
- `e74c459` 2026-11-27 22:19 fix(engine): leave internal font names out of the substitution notice
- `83b812e` 2026-11-27 22:18 test: integration and browser test suites
- `07b5c8a` 2026-11-27 22:18 test: multi-language PDF corpus and Playwright config
- `5d86f69` 2026-11-27 22:07 fix(shell): zoom buttons follow the viewer's real fit scale
- `0be61f4` 2026-11-27 22:06 feat(viewer): virtualised pages, inline text editing and on-page tools
- `41db324` 2026-11-27 22:06 fix(engine): hold calls until the worker has loaded so an early open cannot hang
- `c562164` 2026-11-27 21:51 docs: handoff status for operations and shell
- `08908b8` 2026-11-27 21:50 feat(shell): start screen, editor chrome, panels and dialogs
- `942591c` 2026-11-27 21:50 feat(shell): design tokens, app icons and PWA assets
- `8e1236b` 2026-11-27 21:50 fix(store): stay busy until overlapping calls all finish
- `02ee33c` 2026-11-27 21:50 feat(ops): added objects, images, forms, page tools, redaction and export
- `9c783bf` 2026-11-27 21:49 fix(engine): drop MuPDF's font cache after every mutation, undo and redo

### Uncommitted changes at refresh time

```
M  HANDOFF.md
 M src/engine/ocr/index.ts
 M src/ocr/index.ts
?? src/engine/ocr/edit.ts
?? src/engine/ocr/fit.ts
?? src/engine/ocr/ink.ts
?? src/engine/ocr/pdf.ts
?? src/engine/ocr/recognised.ts
?? src/engine/ocr/searchable.ts
?? src/engine/ocr/state.ts
?? src/engine/ocr/style.ts
?? src/engine/ocr/textlayer.ts
?? src/ocr/convert.ts
?? src/ocr/detect.ts
?? src/ocr/languages.ts
?? src/ocr/preprocess.ts
?? src/ocr/tess.ts
?? tests/ocr/
```
<!-- handoff:auto:end -->
