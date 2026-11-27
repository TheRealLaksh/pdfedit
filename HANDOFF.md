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
- 27 Nov 2026: scaffold and contracts done and type-checking; module build by 7 parallel agents starting.

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

_Refreshed 27 Nov 2026, 9:14 pm IST by `scripts/handoff.mjs` (runs on every commit). Don't edit inside this block._

Branch: `main` · remote: none

### Last 15 commits

- `a7cf22a` 2026-11-27 21:13 docs: readme, module brief and handoff automation
- `239e715` 2026-11-27 21:13 chore: project setup, tooling and AGPL licence

### Uncommitted changes at refresh time

```
A  src/engine/context.ts
A  src/engine/geom.ts
A  src/engine/types.ts
?? src/App.tsx
?? src/engine/client.ts
?? src/engine/content/
?? src/engine/engine.ts
?? src/engine/fonts/
?? src/engine/ocr/
?? src/engine/ops/
?? src/engine/text/
?? src/engine/worker.ts
?? src/main.tsx
?? src/ocr/
?? src/store/
?? src/ui/
```
<!-- handoff:auto:end -->
