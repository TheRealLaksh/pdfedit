/** Browser test helpers: the app is driven like a person would; downloads are checked with MuPDF in node. */
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(here, "../fixtures/pdfs");
export const ASSETS = resolve(here, "../fixtures/assets");

export interface Line {
  text: string;
  rect: [number, number, number, number];
  dir: "ltr" | "rtl";
  size: number;
  tags?: string[];
}
export interface Fixture {
  id: string;
  file: string;
  password: string | null;
  pageCount: number;
  pages: { index: number; width: number; height: number; lines: Line[] }[];
  edits: { page: number; line: number; newText?: string }[];
  tags: string[];
}

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as { documents: Fixture[] };
export const fixture = (id: string): Fixture => {
  const found = manifest.documents.find((d) => d.id === id);
  if (!found) throw new Error(`No fixture ${id}`);
  return found;
};
export const fixturePath = (id: string) => join(FIXTURES, fixture(id).file);

/**
 * Every test also fails on uncaught page errors, console errors (including the engine worker's) and on any
 * request that leaves the two origins the privacy promise and the CSP allow.
 */
/** what MuPDF prints while repairing a broken file */
export const REPAIR_NOISE = /console: (format error: (cannot find startxref|cannot recognize xref format)|warning: (trying to repair|repairing PDF))/;

export const test = base.extend<{ guard: { allow(pattern: RegExp): void } }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      const own = new URL(baseURL!).origin;
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
      page.on("console", (m) => {
        // WebKit does not know this (valid) viewport key and logs it as an error
        if (m.type() === "error" && !m.text().includes("interactive-widget")) problems.push(`console: ${m.text()}`);
      });
      page.context().on("request", (request) => {
        const url = new URL(request.url());
        if (!/^https?:$/.test(url.protocol)) return;
        if (url.origin !== own && url.hostname !== "cdn.jsdelivr.net") problems.push(`request to ${url.origin}`);
        if (request.method() !== "GET" && request.method() !== "HEAD") problems.push(`${request.method()} ${url.href}: nothing may be uploaded`);
      });
      await use({ allow: (pattern) => allowed.push(pattern) });
      expect(problems.filter((p) => !allowed.some((a) => a.test(p))), "no errors and no foreign requests").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 900;

/* ---------- opening ---------- */

export async function chooseFiles(page: Page, trigger: Locator, files: string | string[] | { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await trigger.click();
  await (await chooser).setFiles(files);
}

/**
 * Open the start screen. By default also wait for the engine worker to say it is ready, so that tests of other
 * features do not depend on start-up speed (open.spec.ts checks choosing a file before that moment).
 */
export async function start(page: Page, { waitForEngine = true } = {}) {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (e: MessageEvent) => {
          if ((e.data as { id?: number })?.id === 0) (window as unknown as { __engineReady: boolean }).__engineReady = true;
        });
      }
    };
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  if (waitForEngine)
    await page
      .waitForFunction(() => (window as unknown as { __engineReady?: boolean }).__engineReady, undefined, { timeout: 30_000 })
      .catch(() => {});
}

export async function open(page: Page, id: string) {
  await start(page);
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), fixturePath(id));
  const password = fixture(id).password;
  if (password) {
    const dialog = page.getByRole("dialog", { name: "Password needed" });
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "Open" }).click();
  }
  await ready(page);
}

export async function ready(page: Page, index = 0) {
  await expect(page.locator(`[data-page="${index}"] canvas`).first()).toBeVisible();
  await idle(page);
}

interface StoreState {
  busy: string | null;
  doc: { pageCount: number; pages: { width: number; height: number; revision: number }[]; fileName: string } | null;
  editing: unknown;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  tool: string;
  selection: { type: string } | null;
  ocr: { running: boolean; done: number[] };
  toasts: { kind: string; message: string }[];
}

