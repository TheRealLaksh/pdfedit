/**
 * App screenshots with known text, for judging detection: drawn by Chromium with web fonts, shrunk and
 * saved as JPEG the way shared screenshots are. Everything in them is made up or drawn here.
 */
import type { Page } from "playwright";
import type { Picture } from "../../src/image/types";
import { launch } from "../ocr/helpers";
import { decode } from "./helpers";

export interface Truth {
  text: string;
  /** upright rectangle of the lettering, in picture pixels */
  rect: [number, number, number, number];
}

export interface Screen {
  name: string;
  width: number;
  height: number;
  body: string;
  languages?: string[];
}

export interface Variant {
  /** width of the saved picture; default: the drawn width */
  out?: number;
  dpr?: number;
  quality?: number;
}

const CDN = "https://cdn.jsdelivr.net/npm/@fontsource";
const face = (family: string, pkg: string, subset: string, weight: number) =>
  `@font-face{font-family:${family};font-weight:${weight};src:url(${CDN}/${pkg}@5.3.0/files/${pkg}-${subset}-${weight}-normal.woff2) format("woff2")}`;

const INDIC: [string, string, string][] = [
  ["Deva", "devanagari", "U+0900-097F"],
  ["Beng", "bengali", "U+0980-09FF"],
  ["Guru", "gurmukhi", "U+0A00-0A7F"],
  ["Gujr", "gujarati", "U+0A80-0AFF"],
  ["Taml", "tamil", "U+0B80-0BFF"],
  ["Telu", "telugu", "U+0C00-0C7F"],
  ["Knda", "kannada", "U+0C80-0CFF"],
  ["Mlym", "malayalam", "U+0D00-0D7F"],
];

const FACES = [
  ...[400, 500, 600, 700].flatMap((w) => [face("Poppins", "poppins", "latin", w), face("Inter", "inter", "latin", w)]),
  ...INDIC.flatMap(([family, name, range]) => [400, 500, 600].map((w) => face(family, `noto-sans-${name}`, name, w).replace("}", `;unicode-range:${range},U+200C-200D,U+25CC}`))),
].join("");

const CSS = `${FACES}*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden;font-family:Poppins,Deva,Beng,Guru,Gujr,Taml,Telu,Knda,Mlym,sans-serif}
div{position:absolute}span{white-space:nowrap;line-height:1.35}.t{position:absolute;white-space:nowrap;line-height:1.35}
.pill{position:absolute;display:flex;align-items:center;justify-content:center;white-space:nowrap}`;

const at = (x: number, y: number, w: number, h: number, style: string, inner = "") =>
  `<div style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}">${inner}</div>`;
/** a line of text that counts */
const t = (x: number, y: number, size: number, text: string, style = "color:#1d1d29") =>
  `<span class="t" style="left:${x}px;top:${y}px;font-size:${size}px;${style}"><span data-t>${text}</span></span>`;
/** a filled shape with a label in its middle */
const pill = (x: number, y: number, w: number, h: number, size: number, text: string, style: string) =>
  `<span class="pill" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${size}px;border-radius:${h / 2}px;${style}"><span data-t>${text}</span></span>`;
const photo = (x: number, y: number, w: number, h: number, seed: number, style = "") =>
  `<canvas data-photo="${seed}" width="${w}" height="${h}" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}"></canvas>`;
/** a mark that is not text: rings, dots and bars */
const logo = (x: number, y: number, s: number, color: string) =>
  `<svg style="position:absolute;left:${x}px;top:${y}px" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4">
<circle cx="12" cy="12" r="9"/><path d="M7 15l4-7 3 5 3-3"/><circle cx="12" cy="12" r="2" fill="${color}"/></svg>`;

export interface Words {
  title: string;
  tabs: [string, string];
  badges: [string, string];
  card: [string, string];
  progress: string;
  nav: string[];
}

const ENGLISH: Words = {
  title: "Programs & Courses",
  tabs: ["In Progress (1)", "Completed (0)"],
  badges: ["Course", "Open Course"],
  card: ["Effective Speaking and Listening Skills", "Communication Skills"],
  progress: "35% Completed",
  nav: ["Dashboard", "My Learning", "Certificates", "Support"],
};

