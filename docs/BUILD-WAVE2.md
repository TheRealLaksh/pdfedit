# Build wave 2 (28 Nov 2026): from research to product

Research reports are in `.tmp/research/*.md` (screenshots beside them). Read the ones named for you, then build
their recommendations: highest user value first, finish each item properly, skip what conflicts with the rules.
Rules: `docs/RESEARCH-BRIEF.md` "Fixed rules" and `docs/MODULES.md`. The owner is away; decide yourself.

Four agents work at once in the same folder. Edit only your own files; report changes needed elsewhere. No git,
no npm install (name any package you truly need). Contract: `src/engine/types.ts` (new: `getLineFont`,
`getChoiceFont`, `ExportOptions.maxBytes`, `PreviewFont`; store: `image`, `openImage`, `closeImage`,
`openImagesAsPdf`). You may extend the contract additively in files you own. `tests/e2e/helpers.ts` is shared:
additive edits only. Another agent's half-written code can break a build for a minute: retry.

| Agent | Owns | Reports | Server |
|---|---|---|---|
| ENGINE | `src/engine/**`, `tests/{text,fonts,ops,ocr,integration}/**` | F1, F2, F3 (EXIF), R6 (1), R8 | none |
| VIEWER | `src/ui/viewer/**`, `tests/device/**`, `tests/e2e/{edit,phone,objects,ocr}.spec.ts` | R1, R3, R4, R7, F1, F2, R6 | `dist` on 4180 + Android emulator |
| SHELL | `src/App.tsx`, `src/ui/shell/**`, `src/ui/tokens.css`, `src/store/**`, `public/**`, `index.html`, other `tests/e2e/*.spec.ts` | R1-R7, R9, F1 | `--outDir .tmp/shell2/dist` on 4187 |
| IMAGE | `src/image/**`, `src/ocr/**`, `tests/image/**`, `tests/e2e/image.spec.ts` | F3, F2, R3 | `--outDir .tmp/img/dist` on 4186 |

## ENGINE
1. Privacy: no EXIF / GPS or other source metadata may survive images turned into PDF or added to a PDF
   (apply orientation, then strip); test it.
2. `getLineFont` (rebuild the embedded font so FontFace accepts it, with coverage) and `getChoiceFont`.
3. `ExportOptions.maxBytes`: downsample / recompress images step by step, report honestly if unreachable.
4. `listFonts` includes the document's fonts; better metric-based substitute matching.
5. Broken (unreadable) lines on otherwise good pages must be replaceable after OCR.
6. Appending Hindi to a Chromium Devanagari line squeezes the line and the new word looks heavier
   (`.tmp/device/docs/hindi.pdf`, line 4; make-docs in tests/device): fix. Fallback-font saves take 2-4 s: preload.
7. Overflow information so the UI can warn while typing and offer fit (a cheap measure call if needed).
8. Draft recovery: persist the replay journal of `client.ts` to IndexedDB (never passwords, skip protected
   files, size capped, one draft), with exported `loadDraft / restoreDraft / clearDraft` for the shell.

## VIEWER
Real fonts in the typing preview (use the two new engine calls with FontFace); searchable font picker with
live previews and "In this document"; previous / next line arrows; overflow warning with one-tap fit; action
bar for locked lines ("Read this page", "Cover and retype"); tap-to-fill form fields directly on the page;
fill marks (tick, cross, dot, date, initials) for flat forms; copy style and "identify font"; desktop context
menus, clipboard paste / copy / duplicate, keyboard basics (PageDown, Space, Esc); line buttons positioned over
their lines with visible focus; focus never lost to body; keyboard routes for adding and moving things. Verify on
the emulator with `tests/device/phone.mjs` and extend it.

## SHELL
Finish sheet after export (editable file name, Share via `navigator.share` from a fresh tap, Save, "Make it
under N KB"); resume draft (engine `loadDraft` etc.); share target and desktop file handlers; "Try a sample"
(own text, open fonts, precached); first-run hints; plain inline errors; notices that never cover the edited line,
persistent warnings, pause on focus, correct wording; visual direction from R5 (tokens, icons so Redact and
Rectangle differ, touch states, dark mode, start screen, grouped More sheet, one-row tool options); desktop
thumbnail sidebar and tool shortcuts with help; accessibility fixes in the shell; quiet install offer;
search-friendly start page, social preview image, sitemap. Keep UI strings plain and in one place where easy:
a translation pass follows this wave.

## IMAGE
The image text editor (`src/image/ImageEditor.tsx`, lazy loaded; one picture opens it, with a "Make a PDF
instead" button calling `openImagesAsPdf`). Open a photo, screenshot, poster or scan; recognise text (reuse
`recognizePage`, languages picker, auto); every found text is a box; tap and retype in matching font (search the
catalog by render-and-compare), size, weight, colour, angle, spacing, blur and grain; remove old text cleanly
(inpaint from `engine/ocr/ink.ts` ideas, no new dependencies unless essential); manual boxes with four corner
handles for missed or perspective text; all matched properties adjustable; undo / redo; compare with original;
export PNG / JPEG / WebP at the original pixel size with no source metadata and a plain "Edited with PDFEdit"
note; share. Works well on phones (pinch, keyboard never covers the text) and desktop; same design tokens. Judge
realism by looking at before / after crops at high zoom for screenshots, printed posters and phone photos you
generate yourself (several scripts).
