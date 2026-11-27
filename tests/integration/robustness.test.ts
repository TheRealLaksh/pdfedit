/** Hostile and unusual files: clear messages, no crashes, no endless work, and a worker that recovers. */
import * as mupdf from "mupdf";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer, describeError, isFatalError } from "../../src/engine/engine";
import type { EngineRequest, ObjectBase, PageObject } from "../../src/engine/types";
import { newEngine } from "./helpers";

/* ---------- a tiny PDF writer ---------- */

type Obj = string | { dict?: string; data: string | Uint8Array };

function pdf(objects: Obj[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n", "latin1")];
  let length = parts[0]!.length;
  const push = (b: Buffer) => {
    parts.push(b);
    length += b.length;
  };
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(length);
    if (typeof o === "string") return push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1"));
    const data = typeof o.data === "string" ? Buffer.from(o.data, "latin1") : Buffer.from(o.data);
    push(Buffer.from(`${i + 1} 0 obj\n<< ${o.dict ?? ""} /Length ${data.length} >>\nstream\n`, "latin1"));
    push(data);
    push(Buffer.from("\nendstream\nendobj\n"));
  });
  const start = length;
  push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(parts));
}

const CATALOG = "<< /Type /Catalog /Pages 2 0 R >>";
const FONT = "/Font << /F1 4 0 R >>";
const TEXT = "BT /F1 18 Tf 72 700 Td (Hello hostile world) Tj ET";

function onePage(content: string | Uint8Array, options: { resources?: string; extra?: Obj[]; box?: string; dict?: string } = {}) {
  return pdf([
    CATALOG,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox ${options.box ?? "[0 0 612 792]"} /Resources << ${options.resources ?? FONT} >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    { dict: options.dict, data: content },
    ...(options.extra ?? []),
  ]);
}

const form = (resources: string, data: string): Obj => ({
  dict: `/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << ${resources} >>`,
  data,
});

/** n forms, each drawing the next `times` times */
function chain(n: number, times = 1) {
  const extra = Array.from({ length: n }, (_, i) =>
    i === n - 1 ? form("", "0 0 5 5 re f") : form(`/XObject << /N ${7 + i} 0 R >>`, "/N Do ".repeat(times)),
  );
  return onePage(`/N Do ${TEXT}`, { resources: `${FONT} /XObject << /N 6 0 R >>`, extra });
}

const selfDrawing = () => {
  const resources = `${FONT} /XObject << /Fm 6 0 R >>`;
  return onePage(`/Fm Do ${TEXT}`, {
    resources,
    extra: [form(resources, "0 0 m 100 100 l S /Fm Do /Fm Do /Fm Do")],
  });
};

const selfPattern = () =>
  onePage(`/Pattern cs /P1 scn 0 0 100 100 re f ${TEXT}`, {
    resources: `${FONT} /Pattern << /P1 6 0 R >>`,
    extra: [
      {
        dict: "/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 0.01 /YStep 0.01 /Resources << /Pattern << /P1 6 0 R >> >>",
        data: "/Pattern cs /P1 scn 0 0 1 1 re f",
      },
    ],
  });

async function opened(bytes: Uint8Array, name = "x.pdf") {
  const engine = newEngine();
  const result = await engine.open(bytes, name);
  if (result.status !== "ok") throw new Error("password");
  return { engine, doc: result.doc };
}

const box = (text: string): Omit<ObjectBase, "id"> & Record<string, unknown> => ({
  kind: "text",
  page: 0,
  rect: [50, 50, 250, 90],
  text,
  style: { family: "Helvetica", bold: false, italic: false, serif: false, mono: false, size: 14, color: [0, 0, 0] },
  align: "left",
});

/* ---------- opening ---------- */

