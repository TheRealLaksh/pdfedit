// Draws the link preview card (public/og.png) and the install screenshots (public/screenshots/) from a
// running build: node scripts/make-previews.mjs [url]   (default http://localhost:4187/)
import { mkdir, readFile } from "node:fs/promises";
import { chromium, devices } from "playwright";

const url = process.argv[2] ?? "http://localhost:4187/";
const browser = await chromium.launch();
await mkdir("public/screenshots", { recursive: true });

const data = async (path, type) => `data:${type};base64,${(await readFile(path)).toString("base64")}`;
const caslon = await data("public/fonts/caslon-400.ttf", "font/ttf");
const icon = await data("public/icon.svg", "image/svg+xml");

// one line of a receipt, before and after
const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await card.setContent(`<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: C; src: url(${caslon}); }
  body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #eceef1; color: #16181d; font: 26px/1.4 "Segoe UI", system-ui, sans-serif; }
  .name { position: absolute; top: 52px; left: 64px; display: flex; align-items: center; gap: 16px; font: 38px C, serif; }
  h1 { position: absolute; top: 150px; left: 64px; width: 500px; margin: 0; font: 400 68px/1.12 C, serif; }
  p.lead { position: absolute; top: 420px; left: 64px; width: 470px; margin: 0; color: #545a66; }
  .paper { position: absolute; top: 76px; left: 624px; width: 512px; height: 600px; padding: 54px 44px; box-sizing: border-box; background: #fff; box-shadow: 0 2px 4px rgb(16 20 30 / .12), 0 30px 60px -30px rgb(16 20 30 / .4); }
  .title { font: 34px C, serif; margin-bottom: 8px; }
  .muted { color: #545a66; font-size: 19px; padding-bottom: 22px; border-bottom: 2px solid #16181d; margin-bottom: 26px; }
  .row { display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #dcdfe5; font-size: 22px; }
  .edit { position: relative; margin: 30px -12px 0; padding: 12px; border: 2px solid #2b4fd8; background: rgb(43 79 216 / .05); font-size: 26px; font-weight: 600; }
  .edit i { position: absolute; width: 10px; height: 10px; background: #2b4fd8; }
  .caret { display: inline-block; width: 2px; height: 28px; margin-left: 2px; background: #2b4fd8; vertical-align: -5px; }
  .was { margin-top: 18px; color: #545a66; font-size: 19px; }
  s { text-decoration-thickness: 2px; }
</style>
<div class="name"><img src="${icon}" width="48" height="48" alt="">PDFEdit</div>
<h1>Edit the text in any PDF</h1>
<p class="lead">Same font, same place. Free, no account, and the file stays on your device.</p>
<div class="paper">
  <div class="title">Riverside Garden Club</div>
  <div class="muted">Spring membership, receipt 2041</div>
  <div class="row"><span>Yearly membership</span><span>1,200.00</span></div>
  <div class="row"><span>Compost, 25 kg bag</span><span>540.00</span></div>
  <div class="edit">Opens on Saturday 19 April<span class="caret"></span>
    <i style="top:-6px;left:-6px"></i><i style="top:-6px;right:-6px"></i><i style="bottom:-6px;left:-6px"></i><i style="bottom:-6px;right:-6px"></i></div>
  <div class="was">Was: <s>Opens on Saturday 12 April</s></div>
</div>`);
await card.evaluate(() => document.fonts.ready);
await card.screenshot({ path: "public/og.png" });

const shot = async (options, file) => {
  const context = await browser.newContext({ ...options, colorScheme: "light", serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Try a sample" }).click();
  await page.locator('[data-page="0"] canvas').first().waitFor({ timeout: 40_000 });
  await page.waitForTimeout(1000);
  // no passing notes or hints in the picture
  for (const button of await page.getByRole("button", { name: "Dismiss notice" }).all()) await button.click().catch(() => {});
  await page.waitForTimeout(5000);
  await page.screenshot({ path: file });
  await context.close();
};
await shot({ ...devices["Pixel 7"], viewport: { width: 412, height: 839 }, deviceScaleFactor: 2 }, "public/screenshots/phone.png");
await shot({ viewport: { width: 1366, height: 800 } }, "public/screenshots/desktop.png");
await browser.close();
