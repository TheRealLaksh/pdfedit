/**
 * The shell: the start page (also as plain HTML), the sample, the finish sheet, size limits, notices,
 * shortcuts, thumbnails, files handed over by the system, and starting on a bad connection.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import * as mupdf from "mupdf";
import { START } from "../../src/ui/shell/strings";
import {
  chooseFiles, chooseTool, done, download, editor, expect, finishSheet, fixturePath, idle, isPhone, open, openLine,
  openPanel, readPdf, ready, saved, start, state, test, toolbar,
} from "./helpers";

const app = <T>(page: Page, expression: string) =>
  page.evaluate((code) => new Function("s", `return ${code}`)((window as unknown as { __pdfedit: { getState(): unknown } }).__pdfedit.getState()), expression) as Promise<T>;
const notices = (page: Page) => page.getByRole("list", { name: "Notices" });
const downloadButton = (page: Page) =>
  isPhone(page)
    ? page.getByRole("button", { name: "Download PDF", exact: true })
    : page.getByRole("banner").getByRole("button", { name: "Download", exact: true });
const chooseButton = (page: Page) => page.getByRole("button", { name: "Choose file" });

/** make a change that needs no knowledge of the page: turn it */
async function change(page: Page) {
  await page.evaluate(async () => {
    const store = (window as unknown as { __pdfedit: { getState(): { toolOptions: { text: unknown }; addObject(o: unknown): Promise<unknown> } } }).__pdfedit.getState();
    await store.addObject({ page: 0, kind: "text", rect: [72, 340, 400, 370], rotation: 0, opacity: 1, text: "A new line", align: "left", style: store.toolOptions.text });
  });
  await idle(page);
  expect((await state(page)).dirty).toBe(true);
}

/** a browser that can share: remembers what it was given; `refuse` closes the share sheet instead */
async function fakeShare(page: Page, refuse = false) {
  await page.addInitScript((refuse) => {
    const log: { name: string; size: number }[] = [];
    Object.assign(window, { __shared: log });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: { files: File[] }) => {
        if (refuse) throw new DOMException("closed", "AbortError");
        log.push(...data.files.map((f) => ({ name: f.name, size: f.size })));
      },
    });
  }, refuse);
}

