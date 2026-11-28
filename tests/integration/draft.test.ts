/** Draft recovery: the proxy's journal written down and replayed by a fresh session. */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDraftKeeper, DRAFT_LIMIT, type DraftStorage } from "../../src/engine/draft";
import { answer, Engine } from "../../src/engine/engine";
import type { EngineRequest } from "../../src/engine/types";
import { nodeAssets } from "../fonts/nodeAssets";

/** the worker, run in this process, with messages copied as a real one would */
class InProcessWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror = null;
  private engine = new Engine(nodeAssets);
  private dead = false;
  constructor() {
    setTimeout(() => this.send({ id: 0, ok: true, result: "ready" }));
  }
  private send(data: unknown) {
    if (!this.dead) this.onmessage?.({ data });
  }
  postMessage(request: EngineRequest) {
    const copy = structuredClone(request);
    void answer(this.engine, copy).then((reply) => this.send(structuredClone(reply)));
  }
  terminate() {
    this.dead = true;
  }
}

function memory(): DraftStorage & { map: Map<string, unknown>; writes: number } {
  const map = new Map<string, unknown>();
  return {
    map,
    writes: 0,
    async get(key) {
      return structuredClone(map.get(key));
    },
    async write(entries, clear) {
      this.writes++;
      if (clear) map.clear();
      for (const [k, v] of entries) map.set(k, structuredClone(v));
    },
  };
}

