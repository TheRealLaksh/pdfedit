/**
 * Detection measured on the app screenshots of ../replicas.ts.
 * Run:  RECALL=1 npx vitest run tests/image/tools/recall.test.ts      (RECALL=dashboard for one screen,
 * VERBOSE=1 to list what was missed; pictures are left in .tmp/img/replicas/)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";
import { detectText } from "../../../src/image/detect";
import { configureOcr, recognizePage, terminateOcr } from "../../../src/ocr";
import { closeBrowser, TESSDATA } from "../../ocr/helpers";
import { render, SCREENS, type Variant } from "../replicas";
import { score, type Score } from "../score";

const out = fileURLToPath(new URL("../../../.tmp/img/replicas/", import.meta.url));

const VARIANTS: Record<string, Variant[]> = {
  dashboard: [{ out: 520, dpr: 2, quality: 55 }, { out: 620, quality: 40 }, { out: 620, quality: 75 }, { out: 700, dpr: 2, quality: 60 }, { dpr: 2, quality: 75 }],
  "dashboard-hi": [{ out: 620, quality: 70 }, { out: 700, dpr: 2, quality: 60 }, { dpr: 2, quality: 75 }],
  buttons: [{ out: 520, dpr: 2, quality: 60 }, { quality: 55 }, { dpr: 2, quality: 75 }],
  "buttons-hi": [{ quality: 70 }, { dpr: 2, quality: 75 }],
  table: [{ out: 540, dpr: 2, quality: 55 }, { quality: 65 }, { dpr: 2, quality: 75 }],
  "table-hi": [{ quality: 70 }, { dpr: 2, quality: 75 }],
  dark: [{ out: 540, dpr: 2, quality: 55 }, { quality: 65 }, { dpr: 2, quality: 75 }],
  phone: [{ quality: 65 }, { dpr: 2, quality: 70 }, { dpr: 3, quality: 75 }],
  wordless: [{ quality: 60 }, { dpr: 2, quality: 70 }],
};

describe.skipIf(!process.env.RECALL)("recall", () => {
  afterAll(async () => {
    await terminateOcr();
    await closeBrowser();
  });
  it("measures the screenshots", { timeout: 1_200_000 }, async () => {
    configureOcr({ cachePath: TESSDATA });
    mkdirSync(out, { recursive: true });
    const only = process.env.RECALL === "1" ? null : process.env.RECALL!.split(",");
    const table: string[] = [];
    const sum = { total: 0, boxed: 0, exact: 0, boxes: 0, good: 0, ms: 0, calls: 0, chars: 0, weight: 0 };
    for (const [name, variants] of Object.entries(VARIANTS)) {
      if (only && !only.includes(name)) continue;
      const rows: (Score & { ms: number; calls: number })[] = [];
      for (const variant of variants) {
        const { picture, truth, jpeg } = await render(SCREENS[name as keyof typeof SCREENS], variant);
        const id = `${name}-${picture.width}-q${variant.quality}`;
        writeFileSync(`${out}${id}.jpg`, jpeg);
        let calls = 0;
        const started = Date.now();
        const found = await detectText(
          picture,
          (image, options) => (calls++, recognizePage(image, options)),
          { languages: name.endsWith("-hi") ? ["hin", "eng"] : [] },
        );
        const row = { ...score(found.boxes, truth), ms: Date.now() - started, calls };
        rows.push(row);
        if (process.env.VERBOSE)
          console.log(
            `${id} ${row.boxed}/${row.total} exact ${row.exact} junk ${row.junk.length} ${row.ms}ms ${calls} calls` +
              `\n  missed: ${row.missed.join(" | ")}\n  misread: ${row.misread.join(" | ")}\n  junk: ${row.junk.join(" | ")}`,
          );
      }
      const add = (k: "total" | "boxed" | "exact" | "boxes" | "good" | "ms" | "calls") => rows.reduce((s, r) => s + r[k], 0);
      const total = add("total");
      const chars = rows.reduce((s, r) => s + r.chars * r.total, 0);
      table.push(line(name, total, add("boxed"), add("exact"), chars / (total || 1), add("boxes"), add("good"), add("ms") / rows.length, add("calls") / rows.length));
      for (const k of ["total", "boxed", "exact", "boxes", "good", "ms", "calls"] as const) sum[k] += add(k);
      sum.chars += chars;
      sum.weight += rows.length;
    }
    table.push(line("ALL", sum.total, sum.boxed, sum.exact, sum.chars / (sum.total || 1), sum.boxes, sum.good, sum.ms / sum.weight, sum.calls / sum.weight));
    console.log(`screen         lines recall  exact  chars  boxes precision  ms/picture calls\n${table.join("\n")}`);
  });
});

function line(name: string, total: number, boxed: number, exact: number, chars: number, boxes: number, good: number, ms: number, calls: number) {
  const pc = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  return [name.padEnd(14), String(total).padStart(5), pc(boxed, total).padStart(6), pc(exact, total).padStart(6), pc(chars * total, total).padStart(6), String(boxes).padStart(6), pc(good, boxes).padStart(9), String(Math.round(ms)).padStart(11), String(Math.round(calls)).padStart(5)].join(" ");
}