test.describe("start page", () => {
  test("says the same before and after the app starts, and tells search engines", async ({ page, request }) => {
    const html = await (await request.get("/")).text();
    const plain = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const words = [
      START.title, START.lead, START.choose, START.sample, START.privacy, START.source, START.author,
      ...START.steps.flatMap((s) => [s.title, s.text]),
      ...START.more.flatMap((m) => [m.title, m.text]),
      ...START.questions.flatMap((f) => [f.q, f.a]),
    ];
    for (const text of words) expect(plain, "index.html and strings.ts drifted apart").toContain(text);
    const data = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(JSON.stringify(data)).not.toMatch(/aggregateRating|"review/i);
    for (const path of ["/og.png", "/sitemap.xml", "/robots.txt", "/404.html", "/sample.pdf", "/screenshots/phone.png", "/fonts/caslon-400.ttf"]) {
      const answer = await request.get(path);
      expect(answer.ok(), path).toBe(true);
      expect(answer.headers()["content-type"] ?? "", path).not.toBe("");
    }
    await start(page);
    for (const step of START.steps) await expect(page.getByRole("heading", { name: step.title, exact: true })).toBeVisible();
    await page.getByText(START.questions[0].q).click();
    await expect(page.getByText(START.questions[0].a)).toBeVisible();
  });

  test("works under the live security headers", async ({ page }) => {
    const csp = /Content-Security-Policy: (.+)/.exec(readFileSync("public/_headers", "utf8"))![1]!.trim();
    test.skip(!process.env.PDFEDIT_E2E_URL, "the dev server needs inline scripts; run against a build");
    await page.context().route(/^https?:\/\/localhost[^/]*\//, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
    });
    await start(page);
    await page.getByRole("button", { name: START.sample }).click();
    await ready(page);
    await download(page);
  });

  test("the sample opens and every kind of line in it can be edited", async ({ page }) => {
    await start(page);
    await page.getByRole("button", { name: START.sample }).click();
    await ready(page);
    expect((await state(page)).doc!.fileName).toBe("PDFEdit sample.pdf");
    for (const line of ["Tap this line and change it.", "Yearly membership", "यह पंक्ति हिन्दी में है। इसे भी बदलकर देखें।"])
      await expect(page.getByRole("button", { name: `Edit: ${line}` })).toBeAttached({ timeout: 30_000 });
    await page.getByRole("button", { name: "Edit: Tap this line and change it." }).dispatchEvent("click");
    await editor(page).fill("This line was changed.");
    await done(page).click();
    await expect.poll(async () => (await state(page)).dirty).toBe(true);
    await idle(page);
    expect(readPdf((await download(page)).bytes).text(0)).toContain("This line was changed.");
  });

  test("explains a file it cannot open, in place", async ({ page, guard }) => {
    guard.allow(/open failed|engine\.open|console:/i);
    await start(page);
    await chooseFiles(page, chooseButton(page), { name: "letter.docx", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
    await expect(page.getByRole("alert")).toContainText("Save this document as a PDF first");
    await chooseFiles(page, page.getByRole("button", { name: "Choose another file" }), {
      name: "cut.pdf", mimeType: "application/pdf", buffer: Buffer.from("nothing here"),
    });
    await expect(page.getByRole("alert")).toContainText("Couldn't open cut.pdf");
    await expect(page.getByRole("alert")).not.toContainText("MuPDF");
    await chooseFiles(page, page.getByRole("button", { name: "Choose another file" }), fixturePath("en-truetype"));
    await ready(page);
  });

  test("offers a reload when the app does not download", async ({ page, guard }) => {
    test.skip(!process.env.PDFEDIT_E2E_URL, "needs a build");
    guard.allow(/Failed to load resource|ERR_FAILED|access control|console:/i);
    await page.route(/assets\/index-.*\.js/, (route) => route.abort());
    await page.goto("/");
    const retry = page.getByRole("alert").filter({ hasText: "did not download" });
    await expect(retry).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: START.title })).toBeVisible();
    await page.unroute(/assets\/index-.*\.js/);
    await retry.getByRole("button", { name: "Reload" }).click();
    await expect(chooseButton(page)).toBeEnabled();
    await expect(page.locator("[data-boot]")).toHaveCount(0);
  });
});

