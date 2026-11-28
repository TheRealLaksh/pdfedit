// Builds public/sample.pdf, the document behind "Try a sample": our own words, open fonts (SIL OFL 1.1).
// Run after changing it: node scripts/make-sample.mjs
// Fonts are read from .tmp/fonts-cache/ (filled by the tests) and downloaded from jsDelivr when missing.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as mupdf from "mupdf";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom", logLevel: "error" });
const { Engine } = await server.ssrLoadModule("/src/engine/engine.ts");
const { createAssetLoader } = await server.ssrLoadModule("/src/engine/context.ts");

const assets = createAssetLoader(async (url) => {
  const file = `.tmp/fonts-cache/${createHash("sha1").update(url).digest("hex").slice(0, 12)}-${url.split("/").pop()}`;
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await mkdir(".tmp/fonts-cache", { recursive: true });
    await writeFile(file, bytes);
    return bytes;
  }
});

const W = 595;
const H = 842;
const INK = [0.09, 0.1, 0.12];
const MUTED = [0.33, 0.35, 0.4];
const BLUE = [0.17, 0.31, 0.85];
const RULE = [0.78, 0.8, 0.84];

const blank = new mupdf.PDFDocument();
blank.insertPage(-1, blank.addPage([0, 0, W, H], 0, blank.newDictionary(), ""));
const engine = new Engine(assets);
await engine.open(blank.saveToBuffer("").asUint8Array().slice(), "sample.pdf");

/** one line of text whose box starts at x, y (page space, y down) */
async function text(value, x, y, size, { family = "Noto Sans", color = INK, bold = false, align = "left", width = W - 128 } = {}) {
  await engine.addObject({
    page: 0,
    kind: "text",
    rect: [x, y, x + width, y + size * 1.7],
    rotation: 0,
    opacity: 1,
    text: value,
    align,
    style: { family, bold, italic: false, serif: family === "Gelasio", mono: false, size, color },
  });
}
const rule = (x0, y, x1, color = RULE, width = 0.8) =>
  engine.addObject({ page: 0, kind: "line", rect: [x0, y, x1, y + 1], rotation: 0, opacity: 1, from: [x0, y], to: [x1, y], stroke: color, strokeWidth: width });
const box = (rect, fill) =>
  engine.addObject({ page: 0, kind: "rect", rect, rotation: 0, opacity: 1, fill, stroke: null });

await text("Riverside Garden Club", 64, 56, 26, { family: "Gelasio", bold: true });
await text("Spring membership, receipt 2041", 64, 100, 12, { family: "Gelasio", color: MUTED });
await rule(64, 128, W - 64, INK, 1.2);

await text("Tap this line and change it.", 64, 146, 17, { color: BLUE, bold: true });
await text("The new words keep the font, size and colour of the old ones.", 64, 178, 11.5);
await text("Thank you for renewing. The garden opens again on Saturday 12 April.", 64, 197, 11.5);
await text("Bring your own gloves; tools and seedlings are shared at the gate.", 64, 216, 11.5);

await box([64, 252, W - 64, 274], [0.93, 0.94, 0.96]);
const columns = (a, b, c, y, options = {}) =>
  Promise.resolve()
    .then(() => text(a, 72, y, 11, { width: 250, ...options }))
    .then(() => text(b, 330, y, 11, { width: 60, align: "right", ...options }))
    .then(() => text(c, 413, y, 11, { width: 110, align: "right", ...options }));
await columns("Item", "Qty", "Amount (Rs)", 254, { bold: true });
const rows = [
  ["Yearly membership", "1", "1,200.00"],
  ["Vegetable bed, 6 square metres", "2", "900.00"],
  ["Compost, 25 kg bag", "3", "540.00"],
];
for (const [i, row] of rows.entries()) {
  await columns(row[0], row[1], row[2], 282 + i * 26);
  await rule(64, 304 + i * 26, W - 64);
}
await columns("Total paid", "", "2,640.00", 362, { bold: true });

await text("यह पंक्ति हिन्दी में है। इसे भी बदलकर देखें।", 64, 408, 13);
await text("هذا السطر باللغة العربية، ويمكنك تعديله أيضًا.", 64, 436, 13, { align: "right", width: W - 128 });
await text("இந்த வரியையும் மாற்றிப் பாருங்கள்.", 64, 466, 13);

await text("Fill in the form", 64, 520, 15, { family: "Gelasio", bold: true });
await text("Your name", 64, 552, 11, { color: MUTED, width: 120 });
await text("Plot you would like", 64, 590, 11, { color: MUTED, width: 140 });
await rule(64, 672, 290, INK, 0.8);
await text("Signature (use Sign to add yours)", 64, 676, 10, { color: MUTED, width: 240 });

await text("A made-up document for trying PDFEdit. The club, the people and the amounts do not exist.", 64, 770, 9, { color: MUTED });

const drawn = await engine.exportPdf({ compress: true });

// two form fields, added straight to the file
const doc = mupdf.Document.openDocument(drawn, "application/pdf").asPDF();
const pageObject = doc.findPage(0);
const helvetica = doc.addSimpleFont(new mupdf.Font("Helvetica"));
const field = (name, x, y, w, h) => {
  const widget = doc.addObject({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Tx",
    F: 4,
    Rect: [x, H - y - h, x + w, H - y],
    MK: { BC: [0.5, 0.52, 0.58], BG: [1, 1, 1] },
  });
  widget.put("T", doc.newString(name));
  widget.put("DA", doc.newString("/Helv 11 Tf 0 g"));
  widget.put("P", pageObject);
  return widget;
};
const fields = [field("Your name", 210, 550, 250, 24), field("Plot you would like", 210, 588, 250, 24)];
pageObject.put("Annots", fields);
doc.getTrailer().get("Root").put("AcroForm", { Fields: fields, DR: { Font: { Helv: helvetica } } });
const page = doc.loadPage(0);
for (const widget of page.getWidgets()) widget.update();
const bytes = doc.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
await writeFile("public/sample.pdf", bytes);

// read it back: every line must come out as written, and be editable
const check = new Engine(assets);
const opened = await check.open(bytes.slice(), "sample.pdf");
const read = await check.getPageText(0);
console.log(`${bytes.length} bytes, forms: ${opened.doc.hasForms}`);
for (const line of read.lines) console.log(line.editable === false ? "LOCKED " : "       ", line.text);
await mkdir(".tmp/shell2", { recursive: true });
await writeFile(".tmp/shell2/sample.png", await check.exportPageImage(0, 110, "png"));
await server.close();
