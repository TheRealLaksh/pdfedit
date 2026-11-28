/**
 * Makes the pictures the image editor is judged on, into .tmp/img/scenes/: browser screenshots, printed
 * posters seen at an angle, and phone photos of paper and signs. All text is made up.
 * Run:  node tests/image/tools/make-scenes.mjs   (needs Playwright Chromium and Python with Pillow + numpy)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const out = fileURLToPath(new URL("../../../.tmp/img/scenes/", import.meta.url));
mkdirSync(out, { recursive: true });
const cdn = (slug, v, w, stem) => `https://cdn.jsdelivr.net/npm/@expo-google-fonts/${slug}@${v}/${w}/${stem}_${w}.ttf`;
const faces = [
  ["M", cdn("montserrat", "0.4.2", "800ExtraBold", "Montserrat"), 800],
  ["M", cdn("montserrat", "0.4.2", "500Medium", "Montserrat"), 500],
  ["O", cdn("oswald", "0.4.2", "600SemiBold", "Oswald"), 600],
  ["P", cdn("playfair-display", "0.4.2", "700Bold", "PlayfairDisplay"), 700],
  ["L", cdn("lato", "0.4.1", "400Regular", "Lato"), 400],
]
  .map(([family, url, weight]) => `@font-face{font-family:${family};src:url(${url});font-weight:${weight}}`)
  .join("");

const page = (body, css = "") => `<!doctype html><meta charset="utf-8"><style>${faces}*{margin:0;padding:0;box-sizing:border-box}
.t{position:absolute;white-space:nowrap;line-height:1.25}${css}</style><body>${body}</body>`;
const t = (id, x, y, size, text, style = "") => `<div class="t" data-id="${id}" style="left:${x}px;top:${y}px;font-size:${size}px;${style}">${text}</div>`;
const box = (x, y, w, h, style) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}"></div>`;

const screenshot = page(
  [
    box(0, 0, 900, 56, "background:#fff;border-bottom:1px solid #e3e3e8"),
    t("title", 24, 15, 18, "Northwind Payments", "font-weight:600;color:#17171a"),
    t("user", 742, 18, 14, "Signed in as Meera", "color:#63636b"),
    box(0, 57, 200, 460, "background:#1f2430"),
    t("nav1", 24, 84, 14, "Overview", "color:#ffffff;font-weight:600"),
    t("nav2", 24, 118, 14, "Transactions", "color:#aab1c2"),
    t("nav3", 24, 152, 14, "Customers", "color:#aab1c2"),
    box(230, 84, 640, 150, "background:#fff;border:1px solid #e3e3e8;border-radius:10px"),
    t("label", 254, 104, 13, "Available balance", "color:#63636b"),
    t("amount", 254, 126, 34, "&#8377;48,250.75", "font-weight:700;color:#17171a"),
    t("note", 254, 186, 13, "Next payout on 12 March 2027", "color:#1d7a4a"),
    box(700, 150, 140, 42, "background:#2f5bea;border-radius:8px"),
    t("button", 731, 162, 14, "Withdraw now", "color:#fff;font-weight:600"),
    box(230, 254, 640, 230, "background:#fff;border:1px solid #e3e3e8;border-radius:10px"),
    ...[
      ["Invoice 2041", "Asha Textiles", "12,400.00"],
      ["Invoice 2042", "Blue Harbour Cafe", "3,150.50"],
      ["Invoice 2043", "Kiran Motors", "27,980.00"],
      ["Invoice 2044", "Studio Lantern", "4,720.25"],
    ].flatMap((r, i) => [
      t(`r${i}a`, 254, 278 + i * 46, 14, r[0], "color:#17171a;font-family:Arial"),
      t(`r${i}b`, 430, 278 + i * 46, 14, r[1], "color:#43434b;font-family:Arial"),
      t(`r${i}c`, 760, 278 + i * 46, 14, r[2], "color:#17171a;font-family:Consolas,monospace"),
      box(254, 310 + i * 46, 592, 1, "background:#ececf0"),
    ]),
  ].join(""),
  "body{width:900px;height:517px;background:#f4f4f2;font-family:'Segoe UI',sans-serif;position:relative}",
);

const poster = page(
  [
    t("kicker", 70, 70, 26, "ANNUAL STREET FOOD FAIR", "font-family:M;font-weight:500;letter-spacing:6px;color:#ffd98a"),
    t("head", 66, 130, 96, "Monsoon Market", "font-family:P;font-weight:700;color:#fff6e8"),
    t("date", 70, 290, 74, "SATURDAY 14 AUGUST", "font-family:O;font-weight:600;color:#ffcf4a"),
    box(70, 420, 660, 4, "background:#ffd98a"),
    t("place", 70, 448, 34, "Riverside Grounds, Gate 3", "font-family:L;color:#ffffff"),
    t("price", 70, 505, 40, "Entry Rs 150 per person", "font-family:M;font-weight:800;color:#ffffff"),
    t("small", 70, 590, 20, "Children under ten come in free. Bring your own cup.", "font-family:L;color:#e9d9ee"),
  ].join(""),
  "body{width:800px;height:660px;position:relative;background:linear-gradient(160deg,#41205f 0%,#7a2e62 55%,#c0553f 100%)}",
);

const hindi = page(
  [
    t("h1", 60, 50, 64, "ताज़ा फल और सब्ज़ियाँ", "font-family:'Nirmala UI';font-weight:700;color:#173f22"),
    t("h2", 60, 170, 44, "हर रविवार सुबह खुला", "font-family:'Nirmala UI';color:#2b2b2b"),
    t("h3", 60, 260, 40, "Fresh from local farms", "font-family:Georgia;color:#7a2b16"),
  ].join(""),
  "body{width:760px;height:360px;position:relative;background:#f3e7c4}",
);

const scenes = [
  { id: "screen1", html: screenshot, width: 900, height: 517, scale: 1 },
  { id: "screen2", html: screenshot, width: 900, height: 517, scale: 2 },
  { id: "poster-flat", html: poster, width: 800, height: 660, scale: 2 },
  { id: "hindi-flat", html: hindi, width: 760, height: 360, scale: 2 },
];

const browser = await chromium.launch();
const truth = {};
for (const s of scenes) {
  const context = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale });
  const tab = await context.newPage();
  await tab.setContent(s.html, { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: out + s.id + ".png" });
  truth[s.id] = await tab.evaluate((scale) =>
    [...document.querySelectorAll("[data-id]")].map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      const q = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];
      return { id: el.dataset.id, text: el.textContent, quad: q.map(([x, y]) => [x * scale, y * scale]) };
    }), s.scale);
  await context.close();
}
await browser.close();
writeFileSync(out + "truth.json", JSON.stringify(truth, null, 1));
execFileSync("python", [fileURLToPath(new URL("./photos.py", import.meta.url)), out], { stdio: "inherit" });