describe("files that cannot be opened say why", () => {
  const cases: [string, Uint8Array, RegExp][] = [
    ["empty file", new Uint8Array(), /empty/],
    ["plain text", new TextEncoder().encode("just words\n".repeat(50)), /could not be read as a PDF/],
    ["web page", new TextEncoder().encode("<!doctype html><p>hi</p>"), /not a PDF|could not be read/],
    ["header only", new TextEncoder().encode("%PDF-1.7\n%%EOF\n"), /could not be read as a PDF/],
    ["no pages", pdf([CATALOG, "<< /Type /Pages /Kids [] /Count 0 >>"]), /no pages/],
    ["no page tree", pdf(["<< /Type /Catalog >>"]), /no pages|damaged/],
    ["absurd page count", pdf([CATALOG, "<< /Type /Pages /Kids [] /Count 1000000000 >>"]), /damaged|no pages/],
    ["page tree in a circle", pdf([CATALOG, "<< /Type /Pages /Kids [3 0 R] /Count 2 >>", "<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 2 >>"]), /damaged/],
    ["parent in a circle", pdf([CATALOG, "<< /Type /Pages /Kids [3 0 R] /Count 1 /Parent 3 0 R >>", "<< /Type /Page /Parent 3 0 R >>"]), /damaged/],
  ];

  it.each(cases)("%s", async (_name, bytes, message) => {
    await expect(newEngine().open(bytes, "x.pdf")).rejects.toThrow(message);
  });

  it("keeps the open document when the next file is rejected", async () => {
    const { engine } = await opened(onePage(TEXT));
    await expect(engine.open(new TextEncoder().encode("nope"), "no.pdf")).rejects.toThrow();
    await expect(engine.createFromImages([new Uint8Array([1, 2, 3])], "bad.pdf")).rejects.toThrow(/image format/);
    expect((await engine.getPageText(0)).lines[0]!.text).toBe("Hello hostile world");
    await engine.addObject(box("still works") as never);
  });

  it("opens a picture that was named .pdf", async () => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 60, 40], false);
    pixmap.clear(180);
    for (const bytes of [pixmap.asPNG().slice(), pixmap.asJPEG(80, false).slice()]) {
      const { engine, doc } = await opened(bytes, "scan.pdf");
      expect(doc.pageCount).toBe(1);
      expect((await engine.listImages(0)).length).toBe(1);
    }
  });

  it("inserts a picture named .pdf as a page, and explains a damaged file", async () => {
    const { engine } = await opened(onePage(TEXT));
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 60, 40], false);
    pixmap.clear(180);
    expect((await engine.insertPdf(pixmap.asPNG().slice(), 1)).doc.pageCount).toBe(2);
    const circle = pdf([CATALOG, "<< /Type /Pages /Kids [3 0 R] /Count 2 >>", "<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 2 >>"]);
    await expect(engine.insertPdf(circle, 0)).rejects.toThrow(/damaged/);
    expect((await engine.getPageText(0)).lines).toHaveLength(1);
  });

  it.each(["rc4-40", "rc4-128", "aes-128", "aes-256"])("%s passwords", async (method) => {
    const source = new mupdf.PDFDocument(onePage(TEXT));
    const locked = source.saveToBuffer(`encrypt=${method},user-password=s3cret,owner-password=boss`).asUint8Array().slice();
    const open = source.saveToBuffer(`encrypt=${method},owner-password=boss,permissions=0`).asUint8Array().slice();
    const engine = newEngine();
    expect(await engine.open(locked.slice(), "a.pdf")).toEqual({ status: "password", wrong: false });
    expect(await engine.open(locked.slice(), "a.pdf", "no")).toEqual({ status: "password", wrong: true });
    expect((await engine.open(locked.slice(), "a.pdf", "s3cret")).status).toBe("ok");
    expect((await opened(open)).doc.pageCount).toBe(1);
  });
});

/* ---------- pages that would hang or crash MuPDF ---------- */

