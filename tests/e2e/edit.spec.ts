/** The headline feature: tap existing text, change it, download. */
import {
  changed, compare, done, download, editLine, editor, expect, fixture, grow, history, idle, isPhone, open, openLine, readPdf, redoButton, revision, state, styleControls, tapLine, tapPage, test, toolbar, undoButton,
chooseTool,
} from "./helpers";

test("tap a line, retype it, download", async ({ page }) => {
  await open(page, "en-truetype");
  const entry = fixture("en-truetype");
  const line = await openLine(page, "en-truetype", 7);
  await expect(editor(page)).toHaveValue(line.text);
  await expect(editor(page)).toBeFocused();
  const before = await revision(page);
  await editor(page).fill("The next visit is on Friday, quite early!");
  await done(page).click();
  await changed(page, before);
  await expect(editor(page)).toBeHidden();
  const { bytes, name } = await download(page);
  expect(name).toBe("en-truetype (edited).pdf");
  const pdf = readPdf(bytes);
  expect(pdf.text(0)).toContain("The next visit is on Friday, quite early!");
  expect(pdf.text(0)).not.toContain("on Monday");
  for (const other of entry.pages[0]!.lines.slice(0, 7)) expect(pdf.text(0)).toContain(other.text);
  const difference = compare("en-truetype", bytes, grow(line.rect, 90));
  expect(difference.inside).toBeGreaterThan(30);
  expect(difference.outside, "nothing else changed").toBeLessThan(10);
});

for (const [id, lineIndex] of [
  ["hi-chromium", 6],
  ["ar-chromium", 6],
  ["he-chromium", 6],
  ["ta-chromium", 6],
  ["zh-chromium", 6],
  ["th-chromium", 6],
  ["ur-chromium", 6],
  ["bn-chromium", 6],
] as const) {
  test(`edits ${id} in its own script`, async ({ page }) => {
    await open(page, id);
    const entry = fixture(id);
    const line = entry.pages[0]!.lines[lineIndex]!;
    const wanted = entry.edits[0]!.newText!;
    await openLine(page, id, lineIndex);
    await expect(editor(page)).toHaveValue(line.text);
    await expect(editor(page)).toHaveAttribute("dir", "auto");
    const before = await revision(page);
    await editor(page).fill(wanted);
    await done(page).click();
    await changed(page, before);
    // the app reads back what was written
    await openLine(page, id, lineIndex);
    await expect(editor(page)).toHaveValue(wanted);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const { bytes } = await download(page);
    expect(compare(id, bytes, grow(line.rect, 120)).outside).toBeLessThan(10);
    for (const other of entry.pages[0]!.lines.slice(0, 3)) expect(readPdf(bytes).text(0)).toContain(other.text.slice(0, 3));
  });
}

test("Enter commits and Escape cancels", async ({ page }) => {
  await open(page, "en-standard14");
  await openLine(page, "en-standard14", 10);
  const first = await revision(page);
  await editor(page).fill("Cancelled change");
  await editor(page).press("Escape");
  await expect(editor(page)).toBeHidden();
  await idle(page);
  expect(await revision(page)).toBe(first);
  expect((await state(page)).canUndo).toBe(false);

  await openLine(page, "en-standard14", 10);
  await editor(page).fill("The next meeting is on Sunday.");
  await editor(page).press("Enter");
  await changed(page, first);
  const { bytes } = await download(page);
  expect(readPdf(bytes).text(0)).toContain("on Sunday");
  expect(readPdf(bytes).text(0)).not.toContain("Cancelled");
});

test("Done without a change leaves the document clean", async ({ page }) => {
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 1);
  await done(page).click();
  await expect(editor(page)).toBeHidden();
  await idle(page);
  expect((await state(page)).canUndo).toBe(false);
  expect((await state(page)).dirty).toBe(false);
});

test("tapping another line saves the first and opens the second", async ({ page }) => {
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 1);
  const before = await revision(page);
  await editor(page).fill("Water level fell overnight.");
  const second = fixture("en-truetype").pages[0]!.lines[5]!;
  await tapPage(page, "en-truetype", (second.rect[0] + second.rect[2]) / 2, (second.rect[1] + second.rect[3]) / 2);
  await changed(page, before);
  await expect(editor(page)).toHaveValue(second.text);
  await editor(page).press("Escape");
  expect(readPdf((await download(page)).bytes).text(0)).toContain("Water level fell overnight.");
});

test("undo and redo", async ({ page }) => {
  await open(page, "en-truetype");
  await expect(undoButton(page)).toBeDisabled();
  await editLine(page, "en-truetype", 7, "First replacement.");
  await expect(undoButton(page)).toBeEnabled();
  await history(page, "undo");
  expect(readPdf((await download(page)).bytes).text(0)).toContain("on Monday");
  await expect(redoButton(page)).toBeEnabled();
  await history(page, "redo");
  expect(readPdf((await download(page)).bytes).text(0)).toContain("First replacement.");
  if (!isPhone(page)) {
    const before = await revision(page);
    await page.locator(".pv-scroll").focus();
    await page.keyboard.press("Control+z");
    await changed(page, before);
    await expect(redoButton(page)).toBeEnabled();
  }
});

