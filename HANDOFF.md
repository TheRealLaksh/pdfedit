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
- 28 Nov 2026 evening: **live** with the second round: new phone editing (type in the line), text-box fixes,
  features from 13 research reports, and the **image text editor** (`src/image`).
- Checks: typecheck clean; vitest 1182 passed, 44 skipped (under full load 2 files failed to load / timed out
  once; both pass alone, 16/16); Playwright on the live site 373 passed, 61 skipped, 1 iPhone image test
  failed once and passed 4/4 on rerun. Real touches on an Android emulator (`tests/device/`).
- Not verified: any real phone, iPhone behaviour beyond WebKit emulation, real photos in the image editor.

### Known limits
- No paragraph reflow; longer text can overrun cells or columns (the editor warns and offers to fit).
- Substitute fonts can look different, notably CJK. No typing preview for Type1/Type3 or Indic subsets without
  shaping tables.
- Re-editing can be unreliable after whole-line rewrites in Arabic, Hebrew, Urdu Nastaliq and some Word
  Indic/Thai files.
- Replaced scan text is covered, not erased. OCR accuracy depends on the picture.
- Image editor: new letters can look slightly paler in screen text and Courier/Consolas; busy backgrounds can
  leave smudges; no outlines, soft shadows, gradients or curved text; perspective needs manual corners; huge
  pictures are downscaled; a Hindi-heavy page was once auto-detected as Thai (pick the language).
- Large files (150 MB+) use a lot of memory; not measured since the engine changes.
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
1. Laksh: try it on your own phone (typing, tables, a photo in the image editor) and note what looks off.
2. Interface translation: Laksh said not now (28 Nov). Plan kept in `.tmp/research/R10-ui-i18n.md`.
3. Smaller items from the research: recent files, camera scan, print, large-file memory, paragraph reflow.

## Open questions / waiting on others
- Block editing of identity documents in the image editor? Offered 2026-11-28, Laksh said not now. No such check exists.
- Enable Android "share to PDFEdit" (`share_target`)? Left off: if the service worker were evicted, a shared file
  would be sent to the server. One manifest key; handling is built.

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
- 2026-11-28: identity-document block in the image editor offered and put on hold. No code change.
- 2026-11-28/29: image editor: drag a line to move it (finger: tap first), arrow keys; small tabs, badges and
  buttons detected (generated-replica recall 67% to 92%); Indian-script + English lines read in auto; doubtful
  readings change only edited words or draw nothing until confirmed. Tested on generated notices, not on ID documents.
- 2026-11-28: Laksh reported an image edit that did not show: they typed in the reading-correction field. That field
  is now folded away ("Was the original read wrongly?"), the main field is labelled "New text (changes the
  picture)", and a correction offers "Put it on the picture". Image e2e 18/18; deployed.
- 2026-11-28 evening: Laksh put the Hindi interface translation on hold. No code change.
- 2026-11-28 evening: build wave 2 and image editor merged, tested, deployed; live checks above.
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

_Refreshed 28 Nov 2026, 8:51 pm IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: https://github.com/TheRealLaksh/pdfedit.git

### Last 15 commits

- `090c844` 2026-11-28 20:40 feat(image): drag text to move it
- `6b841b1` 2026-11-28 20:40 feat(image): find small labels, read mixed-script lines and never redraw doubtful text
- `645609d` 2026-11-28 18:18 fix(image): make it obvious which field changes the picture
- `4668201` 2026-11-28 18:12 docs: interface translation on hold
- `6e9f750` 2026-11-28 18:07 docs: status after the second release
- `402a5d6` 2026-11-28 17:48 test(device): retry the screen dump on a busy phone
- `deca56d` 2026-11-28 17:45 fix(image): whole lines are boxed and digits read reliably
- `0921e0c` 2026-11-28 17:28 fix(image): show the whole picture when drawing a new text area
- `f752bd8` 2026-11-28 17:10 feat(shell): finish sheet, drafts, sample, thumbnails, new design, install and search pages
- `7487e0e` 2026-11-28 17:10 feat(viewer): real font preview and picker, overflow fit, form filling, fill marks, menus and keyboard use
- `aa564f2` 2026-11-28 16:41 feat(image): edit the text inside pictures with matched fonts and rebuilt backgrounds
- `4135e0c` 2026-11-28 16:03 feat(engine): real preview fonts, size-limited export, drafts, private image metadata stripped
- `9e68e69` 2026-11-28 09:21 docs: build plan from the research round
- `8b7faa1` 2026-11-28 09:20 feat: contracts for faithful typing previews, size-limited export and an image editor
- `d8569fc` 2026-11-28 09:00 test(phone): device checklist and phone browser tests

### Uncommitted changes at refresh time

```
M  HANDOFF.md
```
<!-- handoff:auto:end -->