const HINDI: Words = {
  title: "कार्यक्रम और पाठ्यक्रम",
  tabs: ["जारी है (1)", "पूरे हुए (0)"],
  badges: ["पाठ्यक्रम", "कोर्स खोलें"],
  card: ["प्रभावी बोलने और सुनने का कौशल", "संचार कौशल"],
  progress: "35% पूरा हुआ",
  nav: ["मुख्य पृष्ठ", "मेरी पढ़ाई", "प्रमाणपत्र", "सहायता"],
};

/** a learning dashboard: heading, underlined tabs, a course card with badges on a photo */
export const dashboard = (w: Words = ENGLISH, name = "dashboard"): Screen => ({
  name,
  width: 620,
  height: 430,
  body: [
    at(0, 0, 620, 430, "background:#f6f7fb"),
    at(0, 0, 620, 40, "background:#fff;border-bottom:1px solid #e8e9f1"),
    logo(18, 9, 22, "#3b5bdb"),
    ...w.nav.map((n, i) => t(60 + i * 108, 12, 10, n, `color:${i === 1 ? "#3b5bdb" : "#5c5f72"};font-weight:500`)),
    t(24, 56, 19, w.title, "color:#14142b;font-weight:600"),
    t(24, 100, 11, w.tabs[0], "color:#22223a;font-weight:500"),
    t(132, 100, 11, w.tabs[1], "color:#8a8d9f;font-weight:500"),
    at(24, 123, 80, 2, "background:#ff7a1a"),
    at(24, 125, 572, 1, "background:#e2e3ec"),
    at(24, 144, 270, 258, "background:#fff;border:1px solid #e6e7f0;border-radius:10px"),
    photo(25, 145, 268, 140, 7, "border-radius:10px 10px 0 0"),
    pill(36, 156, 56, 19, 9, w.badges[0], "background:#2f62e8;color:#fff;font-weight:500"),
    pill(190, 252, 90, 22, 9.5, w.badges[1], "background:#fff;color:#1c1c2e;font-weight:600"),
    t(36, 298, 11.5, w.card[0], "color:#17172b;font-weight:600"),
    t(36, 320, 9, w.card[1], "color:#74778a"),
    at(36, 348, 246, 5, "background:#ececf4;border-radius:3px"),
    at(36, 348, 86, 5, "background:#2fb36b;border-radius:3px"),
    t(36, 362, 9.5, w.progress, "color:#4d5063"),
    at(312, 144, 284, 258, "background:#fff;border:1px solid #e6e7f0;border-radius:10px"),
    photo(328, 160, 72, 72, 11, "border-radius:36px"),
    logo(520, 170, 44, "#ff7a1a"),
  ].join(""),
});

const buttons = (hindi = false): Screen => {
  const s = (en: string, hi: string) => (hindi ? hi : en);
  return {
    name: hindi ? "buttons-hi" : "buttons",
    width: 600,
    height: 360,
    body: [
      at(0, 0, 600, 360, "background:#ffffff"),
      t(24, 18, 15, s("Account settings", "खाता सेटिंग"), "color:#111827;font-weight:600"),
      pill(24, 56, 110, 30, 11, s("Save changes", "बदलाव सहेजें"), "background:#4f46e5;color:#fff;font-weight:500;border-radius:7px"),
      pill(146, 56, 74, 30, 11, s("Cancel", "रद्द करें"), "border:1px solid #d1d5db;color:#374151;border-radius:7px"),
      pill(232, 56, 82, 30, 11, s("Delete", "हटाएँ"), "background:#dc2626;color:#fff;font-weight:500;border-radius:7px"),
      pill(326, 56, 96, 30, 11, s("Upgrade plan", "योजना बदलें"), "background:#facc15;color:#422006;font-weight:600;border-radius:7px"),
      pill(434, 56, 80, 30, 11, s("Publish", "प्रकाशित करें"), "background:#111827;color:#fff;border-radius:7px"),
      ...[
        [s("Design", "डिज़ाइन"), "#e0e7ff", "#3730a3"],
        [s("Marketing", "विपणन"), "#dcfce7", "#166534"],
        [s("Finance", "वित्त"), "#fee2e2", "#991b1b"],
        [s("New", "नया"), "#16a34a", "#ffffff"],
        [s("Beta", "बीटा"), "#7c3aed", "#ffffff"],
        [s("Due today", "आज देय"), "#fef3c7", "#92400e"],
      ].map(([text, bg, fg], i) => pill(24 + i * 92, 110, 74, 20, 9.5, text!, `background:${bg};color:${fg};font-weight:500`)),
      t(24, 154, 12, s("Notifications", "सूचनाएँ"), "color:#111827;font-weight:600"),
      t(24, 180, 10, s("Email me when someone replies", "जवाब आने पर ईमेल भेजें"), "color:#4b5563"),
      at(520, 180, 34, 18, "background:#22c55e;border-radius:9px"),
      at(538, 182, 14, 14, "background:#fff;border-radius:7px"),
      t(24, 208, 10, s("Weekly summary every Monday", "हर सोमवार साप्ताहिक सार"), "color:#4b5563"),
      at(520, 208, 34, 18, "background:#d1d5db;border-radius:9px"),
      at(522, 210, 14, 14, "background:#fff;border-radius:7px"),
      photo(24, 248, 250, 96, 3, "border-radius:8px"),
      pill(36, 258, 52, 18, 9, s("Live", "लाइव"), "background:#e11d48;color:#fff;font-weight:600"),
      pill(188, 316, 74, 20, 9, s("Watch now", "अभी देखें"), "background:rgba(0,0,0,.75);color:#fff"),
      logo(330, 260, 60, "#4f46e5"),
      logo(430, 270, 34, "#16a34a"),
    ].join(""),
  };
};

