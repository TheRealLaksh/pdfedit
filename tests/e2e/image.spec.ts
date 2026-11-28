/** The picture text editor: open, read, retype, undo, draw a box, export with the plain note, leave. */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { chooseFiles, expect, isPhone, saved, start, test } from "./helpers";

test.describe.configure({ timeout: 150_000 });
// the recogniser writes harmless warnings to the console
test.beforeEach(({ guard }) => guard.allow(/console: (Warning[.:]|Estimating resolution|Detected \d+ diacritics)/));

const WIDTH = 760;
const HEIGHT = 420;

/** a made up shop sign, as a screenshot would look */
async function picture(page: Page): Promise<Buffer> {
  const tab = await page.context().browser()!.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await tab.setContent(`<body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#f4f1ea;font-family:Arial,sans-serif;color:#222">
    <div style="position:absolute;left:60px;top:60px;font-size:44px;font-weight:700">Corner Book Shop</div>
    <div style="position:absolute;left:60px;top:170px;font-size:30px">Opening hours 10 to 18</div>
    <div style="position:absolute;left:0;top:280px;width:100%;height:140px;background:#24406b"></div>
    <div style="position:absolute;left:60px;top:325px;font-size:34px;color:#fff">Readings every Friday</div>`);
  const png = await tab.screenshot();
  await tab.close();
  return png;
}

function decode(bytes: Uint8Array) {
  const pixmap = new mupdf.Image(bytes).toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
  return { width: pixmap.getWidth(), height: pixmap.getHeight(), stride: pixmap.getStride(), n: pixmap.getNumberOfComponents(), data: pixmap.getPixels().slice() };
}

/** number of clearly different pixels inside and outside a band of rows */
function difference(a: ReturnType<typeof decode>, b: ReturnType<typeof decode>, from: number, to: number) {
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = y * a.stride + x * a.n;
      const j = y * b.stride + x * b.n;
      const changed = Math.abs(a.data[i]! - b.data[j]!) + Math.abs(a.data[i + 1]! - b.data[j + 1]!) + Math.abs(a.data[i + 2]! - b.data[j + 2]!) > 0;
      if (!changed) continue;
      if (y >= from && y < to) inside++;
      else outside++;
    }
  return { inside, outside };
}

const app = (page: Page) => page.locator(".im-app");
const settled = (page: Page) => expect(app(page)).not.toHaveAttribute("data-working", "true", { timeout: 60_000 });
const textField = (page: Page) => page.locator("input.im-text");

async function openPictureEditor(page: Page, png: Buffer) {
  await start(page, { waitForEngine: false });
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), { name: "sign.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "Make a PDF instead" })).toBeEnabled();
  await expect(page.getByText(/pieces? of text found/)).toBeVisible({ timeout: 90_000 });
}