/** read-only look at the app state through the test hook set up in main.tsx */
export function state(page: Page): Promise<StoreState> {
  return page.evaluate(() => {
    const s = (window as unknown as { __pdfedit: { getState(): Record<string, unknown> } }).__pdfedit.getState();
    return JSON.parse(
      JSON.stringify({
        busy: s.busy, doc: s.doc, editing: s.editing, canUndo: s.canUndo, canRedo: s.canRedo, dirty: s.dirty,
        tool: s.tool, selection: s.selection, ocr: s.ocr, toasts: s.toasts,
      }),
    );
  });
}

export async function idle(page: Page) {
  await expect.poll(async () => (await state(page)).busy, { message: "app stays busy", timeout: 30_000 }).toBeNull();
}

/** wait for a change to reach the engine */
export async function changed(page: Page, before: number, pageIndex = 0) {
  await expect
    .poll(async () => (await state(page)).doc!.pages[pageIndex]!.revision, { message: "page was not changed" })
    .not.toBe(before);
  await idle(page);
}
export const revision = async (page: Page, pageIndex = 0) => (await state(page)).doc!.pages[pageIndex]!.revision;

/* ---------- pointing at the page ---------- */

export const pageElement = (page: Page, index = 0) => page.locator(`[data-page="${index}"][data-testid="page"]`);

/** pages are virtualised: ask the app to scroll one into existence */
export async function showPage(page: Page, index: number) {
  const element = pageElement(page, index);
  if (!(await element.count()))
    await page.evaluate((i) => (window as unknown as { __pdfedit: { getState(): { scrollTo(p: number): void } } }).__pdfedit.getState().scrollTo(i), index);
  await expect(element).toBeVisible();
  return element;
}

/** viewport coordinates of a page-space point, scrolling it into the middle of the view first if needed */
export async function pointOnPage(page: Page, id: string, index: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const size = fixture(id).pages[index]!;
  const element = await showPage(page, index);
  await element.evaluate(
    (node, at) => {
      const scroller = node.closest(".pv-scroll") ?? node.parentElement!.parentElement!;
      const view = scroller.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const px = box.left + at.fx * box.width;
      const py = box.top + at.fy * box.height;
      if (py < view.top + 90 || py > view.bottom - 160) scroller.scrollTop += py - (view.top + view.height * 0.4);
      if (px < view.left + 12 || px > view.right - 12) scroller.scrollLeft += px - (view.left + view.width / 2);
    },
    { fx: x / size.width, fy: y / size.height },
  );
  let box = (await element.boundingBox())!;
  // wait until the view stops moving
  await expect(async () => {
    const next = (await element.boundingBox())!;
    const still = Math.abs(next.y - box.y) < 0.5 && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.width - box.width) < 0.5;
    box = next;
    expect(still).toBe(true);
  }).toPass();
  return { x: box.x + (x / size.width) * box.width, y: box.y + (y / size.height) * box.height };
}

