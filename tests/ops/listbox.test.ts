import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { newEngine } from "../integration/helpers";
import { formPdf } from "./formFixture";

/** pixels of the pale blue bar behind a chosen list entry */
function marked(bytes: Uint8Array): number {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const data = pixmap.getPixels();
  let n = 0;
  for (let i = 0; i < data.length; i += 3)
    if (Math.abs(data[i]! - 153) < 8 && Math.abs(data[i + 1]! - 194) < 8 && Math.abs(data[i + 2]! - 217) < 8) n++;
  return n;
}

describe("list boxes", () => {
  it("keep the mark on the chosen entry, also when saved and flattened", async () => {
    const engine = newEngine();
    await engine.open(formPdf(), "form.pdf");
    const field = (await engine.listFormFields()).find((f) => f.name === "colour")!;
    expect(marked(await engine.exportPdf())).toBe(0);
    await engine.setFormField(field.page, field.id, "Green");
    expect((await engine.listFormFields()).find((f) => f.name === "colour")!.value).toBe("Green");
    expect(marked(await engine.exportPdf())).toBeGreaterThan(500);
    expect(marked(await engine.exportPdf({ flatten: true }))).toBeGreaterThan(500);
    const shown = await engine.renderPage(0, 1);
    let bar = 0;
    for (let i = 0; i < shown.data.length; i += 4)
      if (Math.abs(shown.data[i]! - 153) < 8 && Math.abs(shown.data[i + 1]! - 194) < 8) bar++;
    expect(bar).toBeGreaterThan(500);
  });
});
