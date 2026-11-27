/** The page organiser. */
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  ASSETS, chooseFiles, download, expect, fixturePath, history, idle, isPhone, open, openPanel, readPdf, saved, state,
  test,
} from "./helpers";

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo"];
const order = (bytes: Uint8Array) => {
  const pdf = readPdf(bytes);
  return Array.from({ length: pdf.pages }, (_, i) => WORDS.find((w) => pdf.text(i).includes(`marker ${w}`)) ?? "?");
};
const count = async (page: Page) => (await state(page)).doc!.pageCount;
const thumb = (panel: Locator, n: number) => panel.getByRole("button", { name: `Page ${n}`, exact: true });

async function act(page: Page, panel: Locator, name: string, expected: number) {
  await panel.getByRole("button", { name, exact: true }).click();
  await expect.poll(() => count(page)).toBe(expected);
  await idle(page);
}

async function result(page: Page) {
  const close = page.getByRole("button", { name: "Close panel" });
  if (await close.count()) await close.click();
  return (await download(page)).bytes;
}

test("delete pages and undo", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  await thumb(panel, 2).click();
  await thumb(panel, 4).click();
  await expect(panel.getByText("2 of 5 selected")).toBeVisible();
  await act(page, panel, "Delete", 3);
  expect(order(await result(page))).toEqual(["alpha", "charlie", "echo"]);
  await history(page, "undo");
  await expect.poll(() => count(page)).toBe(5);
});

test("cannot delete every page", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  await panel.getByRole("button", { name: "Select all" }).click();
  await expect(panel.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
});

test("rotate and duplicate", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  await thumb(panel, 1).click();
  await panel.getByRole("button", { name: "Turn right" }).click();
  await expect.poll(async () => (await state(page)).doc!.pages[0]!.width).toBeCloseTo(595, 0);
  await idle(page);
  await act(page, panel, "Duplicate", 6);
  const bytes = await result(page);
  expect(readPdf(bytes).size(0)).toEqual([595, 420]);
  expect(order(bytes).slice(0, 3)).toEqual(["alpha", "alpha", "bravo"]);
});

test("move pages with the arrows", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  await thumb(panel, 1).click();
  const before = (await state(page)).doc!.pages[0]!.revision;
  await panel.getByRole("button", { name: "Later" }).click();
  await expect.poll(async () => (await state(page)).doc!.pages[0]!.revision).not.toBe(before);
  await idle(page);
  expect(order(await result(page))).toEqual(["bravo", "alpha", "charlie", "delta", "echo"]);
});

test("drag a page to a new place", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  const first = panel.locator('li[data-page="0"]');
  const third = panel.locator('li[data-page="2"]');
  await expect(third).toBeVisible();
  const before = (await state(page)).doc!.pages[0]!.revision;
  const source = isPhone(page) ? first.getByTitle("Drag to reorder") : thumb(panel, 1);
  const a = (await source.boundingBox())!;
  const b = (await third.boundingBox())!;
  const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const to = { x: b.x + b.width * 0.8, y: b.y + b.height / 2 };
  if (isPhone(page)) {
    // real touch pointer events: only Chromium offers them to tests
    test.skip(page.context().browser()!.browserType().name() !== "chromium", "touch drag needs CDP");
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await touch("touchStart", from.x, from.y);
    for (let i = 1; i <= 12; i++) await touch("touchMove", from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await touch("touchEnd", to.x, to.y);
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await state(page)).doc!.pages[0]!.revision).not.toBe(before);
  await idle(page);
  expect(order(await result(page))).toEqual(["bravo", "charlie", "alpha", "delta", "echo"]);
});

test("insert a blank page, a PDF and images", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  await thumb(panel, 1).click();
  const add = panel.getByRole("button", { name: "Add pages" });
  await add.click();
  await act(page, panel, "Blank", 6);
  await add.click();
  await chooseFiles(page, panel.getByRole("button", { name: "PDF", exact: true }), fixturePath("en-truetype"));
  await expect.poll(() => count(page)).toBe(7);
  await idle(page);
  await add.click();
  await chooseFiles(page, panel.getByRole("button", { name: "Images", exact: true }), join(ASSETS, "photo.jpg"));
  await expect.poll(() => count(page)).toBe(8);
  await idle(page);
  const pdf = readPdf(await result(page));
  expect(pdf.pages).toBe(8);
  const all = Array.from({ length: 8 }, (_, i) => pdf.text(i)).join("\n");
  expect(all).toContain("river survey");
});

test("inserting a protected PDF asks for its password", async ({ page, guard }) => {
  guard.allow(/password|engine\.insertPdf/i);
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  await panel.getByRole("button", { name: "Add pages" }).click();
  await chooseFiles(page, panel.getByRole("button", { name: "PDF", exact: true }), fixturePath("password-aes256"));
  const dialog = page.getByRole("dialog", { name: "Password needed" });
  await dialog.getByLabel("Password", { exact: true }).fill("wrong");
  await dialog.getByRole("button", { name: "Add file" }).click();
  await expect(dialog.getByText(/did not work/)).toBeVisible();
  await dialog.getByLabel("Password", { exact: true }).fill("test1234");
  await dialog.getByRole("button", { name: "Add file" }).click();
  await expect.poll(() => count(page)).toBe(6);
});

test("extract and split into files", async ({ page }) => {
  await open(page, "multipage");
  const panel = await openPanel(page, "Pages");
  await thumb(panel, 3).click();
  const extracted = await saved(page, () => panel.getByRole("button", { name: "Extract" }).click());
  expect(order(extracted.bytes)).toEqual(["charlie"]);
  expect(extracted.name).toMatch(/multipage.*3.*\.pdf$/);

  await thumb(panel, 3).click();
  await panel.getByRole("button", { name: "Split" }).click();
  await panel.getByLabel("Pages per file").fill("2");
  const files: string[] = [];
  page.on("download", (d) => files.push(d.suggestedFilename()));
  await panel.getByRole("button", { name: "Download 3 files" }).click();
  await expect.poll(() => files.length).toBe(3);
  expect(await count(page)).toBe(5);
});