const file = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/pdfs/${name}.pdf`));

describe("drafts", () => {
  beforeAll(() => vi.stubGlobal("Worker", InProcessWorker));
  afterAll(() => vi.unstubAllGlobals());

  /** a new tab: fresh proxy module over the same storage */
  async function tab(storage: DraftStorage) {
    vi.resetModules();
    const client = await import("../../src/engine/client");
    const keeper = createDraftKeeper(storage);
    client.useDraftKeeper(keeper);
    return { ...client, keeper };
  }

  it("restores the file and every change after the tab is gone", async () => {
    const storage = memory();
    const first = await tab(storage);
    await first.engine.open(file("en-standard14"), "letter.pdf");
    await first.keeper.settled();
    // opening alone keeps nothing
    expect(await first.loadDraft()).toBeNull();
    const line = (await first.engine.getPageText(0)).lines[0]!;
    await first.engine.editLines(0, [{ lineId: line.id, text: "Changed before the tab was closed" }]);
    await first.engine.rotatePages([0], 90);
    await first.engine.insertBlankPage(1, 300, 300);
    await first.engine.undo();
    await first.keeper.settled();
    expect(await first.loadDraft()).toMatchObject({ fileName: "letter.pdf", changes: 4 });
    const text = await first.engine.exportText([0]);

    const second = await tab(storage);
    const restored = (await second.restoreDraft())!;
    expect(restored).toMatchObject({ fileName: "letter.pdf", failed: 0, canUndo: true, canRedo: true });
    expect(await second.engine.exportText([0])).toBe(text);
    expect(restored.doc.pages[0]!.width).toBeGreaterThan(restored.doc.pages[0]!.height);
    // it goes on being kept, and is gone when cleared
    await second.engine.redo();
    await second.keeper.settled();
    expect(await second.loadDraft()).toMatchObject({ changes: 5 });
    await second.clearDraft();
    expect(await second.loadDraft()).toBeNull();
    expect(await second.restoreDraft()).toBeNull();
  });

  it("never keeps passwords or protected files", async () => {
    const storage = memory();
    const t = await tab(storage);
    await t.engine.open(file("password-aes256"), "secret.pdf", "test1234");
    await t.engine.rotatePages([0], 90);
    await t.keeper.settled();
    expect(storage.map.size).toBe(0);
    // adding a protected file to a normal one removes its draft
    await t.engine.open(file("en-standard14"), "plain.pdf");
    await t.engine.rotatePages([0], 90);
    await t.keeper.settled();
    expect(await t.loadDraft()).toMatchObject({ fileName: "plain.pdf" });
    await t.engine.insertPdf(file("password-aes256"), 0, "test1234");
    await t.keeper.settled();
    expect(storage.map.size).toBe(0);
    expect(JSON.stringify([...storage.map])).not.toContain("test1234");
  });

  it("keeps one draft, replaced only once the next file is changed, within a size limit", async () => {
    const storage = memory();
    const t = await tab(storage);
    await t.engine.open(file("en-standard14"), "one.pdf");
    await t.engine.rotatePages([0], 90);
    await t.engine.open(file("multipage"), "two.pdf");
    await t.keeper.settled();
    expect(await t.loadDraft()).toMatchObject({ fileName: "one.pdf" });
    await t.engine.deletePages([0]);
    await t.keeper.settled();
    expect(await t.loadDraft()).toMatchObject({ fileName: "two.pdf", changes: 1 });
    expect([...storage.map.keys()].sort()).toEqual(["meta", "open", "step:0"]);

    const keeper = createDraftKeeper(storage);
    const open = { method: "open", args: [new Uint8Array(10), "big.pdf"] };
    keeper.record({ open, steps: [{ method: "insertPdf", args: [new Uint8Array(DRAFT_LIMIT + 1), 0] }] });
    await keeper.settled();
    expect(storage.map.size).toBe(0);
    // an old draft is forgotten
    keeper.record({ open, steps: [{ method: "undo", args: [] }] });
    await keeper.settled();
    (storage.map.get("meta") as { savedAt: number }).savedAt = Date.now() - 8 * 86_400_000;
    storage.map.set("meta", { ...(storage.map.get("meta") as object) });
    expect(await keeper.info()).toBeNull();
    await keeper.setEnabled(false);
    keeper.record({ open, steps: [{ method: "undo", args: [] }] });
    await keeper.settled();
    expect(storage.map.size).toBe(0);
  });

  it("works with the browser's IndexedDB", async () => {
    vi.unstubAllGlobals();
    const { chromium } = await import("playwright");
    const { transformWithOxc } = await import("vite");
    const source = readFileSync("src/engine/draft.ts", "utf8");
    const script = (await transformWithOxc(source, "draft.ts")).code;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // a page of its own origin without a server: every request is answered here
      await page.route("http://draft.test/**", (route) =>
        route.request().url().endsWith(".js")
          ? route.fulfill({ contentType: "text/javascript", body: script })
          : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      const load = async () => {
        await page.addScriptTag({
          type: "module",
          content: `import { createDraftKeeper } from "/draft.js"; window.createDraftKeeper = createDraftKeeper;`,
        });
        await page.waitForFunction("window.createDraftKeeper");
      };
      await page.goto("http://draft.test/");
      await load();
      const write = () =>
        page.evaluate(async () => {
          const { createDraftKeeper } = window as any;
          const keeper = createDraftKeeper();
          const open = { method: "open", args: [new Uint8Array([1, 2, 3]), "kept.pdf"] };
          keeper.record({ open, steps: [{ method: "rotatePages", args: [[0], 90] }] });
          keeper.record({
            open,
            steps: [{ method: "rotatePages", args: [[0], 90] }, { method: "undo", args: [] }],
          });
          await keeper.settled();
        });
      await write();
      await page.reload();
      await load();
      const found = await page.evaluate(async () => {
        const { createDraftKeeper } = window as any;
        const keeper = createDraftKeeper();
        const journal = await keeper.read();
        const info = await keeper.info();
        await keeper.clear();
        return {
          name: info.fileName,
          changes: info.changes,
          bytes: Array.from(journal.open.args[0] as Uint8Array),
          steps: journal.steps.map((s: { method: string }) => s.method),
          after: await keeper.info(),
        };
      });
      expect(found).toEqual({ name: "kept.pdf", changes: 2, bytes: [1, 2, 3], steps: ["rotatePages", "undo"], after: null });
    } finally {
      await browser.close();
    }
  });
});
