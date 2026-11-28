/**
 * Runs the box sweep over generated documents. Not part of the normal test run:
 *
 *   node tests/text/sweep/gen-html.mjs && python tests/text/sweep/gen-py.py && python tests/text/sweep/gen-scan.py
 *   node tests/text/sweep/run.mjs            (all documents, in parallel)
 *   python tests/text/sweep/show.py          (a sample of what failed)
 * The committed fixtures can be swept too: see corpus.mjs. dump.test.ts prints the boxes of one page.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { sweepDocument, summary } from "./sweep";

const dir = path.resolve(process.env.SWEEP_DIR ?? ".tmp/boxes/pdfs");
const out = path.resolve(process.env.SWEEP_OUT ?? ".tmp/boxes/out");
const only = process.env.SWEEP_ONLY?.split(",");

describe.skipIf(!process.env.SWEEP || !fs.existsSync(dir))("box sweep", () => {
  const ids = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".pdf"))
        .map((f) => f.slice(0, -4))
        .filter((id) => !only || only.includes(id))
    : [];
  for (const id of ids)
    it(
      id,
      async () => {
        const truthFile = path.join(dir, `${id}.json`);
        const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, "utf8")) : { producer: "?", pages: [] };
        const result = await sweepDocument(id, new Uint8Array(fs.readFileSync(path.join(dir, `${id}.pdf`))), truth, {
          out,
          every: Number(process.env.SWEEP_EVERY ?? 1),
        });
        fs.mkdirSync(path.join(out, "results"), { recursive: true });
        fs.writeFileSync(path.join(out, "results", `${id}.json`), JSON.stringify(result, null, 1));
        process.stdout.write(`${summary([result])}\n`);
      },
      3_600_000,
    );
});