const table = (hindi = false): Screen => {
  const s = (en: string, hi: string) => (hindi ? hi : en);
  const rows = [
    [s("Invoice", "बिल"), s("Client", "ग्राहक"), s("Status", "स्थिति"), s("Amount", "राशि")],
    ["INV-2041", s("Asha Textiles", "आशा वस्त्र"), s("Paid", "चुकाया"), "12,400"],
    ["INV-2042", s("Blue Harbour", "नीला घाट"), s("Pending", "बाकी"), "3,150"],
    ["INV-2043", s("Kiran Motors", "किरण मोटर्स"), s("Overdue", "विलंब"), "27,980"],
    ["INV-2044", s("Studio Lantern", "दीप स्टूडियो"), s("Paid", "चुकाया"), "4,720"],
  ];
  const chip: Record<number, [string, string]> = { 1: ["#dcfce7", "#166534"], 2: ["#fef3c7", "#92400e"], 3: ["#fee2e2", "#991b1b"], 4: ["#dcfce7", "#166534"] };
  return {
    name: hindi ? "table-hi" : "table",
    width: 620,
    height: 320,
    body: [
      at(0, 0, 620, 320, "background:#fff"),
      ...[s("Overview", "सारांश"), s("Invoices", "बिल सूची"), s("Reports", "रिपोर्ट"), s("Settings", "सेटिंग")].map((n, i) =>
        t(24 + i * 78, 16, 11, n, `color:${i === 1 ? "#0f172a" : "#94a3b8"};font-weight:500`),
      ),
      at(102, 40, 50, 2, "background:#0ea5e9"),
      at(24, 42, 572, 1, "background:#e2e8f0"),
      at(24, 60, 572, 30, "background:#f1f5f9"),
      ...rows.flatMap((r, row) =>
        r.map((cell, col) => {
          const x = [36, 150, 330, 500][col]!;
          const y = 68 + row * 40;
          if (col === 2 && row) return pill(x, y - 2, 66, 20, 9.5, cell, `background:${chip[row]![0]};color:${chip[row]![1]};font-weight:500`);
          return t(x, y, row ? 10.5 : 10, cell, `color:${row ? "#1e293b" : "#64748b"};font-weight:${row ? 400 : 600}`);
        }),
      ),
      ...[1, 2, 3, 4, 5].map((i) => at(24, 54 + i * 40 + 4, 572, 1, "background:#e2e8f0")),
      pill(500, 276, 96, 28, 10.5, s("Export CSV", "निर्यात करें"), "background:#0ea5e9;color:#fff;border-radius:6px;font-weight:500"),
    ].join(""),
  };
};