test("style bar changes weight and the line can be deleted", async ({ page }) => {
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 1);
  let before = await revision(page);
  // an existing line's first row steps between lines on phones: weight sits with the font
  await styleControls(page, "Font and size");
  await page.getByRole("button", { name: /^Bold/ }).click();
  await done(page).click();
  await changed(page, before);
  let { bytes } = await download(page);
  const line = fixture("en-truetype").pages[0]!.lines[1]!;
  expect(compare("en-truetype", bytes, grow(line.rect, 30)).inside).toBeGreaterThan(30);
  expect(readPdf(bytes).text(0)).toContain(line.text);

  await openLine(page, "en-truetype", 2);
  before = await revision(page);
  await styleControls(page, "More options");
  await page.getByRole("button", { name: /^Delete/ }).click();
  await changed(page, before);
  ({ bytes } = await download(page));
  expect(readPdf(bytes).text(0)).not.toContain("herons");
});

test("edits a line on a turned page", async ({ page }) => {
  await open(page, "rotated-pages");
  await editLine(page, "rotated-pages", 2, "The next review is on Friday.", 2);
  const { bytes } = await download(page);
  expect(readPdf(bytes).text(2)).toContain("on Friday");
  expect(readPdf(bytes).text(0)).toContain("on Monday");
});

test("edits text written at an angle", async ({ page }) => {
  await open(page, "rotated-text");
  await openLine(page, "rotated-text", 3);
  await expect(editor(page)).toHaveValue("Banner tilted thirty degrees");
  const before = await revision(page);
  await editor(page).fill("Banner tilted forty degrees");
  await done(page).click();
  await changed(page, before);
  expect(readPdf((await download(page)).bytes).text(0)).toContain("forty");
});

test("keeps the editor visible and the tool bar out of the way", async ({ page }) => {
  await open(page, "en-standard14");
  await openLine(page, "en-standard14", 12); // the lowest line
  const view = page.viewportSize()!;
  // a magnified line may be wider than a phone: what must be seen is the spot being typed at
  const spot = isPhone(page) ? page.locator("[data-pv-caret]") : editor(page);
  await expect(spot).toBeInViewport();
  const box = (await spot.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1);
  if (isPhone(page)) {
    await expect(toolbar(page)).toBeHidden();
    const font = await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(font, "iOS zooms the page for inputs under 16px").toBeGreaterThanOrEqual(16);
    for (const name of ["Done", "Cancel"]) {
      const button = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(Math.min(button.width, button.height), `${name} touch target`).toBeGreaterThanOrEqual(43);
    }
    // a short viewport stands in for the on-screen keyboard
    await page.setViewportSize({ width: view.width, height: 380 });
    await expect(page.locator("[data-pv-caret]")).toBeInViewport({ ratio: 1 });
    await expect(done(page)).toBeInViewport({ ratio: 1 });
    await page.setViewportSize(view);
  }
  await editor(page).press("Escape");
  if (isPhone(page)) await expect(toolbar(page)).toBeVisible();
});

test("a finger that misses slightly still picks the nearest line", async ({ page }) => {
  test.skip(!isPhone(page), "touch targets are enlarged; a mouse is precise");
  await open(page, "en-truetype");
  const line = fixture("en-truetype").pages[0]!.lines[7]!;
  await expect(page.locator("[data-line-id]").first()).toBeAttached();
  await tapLine(page, "en-truetype", (line.rect[0] + line.rect[2]) / 2, line.rect[3] + 5);
  await expect(editor(page)).toHaveValue(line.text);
});

test("lines can be reached from the keyboard", async ({ page }) => {
  await open(page, "en-truetype");
  const button = page.getByRole("button", { name: "Edit: The next visit is on Monday." });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveValue("The next visit is on Monday.");
});

