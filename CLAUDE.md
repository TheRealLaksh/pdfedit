# pdfedit

@HANDOFF.md

- Public AGPL repo: never commit secrets, personal files or real people's documents (test PDFs must be generated).
- Module ownership and rules: `docs/MODULES.md`. Contract: `src/engine/types.ts`.
- Checks: `npm run typecheck`, `npm test`, `npm run e2e`, `npm run build`.
- Never add features that hide that a PDF was edited (faked metadata, signature workarounds).
- Commits are the owner's own: no AI co-author lines.
