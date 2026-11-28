import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const textField = (page: Page) => page.locator("input.im-text");

async function openNotice(page: Page) {
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles({ name: "notice.png", mimeType: "image/png", buffer: readFileSync("tests/image/fixtures/notice.png") });
  await expect(page.locator(".im-box")).toHaveCount(5, { timeout: 120_000 });
}

const firstBox = (page: Page) => page.locator(".im-box").first();
const centre = async (page: Page) => {
  const r = (await firstBox(page).boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
const pixels = (page: Page) => page.locator(".im-canvas").evaluate((c: HTMLCanvasElement) => c.toDataURL());

test("a line can be dragged somewhere else, and undone", async ({ page }) => {
  await openNotice(page);
  // choose it first: with a finger only the chosen line can be picked up
  const at = await centre(page);
  await page.mouse.click(at.x, at.y);
  await expect(textField(page)).not.toHaveValue("", { timeout: 60_000 });
  await expect(page.locator(".im-spin")).toHaveCount(0, { timeout: 60_000 });
  await page.waitForTimeout(800);
  const before = await pixels(page);
  const from = await centre(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 25, { steps: 4 });
  await page.mouse.move(from.x + 40, from.y + 60, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".im-box[data-edited]")).toHaveCount(1);
  await expect.poll(() => pixels(page), { timeout: 60_000 }).not.toBe(before);
  await expect.poll(async () => (await centre(page)).y).toBeGreaterThan(from.y + 20);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => pixels(page), { timeout: 60_000 }).toBe(before);
});

test("arrow keys move the chosen line", async ({ page }) => {
  await openNotice(page);
  const at = await centre(page);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator(".im-spin")).toHaveCount(0, { timeout: 60_000 });
  await page.waitForTimeout(800);
  const before = await pixels(page);
  await firstBox(page).focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => pixels(page), { timeout: 60_000 }).not.toBe(before);
  await expect(page.locator(".im-box[data-edited]")).toHaveCount(1);
});

test("a finger drags the chosen line, and pans elsewhere", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium" || !info.project.use.hasTouch, "real touch events need a Chromium phone");
  await openNotice(page);
  const at = await centre(page);
  await page.touchscreen.tap(at.x, at.y);
  await expect(page.locator(".im-spin")).toHaveCount(0, { timeout: 60_000 });
  await page.waitForTimeout(800);
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (x: number, y: number, dx: number, dy: number) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const before = await pixels(page);
  const from = await centre(page);
  await swipe(from.x, from.y, 30, 50);
  await expect(page.locator(".im-box[data-edited]")).toHaveCount(1);
  await expect.poll(() => pixels(page), { timeout: 60_000 }).not.toBe(before);
  const landed = await centre(page);
  expect(landed.y).toBeGreaterThan(from.y + 20);
  // a swipe on bare picture moves the view, not the text
  const edited = await pixels(page);
  const sheet = (await page.locator(".im-stage").boundingBox())!;
  await swipe(sheet.x + 24, sheet.y + 24, 0, 40);
  await page.waitForTimeout(600);
  expect(await pixels(page)).toBe(edited);
});
