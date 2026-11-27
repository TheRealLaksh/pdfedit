/** AcroForm listing, filling (any script) and flattening. */
import { describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/engine";
import { diffPixels, doc, inkPixels, mupdfDocument, mupdfText, normalise, openBytes, openDoc, overlap, pad, render, savePng } from "./helpers";

const expected = doc("forms").fields!;

async function fields(engine: Engine) {
  return engine.listFormFields();
}
const named = async (engine: Engine, name: string) => (await fields(engine)).filter((f) => f.name === name);

describe("forms", () => {
  it("lists every field with its type, value, options and place", async () => {
    const { engine, info } = await openDoc("forms");
    expect(info.hasForms).toBe(true);
    const list = await fields(engine);
    expect(list.length).toBe(expected.length + 1); // the radio group has two buttons
    expect(new Set(list.map((f) => f.id)).size).toBe(list.length);
    for (const want of expected) {
      const found = list.find((f) => f.name === want.name && overlap(f.rect, want.rect) > 0.8);
      expect(found, want.name).toBeTruthy();
      expect(found!.type, want.name).toBe(want.type);
      expect(found!.page).toBe(0);
      expect(found!.label.length).toBeGreaterThan(0);
      expect(found!.readOnly, want.name).toBe(!!want.readOnly);
      if (want.options) expect(found!.options, want.name).toEqual(want.options);
      if (want.multiline) expect(found!.multiline).toBe(true);
      if (want.type === "text" || want.type === "combobox" || want.type === "listbox") expect(found!.value, want.name).toBe(want.value);
      if (want.type === "checkbox") expect(found!.checked).toBe(false);
    }
    expect((await named(engine, "plan")).map((f) => f.checked)).toEqual([true, false]);
  });

  it("fills every kind of field and the values survive export", async () => {
    const { engine } = await openDoc("forms");
    const set = async (name: string, value: string | boolean, index = 0) => {
      const field = (await named(engine, name))[index]!;
      const result = await engine.setFormField(field.page, field.id, value);
      expect(result.changedPages).toContain(0);
    };
    await set("full_name", "Asha Example");
    await set("about", "Line one of the note.\nLine two of the note.");
    await set("newsletter", true);
    await set("plan", true, 1);
    await set("city", "Kochi");
    await set("interest", "Cycling");
    const reopened = await openBytes(await engine.exportPdf(), "filled.pdf");
    const value = async (name: string) => (await named(reopened.engine, name))[0]!;
    expect((await value("full_name")).value).toBe("Asha Example");
    expect(normalise((await value("about")).value)).toBe("Line one of the note. Line two of the note.");
    expect((await value("newsletter")).checked).toBe(true);
    expect((await named(reopened.engine, "plan")).map((f) => f.checked)).toEqual([false, true]);
    expect((await value("city")).value).toBe("Kochi");
    expect((await value("interest")).value).toBe("Cycling");
    expect((await value("reference")).value).toBe("REF-0042");
    const picture = await render(reopened.engine, 0);
    const clean = await render((await openDoc("forms")).engine, 0);
    const changed = diffPixels(clean, picture, expected.map((f) => pad(f.rect, 2)).concat([pad([230, 595 - 346, 248, 595 - 328], 2)]));
    if (changed.stray) savePng("forms-filled", picture, expected.map((f) => f.rect));
    expect(changed.stray, "only field areas change").toBe(0);
    for (const name of ["full_name", "about", "newsletter", "city"])
      expect(inkPixels(picture, pad((await value(name)).rect, -3)), `${name} has a visible value`).toBeGreaterThan(8);
  });

  it("unticks and undoes", async () => {
    const { engine } = await openDoc("forms");
    const box = (await named(engine, "newsletter"))[0]!;
    const clean = await render(engine, 0);
    await engine.setFormField(0, box.id, true);
    await engine.setFormField(0, box.id, false);
    expect((await named(engine, "newsletter"))[0]!.checked).toBe(false);
    await engine.undo();
    expect((await named(engine, "newsletter"))[0]!.checked).toBe(true);
    await engine.undo();
    expect(diffPixels(clean, await render(engine, 0), [], 2, 2).changed).toBe(0);
  });

  it.each([
    ["Hindi", "अनुराग शर्मा"],
    ["Chinese", "公共图书馆"],
    ["Arabic", "مكتبة المدينة"],
    ["Tamil", "பொது நூலகம்"],
    ["Greek", "Βιβλιοθήκη"],
  ])("draws %s values with a font that has the glyphs", async (_language, text) => {
    const { engine } = await openDoc("forms");
    const field = (await named(engine, "full_name"))[0]!;
    const clean = await render(engine, 0);
    await engine.setFormField(0, field.id, text);
    expect((await named(engine, "full_name"))[0]!.value).toBe(text);
    const picture = await render(engine, 0);
    savePng(`form-${_language}`, picture, [field.rect]);
    const difference = diffPixels(clean, picture, [pad(field.rect, 2)]);
    expect(difference.changed).toBeGreaterThan(60);
    expect(difference.stray).toBe(0);
    const flat = await engine.exportPdf({ flatten: true, compress: true });
    expect(normalise(mupdfText(flat, 0)).replace(/ /g, "").length).toBeGreaterThan(20);
    const reopened = await openBytes(flat, "flat.pdf");
    expect(diffPixels(picture, await render(reopened.engine, 0), [pad(field.rect, 2)]).stray, "flattening keeps the look").toBeLessThanOrEqual(20);
    const lines = (await reopened.engine.getPageText(0)).lines.map((l) => normalise(l.text));
    expect(lines, "value is real text after flattening").toContain(text);
  });

  it("flattens: no widgets remain, values stay visible and searchable", async () => {
    const { engine } = await openDoc("forms");
    const field = (await named(engine, "full_name"))[0]!;
    await engine.setFormField(0, field.id, "Flattened Person");
    const flat = await engine.exportPdf({ flatten: true });
    const pdf = mupdfDocument(flat);
    expect(pdf.loadPage(0).getWidgets().length).toBe(0);
    expect(mupdfText(flat, 0)).toContain("Flattened Person");
    expect((await openBytes(flat, "flat.pdf")).info.hasForms).toBe(false);
    // the document being edited still has its form
    expect((await fields(engine)).length).toBe(expected.length + 1);
  });

  it("returns no fields for documents without a form", async () => {
    const { engine } = await openDoc("en-truetype");
    expect(await fields(engine)).toEqual([]);
  });
});
