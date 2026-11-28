/**
 * Edits lines of the generated scenes and writes before / after crops to .tmp/img/out/ for looking at.
 * Run:  SCENES=screen1:amount,button npx vitest run tests/image/tools/harness.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { ImageSession } from "../../../src/image/session";
import type { Quad4 } from "../../../src/image/types";
import { createNodeAssets } from "../../fonts/nodeAssets";
import { apply, bounds, crop, decode, png, sheet } from "../helpers";

const root = fileURLToPath(new URL("../../../.tmp/img/", import.meta.url));

const EDITS: Record<string, string> = {
  "screen1:amount": "₹52,930.40", "screen1:button": "Transfer now", "screen1:nav2": "Settlements", "screen1:note": "Next payout on 19 April 2027", "screen1:r1b": "Silver Oak Bakery", "screen1:r2c": "31,465.00", "screen1:title": "Southwind Payments",
  "screen2:amount": "₹52,930.40", "screen2:button": "Transfer now", "screen2:note": "Next payout on 19 April 2027", "screen2:r1b": "Silver Oak Bakery", "screen2:r2c": "31,465.00",
  "poster:kicker": "ANNUAL STREET BOOK FAIR", "poster:head": "Monsoon Bazaar", "poster:date": "SUNDAY 22 AUGUST", "poster:price": "Entry Rs 200 per person", "poster:place": "Hillside Grounds, Gate 7",
  "receipt:date": "Date: 23 November 2027", "receipt:total": "Total payable: Rs 2,980.00", "receipt:p1": "4,815.00", "receipt:shop": "Greenfield Garden Store",
  "scan:date": "Date: 23 November 2027", "scan:total": "Total payable: Rs 2,980.00", "scan:thanks": "Thank you for visiting our store.", "scan:stamp": "Ref no. GH-90342-LM",
  "brick:open": "OPEN SUNDAY", "brick:hours": "From 8 am to 10 pm",
  "hindi:h1": "ताज़ा दूध और सब्ज़ियाँ", "hindi:h3": "Fresh from nearby farms",
};

describe.skipIf(!process.env.SCENES)("scenes", () => {
  const assets = createNodeAssets();
  const truth = process.env.SCENES ? JSON.parse(readFileSync(root + "scenes/truth.json", "utf8")) : {};
  for (const spec of (process.env.SCENES ?? "").split(";").filter(Boolean)) {
    const [scene, list] = spec.split(":") as [string, string];
    it(scene, { timeout: 600_000 }, async () => {
      mkdirSync(root + "out", { recursive: true });
      const file = ["png", "jpg"].map((e) => `${root}scenes/${scene.replace(/^screen(\d)$/, "screen$1")}.${e}`);
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(file[0]!);
      } catch {
        bytes = readFileSync(file[1]!);
      }
      const picture = decode(bytes);
      const session = new ImageSession(picture, assets);
      let after = picture;
      const crops = [];
      for (const id of list.split(",")) {
        const found = truth[scene].find((b: { id: string }) => b.id === id);
        // as loose as a recogniser's box
        const quad = found.quad as Quad4;
        const box = { id, quad, text: found.text as string, source: "ocr" as const };
        const t0 = Date.now();
        const a = await session.analyze(box);
        const t1 = Date.now();
        const text = process.env.ERASE ? "" : process.env.SAME ? box.text.slice(0, -1) + (box.text.endsWith("x") ? "y" : "x") : (EDITS[`${scene}:${id}`] ?? box.text);
        const r = await session.render(box, { text, keep: process.env.KEEP !== "0" });
        console.log(
          `${scene}:${id} ${a.style.font} ${a.style.weight}${a.style.italic ? "i" : ""} size ${a.style.size.toFixed(1)} x${a.style.stretch.toFixed(3)} sp ${a.style.spacing.toFixed(1)} th ${a.style.thickness.toFixed(2)} g ${a.style.gamma.toFixed(2)} blur ${a.style.blur.toFixed(2)} grain ${a.style.grain.toFixed(1)} sub ${a.style.subpixel} rgb ${a.style.color} score ${a.candidates[0]?.score} blank ${a.blank} busy ${a.busy} kept ${r.kept} | ${t1 - t0}ms + ${Date.now() - t1}ms | ${a.candidates.slice(0, 4).map((c) => `${c.font}/${c.weight}=${c.score}`).join(" ")}`,
        );
        after = apply(after, r.patch);
        const [x0, y0, x1, y1] = bounds(a.quad);
        const [u0, v0, u1, v1] = bounds(r.quad);
        const pad = (y1 - y0) * 0.5;
        const area = [Math.min(x0, u0) - pad, Math.min(y0, v0) - pad, Math.max(x1, u1) + pad, Math.max(y1, v1) + pad] as const;
        const zoom = Math.max(1, Math.min(6, Math.floor(1100 / (area[2] - area[0]))));
        crops.push(crop(picture, ...area, zoom), crop(apply(picture, r.patch), ...area, zoom), crop(picture, 0, 0, 40, 4));
      }
      writeFileSync(`${root}out/${scene}${process.env.TAG ?? ""}.png`, png(sheet(crops)));
      writeFileSync(`${root}out/${scene}-full.png`, png(after));
    });
  }
});
