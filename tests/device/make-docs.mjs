/** Realistic documents for device testing: small print, tight tables, columns, several scripts. */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const css = `body{font:9pt Arial,sans-serif;margin:0;color:#111} h1{font-size:18pt;margin:0 0 4pt} h2{font-size:11pt;border-bottom:1px solid #999;margin:10pt 0 4pt}
 table{width:100%;border-collapse:collapse} td,th{border:1px solid #bbb;padding:2pt 4pt;text-align:left} .r{text-align:right} .c{text-align:center}
 .cols{columns:2;column-gap:14pt;text-align:justify} p{margin:0 0 3pt;line-height:1.25} .small{font-size:7pt;color:#555}`;
const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>${i + 1}</td><td>Item ${i + 1} cable set</td><td class="c">${(i % 4) + 1}</td><td class="r">Rs ${(i + 3) * 125}.00</td><td class="r">Rs ${(i + 3) * 125 * ((i % 4) + 1)}.00</td></tr>`).join("");
const docs = {
  invoice: `<h1>Tax Invoice</h1><p>Invoice No. INV-2026-0042 &nbsp; Date: 28 November 2026</p><h2>Billed to</h2><p>Asha Verma</p><p>14 Lake Road, Pune 411001</p>
    <h2>Items</h2><table><tr><th>#</th><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>${rows}</table>
    <p class="r">Subtotal Rs 24,500.00</p><p class="r"><b>Total Rs 28,910.00</b></p><p class="small">This is a generated sample used for testing. Goods once sold are not returned.</p>`,
  article: `<h1>Notes on river gauges</h1><div class="cols">${Array.from({ length: 14 }, (_, i) => `<p>Paragraph ${i + 1}: the gauge was read twice each morning and the values were copied into the ledger before the water rose again near the old bridge.</p>`).join("")}</div>`,
  hindi: `<h1>वार्षिक रिपोर्ट</h1>${Array.from({ length: 14 }, (_, i) => `<p>पंक्ति ${i + 1}: नदी का जल स्तर सुबह और शाम को दर्ज किया गया था।</p>`).join("")}
    <h2>विवरण</h2><table><tr><th>नाम</th><th>राशि</th></tr><tr><td>आशा वर्मा</td><td>रु 1,250</td></tr><tr><td>रवि कुमार</td><td>रु 980</td></tr></table>`,
};

mkdirSync(".tmp/device/docs", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, body] of Object.entries(docs)) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`, { waitUntil: "load" });
  await page.pdf({ path: `.tmp/device/docs/${name}.pdf`, format: "A4", margin: { top: "40px", bottom: "40px", left: "40px", right: "40px" } });
}
await browser.close();
console.log("made", Object.keys(docs).join(", "));