/** a real tap (touch screens) or click */
export async function tap(page: Page, point: { x: number; y: number }) {
  if (isPhone(page)) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

export async function tapPage(page: Page, id: string, x: number, y: number, index = 0) {
  await tap(page, await pointOnPage(page, id, index, x, y));
}

export async function drag(page: Page, id: string, from: [number, number], to: [number, number], index = 0) {
  const a = await pointOnPage(page, id, index, ...from);
  const size = fixture(id).pages[index]!;
  const box = (await pageElement(page, index).boundingBox())!;
  const b = { x: box.x + (to[0] / size.width) * box.width, y: box.y + (to[1] / size.height) * box.height };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

/* ---------- editing text ---------- */

export const editor = (page: Page) => page.getByRole("textbox", { name: "Edit text" });

/**
 * A tap on a line. On a phone, tiny crowded text magnifies first (nothing opens, the page grows) and the
 * second tap, on the same spot of the page, opens the line.
 */
export async function tapLine(page: Page, id: string, x: number, y: number, index = 0) {
  const zoom = () => page.evaluate(() => (window as unknown as { __pdfedit: { getState(): { zoom: unknown } } }).__pdfedit.getState().zoom);
  const before = await zoom();
  await tapPage(page, id, x, y, index);
  if (!isPhone(page)) return;
  await expect.poll(async () => !!(await state(page)).editing || (await zoom()) !== before, { message: "the tap did nothing" }).toBe(true);
  if ((await state(page)).editing) return;
  // a double tap is deliberately one tap: wait it out
  await page.waitForTimeout(500);
  await tapPage(page, id, x, y, index);
}

export async function openLine(page: Page, id: string, lineIndex: number, index = 0) {
  const line = fixture(id).pages[index]!.lines[lineIndex]!;
  await showPage(page, index);
  await expect(pageElement(page, index).locator("[data-line-id]").first()).toBeAttached({ timeout: 30_000 });
  const [x0, y0, x1, y1] = line.rect;
  await tapLine(page, id, (x0 + x1) / 2, (y0 + y1) / 2, index);
  await expect(editor(page)).toBeVisible();
  return line;
}

/** the less common controls: on phones they sit behind a button of the style bar */
export async function styleControls(page: Page, group: "Font and size" | "Colour" | "More options") {
  if (isPhone(page)) await page.getByRole("button", { name: group, exact: true }).click();
}

export const done = (page: Page) => page.getByRole("button", { name: "Done", exact: true }).and(page.getByTestId("editor-done"));

export async function editLine(page: Page, id: string, lineIndex: number, text: string, index = 0) {
  await openLine(page, id, lineIndex, index);
  const before = await revision(page, index);
  await editor(page).fill(text);
  await done(page).click();
  await changed(page, before, index);
  await expect(editor(page)).toBeHidden();
}

/* ---------- chrome ---------- */

export const toolbar = (page: Page) => page.getByRole("navigation", { name: "Tools" });

export async function chooseTool(page: Page, name: "Edit text" | "Add text" | "Select" | "Highlight" | "Draw" | "Rectangle" | "Ellipse" | "Line" | "Arrow" | "Whiteout" | "Redact") {
  if (isPhone(page) && name !== "Edit text" && name !== "Add text") {
    await toolbar(page).getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name, exact: true }).click();
  } else await toolbar(page).getByRole("button", { name, exact: true }).click();
  await expect.poll(async () => (await state(page)).tool).toBe(name.toLowerCase().replace("rectangle", "rect").replace("draw", "ink").replace(" ", "-"));
}

export type PanelName = "Pages" | "Find and replace" | "Fill forms" | "Download" | "Recognise text" | "Signature" | "Watermark and numbers" | "Fonts" | "About and privacy";

export const panel = (page: Page, name: PanelName) =>
  page.getByRole("dialog", { name, exact: true }).or(page.getByRole("complementary", { name, exact: true }));

export async function openPanel(page: Page, name: PanelName): Promise<Locator> {
  const phone = isPhone(page);
  if (name === "Signature") {
    await toolbar(page).getByRole("button", { name: "Sign", exact: true }).click();
  } else if (name === "Pages") {
    if (phone) await toolbar(page).getByRole("button", { name: "Pages", exact: true }).click();
    else await page.getByRole("banner").getByRole("button", { name: "Pages", exact: true }).click();
  } else if (!phone && name === "Find and replace") await page.getByRole("button", { name: "Find and replace" }).click();
  else if (!phone && name === "Download") await page.getByRole("button", { name: "Download options" }).click();
  else if (!phone && name === "Fill forms" && (await page.getByRole("banner").getByRole("button", { name: "Forms" }).count()))
    await page.getByRole("banner").getByRole("button", { name: "Forms" }).click();
  else {
    const more = phone ? toolbar(page).getByRole("button", { name: "More" }) : page.getByRole("banner").getByRole("button", { name: "More" });
    await more.click();
    // the export panel is listed as "Download options" in the menu
    const item = name === "Download" ? "Download options" : name;
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: new RegExp(`^${item}`) }).click();
  }
  const found = panel(page, name);
  await expect(found).toBeVisible();
  return found;
}

