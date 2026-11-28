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
- Re-reading or re-editing can be unreliable after whole-line rewrites in Urdu Nastaliq and some Word
  Indic/Thai files; some PyMuPDF htmlbox Hindi lines read with missing letters. Vertical Japanese rewritten
  mostly in Latin letters reads back letter by letter.
- Replaced scan text is covered, not erased; text on busy photographs in a scan covers badly. Telugu/Kannada/
  Malayalam/Urdu OCR about 82-91%.
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
Laksh asked on 28 Nov (then went AFK; "implement it as your project"):
1. Fix the phone UI and touch bugs and make every text box editable (two agents running: phone UI; engine boxes).
2. Test on the real Android emulator, deploy.
3. Run 10 research / UI-research agents and 3 feature-research agents (read-only), then apply the UI changes and
   add the worthwhile features without asking.
4. Add image editing: every recognisable text box in an uploaded image editable in matching style and font,
   looking real. Keep the rule: nothing built to hide that a file was edited (mark exports, no faked metadata).
5. Test everything, deploy, report. "Surveillance" in the request is read as supervising the agents' work; no
   user tracking is added to a privacy product.

Device testing: `C:devandroid-sdk`, AVD `pdfedit-phone`, `tests/device/` (see script headers).

## Open questions / waiting on others
- None.

## Decisions not to undo
- Owner-restricted PDFs stay editable with a warning; the export drops the restriction (Laksh, 28 Nov).
- Engine MuPDF (AGPL), so the repo is public. OCR is free, in-browser only (no paid APIs).
- Hosting: Cloudflare Pages (Laksh chose it over Vercel in the question round, although the first message said Vercel).
- Public, no login; files never uploaded.
- Edits keep the original look; unchanged characters keep original glyphs; missing glyphs get the closest free
  font with a notice and a font upload option.
- Nothing that hides a file was edited: no faked metadata, no signature workarounds.
- Small commits, pushed after each (Laksh, 27 Nov session only; ask again next session).

## Session log
- 2026-11-28: engine box QA (not committed or deployed): box sweep in `tests/text/sweep/` (see `sweep.test.ts`
  header) and fixes for how text is grouped into boxes, re-editing, clips, substitute fonts and OCR sizing.
  How a page was grouped before an edit is kept in `ctx.state.extra` (`text/starts.ts`).
- 2026-11-28: phone testing set up on an Android emulator with real touches; sample boxes open correctly on a
  single tap; two fix agents started.
- 2026-11-28: Laksh chose to keep owner-restricted PDFs editable with a warning. No code change.
- 2026-11-28: summary emailed to work@lakshpradhwani.com. GitGuardian "generic password" alert is made-up test PDF
  passwords in tests/ (no real secrets found in history).
- 2026-11-28: QA round merged, all checks green, deployed, live site verified, Cloudflare script injection fixed.
- 2026-11-27: Q&A with Laksh, repo created, scaffold + contracts written, agents dispatched.

<!-- handoff:auto:start -->
## Auto: repo state

_Refreshed 28 Nov 2026, 9:00 am IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `e159762` 2026-11-28 09:00 feat(phone): type directly in the tapped line with one toolbar above the keyboard
- `9f13af1` 2026-11-28 08:43 fix(text): every box groups, edits and re-edits cleanly; sweep over realistic documents
- `ae902cd` 2026-11-28 06:56 docs: handoff for the phone fixes and next work
- `051b4a0` 2026-11-28 06:53 test(device): drive the app with real touches on an Android phone
- `ecff063` 2026-11-28 06:39 docs: keep owner-restricted PDFs editable with a warning
- `1982251` 2026-11-28 00:21 docs: record summary email and secret-scan result
- `dc0044b` 2026-11-28 00:13 docs: mark the live link
- `622a699` 2026-11-28 00:13 docs: handoff for the live release
- `1969f44` 2026-11-28 00:02 fix(deploy): stop Cloudflare injecting scripts into the page without losing compression
- `fa2f5dd` 2026-11-27 23:48 chore: deploy with wrangler through npx
- `052057d` 2026-11-27 23:41 fix(text): spacing, layered and mixed-style fidelity, readable re-extraction and long lines
- `74f6157` 2026-11-27 23:33 docs: describe features and limits
- `a4598bd` 2026-11-27 23:33 fix(viewer): keep a tap made while a change is saving
- `4dd84e0` 2026-11-27 23:28 test: desktop and back-navigation browser tests
- `41fa302` 2026-11-27 23:28 fix(shell): desktop and back-navigation fixes, restriction and XFA notices

### Uncommitted changes at refresh time

```
M  tests/device/android.mjs
A  tests/device/phone.mjs
M  tests/device/sweep.mjs
M  tests/e2e/edit.spec.ts
M  tests/e2e/helpers.ts
M  tests/e2e/ocr.spec.ts
A  tests/e2e/phone.spec.ts
M  tests/e2e/ui.spec.ts
```
<!-- handoff:auto:end -->
