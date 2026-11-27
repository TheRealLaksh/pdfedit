/** The back gesture, small screens and a slow first download. */
import {
  chooseFiles, chooseTool, done, download, editor, expect, fixturePath, idle, isPhone, open, openLine, openPanel,
  readPdf, start, state, test,
} from "./helpers";

test("Back saves an open line, then asks before leaving unsaved changes", async ({ page }) => {
  test.skip(!isPhone(page), "the back gesture is a phone habit");
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 7);
  await editor(page).fill("Kept by the back gesture.");
  await page.goBack();
  await expect(editor(page)).toBeHidden();
  await expect.poll(async () => (await state(page)).dirty).toBe(true);
  await idle(page);
  expect(readPdf((await download(page)).bytes).text(0)).toContain("Kept by the back gesture.");

  // downloaded: nothing left to lose, so change something again
  await openLine(page, "en-truetype", 1);
  await editor(page).fill("Not downloaded yet.");
  await done(page).click();
  await expect.poll(async () => (await state(page)).dirty).toBe(true);
  await idle(page);
  const dialog = page.getByRole("dialog", { name: "Unsaved changes" });
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  expect((await state(page)).doc).not.toBeNull();
  await page.goBack();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  // the extra history entry is gone again
  await expect.poll(() => page.evaluate(() => !!history.state?.pdfeditSheet)).toBe(false);
});

test("closing a line normally leaves no extra history entry behind", async ({ page }) => {
  test.skip(!isPhone(page), "the back gesture is a phone habit");
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 7);
  await expect.poll(() => page.evaluate(() => !!history.state?.pdfeditSheet)).toBe(true);
  await editor(page).press("Escape");
  await expect.poll(() => page.evaluate(() => !!history.state?.pdfeditSheet)).toBe(false);
  expect((await state(page)).doc).not.toBeNull();
});

test("landscape phone: tool options stay on one row", async ({ page }) => {
  test.skip(!isPhone(page), "phone layout");
  await open(page, "en-truetype");
  await page.setViewportSize({ width: 740, height: 360 });
  for (const tool of ["Rectangle", "Highlight"] as const) {
    await chooseTool(page, tool);
    const card = page.getByRole("region", { name: `${tool} options` });
    await expect(card).toBeInViewport({ ratio: 1 });
    expect((await card.boundingBox())!.height).toBeLessThanOrEqual(72);
    await expect(card.getByRole("button", { name: "Done" })).toBeInViewport({ ratio: 1 });
  }
});

test("narrow phone: the find field keeps room for its focus ring", async ({ page }) => {
  test.skip(!isPhone(page), "phone layout");
  await page.setViewportSize({ width: 320, height: 568 });
  await open(page, "en-truetype");
  const panel = await openPanel(page, "Find and replace");
  const field = panel.getByRole("searchbox", { name: "Find" });
  const gap = await field.evaluate(
    (input) => input.getBoundingClientRect().top - input.closest(".sh-scroll")!.getBoundingClientRect().top,
  );
  expect(gap).toBeGreaterThanOrEqual(4);
});

test("a slow first visit says that the editor is downloading", async ({ page, context }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await context.route(/mupdf-wasm.*\.wasm/, async (route) => {
    await held;
    await route.continue();
  });
  await start(page, { waitForEngine: false });
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), fixturePath("en-truetype"));
  await expect(page.getByText(/Downloading the editor \(first visit only\)/)).toBeVisible();
  release();
  await expect(page.locator('[data-page="0"] canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Downloading the editor/)).toHaveCount(0);
});
