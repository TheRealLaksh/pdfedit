/** Layout, touch targets, theming, accessibility basics, the narrowest phone and a large file. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import * as mupdf from "mupdf";
import {
  chooseFiles, done, editor, expect, idle, isPhone, open, openPanel, ready, start, state, test, toolbar, type PanelName,
} from "./helpers";

/** problems a person would notice: sideways scrolling, unnamed controls, tiny touch targets */
async function audit(page: Page, touch: boolean) {
  return page.evaluate((touch) => {
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.top < innerHeight;
    };
    for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=button]")) {
      if (!shown(el) || el.closest(".pv-sr, .sh-sr, [aria-hidden=true]") || el.classList.contains("sh-skip")) continue;
      // the field laid over a line of the page is as big as the line: taps around it are caught by the page
      if (el.matches("[data-testid=line-editor]")) continue;
      const input = el as HTMLInputElement;
      const name = (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || input.labels?.[0]?.textContent || el.textContent || input.placeholder || "").trim();
      const html = el.outerHTML.slice(0, 90);
      if (!name) problems.push(`no accessible name: ${html}`);
      if (!touch || el.tagName === "A") continue;
      const target = (el.closest("label") ?? el).getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.right > innerWidth + 1 || r.left < -1) {
        // inside a horizontally scrollable strip this is fine
        let node: Element | null = el.parentElement;
        while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowX)) node = node.parentElement;
        if (!node) problems.push(`outside the screen: ${name || html}`);
      }
      if (Math.min(target.width, target.height) < 40) problems.push(`small touch target ${Math.round(target.width)}x${Math.round(target.height)}: ${name || html}`);
    }
    return [...new Set(problems)];
  }, touch);
}

const PANELS: PanelName[] = ["Pages", "Find and replace", "Fill forms", "Download", "Recognise text", "Signature", "Watermark and numbers", "Fonts", "About and privacy"];

test("start screen and editor pass a layout audit", async ({ page }) => {
  await start(page);
  expect(await audit(page, isPhone(page)), "start screen").toEqual([]);
  await open(page, "forms");
  expect(await audit(page, isPhone(page)), "editor").toEqual([]);
});

for (const name of PANELS) {
  test(`panel "${name}" fits and can be closed`, async ({ page }, info) => {
    await open(page, "forms");
    const panel = await openPanel(page, name);
    await idle(page);
    await page.screenshot({ path: join("test-results", "screens", `${info.project.name}-${name}.png`) });
    expect(await audit(page, isPhone(page))).toEqual([]);
    const box = (await panel.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
}

test("works at 320 pixels wide", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone layout");
  await page.setViewportSize({ width: 320, height: 568 });
  await start(page);
  expect(await audit(page, true)).toEqual([]);
  await open(page, "en-truetype");
  expect(await audit(page, true)).toEqual([]);
  await page.locator("[data-line-id]").first().waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Edit: Water level rose by 42 centimetres overnight." }).dispatchEvent("click");
  await expect(editor(page)).toBeInViewport();
  await expect(done(page)).toBeInViewport({ ratio: 1 });
  expect(await audit(page, true)).toEqual([]);
  await page.screenshot({ path: join("test-results", "screens", `${info.project.name}-320-editing.png`) });
});

test("landscape phone keeps the editor usable", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone layout");
  await page.setViewportSize({ width: 740, height: 360 });
  await open(page, "en-truetype");
  await page.locator("[data-line-id]").first().waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Edit: Water level rose by 42 centimetres overnight." }).dispatchEvent("click");
  await expect(page.locator("[data-pv-caret]")).toBeInViewport({ ratio: 1 });
  await expect(done(page)).toBeInViewport({ ratio: 1 });
});

test("the back gesture closes a sheet instead of leaving", async ({ page }) => {
  test.skip(!isPhone(page), "phone sheets");
  await open(page, "en-truetype");
  const panel = await openPanel(page, "Pages");
  await page.goBack();
  await expect(panel).toBeHidden();
  expect((await state(page)).doc).not.toBeNull();
});

test("the bottom bar offers the main tools", async ({ page }) => {
  test.skip(!isPhone(page), "phone layout");
  await open(page, "en-truetype");
  for (const name of ["Edit text", "Add text", "Sign", "Pages", "More"])
    await expect(toolbar(page).getByRole("button", { name, exact: true })).toBeInViewport();
  const bar = (await toolbar(page).boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
});

test("light and dark themes", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  await start(page);
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await background();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(background).not.toBe(light);
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(background).toBe(light);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: join("test-results", "screens", `${info.project.name}-start.png`) });
});

test("pinch and zoom controls keep the page sharp and in range", async ({ page }) => {
  await open(page, "en-truetype");
  const width = () => page.locator('[data-testid="page"]').first().evaluate((el) => el.getBoundingClientRect().width);
  const fit = await width();
  expect(fit).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (isPhone(page)) {
    await toolbar(page).getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
  } else await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(width).toBeGreaterThan(fit * 1.1);
  const canvas = page.locator('[data-testid="page"] canvas').first();
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => (c.width * c.height) / 1e6))
    .toBeLessThanOrEqual(16.8);
});

test("a 300 page file stays responsive", async ({ page }) => {
  const pdf = new mupdf.PDFDocument();
  const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
  const resources = pdf.addObject({ Font: { F1: font } });
  for (let i = 0; i < 300; i++)
    pdf.insertPage(-1, pdf.addPage([0, 0, 595, 842], 0, resources, `BT /F1 14 Tf 60 760 Td (Ledger page ${i + 1} of three hundred) Tj ET`));
  const folder = join("test-results", "generated");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `ledger-300-${test.info().project.name}.pdf`);
  writeFileSync(file, pdf.saveToBuffer("compress").asUint8Array());
  await start(page);
  const started = Date.now();
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), file);
  await ready(page);
  expect(Date.now() - started, "first page visible, ms").toBeLessThan(15_000);
  expect((await state(page)).doc!.pageCount).toBe(300);
  expect(await page.locator('[data-testid="page"]').count(), "pages are virtualised").toBeLessThan(20);
  await page.evaluate(() => (window as unknown as { __pdfedit: { getState(): { scrollTo(p: number): void } } }).__pdfedit.getState().scrollTo(249));
  await ready(page, 249);
  await expect(page.getByRole("button", { name: "Edit: Ledger page 250 of three hundred" })).toBeAttached();
});
