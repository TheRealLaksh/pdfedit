/** A full A4 page as offices produce them: columns, a ruled table, a dark band, an underlined link. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { PageText, TextLine } from "../../src/engine/types";
import { configureOcr, OCR_SCALE, recognizePage, terminateOcr } from "../../src/ocr";
import { createNodeAssets } from "../fonts/nodeAssets";
import { closeBrowser, decode, degrade, launch, render, savePage, scanPdf, TESSDATA, type Bitmap } from "./helpers";

vi.mock("../../src/engine/text", () => ({
  analyzePage: (_ctx: unknown, page: number) => ({ page, revision: 0, kind: "scanned", lines: [] }),
}));

async function page(): Promise<Bitmap> {
  const context = await (await launch()).newContext({ viewport: { width: 595, height: 842 }, deviceScaleFactor: 300 / 72 });
  const tab = await context.newPage();
  const para = "The harbour committee reviewed the annual accounts and agreed that the northern pier needs urgent repair before winter arrives. ".repeat(3);
  const rows = [1, 2, 3, 4]
    .map((i) => `<tr><td>Item number ${i}</td><td style="text-align:right">${i * 1234}.50</td></tr>`)
    .join("");
  await tab.setContent(`<!doctype html><style>td{border:1px solid #000;padding:3px;font-size:12px}</style>
<body style="margin:50px;font:11px Calibri;line-height:16px;text-align:justify">
<h2 style="font:bold 18px Arial">Minutes of the annual meeting</h2>
<div style="column-count:2;column-gap:24px"><p>${para}</p><p>${para}</p></div>
<table style="border-collapse:collapse;width:100%">${rows}</table>
<div style="background:#222;color:#fff;padding:6px;margin-top:14px">White heading on a dark band</div>
<p style="color:#1a3fb0;text-decoration:underline">A blue underlined link to the old archive</p>`);
  const png = await tab.screenshot();
  await context.close();
  return decode(png);
}

describe("an office page", () => {
  let engine: Engine;
  let text: PageText;
  beforeAll(async () => {
    configureOcr({ cachePath: TESSDATA });
    engine = new Engine(createNodeAssets());
    const scan = degrade(await page(), { noise: 5, skew: -0.5, paper: [246, 243, 233], shade: 0.08 });
    await engine.open(scanPdf(scan, { size: [595, 842], jpeg: 75 }), "minutes.pdf");
    const image = await engine.renderPage(0, OCR_SCALE);
    await engine.setOcrResult(await recognizePage(image, { languages: [], scale: OCR_SCALE }));
    text = await engine.getPageText(0);
  }, 120_000);
  afterAll(async () => {
    await terminateOcr();
    await closeBrowser();
  });

  const find = (part: string): TextLine => {
    const line = text.lines.find((l) => l.text.includes(part));
    expect(line, `${part}: ${text.lines.map((l) => l.text).join(" / ")}`).toBeTruthy();
    return line!;
  };

  it("reads cells separately with believable size and alignment", () => {
    const cell = find("number 2");
    const figure = find("2468.50");
    expect(cell.id).not.toBe(figure.id);
    expect(figure.text).toBe("2468.50");
    for (const l of [cell, figure]) expect(Math.abs(l.style.size - 12)).toBeLessThanOrEqual(2.5);
    expect(figure.align).toBe("right");
    expect(cell.align).toBe("left");
    const body = find("reviewed the annual");
    expect(Math.abs(body.style.size - 11)).toBeLessThan(1.3);
    expect(body.style.serif).toBe(false);
    expect(find("Minutes").style.bold).toBe(true);
    expect(find("underlined link").style.underline).toBe(true);
    // white on dark
    expect(Math.min(...find("dark band").style.color)).toBeGreaterThan(0.6);
  });

  it("rewrites cells, the band and the link without touching the rules", async () => {
    savePage(engine.context.doc, "office-0-before.png", 0, 2.5);
    const s = 200 / 72;
    const before = render(engine.context.doc, 0, s);
    const targets = [find("number 2"), find("2468.50"), find("dark band"), find("underlined link")];
    await engine.editLines(0, [
      { lineId: targets[0]!.id, text: "Boat fees" },
      { lineId: targets[1]!.id, text: "19,999.00" },
      { lineId: targets[2]!.id, text: "Notices for all members" },
      { lineId: targets[3]!.id, text: "A blue link to the new library" },
    ]);
    savePage(engine.context.doc, "office-1-edited.png", 0, 2.5);
    const after = render(engine.context.doc, 0, s);
    const now = (await engine.getPageText(0)).lines;
    const figure = now.find((l) => l.id === targets[1]!.id)!;
    // right aligned figures keep their right edge, so a longer number stays inside the cell
    expect(Math.abs(figure.rect[2] - targets[1]!.rect[2])).toBeLessThan(2);
    expect(now.find((l) => l.id === targets[3]!.id)!.style.underline).toBe(true);
    // the original underline went with its text: nothing blue is left past the end of the new one
    const link = now.find((l) => l.id === targets[3]!.id)!;
    let blue = 0;
    for (let x = Math.ceil((link.rect[2] + 3) * s); x < (targets[3]!.rect[2] + 1) * s; x++)
      for (let y = Math.floor(link.rect[1] * s); y < (targets[3]!.rect[3] + 3) * s; y++) {
        const i = (y * after.width + x) * 4;
        if (after.data[i + 2]! - after.data[i]! > 60) blue++;
      }
    expect(blue).toBeLessThan(10);
    // table rules: every long dark run that existed is still there
    let lost = 0;
    let ruled = 0;
    for (let y = 0; y < before.height; y++) {
      let run = 0;
      for (let x = 0; x <= before.width; x++) {
        if (x < before.width && before.data[(y * before.width + x) * 4]! < 90) run++;
        else {
          if (run > 150 * s) {
            for (let k = x - run; k < x; k++) {
              ruled++;
              if (after.data[(y * after.width + k) * 4]! > 150) lost++;
            }
          }
          run = 0;
        }
      }
    }
    expect(ruled).toBeGreaterThan(1000);
    expect(lost / ruled).toBeLessThan(0.002);
    const reread = await recognizePage(await engine.renderPage(0, OCR_SCALE), { languages: ["eng"], scale: OCR_SCALE });
    const words = reread.lines.map((l) => l.text).join("\n");
    for (const expected of ["Boat fees", "19,999.00", "Notices for all members", "new library"]) expect(words).toContain(expected);
    expect(words).not.toContain("2468");
  }, 180_000);
});