/** taps the picture at a picture coordinate */
async function tapPicture(page: Page, x: number, y: number, height = HEIGHT) {
  const box = (await page.locator(".im-canvas").boundingBox())!;
  const point = { x: box.x + (x / WIDTH) * box.width, y: box.y + (y / height) * box.height };
  if (isPhone(page)) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function exportPng(page: Page) {
  await page.getByRole("button", { name: "Export" }).click();
  const dialog = page.getByRole("dialog", { name: "Export picture" });
  await dialog.getByRole("button", { name: "PNG", exact: true }).click();
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  const file = await saved(page, () => save.click());
  await dialog.getByRole("button", { name: "Close" }).click();
  return file;
}

test("retypes a line of a picture and exports it with the plain note", async ({ page }) => {
  const png = await picture(page);
  await openPictureEditor(page, png);
  await expect(page.locator(".im-box")).toHaveCount(3);

  await tapPicture(page, 200, 188);
  await expect(textField(page)).toHaveValue("Opening hours 10 to 18");
  await settled(page);
  await textField(page).fill("Opening hours 11 to 20");
  await settled(page);
  await expect(page.locator(".im-box[data-edited]")).toHaveCount(1);

  // the field being typed in is on screen
  const field = (await textField(page).boundingBox())!;
  const visible = page.viewportSize()!;
  expect(field.y).toBeGreaterThanOrEqual(0);
  expect(field.y + field.height).toBeLessThanOrEqual(visible.height);

  // the matched face is a close relative of Arial
  await page.getByRole("tab", { name: "Style" }).click();
  await expect(page.locator(".im-fontbtn")).toContainText(/Arimo|Helvetica|Liberation/);
  await page.getByRole("button", { name: "Done" }).click();

  const file = await exportPng(page);
  expect(file.name).toBe("sign (edited).png");
  const raw = file.bytes.toString("latin1");
  expect(raw).toContain("Edited with PDFEdit");
  const before = decode(png);
  const after = decode(file.bytes);
  expect([after.width, after.height]).toEqual([WIDTH, HEIGHT]);
  const changed = difference(before, after, 160, 220);
  expect(changed.inside).toBeGreaterThan(60);
  expect(changed.outside).toBe(0);
});

test("a line of a device picture is recognised to its end", async ({ page }) => {
  // taken on Android, where the first reading stopped before "18" and took "10" for "70"
  await openPictureEditor(page, readFileSync("tests/image/fixtures/notice.png"));
  await expect(page.locator(".im-box")).toHaveCount(5);
  await tapPicture(page, 200, 170, 520);
  await expect(textField(page)).toHaveValue("Opening hours 10 to 18");
});

test("undo, redo and comparing with the original", async ({ page }) => {
  await openPictureEditor(page, await picture(page));
  await tapPicture(page, 240, 85);
  await expect(textField(page)).toHaveValue("Corner Book Shop");
  await settled(page);
  await textField(page).fill("Corner Tea Shop");
  await settled(page);

  const pixels = () => page.locator(".im-canvas").evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const edited = await pixels();
  const undo = page.getByRole("button", { name: "Undo" });
  await undo.click();
  await expect(textField(page)).toHaveValue("Corner Book Shop");
  await expect.poll(pixels).not.toBe(edited);
  const original = await pixels();
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(textField(page)).toHaveValue("Corner Tea Shop");
  await expect.poll(pixels).toBe(edited);

  const eye = page.getByRole("button", { name: "Hold to see the original" });
  await eye.dispatchEvent("keydown", { key: " " });
  await expect.poll(pixels).toBe(original);
  await eye.dispatchEvent("keyup", { key: " " });
  await expect.poll(pixels).toBe(edited);

  // leaving with changes asks first
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const leave = page.getByRole("dialog", { name: "Discard your changes?" });
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(app(page)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await leave.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
});

test("a box drawn by hand is read and can be retyped; corners move by keyboard", async ({ page }) => {
  await openPictureEditor(page, await picture(page));
  // remove the recognised box first, then draw it again
  await tapPicture(page, 250, 343);
  await page.getByRole("button", { name: "Delete box" }).click();
  await expect(page.locator(".im-box")).toHaveCount(2);
  await page.getByRole("button", { name: "Add text area" }).click();
  const box = (await page.locator(".im-canvas").boundingBox())!;
  const at = (x: number, y: number) => [box.x + (x / WIDTH) * box.width, box.y + (y / HEIGHT) * box.height] as const;
  await page.mouse.move(...at(50, 318));
  await page.mouse.down();
  await page.mouse.move(...at(300, 350), { steps: 4 });
  await page.mouse.move(...at(560, 372), { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".im-box")).toHaveCount(3);
  await expect(textField(page)).toHaveValue(/Readings every Friday/, { timeout: 60_000 });
  await settled(page);
  const corner = page.getByRole("button", { name: "Top left corner" });
  const where = (await corner.boundingBox())!;
  await corner.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => (await corner.boundingBox())!.x).toBeLessThan(where.x);
  await settled(page);
  await textField(page).fill("Readings every Sunday");
  await settled(page);
  await expect(page.locator(".im-box[data-edited]")).toHaveCount(1);
});

test("wording typed where the reading is corrected can be put on the picture", async ({ page }) => {
  await openPictureEditor(page, await picture(page));
  await tapPicture(page, 240, 85);
  await expect(textField(page)).toHaveValue("Corner Book Shop");
  await settled(page);
  const pixels = () => page.locator(".im-canvas").evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const before = await pixels();
  await page.getByText("Was the original read wrongly?").click();
  const reading = page.getByLabel("What the original says");
  await reading.fill("Corner Tea Shop");
  await reading.press("Enter");
  await expect(page.getByText("the picture has not changed")).toBeVisible();
  expect(await pixels()).toBe(before);
  await page.getByRole("button", { name: "Put it on the picture" }).click();
  await expect(textField(page)).toHaveValue("Corner Tea Shop");
  await expect.poll(pixels, { timeout: 60_000 }).not.toBe(before);
  await expect(page.locator(".im-box[data-edited]")).toHaveCount(1);
});

test("a picture can become a PDF instead", async ({ page }) => {
  await openPictureEditor(page, await picture(page));
  await page.getByRole("button", { name: "Make a PDF instead" }).click();
  await expect(page.locator('[data-page="0"] canvas').first()).toBeVisible({ timeout: 60_000 });
});
