/** Desktop habits: several files at once, interrupted work, keyboard shortcuts and short windows. */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  ASSETS, changed, chooseFiles, download, expect, fixturePath, idle, isPhone, open, openPanel, readPdf, revision, start,
  state, test, toolbar,
} from "./helpers";

test.beforeEach(({ page }) => {
  test.skip(isPhone(page), "desktop behaviour");
});

const choose = (page: Page, files: Parameters<typeof chooseFiles>[2]) =>
  chooseFiles(page, page.getByRole("button", { name: "Choose file" }), files);

test("files chosen with a protected PDF wait for it, in the order picked", async ({ page }) => {
  await open(page, "en-truetype");
  const picker = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+o");
  await (await picker).setFiles([join(ASSETS, "photo.png"), fixturePath("password-aes256"), fixturePath("multipage")]);
  const dialog = page.getByRole("dialog", { name: "Password needed" });
  await expect(dialog).toBeVisible();
  expect((await state(page)).doc!.pageCount, "nothing is added to the document still open").toBe(1);
  await dialog.getByLabel("Password", { exact: true }).fill("test1234");
  await dialog.getByRole("button", { name: "Open" }).click();
  await expect.poll(async () => (await state(page)).doc!.pageCount).toBe(7);
  await idle(page);
  expect((await state(page)).doc!.fileName).toBe("password-aes256.pdf");
  const pdf = readPdf((await download(page)).bytes);
  expect(pdf.text(0).trim(), "the picture chosen first comes first").toBe("");
  expect(pdf.text(1)).toContain("Field notes");
  expect(pdf.text(2)).toContain("Chapter alpha");
});

test("a broken picture does not wreck the open document", async ({ page }) => {
  await open(page, "en-truetype");
  await page.getByRole("banner").getByRole("button", { name: "More" }).click();
  await chooseFiles(page, page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Open another file" }), {
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a picture"),
  });
  await expect(page.getByText(/broken\.png could not be read/)).toBeVisible();
  await idle(page);
  expect(readPdf((await download(page)).bytes).text(0)).toContain("Field notes");
});

test("downloading some pages keeps the unsaved warning", async ({ page }) => {
  await start(page);
  await choose(page, [fixturePath("en-truetype"), fixturePath("multipage")]);
  await expect.poll(async () => (await state(page)).doc?.pageCount).toBe(6);
  await idle(page);
  const panel = await openPanel(page, "Download");
  await panel.getByRole("button", { name: "This page" }).click();
  const waiting = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download PDF" }).click();
  await waiting;
  await idle(page);
  expect((await state(page)).dirty).toBe(true);
});

test("Escape drops a waiting picture and returns to text editing", async ({ page }) => {
  await open(page, "en-truetype");
  await chooseFiles(page, toolbar(page).getByRole("button", { name: "Image", exact: true }), join(ASSETS, "photo.png"));
  await expect(page.getByText(/Tap the page to place your image/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Tap the page to place/)).toHaveCount(0);
  expect((await state(page)).tool).toBe("edit-text");
});

test("only the latest change offers Undo, and the pages panel takes Delete and Ctrl+A", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  const first = panel.getByRole("button", { name: "Page 1", exact: true });
  await first.click();
  await first.press("Delete");
  await expect.poll(async () => (await state(page)).doc!.pageCount).toBe(4);
  await idle(page);
  await first.click();
  await first.press("Delete");
  await expect.poll(async () => (await state(page)).doc!.pageCount).toBe(3);
  await expect(page.getByRole("list", { name: "Notices" }).getByRole("button", { name: "Undo" })).toHaveCount(1);
  await first.press("Control+a");
  await expect(panel.getByText("3 of 3 selected")).toBeVisible();
  // every page selected: Delete must not empty the document
  await first.press("Delete");
  await idle(page);
  expect((await state(page)).doc!.pageCount).toBe(3);
});

test("recognition never lands on a page that moved while it was being read", async ({ page }) => {
  await open(page, "scan-en");
  const panel = await openPanel(page, "Pages");
  await panel.getByRole("button", { name: "Add pages" }).click();
  await panel.getByRole("button", { name: "Blank" }).click();
  await expect.poll(async () => (await state(page)).doc!.pageCount).toBe(2);
  await idle(page);
  await page.evaluate(() => {
    const app = (window as unknown as { __pdfedit: { getState(): { runOcr(p: number[], l: string[]): Promise<void> } } }).__pdfedit;
    void app.getState().runOcr([0], ["eng"]);
  });
  await panel.getByRole("button", { name: "Page 2", exact: true }).click();
  await panel.getByRole("button", { name: "Earlier" }).click();
  await expect.poll(async () => (await state(page)).ocr.running, { timeout: 120_000 }).toBe(false);
  await expect(page.getByText(/changed while the text was being read/)).toBeVisible();
  expect((await state(page)).ocr.done).toEqual([]);
});

test("undo and redo keep the list of recognised pages honest", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page, "scan-en");
  await page.evaluate(() => {
    const app = (window as unknown as { __pdfedit: { getState(): { runOcr(p: number[], l: string[]): Promise<void> } } }).__pdfedit;
    void app.getState().runOcr([0], ["eng"]);
  });
  await expect.poll(async () => (await state(page)).ocr.done, { timeout: 150_000 }).toEqual([0]);
  await idle(page);
  let before = await revision(page);
  await page.keyboard.press("Control+z");
  await changed(page, before);
  await expect.poll(async () => (await state(page)).ocr.done).toEqual([]);
  before = await revision(page);
  await page.keyboard.press("Control+y");
  await changed(page, before);
  await expect.poll(async () => (await state(page)).ocr.done).toEqual([0]);
});

for (const height of [600, 650]) {
  test(`every tool is in view in a ${height}px tall window`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height });
    await open(page, "en-truetype");
    await expect(toolbar(page).getByRole("button", { name: "Redact", exact: true })).toBeInViewport({ ratio: 1 });
  });
}