describe("hostile pages are refused before they reach MuPDF", () => {
  it.each([
    ["forms nested 200 deep", () => chain(200), /nested too deeply/],
    ["forms repeated a billion times", () => chain(10, 10), /so many times/],
    ["a pattern that paints itself", selfPattern, /inside themselves/],
  ] as const)("%s", async (_name, make, message) => {
    const { engine } = await opened(make());
    await expect(engine.renderPage(0, 1)).rejects.toThrow(message);
    await expect(engine.getPageText(0)).rejects.toThrow(message);
    await expect(engine.addObject(box("x") as never)).rejects.toThrow(message);
    await expect(engine.redactAreas(0, [[0, 0, 100, 100]])).rejects.toThrow(message);
    expect(engine.healthy()).toBe(true);
    // the file can still be saved as it is
    expect((await engine.exportPdf()).length).toBeGreaterThan(100);
    expect((await engine.exportPdf({ compress: true })).length).toBeGreaterThan(100);
  });

  it("allows ordinary nesting", async () => {
    const { engine } = await opened(chain(8, 2));
    expect((await engine.renderPage(0, 1)).width).toBe(612);
    await engine.getPageText(0);
    await engine.redactAreas(0, [[0, 0, 100, 100]]);
  });

  it("shows and edits a form that draws itself, but will not claim to redact it", async () => {
    const { engine } = await opened(selfDrawing());
    await engine.renderPage(0, 1);
    await engine.getPageText(0);
    const started = Date.now();
    await expect(engine.redactAreas(0, [[0, 600, 300, 800]])).rejects.toThrow(/include themselves/);
    expect(Date.now() - started).toBeLessThan(2000);
    await engine.exportPdf({ compress: true });
    expect(engine.healthy()).toBe(true);
    await engine.addObject(box("after") as never);
  });

  it("refuses to take apart a content stream that unpacks to many megabytes", async () => {
    const huge = deflateSync(Buffer.from("0 0 m 1 1 l S ".repeat(2_500_000)), { level: 6 });
    const { engine } = await opened(onePage(huge, { dict: "/Filter /FlateDecode" }));
    await expect(engine.getPageText(0)).rejects.toThrow(/too much drawing data/);
    await expect(engine.listImages(0)).rejects.toThrow(/too much drawing data/);
  });

  it.each(["[0 0 14400000 14400000]", "[0 0 0.001 0.001]", "[0 0 1 14400]", "[612 792 0 0]"])("draws a page sized %s", async (size) => {
    const { engine } = await opened(onePage(TEXT, { box: size }));
    for (const scale of [1, 4]) {
      const image = await engine.renderPage(0, scale);
      expect(image.width).toBeGreaterThan(0);
      expect(image.width * image.height).toBeLessThanOrEqual(41_000_000);
      expect(image.data.length).toBe(image.width * image.height * 4);
    }
  });

  it("puts MuPDF's wording into plain words", () => {
    expect(describeError(new Error("exception stack overflow!"))).toMatch(/nested too deeply/);
    expect(describeError(new Error("compression bomb detected"))).toMatch(/unpacks/);
    expect(isFatalError(new WebAssembly.RuntimeError("memory access out of bounds"))).toBe(true);
    expect(isFatalError(new Error("Page 3 does not exist"))).toBe(false);
  });
});

describe("repeatable results", () => {
  it("gives the same ids and revisions when the same steps are repeated", async () => {
    const run = async () => {
      const { engine } = await opened(onePage(TEXT));
      await expect(engine.addObject({ ...box("bad"), page: 9 } as never)).rejects.toThrow();
      const first = await engine.addObject(box("one") as never);
      await engine.undo();
      const second = await engine.addObject(box("two") as never);
      return [first.createdId, second.createdId, second.doc.pages[0]!.revision];
    };
    expect(await run()).toEqual(await run());
  });
});

/* ---------- worker recovery ---------- */

