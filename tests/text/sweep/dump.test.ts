/**
 * Prints the boxes of a page, optionally after edits:
 *   DUMP=file.pdf PAGE=0 GREP=text EDITS='[["old","new"]]' npx vitest run tests/text/sweep/dump.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { describe, it } from "vitest";
import { Engine } from "../../../src/engine/engine";
import { nodeAssets } from "../../fonts/nodeAssets";

describe.skipIf(!process.env.DUMP)("dump", () => {
  it("prints the boxes", async () => {
    const engine = new Engine(nodeAssets);
    await engine.open(new Uint8Array(fs.readFileSync(process.env.DUMP!)), "d.pdf");
    const page = Number(process.env.PAGE ?? 0);
    const show = async (label: string) => {
      const text = await engine.getPageText(page);
      const out = text.lines
        .filter((l) => !process.env.GREP || new RegExp(process.env.GREP).test(l.text))
        .map((l) => `${JSON.stringify(l.text)} [${l.rect.map((v) => v.toFixed(1))}] ${l.style.family} ${l.style.size}${l.style.bold ? " b" : ""}${l.style.italic ? " i" : ""} ${l.align}${l.editable ? "" : " RO"}`);
      process.stdout.write(`--- ${label} (${text.kind})\n${out.join("\n")}\n`);
    };
    await show("original");
    for (const [from, to] of JSON.parse(process.env.EDITS ?? "[]") as [string, string][]) {
      const line = (await engine.getPageText(page)).lines.find((l) => l.text === from);
      if (!line) {
        process.stdout.write(`no line ${JSON.stringify(from)}\n`);
        continue;
      }
      const r = await engine.editLines(page, [{ lineId: line.id, text: to }]);
      process.stdout.write(`edit ${JSON.stringify(from)} -> ${JSON.stringify(to)} ${JSON.stringify(r.warnings)} ${JSON.stringify(r.fallbackFonts)}\n`);
      await show("after");
    }
    if (process.env.PNG) {
      const p = engine.context.doc.loadPage(page);
      const scale = Number(process.env.SCALE ?? 1.5);
      fs.writeFileSync(path.resolve(process.env.PNG), p.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false).asPNG());
    }
  });
});