const dark: Screen = {
  name: "dark",
  width: 600,
  height: 340,
  body: [
    at(0, 0, 600, 340, "background:#0f1117;font-family:Inter"),
    t(22, 18, 15, "Team activity", "color:#f4f4f5;font-weight:600;font-family:Inter"),
    t(22, 52, 10.5, "All", "color:#f4f4f5;font-family:Inter"),
    t(62, 52, 10.5, "Mentions", "color:#71717a;font-family:Inter"),
    t(140, 52, 10.5, "Archived", "color:#71717a;font-family:Inter"),
    at(22, 74, 16, 2, "background:#818cf8"),
    at(22, 90, 556, 92, "background:#1a1d27;border-radius:10px"),
    logo(38, 108, 28, "#818cf8"),
    t(80, 104, 11, "Priya shared a file", "color:#e4e4e7;font-weight:500;font-family:Inter"),
    t(80, 124, 9.5, "Roadmap draft, 2 minutes ago", "color:#8b8b95;font-family:Inter"),
    pill(80, 148, 62, 22, 9.5, "Review", "background:#6366f1;color:#fff;border-radius:6px;font-family:Inter"),
    pill(152, 148, 62, 22, 9.5, "Dismiss", "background:#2a2e3d;color:#c7c7d1;border-radius:6px;font-family:Inter"),
    pill(482, 106, 78, 20, 9, "Unread 4", "background:#14532d;color:#86efac;font-family:Inter"),
    photo(22, 200, 200, 116, 19, "border-radius:10px"),
    pill(34, 212, 58, 18, 9, "Video", "background:#000;color:#fff;font-family:Inter"),
    t(240, 206, 11.5, "Storage almost full", "color:#fbbf24;font-weight:600;font-family:Inter"),
    t(240, 228, 10, "4.6 GB of 5 GB used", "color:#a1a1aa;font-family:Inter"),
    at(240, 254, 300, 6, "background:#27272a;border-radius:3px"),
    at(240, 254, 262, 6, "background:#fbbf24;border-radius:3px"),
    pill(240, 280, 104, 28, 10.5, "Get more space", "background:#f4f4f5;color:#18181b;border-radius:6px;font-weight:600;font-family:Inter"),
  ].join(""),
};

const phone: Screen = {
  name: "phone",
  width: 390,
  height: 740,
  body: [
    at(0, 0, 390, 740, "background:#f4f5f7;font-family:Inter"),
    t(22, 12, 13, "9:41", "color:#111;font-weight:600;font-family:Inter"),
    t(20, 48, 22, "Good morning, Meera", "color:#111827;font-weight:700"),
    t(20, 84, 12, "You have 3 lessons this week", "color:#6b7280"),
    pill(20, 116, 60, 28, 12, "All", "background:#111827;color:#fff"),
    pill(88, 116, 82, 28, 12, "Popular", "background:#fff;color:#374151"),
    pill(178, 116, 62, 28, 12, "Free", "background:#fff;color:#374151"),
    photo(20, 164, 350, 170, 23, "border-radius:16px"),
    pill(34, 178, 66, 22, 10, "Course", "background:#2563eb;color:#fff;font-weight:600"),
    pill(240, 290, 116, 30, 11, "Open Course", "background:#fff;color:#111827;font-weight:600"),
    t(20, 348, 14, "Public Speaking Basics", "color:#111827;font-weight:600"),
    t(20, 374, 11, "12 lessons . 4 hours", "color:#6b7280"),
    at(20, 410, 350, 74, "background:#fff;border-radius:14px"),
    logo(34, 426, 42, "#f59e0b"),
    t(90, 424, 13, "Daily streak", "color:#111827;font-weight:600"),
    t(90, 448, 11, "5 days in a row", "color:#6b7280"),
    pill(292, 432, 64, 28, 11, "Claim", "background:#f59e0b;color:#fff;font-weight:600"),
    photo(20, 500, 165, 110, 31, "border-radius:14px"),
    photo(205, 500, 165, 110, 37, "border-radius:14px"),
    t(20, 618, 11, "Design Systems", "color:#111827;font-weight:500"),
    t(205, 618, 11, "Data Basics", "color:#111827;font-weight:500"),
    at(0, 672, 390, 68, "background:#fff;border-top:1px solid #e5e7eb"),
    ...["Home", "Search", "Saved", "Profile"].flatMap((n, i) => [
      logo(36 + i * 94, 682, 22, i ? "#9ca3af" : "#2563eb"),
      t(30 + i * 94, 710, 10, n, `color:${i ? "#9ca3af" : "#2563eb"};font-weight:500`),
    ]),
  ].join(""),
};