export async function closePanel(page: Page) {
  const button = page.getByRole("button", { name: "Close panel" });
  if (await button.count()) await button.click();
}

export const undoButton = (page: Page) => page.getByRole("banner").getByRole("button", { name: "Undo", exact: true });
export const redoButton = (page: Page) => page.getByRole("banner").getByRole("button", { name: "Redo", exact: true });

export async function history(page: Page, which: "undo" | "redo", pageIndex = 0) {
  const before = await revision(page, pageIndex);
  await (which === "undo" ? undoButton(page) : redoButton(page)).click();
  await changed(page, before, pageIndex);
}

/* ---------- downloads ---------- */

export async function saved(page: Page, action: () => Promise<unknown>): Promise<{ bytes: Buffer; name: string }> {
  const waiting = page.waitForEvent("download");
  await action();
  const download = await waiting;
  const file = await download.path();
  return { bytes: readFileSync(file), name: download.suggestedFilename() };
}

export async function download(page: Page) {
  await idle(page);
  const button = isPhone(page)
    ? page.getByRole("button", { name: "Download PDF", exact: true })
    : page.getByRole("banner").getByRole("button", { name: "Download", exact: true });
  return saveFrom(page, button);
}

/** the sheet a phone finishes in: name, share, save */
export const finishSheet = (page: Page) => page.getByRole("dialog", { name: /^(Your PDF is ready|Saved)$/ });

/** press a download button; on a phone also tap Save in the sheet that follows and put the sheet away */
export async function saveFrom(page: Page, button: Locator) {
  const phone = isPhone(page);
  const result = await saved(page, async () => {
    await button.click();
    if (phone) await finishSheet(page).getByTestId("finish-save").click();
  });
  if (phone) {
    await finishSheet(page).getByRole("button", { name: "Keep editing" }).click();
    await expect(finishSheet(page)).toBeHidden();
  }
  return result;
}

/* ---------- reading the results ---------- */

export function readPdf(bytes: Uint8Array, password?: string) {
  const opened = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const locked = opened.needsPassword();
  if (locked) opened.authenticatePassword(password ?? "");
  const pdf: mupdf.PDFDocument = opened.asPDF()!;
  return {
    locked,
    pdf,
    pages: pdf.countPages(),
    text: (i: number) => pdf.loadPage(i).toStructuredText("preserve-whitespace").asText().normalize("NFC"),
    size: (i: number) => {
      const [x0, y0, x1, y1] = pdf.loadPage(i).getBounds();
      return [Math.round(x1 - x0), Math.round(y1 - y0)];
    },
  };
}

/** count of clearly changed pixels between the fixture page and the downloaded page, inside and outside `rect` */
export function compare(id: string, bytes: Uint8Array, rect: [number, number, number, number], index = 0) {
  const render = (data: Uint8Array) => {
    const doc = readPdf(data, fixture(id).password ?? undefined).pdf;
    const pixmap = doc.loadPage(index).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
    return { data: pixmap.getPixels().slice(), width: pixmap.getWidth(), height: pixmap.getHeight(), n: pixmap.getNumberOfComponents() };
  };
  const a = render(readFileSync(fixturePath(id)));
  const b = render(bytes);
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * a.n;
      if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) < 60) continue;
      if (x >= rect[0] * 2 && x <= rect[2] * 2 && y >= rect[1] * 2 && y <= rect[3] * 2) inside++;
      else outside++;
    }
  return { inside, outside };
}

export const grow = (r: [number, number, number, number], by: number): [number, number, number, number] => [r[0] - by, r[1] - by, r[2] + by, r[3] + by];
