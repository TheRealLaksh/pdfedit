/** Prints what is found on the generated scenes. Run: DETECT=hindi.jpg,poster.jpg npx vitest run tests/image/tools/detect.test.ts */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";
import { detectText } from "../../../src/image/detect";
import { configureOcr, recognizePage, terminateOcr } from "../../../src/ocr";
import { TESSDATA } from "../../ocr/helpers";
import { decode } from "../helpers";

describe.skipIf(!process.env.DETECT)("detection", () => {
  afterAll(() => terminateOcr());
  it("reads the scenes", { timeout: 600_000 }, async () => {
    configureOcr({ cachePath: TESSDATA });
    for (const file of process.env.DETECT!.split(",")) {
      const picture = decode(readFileSync(fileURLToPath(new URL(`../../../.tmp/img/scenes/${file}`, import.meta.url))));
      const t = Date.now();
      const r = await detectText(picture, recognizePage, { languages: process.env.LANGS?.split(",") ?? [] });
      console.log(file, `${Date.now() - t}ms`, r.languages.join(), r.boxes.map((b) => `${b.text} (${b.confidence})`).join(" | "));
    }
  });
});