/** photographs and marks with no lettering at all: nothing may be found */
export const wordless: Screen = {
  name: "wordless",
  width: 640,
  height: 420,
  body: [
    at(0, 0, 640, 420, "background:#fff"),
    photo(0, 0, 320, 210, 5),
    photo(320, 0, 320, 210, 13),
    photo(0, 210, 320, 210, 29),
    ...Array.from({ length: 12 }, (_, i) => logo(340 + (i % 4) * 72, 225 + Math.floor(i / 4) * 62, 40, ["#e11d48", "#2563eb", "#16a34a"][i % 3]!)),
  ].join(""),
};

/** a shop notice, a menu board, a poster and a sign, each with two scripts on one baseline */
const bilingual = (name: string, ground: string, ink: string, lines: [number, string][], languages?: string[]): Screen => ({
  name,
  width: 640,
  height: Math.round(60 + lines.reduce((sum, [size]) => sum + size * 2.2, 0)),
  body: [
    at(0, 0, 640, 900, `background:${ground}`),
    ...lines.map(([size, text], i) => t(32, 30 + lines.slice(0, i).reduce((sum, [s]) => sum + s * 2.2, 0), size, text, `color:${ink};font-weight:500`)),
  ].join(""),
  languages,
});

export const MIXED = {
  notice: bilingual("notice", "#f4efe2", "#22201c", [
    [28, "खुलने का समय / Hours: 10 to 18"],
    [24, "आज की तारीख / Date: 13/02/2026"],
    [20, "रविवार को बंद / Closed on Sunday"],
    [20, "Please ring the bell at gate 7"],
  ]),
  menu: bilingual("menu", "#23342b", "#f6f1df", [
    [26, "आज का मेनू / Today's Menu"],
    [20, "मसाला चाय / Masala Tea 15"],
    [20, "आलू पराठा / Potato Paratha 40"],
    [20, "ठंडी लस्सी / Sweet Lassi 35"],
  ]),
  poster: bilingual("poster", "#ffffff", "#15306b", [
    [34, "पुस्तक मेला / Book Fair 2026"],
    [20, "स्थान: नगर भवन, Hall No. 3"],
    [20, "प्रवेश निःशुल्क - Free Entry"],
  ]),
  sign: bilingual("sign", "#f7c600", "#111111", [
    [30, "धीरे चलें  GO SLOW"],
    [22, "स्कूल आगे है / School Ahead"],
  ]),
  bengali: bilingual("bengali", "#fbfaf5", "#1c1c1c", [[26, "খোলার সময় / Hours: 10 to 18"], [22, "রবিবার বন্ধ / Closed on Sunday"]]),
  tamil: bilingual("tamil", "#fbfaf5", "#1c1c1c", [[26, "திறக்கும் நேரம் / Hours: 10 to 18"], [22, "ஞாயிறு விடுமுறை / Closed on Sunday"]]),
  telugu: bilingual("telugu", "#fbfaf5", "#1c1c1c", [[26, "తెరిచే సమయం / Hours: 10 to 18"], [22, "ఆదివారం సెలవు / Closed on Sunday"]]),
  gujarati: bilingual("gujarati", "#fbfaf5", "#1c1c1c", [[26, "ખુલવાનો સમય / Hours: 10 to 18"], [22, "રવિવારે બંધ / Closed on Sunday"]]),
  punjabi: bilingual("punjabi", "#fbfaf5", "#1c1c1c", [[26, "ਖੁੱਲਣ ਦਾ ਸਮਾਂ / Hours: 10 to 18"], [22, "ਐਤਵਾਰ ਬੰਦ / Closed on Sunday"]]),
  kannada: bilingual("kannada", "#fbfaf5", "#1c1c1c", [[26, "ತೆರೆಯುವ ಸಮಯ / Hours: 10 to 18"], [22, "ಭಾನುವಾರ ರಜೆ / Closed on Sunday"]]),
  malayalam: bilingual("malayalam", "#fbfaf5", "#1c1c1c", [[26, "തുറക്കുന്ന സമയം / Hours: 10 to 18"], [22, "ഞായർ അവധി / Closed on Sunday"]]),
};