test.describe("finishing", () => {
  test("a phone shares or saves under the chosen name, and only then counts as saved", async ({ page }) => {
    test.skip(!isPhone(page), "the sheet comes first on phones");
    await fakeShare(page);
    await open(page, "en-truetype");
    await change(page);
    await downloadButton(page).click();
    const sheet = finishSheet(page);
    await expect(sheet).toBeVisible();
    expect((await state(page)).dirty, "preparing is not saving").toBe(true);
    await sheet.getByLabel("File name").fill("Rent/receipt: May");
    await sheet.getByTestId("finish-share").click();
    await expect(sheet).toBeHidden();
    const shared = await page.evaluate(() => (window as unknown as { __shared: { name: string; size: number }[] }).__shared);
    expect(shared.map((f) => f.name)).toEqual(["Rent receipt May.pdf"]);
    expect(shared[0]!.size).toBeGreaterThan(500);
    expect((await state(page)).dirty).toBe(false);

    await downloadButton(page).click();
    const file = await saved(page, () => sheet.getByTestId("finish-save").click());
    expect(file.name).toBe("en-truetype (edited).pdf");
    await expect(page.getByRole("dialog", { name: "Saved" })).toBeVisible();
    await page.goBack();
    await expect(sheet).toBeHidden();
    expect((await state(page)).doc).not.toBeNull();
  });

  test("closing the share sheet keeps the changes unsaved", async ({ page }) => {
    test.skip(!isPhone(page), "the sheet comes first on phones");
    await fakeShare(page, true);
    await open(page, "en-truetype");
    await change(page);
    await downloadButton(page).click();
    await finishSheet(page).getByTestId("finish-share").click();
    await expect(finishSheet(page)).toBeVisible();
    expect((await state(page)).dirty).toBe(true);
    await expect(notices(page).getByText(/did not work/)).toHaveCount(0);
  });

  test("a computer saves in one click and can then rename", async ({ page }) => {
    test.skip(isPhone(page), "one click with a mouse");
    await open(page, "en-truetype");
    await change(page);
    const first = await download(page);
    expect(first.name).toBe("en-truetype (edited).pdf");
    await expect(finishSheet(page)).toHaveCount(0);
    expect((await state(page)).dirty).toBe(false);
    await notices(page).getByRole("button", { name: "Share or resize" }).click();
    await finishSheet(page).getByLabel("File name").fill("final copy.pdf");
    const second = await saved(page, () => finishSheet(page).getByTestId("finish-save").click());
    expect(second.name).toBe("final copy.pdf");
  });

  test("gets a picture heavy file under a size limit, or says it cannot", async ({ page }, info) => {
    // a page filled with noise, which compresses badly until it is scaled down
    const pdf = new mupdf.PDFDocument();
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1400, 1900], false);
    const pixels = pixmap.getPixels();
    for (let i = 0, seed = 7; i < pixels.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      pixels[i] = ((i % 4200) / 40 + (seed >>> 27)) & 255;
    }
    const image = pdf.addImage(new mupdf.Image(pixmap));
    const resources = pdf.addObject({ XObject: { I: image } });
    pdf.insertPage(-1, pdf.addPage([0, 0, 595, 842], 0, resources, "q 595 0 0 842 0 0 cm /I Do Q"));
    const folder = join("test-results", "generated");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `heavy-${info.project.name}.pdf`);
    writeFileSync(file, pdf.saveToBuffer("compress").asUint8Array());

    await start(page);
    await chooseFiles(page, chooseButton(page), file);
    await ready(page);
    await downloadButton(page).click();
    if (!isPhone(page)) await notices(page).getByRole("button", { name: "Share or resize" }).click();
    const sheet = finishSheet(page);
    await sheet.getByRole("button", { name: "500 KB" }).click();
    await expect(sheet.getByRole("status")).toContainText("within the limit", { timeout: 40_000 });
    const small = await saved(page, () => sheet.getByTestId("finish-save").click());
    expect(small.bytes.length).toBeLessThanOrEqual(500 * 1024);
    expect(readPdf(small.bytes).pages).toBe(1);
    await sheet.getByRole("button", { name: "Other", exact: true }).click();
    await sheet.getByLabel("Largest size in KB").fill("1");
    await sheet.getByRole("button", { name: "Apply" }).click();
    await expect(sheet.getByRole("status")).toContainText("still over", { timeout: 40_000 });
  });
});

