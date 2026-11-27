/** Adding things to the page: text, shapes, highlight, ink, images, whiteout and redaction. */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  ASSETS, changed, chooseFiles, chooseTool, compare, done, download, drag, expect, fixture, grow, history, idle,
  isPhone, open, openPanel, pointOnPage, readPdf, revision, state, tap, tapPage, test, toolbar,
} from "./helpers";

const ID = "en-truetype";
/** an empty area in the lower half of the fixture page */
const FROM: [number, number] = [80, 330];
const TO: [number, number] = [260, 420];
const AREA: [number, number, number, number] = [...FROM, ...TO];

async function settle(page: Page, before: number) {
  await changed(page, before);
}

test("adds a text box", async ({ page }) => {
  await open(page, ID);
  await chooseTool(page, "Add text");
  await tapPage(page, ID, 80, 340);
  const field = page.getByRole("textbox", { name: "Text", exact: true });
  await expect(field).toBeFocused();
  const before = await revision(page);
  await field.fill("Added by hand: नमस्ते");
  await done(page).click();
  await settle(page, before);
  const { bytes } = await download(page);
  expect(readPdf(bytes).text(0)).toContain("Added by hand");
  const difference = compare(ID, bytes, [60, 310, 420, 390]);
  expect(difference.inside).toBeGreaterThan(40);
  expect(difference.outside).toBeLessThan(10);
});

for (const tool of ["Rectangle", "Ellipse", "Line", "Arrow", "Whiteout", "Draw"] as const) {
  test(`draws with ${tool}, then undoes`, async ({ page }) => {
    await open(page, ID);
    await chooseTool(page, tool);
    const before = await revision(page);
    if (tool === "Whiteout") await drag(page, ID, [30, 80], [300, 130]);
    else await drag(page, ID, FROM, TO);
    if (tool === "Draw") await page.getByRole("button", { name: "Save" }).click();
    await settle(page, before);
    const { bytes } = await download(page);
    const area = tool === "Whiteout" ? ([30, 80, 300, 130] as [number, number, number, number]) : AREA;
    const difference = compare(ID, bytes, grow(area, 14));
    expect(difference.inside).toBeGreaterThan(40);
    expect(difference.outside).toBeLessThan(10);
    if (tool === "Whiteout") expect(readPdf(bytes).text(0), "whiteout only covers").toContain("Water level");
    await history(page, "undo");
    expect(compare(ID, (await download(page)).bytes, AREA).inside).toBeLessThan(10);
  });
}

test("highlighting snaps to the line it crosses", async ({ page }) => {
  await open(page, ID);
  const line = fixture(ID).pages[0]!.lines[1]!;
  await chooseTool(page, "Highlight");
  const before = await revision(page);
  const middle = (line.rect[1] + line.rect[3]) / 2;
  await drag(page, ID, [line.rect[0] + 2, middle - 1], [line.rect[2] - 2, middle + 1]);
  await settle(page, before);
  const { bytes } = await download(page);
  const difference = compare(ID, bytes, grow(line.rect, 3));
  expect(difference.inside).toBeGreaterThan(500);
  expect(difference.outside).toBeLessThan(30);
});

test("redaction asks first and removes the text for good", async ({ page }) => {
  await open(page, ID);
  const line = fixture(ID).pages[0]!.lines[2]!;
  await chooseTool(page, "Redact");
  const before = await revision(page);
  await drag(page, ID, [line.rect[0] - 3, line.rect[1] - 1], [line.rect[2] + 3, line.rect[3] + 1]);
  await expect(page.getByText(/Permanently remove/)).toBeVisible();
  await idle(page);
  expect(await revision(page), "nothing happens before the confirmation").toBe(before);
  await page.getByTestId("redact-confirm").click();
  await settle(page, before);
  const text = readPdf((await download(page)).bytes).text(0);
  expect(text).not.toContain("herons");
  expect(text).toContain("Water level");
});

test("places a picture, moves it and deletes it", async ({ page }) => {
  await open(page, ID);
  const trigger = async () => {
    if (isPhone(page)) {
      await toolbar(page).getByRole("button", { name: "More" }).click();
      return page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Image", exact: true });
    }
    return toolbar(page).getByRole("button", { name: "Image", exact: true });
  };
  await chooseFiles(page, await trigger(), join(ASSETS, "photo.png"));
  await expect(page.getByText(/Tap the page to place your image/)).toBeVisible();
  let before = await revision(page);
  await tapPage(page, ID, 170, 400);
  await settle(page, before);
  await expect.poll(async () => (await state(page)).selection?.type).toBe("object");
  let { bytes } = await download(page);
  expect(compare(ID, bytes, [20, 300, 320, 500]).inside).toBeGreaterThan(2000);

  // drag it somewhere else
  before = await revision(page);
  await drag(page, ID, [170, 400], [250, 480]);
  await settle(page, before);
  ({ bytes } = await download(page));
  expect(compare(ID, bytes, [100, 380, 410, 590]).outside, "moved away from the first place").toBeLessThan(10);

  await tap(page, await pointOnPage(page, ID, 0, 250, 480));
  before = await revision(page);
  await page.getByRole("toolbar", { name: "Selected item" }).getByRole("button", { name: "Delete" }).click();
  await settle(page, before);
  expect(compare(ID, (await download(page)).bytes, [0, 0, 1, 1]).outside).toBeLessThan(10);
});

test("selects and deletes an image that was already in the file", async ({ page }) => {
  await open(page, "images");
  await chooseTool(page, "Select");
  const before = await revision(page);
  // the list of pictures loads when the tool is chosen: tap again if the first tap was quicker than that
  await expect(async () => {
    await tapPage(page, "images", 130, 135);
    expect((await state(page)).selection?.type).toBe("image");
  }).toPass({ timeout: 10_000 });
  await page.getByRole("toolbar", { name: "Selected item" }).getByRole("button", { name: "Delete" }).click();
  await changed(page, before);
  const { bytes } = await download(page);
  expect(compare("images", bytes, [39, 74, 221, 196]).inside).toBeGreaterThan(2000);
  expect(compare("images", bytes, [39, 74, 221, 196]).outside).toBeLessThan(10);
});

test("adds a watermark and page numbers", async ({ page }) => {
  await open(page, "multipage");
  let dialog = await openPanel(page, "Watermark and numbers");
  await dialog.getByLabel("Watermark text").fill("CONFIDENTIAL");
  let before = await revision(page, 4);
  await dialog.getByRole("button", { name: "Add watermark" }).click();
  await changed(page, before, 4);
  if (!(await dialog.isVisible())) dialog = await openPanel(page, "Watermark and numbers");
  await dialog.getByRole("button", { name: "Page numbers", exact: true }).click();
  before = await revision(page, 4);
  await dialog.getByRole("button", { name: "Add page numbers" }).click();
  await changed(page, before, 4);
  await page.getByRole("button", { name: "Close panel" }).click();
  const pdf = readPdf((await download(page)).bytes);
  for (let i = 0; i < 5; i++) expect(pdf.text(i)).toContain("CONFIDENTIAL");
});
