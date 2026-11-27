/** Signing: drawn, typed and uploaded signatures. */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  ASSETS, changed, chooseFiles, compare, download, expect, idle, open, openPanel, revision, state, tapPage, test,
} from "./helpers";

const ID = "en-truetype";
const AREA: [number, number, number, number] = [60, 330, 340, 470];

async function drawOnPad(page: Page) {
  const pad = page.getByRole("img", { name: /Signature drawing area/ });
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++)
    await page.mouse.move(box.x + box.width * (0.15 + i * 0.06), box.y + box.height * (0.5 + (i % 2 ? -0.2 : 0.2)), { steps: 3 });
  await page.mouse.up();
}

async function placeAndCheck(page: Page) {
  await expect(page.getByText(/Tap the page to place your/)).toBeVisible();
  const before = await revision(page);
  await tapPage(page, ID, 200, 400);
  await changed(page, before);
  const { bytes } = await download(page);
  const difference = compare(ID, bytes, AREA);
  expect(difference.inside).toBeGreaterThan(60);
  expect(difference.outside).toBeLessThan(10);
}

test("draw a signature and place it", async ({ page }) => {
  await open(page, ID);
  const dialog = await openPanel(page, "Signature");
  const use = dialog.getByRole("button", { name: "Use signature" });
  await expect(use).toBeDisabled();
  await drawOnPad(page);
  await use.click();
  await placeAndCheck(page);
});

test("remembers a signature only when asked", async ({ page }) => {
  await open(page, ID);
  let dialog = await openPanel(page, "Signature");
  await drawOnPad(page);
  await dialog.getByRole("button", { name: "Use signature" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openPanel(page, "Signature");
  await expect(dialog.getByRole("button", { name: "Use saved signature 1" })).toHaveCount(0);
  await drawOnPad(page);
  await dialog.getByLabel(/Remember on this device/).check();
  await dialog.getByRole("button", { name: "Use signature" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  // a fresh visit
  await open(page, ID);
  dialog = await openPanel(page, "Signature");
  await dialog.getByRole("button", { name: "Use saved signature 1" }).click();
  await placeAndCheck(page);
});

test("type a signature", async ({ page }) => {
  await open(page, ID);
  const dialog = await openPanel(page, "Signature");
  await dialog.getByRole("button", { name: "Type", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Your name" }).fill("Asha Example");
  await dialog.getByRole("button", { name: "Use signature" }).click();
  await placeAndCheck(page);
});

test("upload a photo of a signature", async ({ page }) => {
  await open(page, ID);
  const dialog = await openPanel(page, "Signature");
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await chooseFiles(page, dialog.getByRole("button", { name: "Choose an image" }), join(ASSETS, "signature.png"));
  await expect(dialog.getByRole("img", { name: "Signature preview" })).toBeVisible();
  await expect(dialog.getByLabel("Remove the paper background")).toBeChecked();
  await dialog.getByRole("button", { name: "Use signature" }).click();
  await placeAndCheck(page);
  await idle(page);
  expect((await state(page)).canUndo).toBe(true);
});
