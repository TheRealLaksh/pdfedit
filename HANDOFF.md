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
- OCR landed: 122 languages; scanned text is covered (not erased) when replaced; Telugu/Kannada/Malayalam/Urdu
  recognise at about 82-91%.
- All 7 modules integrated: 1040 vitest tests pass, typecheck clean. Next: second-round testing agents.
- Cloudflare Pages project `pdfedit` (https://pdfedit-177.pages.dev) created with `wrangler pages project
  create --force` (plain create now tries Workers); first deploy done; custom domain added in the dashboard
  (CNAME pdfedit to pdfedit-177.pages.dev). No git auto-deploy: deploy with `npm run deploy`.
- Cross-module couplings to keep: hidden text-layer line ids end ".h"; ops reads OCR `edits.__page`,
  `patch.object`, `textForm`; `text/fallback.ts` and `ocr/edit.ts` import `ops/redactContent.ts`.

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

_Refreshed 27 Nov 2026, 11:28 pm IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `352af7f` 2026-11-27 23:28 fix(ocr): better mixed-language detection and pinned recognition data
- `31c2352` 2026-11-27 23:28 fix(ops): guard hostile documents and keep list box highlights
- `72182c2` 2026-11-27 23:28 fix(engine): cap content parser nesting
- `b4aaf22` 2026-11-27 23:28 fix(engine): restart a crashed or hung worker and replay the document
- `011c3a4` 2026-11-27 23:06 fix(phone): landscape and 320px editor layout, dark swatches and safer service worker updates
- `e3f850d` 2026-11-27 22:42 docs: record Cloudflare Pages project and domain
- `c2c020b` 2026-11-27 22:37 fix(engine): record an undo step only when the document changed
- `e6302e6` 2026-11-27 22:37 feat(ocr): in-browser recognition and native-looking edits on scanned pages
- `8982559` 2026-11-27 22:30 docs: handoff status for text and tests
- `46f08ff` 2026-11-27 22:30 feat(text): edit existing text in place, keeping the document's fonts, colours and positions
- `5ce54d9` 2026-11-27 22:24 fix(viewer): safe document close, 44px size buttons and undo while typing
- `126fec4` 2026-11-27 22:22 fix(ops): keep stroke state on redaction, order rotated text, quiet export after undo
- `e74c459` 2026-11-27 22:19 fix(engine): leave internal font names out of the substitution notice
- `83b812e` 2026-11-27 22:18 test: integration and browser test suites
- `07b5c8a` 2026-11-27 22:18 test: multi-language PDF corpus and Playwright config

### Uncommitted changes at refresh time

```
M  src/App.tsx
 M src/engine/fonts/draw.ts
 M src/engine/fonts/index.ts
 M src/engine/fonts/inspect.ts
 M src/engine/fonts/layout.ts
 M src/engine/fonts/types.ts
 M src/engine/text/analyze.ts
 M src/engine/text/diff.ts
 M src/engine/text/edit.ts
 M src/engine/text/encode.ts
 M src/engine/text/layout.ts
 M src/engine/text/pdffont.ts
 M src/engine/text/rewrite.ts
M  src/store/index.ts
M  src/ui/shell/Feedback.tsx
M  src/ui/shell/actions.ts
A  src/ui/shell/backGuard.ts
M  src/ui/shell/panels/AboutPanel.tsx
M  src/ui/shell/panels/PagesPanel.tsx
M  src/ui/shell/shell.css
 M src/ui/viewer/Viewer.tsx
 M src/ui/viewer/editor/controller.ts
 M src/ui/viewer/layers/EditTextLayer.tsx
 M src/ui/viewer/layers/PlaceLayer.tsx
 M src/ui/viewer/layers/SelectLayer.tsx
 M src/ui/viewer/pageData.ts
 M tests/text/mockFonts.ts
?? tests/e2e/back.spec.ts
?? tests/e2e/desktop.spec.ts
?? tests/text/fidelity.test.ts
```
<!-- handoff:auto:end -->
