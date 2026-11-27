import { describe, expect, it, vi } from "vitest";
import type { Engine } from "../../src/engine/engine";
import type { FormField } from "../../src/engine/types";
import { written } from "./fakeFonts";
import { formPdf } from "./formFixture";
import { load, open, savePng, shot, undoable } from "./helpers";

vi.mock("../../src/engine/fonts", async () => (await import("./fakeFonts")).fake);
vi.mock("../../src/engine/text", async () => (await import("./fakeModules")).text);
vi.mock("../../src/engine/ocr", async () => (await import("./fakeModules")).ocr);

const byName = async (engine: Engine, name: string) => (await engine.listFormFields()).filter((f) => f.name === name);
const set = async (engine: Engine, name: string, value: string | boolean, index = 0) => {
  const f = (await byName(engine, name))[index]!;
  return undoable(engine, () => engine.setFormField(f.page, f.id, value));
};
const dark = async (engine: Engine, f: FormField) => (await shot(engine, f.page)).ink(f.rect);

describe("forms", () => {
  it("lists every field type", async () => {
    const engine = await open(formPdf());
    const fields = await engine.listFormFields();
    expect(fields.map((f) => `${f.name}:${f.type}:${f.page}`)).toEqual([
      "name:text:0", "address:text:0", "pin:text:0", "agree:checkbox:0", "size:radio:0", "city:combobox:0",
      "colour:listbox:0", "size:radio:1", "locked:text:1", "sign:signature:1",
    ]);
    expect(fields[0]).toMatchObject({ label: "Full name", value: "", readOnly: false, multiline: false, rect: [20, 35, 200, 60] });
    expect(fields[1]!.multiline).toBe(true);
    expect(fields[4]).toMatchObject({ value: "small", checked: false, options: ["small", "large"] });
    expect(fields[5]!.options).toEqual(["Delhi", "मुंबई"]);
    expect(fields[8]!.readOnly).toBe(true);
    expect(fields[9]!.readOnly).toBe(true);
  });

  it("fills western text natively, with limits and combs", async () => {
    written.length = 0;
    const engine = await open(formPdf());
    await set(engine, "name", "Asha Verma");
    await set(engine, "address", "12 Park Street\nKolkata");
    const result = await set(engine, "pin", "7000161234");
    expect(result.warnings.join()).toContain("at most 6");
    expect(written, "MuPDF drew these itself").toEqual([]);
    expect((await byName(engine, "name"))[0]!.value).toBe("Asha Verma");
    expect((await byName(engine, "pin"))[0]!.value).toBe("700016");
    for (const name of ["name", "address", "pin"]) expect(await dark(engine, (await byName(engine, name))[0]!)).toBeGreaterThan(0.02);
    await shot(engine, 0, "forms-western");
    await expect(set(engine, "locked", "x")).rejects.toThrow(/read only/);
    await expect(set(engine, "sign", "x")).rejects.toThrow();
  });

  it("draws other scripts with the fonts module and keeps the value", async () => {
    written.length = 0;
    const engine = await open(formPdf());
    await set(engine, "name", "आशा वर्मा");
    await set(engine, "address", "पार्क स्ट्रीट\nकोलकाता");
    await set(engine, "pin", "१२३");
    await set(engine, "city", "मुंबई");
    expect(written).toEqual(expect.arrayContaining(["आशा वर्मा", "पार्क स्ट्रीट", "कोलकाता", "१", "२", "३", "मुंबई"]));
    expect((await byName(engine, "city"))[0]!.value).toBe("मुंबई");
    const saved = load(await engine.exportPdf());
    const values = saved.loadPage(0).getWidgets().map((w) => w.getValue());
    expect(values).toContain("आशा वर्मा");
    expect(values).toContain("BOM");
    expect(saved.getTrailer().get("Root", "AcroForm", "NeedAppearances").isNull()).toBe(true);
    await expect(set(engine, "city", "Pune")).rejects.toThrow(/choices/);
  });

  it("ticks checkboxes and radio groups across pages", async () => {
    const engine = await open(formPdf());
    await set(engine, "agree", true);
    expect((await byName(engine, "agree"))[0]!.checked).toBe(true);
    expect(await dark(engine, (await byName(engine, "agree"))[0]!)).toBeGreaterThan(0.15);
    await set(engine, "agree", false);
    expect((await byName(engine, "agree"))[0]!.checked).toBe(false);

    await set(engine, "size", true, 0);
    expect((await byName(engine, "size")).map((f) => f.checked)).toEqual([true, false]);
    const result = await set(engine, "size", true, 1);
    expect(result.changedPages.sort()).toEqual([0, 1]);
    expect((await byName(engine, "size")).map((f) => f.checked)).toEqual([false, true]);
    // choose by value from any button of the group
    await set(engine, "size", "small", 1);
    expect((await byName(engine, "size")).map((f) => f.checked)).toEqual([true, false]);
    expect(await dark(engine, (await byName(engine, "size"))[0]!)).toBeGreaterThan(await dark(engine, (await byName(engine, "size"))[1]!));
  });

  it("selects in combo and list boxes", async () => {
    const engine = await open(formPdf());
    await set(engine, "city", "Delhi");
    await set(engine, "colour", "Green");
    expect((await byName(engine, "city"))[0]!.value).toBe("Delhi");
    expect((await byName(engine, "colour"))[0]!.value).toBe("Green");
    expect(await dark(engine, (await byName(engine, "city"))[0]!)).toBeGreaterThan(0.02);
    expect(await dark(engine, (await byName(engine, "colour"))[0]!)).toBeGreaterThan(0.05);
    await shot(engine, 0, "forms-choice");
  });

  it("draws missing appearances once when the file asks viewers to", async () => {
    const engine = await open(formPdf(true));
    await set(engine, "name", "Zoë");
    const root = engine.context.doc.getTrailer().get("Root", "AcroForm");
    expect(root.get("NeedAppearances").isNull()).toBe(true);
    const locked = (await byName(engine, "locked"))[0]!;
    expect(await dark(engine, locked)).toBeGreaterThan(0.01);
    expect(await dark(engine, (await byName(engine, "name"))[0]!)).toBeGreaterThan(0.01);
  });

  it("flattens on export without losing what is shown", async () => {
    const engine = await open(formPdf(true));
    await set(engine, "name", "Flat value");
    await set(engine, "city", "मुंबई");
    await set(engine, "agree", true);
    const bytes = await engine.exportPdf({ flatten: true });
    const doc = load(bytes);
    expect(doc.loadPage(0).getWidgets()).toHaveLength(0);
    expect(doc.getTrailer().get("Root", "AcroForm").isNull()).toBe(true);
    expect(doc.loadPage(0).toStructuredText("").asText()).toContain("Flat value");
    expect(doc.loadPage(1).toStructuredText("").asText()).toContain("fixed");
    savePng(bytes, 0, "forms-flattened");
    // the open document is untouched
    expect(await engine.listFormFields()).toHaveLength(10);
  });
});
