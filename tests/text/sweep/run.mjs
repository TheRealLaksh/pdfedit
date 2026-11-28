/**
 * Sweeps every generated document, several at a time, and prints the pass rates per document.
 *
 *   node tests/text/sweep/run.mjs [id ...]
 *   env: SWEEP_DIR, SWEEP_OUT, SWEEP_EVERY (edit only every n-th box), SWEEP_JOBS
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.resolve(process.env.SWEEP_DIR ?? ".tmp/boxes/pdfs");
const out = path.resolve(process.env.SWEEP_OUT ?? ".tmp/boxes/out");
const wanted = process.argv.slice(2);
const ids = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".pdf"))
  .map((f) => f.slice(0, -4))
  .filter((id) => !wanted.length || wanted.some((w) => id.includes(w)))
  .sort((a, b) => fs.statSync(path.join(dir, `${b}.pdf`)).size - fs.statSync(path.join(dir, `${a}.pdf`)).size);
for (const id of ids) fs.rmSync(path.join(out, "results", `${id}.json`), { force: true });
for (const folder of ["fail", "log"]) fs.mkdirSync(path.join(out, folder), { recursive: true });
for (const f of fs.readdirSync(path.join(out, "fail"))) if (ids.some((id) => f.startsWith(`${id}-`))) fs.rmSync(path.join(out, "fail", f));

const queue = [...ids];
const jobs = Number(process.env.SWEEP_JOBS ?? Math.min(10, Math.max(2, os.cpus().length >> 1)));
const one = (id) =>
  new Promise((resolve) => {
    const log = fs.openSync(path.join(out, "log", `${id}.log`), "w");
    const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/text/sweep/sweep.test.ts"], {
      env: { ...process.env, SWEEP: "1", SWEEP_ONLY: id },
      stdio: ["ignore", log, log],
    });
    child.on("exit", (code) => {
      console.log(`${code ? "FAILED to run" : "done"} ${id}`);
      resolve();
    });
  });
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (queue.length) await one(queue.shift());
  }),
);

const results = ids
  .sort()
  .map((id) => path.join(out, "results", `${id}.json`))
  .filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const columns = ["found", "sensible", "editable", "style-read", "bounds", "delete", "word", "append", "shorten", "twice", "restyle", "move", "sequence", "sequence-pixels"];
const total = {};
for (const r of results)
  for (const [k, [a, b]] of Object.entries(r.checks)) {
    total[k] ??= [0, 0];
    total[k][0] += a;
    total[k][1] += b;
  }
const cell = (c) => (c?.[1] ? (c[0] === c[1] ? "100" : ((100 * c[0]) / c[1]).toFixed(1)) : "-");
const rows = results.map((r) => [r.id, String(r.boxes), ...columns.map((c) => cell(r.checks[c]))]);
rows.push(["ALL", String(results.reduce((n, r) => n + r.boxes, 0)), ...columns.map((c) => cell(total[c]))]);
const head = ["document", "boxes", ...columns];
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => r.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ");
const table = [line(head), ...rows.map(line)].join("\n");
console.log(`\n${table}\n\ncounts: ${columns.map((c) => `${c} ${total[c]?.join("/") ?? "-"}`).join(", ")}`);
fs.writeFileSync(path.join(out, "summary.txt"), `${table}\n`);
const failures = results.flatMap((r) => r.failures.map((f) => ({ doc: r.id, ...f })));
fs.writeFileSync(path.join(out, "failures.json"), JSON.stringify(failures, null, 1));
console.log(`${failures.length} failures listed in ${path.join(out, "failures.json")}`);
