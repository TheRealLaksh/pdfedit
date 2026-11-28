/**
 * Prepares the committed fixture corpus for the box sweep:
 *   node tests/text/sweep/corpus.mjs && SWEEP_DIR=.tmp/boxes/corpus SWEEP_OUT=.tmp/boxes/corpus-out node tests/text/sweep/run.mjs
 */
import fs from "node:fs";
import path from "node:path";

const from = path.resolve("tests/fixtures/pdfs");
const out = path.resolve(process.argv[2] ?? ".tmp/boxes/corpus");
fs.mkdirSync(out, { recursive: true });
const { documents } = JSON.parse(fs.readFileSync(path.join(from, "manifest.json"), "utf8"));
let count = 0;
for (const d of documents) {
  // files whose text cannot be read from the page at all are covered by the OCR tests
  if (/^(scan-|broken-|story-|legacy-)/.test(d.id) || d.pageCount > 20) continue;
  const file = path.join(from, d.file);
  if (!fs.existsSync(file)) continue;
  fs.copyFileSync(file, path.join(out, `${d.id}.pdf`));
  const pages = d.pages.map((p) => ({ segments: (p.lines ?? []).map((l) => ({ text: l.text, rect: l.rect })) }));
  fs.writeFileSync(path.join(out, `${d.id}.json`), JSON.stringify({ producer: d.producer, password: d.password ?? undefined, pages }));
  count++;
}
console.log(count, "documents in", out);
