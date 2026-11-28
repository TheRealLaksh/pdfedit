/**
 * Recognition of scanned pages with the real in-browser engine. Language data comes from cdn.jsdelivr.net,
 * so these need a network connection. Run alone with: npx playwright test ocr
 */
import {
  changed, compare, done, download, editor, expect, fixture, grow, idle, open, openPanel, revision, state, styleControls, tapLine,
  test,
} from "./helpers";

// one recognition at a time: they are CPU bound
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
// tesseract writes its own harmless warnings to console.error
test.beforeEach(({ guard }) => guard.allow(/console: (Warning[.:]|Estimating resolution|Detected \d+ diacritics)/));

test("recognises a scan from the on-page prompt and edits a line", async ({ page }) => {
  await open(page, "scan-en");
  const prompt = page.getByRole("button", { name: "Recognise text on this page" });
  await expect(prompt).toBeVisible();
  await prompt.click();
  await expect.poll(async () => (await state(page)).ocr.done, { timeout: 180_000 }).toEqual([0]);
  await idle(page);
  const line = fixture("scan-en").pages[0]!.lines[6]!;
  await expect(page.locator('[data-line-id^="ocr:"]').first()).toBeAttached();
  await tapLine(page, "scan-en", (line.rect[0] + line.rect[2]) / 2, (line.rect[1] + line.rect[3]) / 2);
  await expect(editor(page)).toHaveValue(/next meeting is on Monday/i);
  await styleControls(page, "Font and size");
  const size = Number(await page.getByLabel("Font size").inputValue());
  expect(size, `estimated font size (the page was set in ${line.size} pt)`).toBeGreaterThan(line.size * 0.75);
  expect(size, `estimated font size (the page was set in ${line.size} pt)`).toBeLessThan(line.size * 1.25);
  const before = await revision(page);
  await editor(page).fill("The next meeting is on Friday.");
  await done(page).click();
  await changed(page, before);
  const { bytes } = await download(page);
  const difference = compare("scan-en", bytes, grow(line.rect, 16));
  expect(difference.inside).toBeGreaterThan(100);
  expect(difference.outside).toBeLessThan(30);
});

for (const [id, language, expected] of [
  ["scan-hi", "Hindi", "पुस्तकालय"],
  ["scan-ar", "Arabic", "المكتبة"],
] as const) {
  test(`recognises ${language} with the language chosen by hand`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "language packs are checked once");
    await open(page, id);
    const panel = await openPanel(page, "Recognise text");
    await panel.getByRole("searchbox", { name: "Search languages" }).fill(language);
    await panel.getByRole("checkbox", { name: new RegExp(`^${language}`) }).check();
    await panel.getByRole("button", { name: "Recognise page 1" }).click();
    await expect.poll(async () => (await state(page)).ocr.done, { timeout: 180_000 }).toEqual([0]);
    await expect(page.getByRole("button", { name: new RegExp(`^Edit: .*${expected}`) }).first()).toBeAttached();
  });
}

test("detects the language on its own", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "checked once");
  await open(page, "scan-ru");
  await page.getByRole("button", { name: "Recognise text on this page" }).click();
  await expect.poll(async () => (await state(page)).ocr.done, { timeout: 200_000 }).toEqual([0]);
  await expect(page.getByRole("button", { name: /^Edit: .*библиотек/i }).first()).toBeAttached();
});

test("recognition can be stopped", async ({ page }) => {
  await open(page, "scan-en");
  await page.getByRole("button", { name: "Recognise text on this page" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => (await state(page)).ocr.running).toBe(false);
  expect((await state(page)).ocr.done).toEqual([]);
});

test("offers recognition for a broken text layer", async ({ page }) => {
  await open(page, "legacy-krutidev");
  await expect(page.getByRole("button", { name: "Recognise text on this page" })).toBeVisible();
  await expect(page.getByText(/broken/i)).toBeVisible();
});