describe("client: a dead worker is replaced and the document rebuilt", () => {
  /** what the next worker should do instead of answering a method */
  let sabotage: Map<string, "crash" | "hang" | "die">;
  let started = 0;

  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    private engine = newEngine();
    private dead = false;
    constructor(loads = true) {
      started++;
      if (loads) setTimeout(() => this.emit({ id: 0, ok: true, result: "ready" }));
    }
    private emit(data: unknown) {
      if (!this.dead) this.onmessage?.({ data });
    }
    postMessage(request: EngineRequest) {
      const data = structuredClone(request) as EngineRequest;
      const plan = sabotage.get(data.method);
      if (plan) sabotage.delete(data.method);
      if (plan === "hang") return;
      if (plan === "die") return void setTimeout(() => this.onerror?.({ message: "worker died" }));
      if (plan === "crash")
        return void setTimeout(() => this.emit({ id: data.id, ok: false, error: "restarted", fatal: true }));
      void answer(this.engine, data).then((reply) => this.emit(structuredClone(reply)));
    }
    terminate() {
      this.dead = true;
    }
  }

  const load = async () => {
    vi.resetModules();
    return import("../../src/engine/client");
  };

  beforeEach(() => {
    sabotage = new Map();
    started = 0;
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps earlier changes after a crash", async () => {
    const { engine } = await load();
    await engine.open(onePage(TEXT), "a.pdf");
    const added = await engine.addObject(box("kept") as never);
    await engine.rotatePages([0], 90);
    sabotage.set("redactAreas", "crash");
    const failing = engine.redactAreas(0, [[0, 0, 10, 10]]);
    // already waiting behind the failing call
    const queued = engine.listObjects(0);
    await expect(failing).rejects.toThrow(/restarted/);
    const objects: PageObject[] = await queued;
    expect(objects.map((o) => o.id)).toEqual([added.createdId]);
    expect(started).toBe(2);
    await engine.updateObject({ ...objects[0]!, rect: [60, 60, 260, 100] });
    expect((await engine.undo()).canUndo).toBe(true);
  });

  it("does not retry a page that crashes the engine", async () => {
    const { engine } = await load();
    await engine.open(onePage(TEXT), "a.pdf");
    sabotage.set("renderPage", "crash");
    await expect(engine.renderPage(0, 1)).rejects.toThrow();
    sabotage.set("renderPage", "crash");
    await expect(engine.renderPage(0, 2)).rejects.toThrow();
    expect(started).toBe(2);
    expect((await engine.getPageText(0)).lines).toHaveLength(1);
  });

  it("survives the worker dying with an error event", async () => {
    const { engine } = await load();
    await engine.open(onePage(TEXT), "a.pdf");
    sabotage.set("findText", "die");
    await expect(engine.findText("o", { matchCase: false, wholeWord: false })).rejects.toThrow(/died/);
    expect((await engine.getPageText(0)).lines).toHaveLength(1);
  });

  it("stops a call that never ends", async () => {
    const { engine, HUNG } = await load();
    await engine.open(onePage(TEXT), "a.pdf");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    sabotage.set("getPageText", "hang");
    const hung = expect(engine.getPageText(0)).rejects.toThrow(HUNG);
    await vi.advanceTimersByTimeAsync(91_000);
    await hung;
    vi.useRealTimers();
    expect((await engine.renderPage(0, 1)).width).toBe(612);
  });

  it("announces when it is ready, and words a failed download plainly", async () => {
    const { engine, engineReady, warmUpEngine, NOT_DOWNLOADED } = await load();
    let fail = true;
    vi.stubGlobal(
      "Worker",
      class extends FakeWorker {
        constructor() {
          super(!fail);
          if (fail) setTimeout(() => this.onerror?.({ message: "Uncaught RuntimeError: Aborted(NetworkError)" }));
          fail = false;
        }
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(engine.open(onePage(TEXT), "a.pdf")).rejects.toThrow(NOT_DOWNLOADED);
    warmUpEngine();
    await engineReady;
    expect((await engine.open(onePage(TEXT), "a.pdf")).status).toBe("ok");
  });

  it("says so when a file crashes the engine while opening, and keeps the previous one", async () => {
    const { engine, UNOPENABLE } = await load();
    await engine.open(onePage(TEXT), "a.pdf");
    sabotage.set("open", "crash");
    await expect(engine.open(onePage(TEXT), "b.pdf")).rejects.toThrow(UNOPENABLE);
    expect((await engine.getPageText(0)).lines).toHaveLength(1);
  });

  it("gives up cleanly when rebuilding fails too", async () => {
    const { engine, LOST } = await load();
    await engine.open(onePage(TEXT), "a.pdf");
    sabotage.set("rotatePages", "crash");
    sabotage.set("open", "crash");
    const failing = engine.rotatePages([0], 90);
    const queued = engine.getPageText(0);
    await expect(failing).rejects.toThrow();
    await expect(queued).rejects.toThrow(LOST);
    await expect(engine.getPageText(0)).rejects.toThrow(/No document is open/);
    expect((await engine.open(onePage(TEXT), "a.pdf")).status).toBe("ok");
  });
});
