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
- 2026-11-28: 13 research reports (`.tmp/research/`, local only); build wave 2 started (engine, viewer, shell,
  image editor; plan in `docs/BUILD-WAVE2.md`). Then: interface translation, QA round, deploy, report.
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

_Refreshed 28 Nov 2026, 5:10 pm IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `aa564f2` 2026-11-28 16:41 feat(image): edit the text inside pictures with matched fonts and rebuilt backgrounds
- `4135e0c` 2026-11-28 16:03 feat(engine): real preview fonts, size-limited export, drafts, private image metadata stripped
- `9e68e69` 2026-11-28 09:21 docs: build plan from the research round
- `8b7faa1` 2026-11-28 09:20 feat: contracts for faithful typing previews, size-limited export and an image editor
- `d8569fc` 2026-11-28 09:00 test(phone): device checklist and phone browser tests
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

### Uncommitted changes at refresh time

```
M index.html
 M public/manifest.webmanifest
 M public/robots.txt
 M public/sw.js
 M public/theme.js
 M src/App.tsx
 M src/main.tsx
 M src/store/index.ts
 M src/ui/shell/Dialogs.tsx
 M src/ui/shell/Feedback.tsx
 M src/ui/shell/Panel.tsx
 M src/ui/shell/StartScreen.tsx
 M src/ui/shell/ToolBars.tsx
 M src/ui/shell/TopBar.tsx
 M src/ui/shell/actions.ts
 M src/ui/shell/backGuard.ts
 M src/ui/shell/hooks.ts
 M src/ui/shell/panels/AboutPanel.tsx
 M src/ui/shell/panels/ExportPanel.tsx
 M src/ui/shell/panels/FindPanel.tsx
 M src/ui/shell/panels/OcrPanel.tsx
 M src/ui/shell/panels/PagesPanel.tsx
 M src/ui/shell/pwa.ts
 M src/ui/shell/shell.css
 M src/ui/shell/tools.ts
 M src/ui/shell/uiStore.ts
 M src/ui/shell/util.ts
 M src/ui/tokens.css
A  src/ui/viewer/ContextMenu.tsx
M  src/ui/viewer/Overlays.tsx
M  src/ui/viewer/PageView.tsx
M  src/ui/viewer/Viewer.tsx
A  src/ui/viewer/actions.ts
M  src/ui/viewer/device.ts
A  src/ui/viewer/editor/FitChip.tsx
A  src/ui/viewer/editor/FontPicker.tsx
M  src/ui/viewer/editor/PhoneBar.tsx
M  src/ui/viewer/editor/StyleBar.tsx
M  src/ui/viewer/editor/TextEditor.tsx
M  src/ui/viewer/editor/controller.ts
A  src/ui/viewer/editor/fontFaces.ts
A  src/ui/viewer/editor/fontName.ts
M  src/ui/viewer/editor/textMetrics.ts
A  src/ui/viewer/editor/useFit.ts
M  src/ui/viewer/geometry.ts
M  src/ui/viewer/layers/EditTextLayer.tsx
A  src/ui/viewer/layers/FormLayer.tsx
M  src/ui/viewer/layers/PlaceLayer.tsx
M  src/ui/viewer/layers/SelectLayer.tsx
M  src/ui/viewer/pageData.ts
A  src/ui/viewer/useShortcuts.ts
M  src/ui/viewer/useViewport.ts
M  src/ui/viewer/viewer.css
M  src/ui/viewer/viewerStore.ts
M  tests/device/android.mjs
M  tests/device/phone.mjs
 M tests/e2e/document.spec.ts
M  tests/e2e/edit.spec.ts
 M tests/e2e/helpers.ts
M  tests/e2e/objects.spec.ts
 M tests/e2e/ui.spec.ts
?? public/404.html
?? public/fonts/
?? public/og.png
?? public/sample.pdf
?? public/screenshots/
?? public/sitemap.xml
?? scripts/make-previews.mjs
?? scripts/make-sample.mjs
?? src/ui/shell/Drafts.tsx
?? src/ui/shell/FinishSheet.tsx
?? src/ui/shell/Install.tsx
?? src/ui/shell/Shortcuts.tsx
?? src/ui/shell/Sidebar.tsx
?? src/ui/shell/boot.ts
?? src/ui/shell/errors.ts
?? src/ui/shell/incoming.ts
?? src/ui/shell/strings.ts
?? src/ui/shell/swipe.ts
?? tests/e2e/shell.spec.ts
```
<!-- handoff:auto:end -->
