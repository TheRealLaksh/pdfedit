# PDFEdit handoff

## Project
Free, public, no-login PDF editor that edits existing text in any language while keeping its look, entirely in
the browser. For Laksh (owner) and anyone on the web. Phone use matters most, desktop equally polished.

## Links
- Live: https://pdfedit.lakshpradhwani.com (Cloudflare Pages project `pdfedit`)
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
- 28 Nov 2026: **live** at https://pdfedit.lakshpradhwani.com (Cloudflare Pages, project `pdfedit`).
- Built by 7 module agents, then tested and fixed by 4 QA agents (desktop, phone, multilingual fidelity,
  robustness/security).
- Checks on the merged code: typecheck clean; 1088 vitest pass (1 skipped); Playwright 273 pass, 36 skipped,
  0 failed on desktop + Pixel 7 + iPhone emulation, both on a local build and against the live site. Offline
  open verified on the live site.
- Not verified: any real phone or tablet, real scanner output, LaTeX / LibreOffice documents.

### Known limits
- No paragraph reflow; longer text can overrun cells or columns. Search does not cross line breaks.
- Substitute fonts can look different (other than Arial/Times metric twins), notably CJK vs SimSun / Yu Gothic.
- Re-reading or re-editing can be unreliable after whole-line rewrites in Arabic, Hebrew, Urdu Nastaliq and
  some Word Indic/Thai files; some PyMuPDF htmlbox lines are read-only or ask for OCR.
- Replaced scan text is covered, not erased. Telugu/Kannada/Malayalam/Urdu OCR about 82-91%.
- Lines over 1500 glyphs are read-only. Owner-restricted PDFs open with a warning; export drops the restriction.
- XFA forms show only partly. No SRI on the two pinned tesseract scripts from jsDelivr.

### Deploy notes
- `npm run deploy`. `public/_headers` keeps `no-transform` on the page only: without it Cloudflare injects
  analytics and challenge scripts (blocked by the CSP); on assets it would switch compression off.
- Change the CSP script paths together with `TESSERACT_VERSION`.
- Cross-module couplings: hidden text-layer line ids end ".h"; ops reads OCR `edits.__page`, `patch.object`,
  `textForm`; `text/fallback.ts` and `ocr/edit.ts` import `ops/redactContent.ts`. Never `saveToBuffer` the live
  engine document (breaks undo).

## Next steps
1. Laksh: try it on your own phone with real documents (keyboard behaviour above all) and note what looks off.
2. Optional: self-host tesseract scripts; paragraph reflow; one-step undo for multi-line highlight/redaction.

## Open questions / waiting on others
- Keep, or block, editing of owner-restricted PDFs (today: warn and allow)?

## Decisions not to undo
- Engine MuPDF (AGPL), so the repo is public. OCR is free, in-browser only (no paid APIs).
- Hosting: Cloudflare Pages (Laksh chose it over Vercel in the question round, although the first message said Vercel).
- Public, no login; files never uploaded.
- Edits keep the original look; unchanged characters keep original glyphs; missing glyphs get the closest free
  font with a notice and a font upload option.
- Nothing that hides a file was edited: no faked metadata, no signature workarounds.
- Small commits, pushed after each (Laksh, 27 Nov session only; ask again next session).

## Session log
- 2026-11-28: QA round merged, all checks green, deployed, live site verified, Cloudflare script injection fixed.
- 2026-11-27: Q&A with Laksh, repo created, scaffold + contracts written, agents dispatched.

<!-- handoff:auto:start -->
## Auto: repo state

_Refreshed 28 Nov 2026, 12:13 am IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `622a699` 2026-11-28 00:13 docs: handoff for the live release
- `1969f44` 2026-11-28 00:02 fix(deploy): stop Cloudflare injecting scripts into the page without losing compression
- `fa2f5dd` 2026-11-27 23:48 chore: deploy with wrangler through npx
- `052057d` 2026-11-27 23:41 fix(text): spacing, layered and mixed-style fidelity, readable re-extraction and long lines
- `74f6157` 2026-11-27 23:33 docs: describe features and limits
- `a4598bd` 2026-11-27 23:33 fix(viewer): keep a tap made while a change is saving
- `4dd84e0` 2026-11-27 23:28 test: desktop and back-navigation browser tests
- `41fa302` 2026-11-27 23:28 fix(shell): desktop and back-navigation fixes, restriction and XFA notices
- `352af7f` 2026-11-27 23:28 fix(ocr): better mixed-language detection and pinned recognition data
- `31c2352` 2026-11-27 23:28 fix(ops): guard hostile documents and keep list box highlights
- `72182c2` 2026-11-27 23:28 fix(engine): cap content parser nesting
- `b4aaf22` 2026-11-27 23:28 fix(engine): restart a crashed or hung worker and replay the document
- `011c3a4` 2026-11-27 23:06 fix(phone): landscape and 320px editor layout, dark swatches and safer service worker updates
- `e3f850d` 2026-11-27 22:42 docs: record Cloudflare Pages project and domain
- `c2c020b` 2026-11-27 22:37 fix(engine): record an undo step only when the document changed

### Uncommitted changes at refresh time

```
M  HANDOFF.md
```
<!-- handoff:auto:end -->
