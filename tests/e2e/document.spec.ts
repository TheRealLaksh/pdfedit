/** Passwords, export options, find and replace, and forms. */
import {
  ASSETS, chooseFiles, download, expect, fixture, fixturePath, idle, isPhone, open, openPanel, readPdf, saved, saveFrom, start,
  state, test,
} from "./helpers";

test.describe("passwords", () => {
  test("asks for the password, rejects a wrong one, then opens", async ({ page, guard }) => {
    guard.allow(/password/i);
    await start(page);
    await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), fixturePath("password-aes256"));
    const dialog = page.getByRole("dialog", { name: "Password needed" });
    const field = dialog.getByLabel("Password", { exact: true });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("type", "password");
    await field.fill("wrong");
    await dialog.getByRole("button", { name: "Open" }).click();
    await expect(dialog.getByRole("alert")).toContainText("did not work");
    await field.fill("test1234");
    await field.press("Enter");
    await expect(dialog).toBeHidden();
    await idle(page);
    expect((await state(page)).doc!.pageCount).toBe(1);
    const { bytes } = await download(page);
    expect(readPdf(bytes).locked, "the copy is open unless a password was asked for").toBe(false);
  });

  test("cancel returns to the start screen", async ({ page }) => {
    await start(page);
    await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), fixturePath("password-rc4"));
    await page.getByRole("dialog", { name: "Password needed" }).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Choose file" })).toBeEnabled();
    expect((await state(page)).doc).toBeNull();
  });

  test("protects the download with a new password", async ({ page }) => {
    await open(page, "en-truetype");
    const panel = await openPanel(page, "Download");
    await panel.getByLabel(/Protect with a password/).check();
    const button = panel.getByRole("button", { name: "Download PDF" });
    await expect(button).toBeDisabled();
    await panel.getByLabel("New password").fill("open sesame 42");
    const { bytes } = await saveFrom(page, button);
    const pdf = readPdf(bytes, "open sesame 42");
    expect(pdf.locked).toBe(true);
    expect(pdf.text(0)).toContain("river survey");
  });
});

test.describe("export", () => {
  test("downloads chosen pages", async ({ page }) => {
    await open(page, "multipage");
    const panel = await openPanel(page, "Download");
    await panel.getByRole("button", { name: "Range" }).click();
    await panel.getByLabel("Page range").fill("2-3");
    const { bytes } = await saveFrom(page, panel.getByRole("button", { name: "Download PDF" }));
    const pdf = readPdf(bytes);
    expect(pdf.pages).toBe(2);
    expect(pdf.text(0)).toContain("bravo");
  });

  test("downloads a page picture and plain text", async ({ page }) => {
    await open(page, "hi-chromium");
    const panel = await openPanel(page, "Download");
    const image = await saved(page, () => panel.getByRole("button", { name: "Download images" }).click());
    expect(image.name).toMatch(/\.png$/);
    expect([...image.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await idle(page);
    const text = await saved(page, () => panel.getByRole("button", { name: "Download plain text" }).click());
    expect(text.name).toBe("hi-chromium.txt");
    const content = text.bytes.toString("utf8").normalize("NFC");
    for (const line of fixture("hi-chromium").pages[0]!.lines) expect(content).toContain(line.text);
  });
});

test.describe("find and replace", () => {
  test("counts, steps through and replaces all", async ({ page }) => {
    await open(page, "multipage");
    const panel = await openPanel(page, "Find and replace");
    await panel.getByRole("searchbox", { name: "Find" }).fill("weather");
    await expect(panel.getByRole("status").filter({ hasText: "of 5" })).toHaveText("1 of 5");
    await panel.getByRole("button", { name: "Next match" }).click();
    await expect(panel.getByRole("status").filter({ hasText: "of 5" })).toHaveText("2 of 5");
    await panel.getByLabel("Replace with").fill("harvest");
    await panel.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByRole("list", { name: "Notices" }).getByText("Replaced 5 matches")).toBeVisible();
    await expect(panel.getByRole("status").filter({ hasText: /No matches/ })).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    const pdf = readPdf((await download(page)).bytes);
    for (let i = 0; i < 5; i++) expect(pdf.text(i)).toContain("harvest");
  });

  test("replaces a Hindi word", async ({ page }) => {
    await open(page, "hi-chromium");
    const panel = await openPanel(page, "Find and replace");
    await panel.getByRole("searchbox", { name: "Find" }).fill("सोमवार");
    await expect(panel.getByRole("status").filter({ hasText: "of 1" })).toBeVisible();
    await panel.getByLabel("Replace with").fill("बुधवार");
    await panel.getByRole("button", { name: "Replace", exact: true }).click();
    await expect(page.getByRole("list", { name: "Notices" }).getByText("Replaced 1 match")).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    expect(readPdf((await download(page)).bytes).text(0)).toContain("बुधवार");
  });

  test("the keyboard shortcut opens it", async ({ page }) => {
    test.skip(isPhone(page), "desktop keyboards only");
    await open(page, "multipage");
    await page.keyboard.press("Control+f");
    await expect(page.getByRole("searchbox", { name: "Find" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("searchbox", { name: "Find" })).toBeHidden();
  });
});

test.describe("forms", () => {
  test("fills a form from the panel", async ({ page }) => {
    await open(page, "forms");
    const panel = await openPanel(page, "Fill forms");
    const text = panel.locator('input[name="full_name"]');
    await text.fill("Asha Example");
    await text.press("Enter");
    await idle(page);
    // the box follows the document, so it turns once the engine has answered
    await panel.locator('input[name="newsletter"]').click();
    await expect(panel.locator('input[name="newsletter"]')).toBeChecked();
    await idle(page);
    await panel.locator('select[name="city"]').selectOption("Kochi");
    await idle(page);
    await panel.getByRole("radio").nth(1).click();
    await expect(panel.getByRole("radio").nth(1)).toBeChecked();
    await idle(page);
    await expect(panel.locator('input[name="reference"]')).toBeDisabled();
    await page.getByRole("button", { name: "Close panel" }).click();
    const pdf = readPdf((await download(page)).bytes);
    const widgets = pdf.pdf.loadPage(0).getWidgets();
    const value = (name: string) => widgets.filter((w) => w.getName() === name).map((w) => w.getValue());
    expect(value("full_name")).toEqual(["Asha Example"]);
    expect(value("city")).toEqual(["Kochi"]);
    expect(value("newsletter")[0]).not.toBe("Off");
    expect(value("plan")[0]).toBe("family");
  });

  test("says when there is no form", async ({ page }) => {
    await open(page, "en-truetype");
    const panel = await openPanel(page, "Fill forms");
    await expect(panel.getByText("No form fields")).toBeVisible();
  });
});

test("an uploaded font appears in the editor's font list", async ({ page }) => {
  await open(page, "en-truetype");
  const panel = await openPanel(page, "Fonts");
  await chooseFiles(page, panel.getByRole("button", { name: "Upload TTF or OTF" }), `${ASSETS}/FixtureSerif.ttf`);
  await expect(panel.getByText("Fixture Serif").first()).toBeVisible();
});