test.describe("notices and help", () => {
  test("warnings stay, passing notes leave, and nothing covers a line being typed", async ({ page }) => {
    await page.clock.install();
    await open(page, "signed-simulated");
    const warning = notices(page).getByText(/Saving changes will break the signature/);
    await expect(warning).toBeVisible();
    await app(page, 's.toast("Just passing")');
    await expect(notices(page).getByText("Just passing")).toBeVisible();
    await page.clock.fastForward(30_000);
    await expect(notices(page).getByText("Just passing")).toHaveCount(0);
    await expect(warning).toBeVisible();
    await page.getByRole("button", { name: /^Edit: / }).first().dispatchEvent("click");
    await expect(editor(page)).toBeVisible();
    await expect(warning).toBeHidden();
    await editor(page).press("Escape");
    await expect(warning).toBeVisible();
  });

  test("single letters pick tools, can be switched off, and stay letters in a field", async ({ page }) => {
    test.skip(isPhone(page), "desktop keyboards");
    await open(page, "multipage");
    await page.keyboard.press("r");
    await expect.poll(async () => (await state(page)).tool).toBe("rect");
    await page.keyboard.press("e");
    await page.keyboard.press("Control+f");
    await page.getByRole("searchbox", { name: "Find" }).pressSequentially("rv");
    expect((await state(page)).tool).toBe("edit-text");
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toBeFocused();
    await page.keyboard.press("Shift+?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await help.getByLabel(/Single-letter tool keys/).uncheck();
    await help.getByRole("button", { name: "Done" }).click();
    await page.keyboard.press("r");
    expect((await state(page)).tool).toBe("edit-text");
    await page.getByRole("banner").getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: /^Keyboard shortcuts/ }).click();
    await expect(help).toBeVisible();
  });

  test("tool settings open from one row, and Done gives the focus back", async ({ page }) => {
    await open(page, "en-truetype");
    await chooseTool(page, "Rectangle");
    const card = page.getByRole("region", { name: "Rectangle options" });
    await card.getByRole("button", { name: /^Choose line colour/ }).click();
    await card.getByRole("button", { name: "Line colour: Red", exact: true }).click();
    await card.getByRole("button", { name: /^Choose line width/ }).click();
    await card.getByRole("button", { name: "8 pt" }).click();
    expect(await app<{ strokeWidth: number }>(page, "s.toolOptions")).toMatchObject({ strokeWidth: 8, color: [0.8, 0.16, 0.13] });
    expect((await card.boundingBox())!.height).toBeLessThan(180);
    await card.getByRole("button", { name: "Done" }).click();
    await expect(toolbar(page).getByRole("button", { name: "Edit text", exact: true })).toBeFocused();
  });

  test("thumbnails beside the page jump, delete and take dropped files", async ({ page }) => {
    test.skip(isPhone(page), "wide screens");
    await open(page, "multipage");
    const strip = page.getByRole("navigation", { name: "Page thumbnails" });
    await strip.getByRole("button", { name: "Go to page 3" }).click();
    await expect(strip.getByRole("button", { name: "Go to page 3" })).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("ArrowDown");
    await expect(strip.getByRole("button", { name: "Go to page 4" })).toBeFocused();
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await state(page)).doc!.pageCount).toBe(4);
    await idle(page);
    await expect(strip.getByRole("button", { name: "Go to page 4" })).toBeFocused();
    const data = readFileSync(fixturePath("en-truetype")).toString("base64");
    const transfer = await page.evaluateHandle((base64) => {
      const t = new DataTransfer();
      t.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "added.pdf", { type: "application/pdf" }));
      return t;
    }, data);
    const second = strip.locator('[data-thumb="1"]');
    const box = (await second.boundingBox())!;
    for (const type of ["dragover", "drop"])
      await second.dispatchEvent(type, { dataTransfer: transfer, clientX: box.x + 20, clientY: box.y + 5 });
    await expect.poll(async () => (await state(page)).doc!.pageCount).toBe(5);
    await idle(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(readPdf((await download(page)).bytes).text(1)).toContain("Field notes");
    await page.keyboard.press("b");
    await expect(strip).toBeHidden();
  });

  test("the More sheet groups the tools and offers to install", async ({ page }) => {
    test.skip(!isPhone(page), "phone sheet");
    await open(page, "en-truetype");
    await page.evaluate(() => {
      const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
        prompt: async () => void Object.assign(window, { __prompted: true }),
        userChoice: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(event);
    });
    await toolbar(page).getByRole("button", { name: "More" }).click();
    const more = page.getByRole("dialog", { name: "More" });
    await expect(more.getByRole("list", { name: "Add" }).getByRole("button", { name: "Highlight" })).toBeVisible();
    await expect(more.getByRole("list", { name: "Select and remove" }).getByRole("button", { name: "Redact" })).toBeAttached();
    await more.getByRole("button", { name: "Install app" }).click();
    expect(await page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
  });

  test("Find gives the focus back when it closes", async ({ page }) => {
    await open(page, "multipage");
    await openPanel(page, "Find and replace");
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(page.locator("body")).not.toBeFocused();
  });

  test("a change is announced to screen readers", async ({ page }) => {
    await open(page, "en-truetype");
    await openLine(page, "en-truetype", 7);
    await editor(page).fill("Spoken change.");
    await done(page).click();
    await expect(page.getByTestId("announcer")).toHaveText("Text updated");
  });
});

