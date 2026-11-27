import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSETS, REPAIR_NOISE, chooseFiles, download, expect, fixturePath, idle, open, openPanel, pageElement, readPdf, ready, start, state, test,
} from "./helpers";

test("start screen explains the app and keeps files on the device", async ({ page }) => {
  await start(page);
  await expect(page.getByRole("heading", { level: 1, name: "Edit the text in any PDF" })).toBeVisible();
  await expect(page.getByText(/never uploaded/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open source/ })).toHaveAttribute("href", "https://github.com/TheRealLaksh/pdfedit");
  const emoji = await page.locator("body").innerText();
  expect(emoji).not.toMatch(/\p{Extended_Pictographic}/u);
});

test("a file chosen before the engine has loaded still opens", async ({ page }) => {
  // a slow network: the engine's wasm arrives two seconds late
  await page.context().route(/mupdf.*\.wasm/, async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  await start(page, { waitForEngine: false });
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), fixturePath("multipage"));
  await ready(page);
});

test("opens a PDF, shows every page and closes again", async ({ page }) => {
  await open(page, "multipage");
  expect((await state(page)).doc!.pageCount).toBe(5);
  await expect(page.getByText("multipage.pdf").first()).toBeVisible();
  await expect(page).toHaveTitle(/multipage\.pdf/);
  await page.getByRole("button", { name: "Close document" }).click();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
});

test("renders the page with visible ink", async ({ page }) => {
  await open(page, "en-standard14");
  await expect
    .poll(() =>
      pageElement(page)
        .locator("canvas")
        .first()
        .evaluate((c: HTMLCanvasElement) => {
          const copy = document.createElement("canvas");
          copy.width = c.width;
          copy.height = c.height;
          const g = copy.getContext("2d")!;
          g.drawImage(c, 0, 0);
          const data = g.getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 200 && data[i]! < 120 && data[i + 1]! < 120) dark++;
          return dark;
        }),
    )
    .toBeGreaterThan(500);
});

test("turns photos into a PDF", async ({ page }) => {
  await start(page);
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), [join(ASSETS, "photo.png"), join(ASSETS, "photo.jpg")]);
  await ready(page);
  expect((await state(page)).doc!.pageCount).toBe(2);
  const { bytes } = await download(page);
  expect(readPdf(bytes).pages).toBe(2);
});

test("accepts a file dropped on the window", async ({ page }) => {
  await start(page);
  const data = readFileSync(fixturePath("en-truetype")).toString("base64");
  const transfer = await page.evaluateHandle((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const t = new DataTransfer();
    t.items.add(new File([bytes], "dropped.pdf", { type: "application/pdf" }));
    return t;
  }, data);
  for (const type of ["dragenter", "dragover", "drop"]) await page.dispatchEvent("body", type, { dataTransfer: transfer });
  await ready(page);
  await expect(page.getByText("dropped.pdf").first()).toBeVisible();
});

test("says clearly when a file is not a PDF", async ({ page, guard }) => {
  guard.allow(/engine\.open|could not be read|console:/i);
  await start(page);
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), {
    name: "broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("definitely not a PDF"),
  });
  await expect(page.getByRole("alert").filter({ hasText: /could not be read|not a PDF/i })).toBeVisible();
  await idle(page);
  await expect(page.getByRole("button", { name: "Choose file" })).toBeEnabled();
});

test("warns about signed and repaired files", async ({ page, guard }) => {
  guard.allow(REPAIR_NOISE);
  await open(page, "signed-simulated");
  await expect(page.getByRole("list", { name: "Notices" }).getByText(/signed/i)).toBeVisible();
  await page.getByRole("button", { name: "Close document" }).click();
  await chooseFiles(page, page.getByRole("button", { name: "Choose file" }), fixturePath("damaged-truncated"));
  await ready(page);
  await expect(page.getByRole("list", { name: "Notices" }).getByText(/repaired/i)).toBeVisible();
});

test("opens a damaged file and downloads a clean copy", async ({ page, guard }) => {
  guard.allow(REPAIR_NOISE);
  await open(page, "damaged-xref");
  const { bytes, name } = await download(page);
  expect(name).toBe("damaged-xref (edited).pdf");
  const pdf = readPdf(bytes);
  expect(pdf.pdf.wasRepaired()).toBe(false);
  expect(pdf.text(0)).toContain("garden society");
});

test("scrolls through a long document and tracks the page number", async ({ page }) => {
  await open(page, "multipage");
  await page.locator(".pv-scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await ready(page, 4);
  await expect(pageElement(page, 4)).toBeInViewport();
  const dialog = await openPanel(page, "Pages");
  await expect(dialog.getByRole("button", { name: "Page 5", exact: true })).toHaveAttribute("aria-current", "page");
});

test("no request ever carries the document away", async ({ page }) => {
  const urls: string[] = [];
  page.context().on("request", (r) => urls.push(r.url()));
  await open(page, "en-truetype");
  await download(page);
  for (const url of urls) {
    expect(url).not.toContain("en-truetype");
    expect(url.length).toBeLessThan(2000);
  }
});