test("warns before throwing unsaved changes away", async ({ page }) => {
  await open(page, "en-truetype");
  await editLine(page, "en-truetype", 7, "Not downloaded yet.");
  await page.getByRole("button", { name: "Close document" }).click();
  const dialog = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  expect((await state(page)).doc).not.toBeNull();
  await page.getByRole("button", { name: "Close document" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
});

test("the typing preview is drawn with a loaded font", async ({ page }) => {
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 7);
  // the document's own font, or the file the engine would draw with instead
  await expect.poll(() => editor(page).evaluate((el) => getComputedStyle(el).fontFamily)).toContain("pe-font-");
});

test("steps to the next and previous line, saving on the way", async ({ page }) => {
  await open(page, "en-truetype");
  const lines = fixture("en-truetype").pages[0]!.lines;
  await openLine(page, "en-truetype", 1);
  await page.getByRole("button", { name: "Next line", exact: true }).click();
  await expect(editor(page)).toHaveValue(lines[2]!.text);
  await expect(editor(page)).toBeFocused();
  const before = await revision(page);
  await editor(page).fill("Two herons, not three.");
  await page.getByRole("button", { name: "Next line", exact: true }).click();
  await changed(page, before);
  await expect(editor(page)).toHaveValue(lines[3]!.text);
  await page.getByRole("button", { name: "Previous line", exact: true }).click();
  await expect(editor(page)).toHaveValue("Two herons, not three.");
});

test("warns while the text grows too long and fits it at one tap", async ({ page }) => {
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 1);
  await expect(page.getByTestId("fit-chip")).toHaveCount(0);
  await editor(page).fill("Water level rose by 42 centimetres after the long night of steady rain over the whole valley and the hills");
  const chip = page.getByTestId("fit-chip");
  await expect(chip).toContainText(/Runs|Longer/);
  await chip.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(chip.getByRole("button", { name: "Fit", exact: true })).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
});

test("searches the fonts, previews them and applies one", async ({ page }) => {
  await open(page, "en-truetype");
  await openLine(page, "en-truetype", 1);
  await styleControls(page, "Font and size");
  await page.getByRole("button", { name: "Font", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose font" });
  await expect(picker).toContainText("pt");
  await picker.getByRole("button", { name: "Copy style" }).click();
  await picker.getByRole("searchbox", { name: "Search fonts" }).fill("lora");
  const option = picker.getByRole("option", { name: "Lora" });
  await expect(option.locator(".pv-font-sample[data-loaded]")).toBeAttached({ timeout: 30_000 });
  await option.click();
  await expect(picker).toBeHidden();
  await expect(editor(page)).toBeFocused();
  await expect(page.getByRole("button", { name: "Font", exact: true })).toHaveText("Lora");
  const before = await revision(page);
  await done(page).click();
  await changed(page, before);
});

test("keyboard editing returns the focus to the line", async ({ page }) => {
  test.skip(isPhone(page), "desktop keyboard behaviour");
  await open(page, "en-truetype");
  const line = fixture("en-truetype").pages[0]!.lines[2]!;
  const button = page.getByRole("button", { name: `Edit: ${line.text}`, exact: true });
  await button.focus();
  // the focus ring lies on the line itself
  const box = (await button.boundingBox())!;
  const outline = (await page.locator("[data-line-id]").nth(2).boundingBox())!;
  expect(Math.abs(box.y - outline.y)).toBeLessThan(4);
  await button.press("Enter");
  await expect(editor(page)).toBeFocused();
  await editor(page).press("Escape");
  await expect(button).toBeFocused();
  await button.press("Enter");
  await editor(page).fill("Three egrets rested near the weir.");
  await editor(page).press("Enter");
  await expect(page.getByRole("button", { name: "Edit: Three egrets rested near the weir.", exact: true })).toBeFocused();
});

test("keys scroll a fresh document, and Escape returns to editing text", async ({ page }) => {
  test.skip(isPhone(page), "desktop keyboard behaviour");
  await open(page, "multipage");
  const top = () => page.locator(".pv-scroll").evaluate((el) => el.scrollTop);
  await page.keyboard.press("PageDown");
  await expect.poll(top).toBeGreaterThan(100);
  await page.keyboard.press("Home");
  await expect.poll(top).toBeLessThan(5);
  await chooseTool(page, "Rectangle");
  await page.locator(".pv-scroll").focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(page)).tool).toBe("edit-text");
});

test("a line that cannot be edited offers to be covered and retyped", async ({ page }) => {
  await open(page, "broken-pua");
  const line = fixture("broken-pua").pages[0]!.lines[0]!;
  await expect(page.locator(".pv-linebox-locked").first()).toBeAttached({ timeout: 30_000 });
  // the offer to read the whole page lies over the first lines of a phone: put it away
  await page.getByTestId("ocr-prompt").getByRole("button", { name: "Dismiss" }).click();
  const bar = page.getByTestId("locked-bar");
  // on a phone small print magnifies first and takes a second tap
  await expect(async () => {
    if (!(await bar.isVisible()))
      await tapPage(page, "broken-pua", (line.rect[0] + line.rect[2]) / 2, (line.rect[1] + line.rect[3]) / 2);
    await expect(bar).toBeVisible({ timeout: 2000 });
  }).toPass();
  await expect(bar).toContainText("cannot be edited directly");
  await expect(bar.getByRole("button", { name: "Read this page" })).toBeVisible();
  const first = await revision(page);
  await bar.getByRole("button", { name: "Cover and retype" }).click();
  await changed(page, first);
  const field = page.getByRole("textbox", { name: "Text", exact: true });
  await expect(field).toBeFocused();
  const covered = await revision(page);
  await field.fill("Typed again by hand");
  await done(page).click();
  await changed(page, covered);
  expect(readPdf((await download(page)).bytes).text(0)).toContain("Typed again by hand");
});