test.describe("unsaved work", () => {
  test("comes back after the tab is closed, and is forgotten once saved", async ({ page }) => {
    await open(page, "en-truetype");
    await change(page);
    // time for the draft to reach the disk, then the tab goes away
    await page.waitForTimeout(800);
    page.once("dialog", (dialog) => void dialog.accept());
    await start(page);
    const card = page.getByRole("complementary", { name: "Continue where you left off" });
    await expect(card).toContainText("en-truetype.pdf");
    await card.getByRole("button", { name: "Continue" }).click();
    await ready(page);
    expect(await state(page)).toMatchObject({ dirty: true, canUndo: true });
    const { bytes } = await download(page);
    expect(readPdf(bytes).text(0)).toContain("A new line");
    await page.waitForTimeout(500);
    await start(page);
    await expect(page.getByRole("complementary", { name: "Continue where you left off" })).toHaveCount(0);
  });

  test("is not offered after discarding, nor when switched off", async ({ page }) => {
    await open(page, "en-truetype");
    await change(page);
    await page.getByRole("button", { name: "Close document" }).click();
    await page.getByRole("dialog", { name: "Unsaved changes" }).getByRole("button", { name: "Discard changes" }).click();
    await expect(chooseButton(page)).toBeVisible();
    await page.waitForTimeout(1500);
    await start(page);
    const card = page.getByRole("complementary", { name: "Continue where you left off" });
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: "About and privacy" }).click();
    await page.getByLabel(/Keep a draft/).uncheck();
    await page.getByRole("button", { name: "Close panel" }).click();
    await chooseFiles(page, chooseButton(page), fixturePath("en-truetype"));
    await ready(page);
    await change(page);
    await page.waitForTimeout(800);
    page.once("dialog", (dialog) => void dialog.accept());
    await start(page);
    await expect(card).toHaveCount(0);
  });
});

test.describe("files handed over by the system", () => {
  test("opens a file the installed app was started with", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "launchQueue", {
        configurable: true,
        value: { setConsumer: (consumer: unknown) => Object.assign(window, { __consumer: consumer }) },
      });
    });
    await start(page);
    const data = readFileSync(fixturePath("en-truetype")).toString("base64");
    await page.evaluate((base64) => {
      const file = new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "from-explorer.pdf", { type: "application/pdf" });
      (window as unknown as { __consumer(p: unknown): void }).__consumer({ files: [{ getFile: async () => file }] });
    }, data);
    await ready(page);
    expect((await state(page)).doc!.fileName).toBe("from-explorer.pdf");
  });

  test.describe("with the service worker", () => {
    test.use({ serviceWorkers: "allow" });

    test("a shared file stays on the device and opens; the sample is saved for offline", async ({ page, guard, context }, info) => {
      test.skip(!process.env.PDFEDIT_E2E_URL || info.project.name !== "desktop", "needs a build, in Chromium");
      // the post is answered by the service worker: see below that nothing but it ever saw the file
      guard.allow(/POST .*\/share-target/);
      await start(page);
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 60_000 }).toBe(true);
      await expect.poll(() => page.evaluate(async () => !!(await caches.match("/sample.pdf")))).toBe(true);
      await context.setOffline(true);
      const data = readFileSync(fixturePath("en-truetype")).toString("base64");
      // what the share sheet does: a form posted as a navigation, answered on the device even offline
      await page.evaluate((base64) => {
        const input = Object.assign(document.createElement("input"), { type: "file", name: "files" });
        const files = new DataTransfer();
        files.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "shared note.pdf", { type: "application/pdf" }));
        input.files = files.files;
        const form = Object.assign(document.createElement("form"), { method: "post", action: "/share-target", enctype: "multipart/form-data" });
        form.append(input);
        document.body.append(form);
        form.submit();
      }, data);
      await ready(page);
      expect((await state(page)).doc!.fileName).toBe("shared note.pdf");
      expect(new URL(page.url()).search).toBe("");
      expect(await page.evaluate(() => caches.has("pdfedit-inbox")), "nothing is left behind").toBe(false);
      await context.setOffline(false);
    });
  });
});
