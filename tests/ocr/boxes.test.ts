/** Editing recognised boxes: the new lettering keeps to the size of the print, whatever lies around it. */
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { Rect } from "../../src/engine/types";
import { createNodeAssets } from "../fonts/nodeAssets";

const assets = createNodeAssets();

/** a one page scan: the given page content turned into a picture */
function scan(content: string): Uint8Array {
  const typed = new mupdf.PDFDocument();
  const font = typed.newDictionary();
  font.put("Type", typed.newName("Font"));
  font.put("Subtype", typed.newName("Type1"));
  font.put("BaseFont", typed.newName("Helvetica"));
  const resources = typed.newDictionary();
  const fonts = typed.newDictionary();
  fonts.put("F1", typed.addObject(font));
  resources.put("Font", fonts);
  typed.insertPage(-1, typed.addPage([0, 0, 300, 200], 0, typed.addObject(resources), content));
  const page = typed.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false);
  const image = new mupdf.Image(pixmap.asPNG());
  const out = new mupdf.PDFDocument();
  const xobjects = out.newDictionary();
  xobjects.put("Im", out.addImage(image));
  const holder = out.newDictionary();
  holder.put("XObject", xobjects);
  out.insertPage(-1, out.addPage([0, 0, 300, 200], 0, out.addObject(holder), "q 300 0 0 200 0 0 cm /Im Do Q"));
  return out.saveToBuffer("").asUint8Array().slice();
}

const text = (x: number, y: number, size: number, value: string) => `BT /F1 ${size} Tf ${x} ${y} Td (${value}) Tj ET`;

async function editOcr(content: string, said: string, rect: Rect, next: string) {
  const engine = new Engine(assets);
  await engine.open(scan(content), "scan.pdf");
  await engine.setOcrResult({ page: 0, languages: ["eng"], lines: [{ text: said, rect, confidence: 95, words: [{ text: said, rect, confidence: 95 }] }] });
  const line = (await engine.getPageText(0)).lines.find((l) => l.text === said)!;
  await engine.editLines(0, [{ lineId: line.id, text: next }]);
  return (await engine.getPageText(0)).lines.find((l) => l.text === next)!;
}

describe("recognised boxes", () => {
  it("keeps to the size of the print when art touches the words", async () => {
    // dark shapes running into the sampling area above and below a 14 point line
    const art = "0.15 g 20 118 60 40 re f 90 70 130 22 re f 0 g";
    const line = await editOcr(`${art}\n${text(40, 100, 14, "Weekend walks nearby")}`, "Weekend walks nearby", [40, 88.5, 184, 103], "Weekend walks");
    expect(line.style.size).toBeGreaterThan(14 * 0.65);
    expect(line.style.size).toBeLessThan(14 * 1.45);
  });

  it("gives a short cell the size of the other lines of the page", async () => {
    const line = await editOcr(text(40, 100, 12, "noon"), "noon", [40, 93.5, 67, 100.3], "soon");
    expect(line.style.size).toBeGreaterThan(9);
    expect(line.style.size).toBeLessThan(15);
  });
});
