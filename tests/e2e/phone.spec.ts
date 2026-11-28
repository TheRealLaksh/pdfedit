/**
 * Typing on the page on phones: magnifying tiny text, the field over the line, one-tap switching, a view that
 * stays put, the bar above the keyboard (the keyboard is simulated through the visual viewport, as iOS
 * reports it). The real keyboard and real fingers are covered by tests/device on an Android device.
 */
import type { Page } from "@playwright/test";
import {
  changed, done, editor, expect, fixture, idle, isPhone, open, openLine, pageElement, pointOnPage, revision, state, tap, tapLine,
  tapPage, test, toolbar,
} from "./helpers";

test.beforeEach(({ page }) => test.skip(!isPhone(page), "phone behaviour"));

const centre = (rect: number[]) => [(rect[0]! + rect[2]!) / 2, (rect[1]! + rect[3]!) / 2] as const;
const lines = () => fixture("en-truetype").pages[0]!.lines;

const view = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __pdfedit: { getState(): { zoom: unknown } } }).__pdfedit.getState();
    const el = document.querySelector(".pv-scroll")!;
    return { zoom: s.zoom, top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft) };
  });

/** pretend the on-screen keyboard covers `height` pixels, the way iOS reports it */
const keyboard = (page: Page, height: number) =>
  page.evaluate((height) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, "height", { configurable: true, get: () => window.innerHeight - height });
    vv.dispatchEvent(new Event("resize"));
  }, height);

test("tiny text magnifies on the first tap and is typed in place after the second", async ({ page }) => {
  // a table in small print: its rows are closer together than a fingertip is wide
  await open(page, "columns-table");
  const line = fixture("columns-table").pages[0]!.lines[3]!;
  await expect(page.locator("[data-line-id]").first()).toBeAttached();
  await tapPage(page, "columns-table", ...centre(line.rect));
  await expect.poll(async () => (await view(page)).zoom).not.toBe("fit");
  await expect(editor(page)).toBeHidden();
  await expect(page.getByText(/Tap the line you want/)).toBeVisible();

  const before = await view(page);
  await page.waitForTimeout(500);
  await tapPage(page, "columns-table", ...centre(line.rect));
  await expect(editor(page)).toHaveValue(line.text);
  await expect(editor(page)).toBeFocused();
  expect((await view(page)).zoom, "opening a readable line does not zoom").toBe(before.zoom);

  // the field lies over the line itself
  const spot = await pointOnPage(page, "columns-table", 0, line.rect[0], (line.rect[1] + line.rect[3]) / 2);
  const box = (await editor(page).boundingBox())!;
  expect(Math.abs(box.x - spot.x)).toBeLessThan(8);
  expect(Math.abs(box.y + box.height / 2 - spot.y)).toBeLessThan(8);
  expect(await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
});

test("one tap switches lines, and closing leaves the view where it was", async ({ page }) => {
  await open(page, "en-truetype");
  const [first, second] = [lines()[5]!, lines()[7]!];
  await page.evaluate(() => (window as unknown as { __pdfedit: { getState(): { setZoom(z: number): void } } }).__pdfedit.getState().setZoom(1.3));
  await openLine(page, "en-truetype", 5);
  await editor(page).fill(first.text + " Yes.");
  const zoom = (await view(page)).zoom;
  const old = await revision(page);
  await tapPage(page, "en-truetype", ...centre(second.rect));
  await changed(page, old);
  await expect(editor(page)).toHaveValue(second.text);
  expect((await view(page)).zoom).toBe(zoom);

  await page.waitForTimeout(400);
  const here = await view(page);
  await done(page).click();
  await expect(editor(page)).toBeHidden();
  await idle(page);
  await expect(toolbar(page)).toBeVisible();
  expect(await view(page)).toEqual(here);
  await page.getByRole("button", { name: "Fit page" }).click();
  await expect.poll(async () => (await view(page)).zoom).toBe("fit");
});

test("the bar and the line stay above the keyboard, and nothing in the bar is cut off", async ({ page }) => {
  await open(page, "en-standard14");
  await openLine(page, "en-standard14", 12);
  await keyboard(page, 320);
  const dock = page.getByTestId("editor-dock");
  const height = page.viewportSize()!.height;
  await expect.poll(async () => Math.round((await dock.boundingBox())!.y + (await dock.boundingBox())!.height)).toBe(height - 320);
  await expect
    .poll(async () => {
      const caret = (await page.locator("[data-pv-caret]").boundingBox())!;
      return caret.y + caret.height <= (await dock.boundingBox())!.y + 1 && caret.y >= 40;
    })
    .toBe(true);
  for (const group of ["Font and size", "Colour", "More options"]) {
    await page.getByRole("button", { name: group, exact: true }).click();
    const bad = await dock.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>("button, select, label, input.pv-size")]
        .filter((e) => e.getBoundingClientRect().width > 1)
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.left < -0.5 || r.right > innerWidth + 0.5 || r.height < 40;
        })
        .map((e) => e.getAttribute("aria-label")),
    );
    expect(bad, group).toEqual([]);
    await expect(editor(page), "the field keeps the focus").toBeFocused();
  }
});

test("a double tap does not close the line it opened", async ({ page }) => {
  await open(page, "en-truetype");
  const line = lines()[7]!;
  await tapLine(page, "en-truetype", ...centre(line.rect));
  await expect(editor(page)).toBeVisible();
  await editor(page).press("Escape");
  await page.waitForTimeout(500);
  const point = await pointOnPage(page, "en-truetype", 0, ...centre(line.rect));
  await tap(page, point);
  await tap(page, point);
  await page.waitForTimeout(600);
  await expect(editor(page)).toHaveValue(line.text);
});

test("the keyboard is claimed inside the tap itself", async ({ page }) => {
  await open(page, "en-truetype");
  const line = lines()[7]!;
  await openLine(page, "en-truetype", 7);
  await editor(page).press("Escape");
  await page.waitForTimeout(500);
  // iOS opens the keyboard only if a field has the focus by the end of the tap's click
  await page.evaluate(() => {
    window.addEventListener("click", () => ((window as unknown as { __focus: string }).__focus = document.activeElement!.tagName), { once: true });
  });
  await tapPage(page, "en-truetype", ...centre(line.rect));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __focus?: string }).__focus)).toBe("TEXTAREA");
  await expect(editor(page)).toBeFocused();
});

test("added text wraps on the screen and keeps its lines", async ({ page }) => {
  await open(page, "en-truetype");
  await toolbar(page).getByRole("button", { name: "Add text", exact: true }).click();
  await tapPage(page, "en-truetype", 80, 420);
  const field = page.getByRole("textbox", { name: "Text", exact: true });
  await expect(field).toBeFocused();
  await field.fill("A rather long new note that has to wrap before it leaves the screen of a phone\nsecond line");
  const box = (await field.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  const old = await revision(page);
  await done(page).click();
  await changed(page, old);
  expect((await state(page)).selection?.type).toBe("object");
  await expect(pageElement(page).getByTestId("selection-frame")).toBeVisible();
});