export const SCREENS = {
  dashboard: dashboard(),
  "dashboard-hi": dashboard(HINDI, "dashboard-hi"),
  ...MIXED,
  buttons: buttons(),
  "buttons-hi": buttons(true),
  table: table(),
  "table-hi": table(true),
  dark,
  phone,
  wordless,
};

/** paints the photo-like canvases: blurred shapes, edges and grain, the same for the same seed */
function paintPhotos() {
  for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas[data-photo]"))) {
    let seed = Number(canvas.dataset.photo) * 7919 + 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const g = canvas.getContext("2d")!;
    const { width: w, height: h } = canvas;
    const sky = g.createLinearGradient(0, 0, w, h);
    sky.addColorStop(0, `hsl(${rnd() * 360},35%,62%)`);
    sky.addColorStop(1, `hsl(${rnd() * 360},40%,28%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      g.filter = i < 40 ? "blur(5px)" : "blur(0.6px)";
      g.fillStyle = `hsla(${rnd() * 360},${20 + rnd() * 50}%,${15 + rnd() * 70}%,${0.35 + rnd() * 0.6})`;
      g.beginPath();
      if (i % 3 === 0) g.rect(rnd() * w, rnd() * h, 3 + rnd() * 24, 4 + rnd() * 50);
      else g.ellipse(rnd() * w, rnd() * h, 2 + rnd() * 20, 2 + rnd() * 24, rnd() * 3, 0, 7);
      g.fill();
    }
    g.filter = "none";
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `hsla(${rnd() * 360},30%,${rnd() * 90}%,.8)`;
      g.lineWidth = 0.7 + rnd() * 2;
      g.beginPath();
      const x = rnd() * w;
      const y = rnd() * h;
      g.moveTo(x, y);
      g.quadraticCurveTo(x + rnd() * 30 - 15, y + rnd() * 30 - 15, x + rnd() * 50 - 25, y + rnd() * 50 - 25);
      g.stroke();
    }
    const image = g.getImageData(0, 0, w, h);
    for (let i = 0; i < image.data.length; i += 4) {
      const n = (rnd() - 0.5) * 34;
      for (let c = 0; c < 3; c++) image.data[i + c] = image.data[i + c]! + n;
    }
    g.putImageData(image, 0, 0);
  }
}

export async function render(screen: Screen, variant: Variant = {}): Promise<{ picture: Picture; truth: Truth[]; jpeg: Buffer }> {
  const dpr = variant.dpr ?? 1;
  const page: Page = await (await launch()).newPage({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: dpr });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${screen.body}</body>`);
  await page.evaluate(paintPhotos);
  // every face is asked for, then waited for: a missing one would be drawn in another font
  const ready = await page.evaluate(async () => {
    const used = Array.from(document.querySelectorAll<HTMLElement>("[data-t]")).map((e) => {
      const s = getComputedStyle(e);
      return document.fonts.load(`${s.fontWeight} 16px ${s.fontFamily}`, e.textContent ?? "");
    });
    const faces = (await Promise.all(used)).flat();
    await document.fonts.ready;
    return faces.every((f) => f.status === "loaded");
  });
  if (!ready) throw new Error("the web fonts did not load");
  const rects = await page.$$eval("[data-t]", (spans) =>
    spans.map((s) => {
      const r = s.getBoundingClientRect();
      return { text: s.textContent ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );
  const shot = await page.screenshot();
  const out = variant.out ?? screen.width * dpr;
  const url = await page.evaluate(
    async ([data, width, quality]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width as number;
      canvas.height = Math.round((image.height * (width as number)) / image.width);
      const g = canvas.getContext("2d")!;
      g.imageSmoothingQuality = "high";
      g.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality as number);
    },
    [shot.toString("base64"), out, (variant.quality ?? 70) / 100] as const,
  );
  await page.close();
  const jpeg = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const by = out / screen.width;
  // the element box has room above and below the letters
  const truth = rects.map((r): Truth => ({ text: r.text, rect: [r.x * by, (r.y + r.h * 0.12) * by, (r.x + r.w) * by, (r.y + r.h * 0.88) * by] }));
  return { picture: decode(jpeg), truth, jpeg };
}
