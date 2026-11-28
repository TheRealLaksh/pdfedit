/**
 * Documents like people really have, printed by Chromium. Next to every PDF a JSON file lists the text
 * a reader sees as separate pieces, taken from the page layout itself, for the box sweep to compare with.
 *
 *   node tests/text/sweep/gen-html.mjs [outDir]
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const out = path.resolve(process.argv[2] ?? ".tmp/boxes/pdfs");
fs.mkdirSync(out, { recursive: true });

const A4 = [794, 1123];
const doc = (body, css = "", [w, h] = A4) => `<!doctype html><meta charset="utf-8"><style>
@page { size: ${w}px ${h}px; margin: 0 }
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: Arial, sans-serif; font-size: 13px; color: #222; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.page { width: ${w}px; height: ${h - 1}px; position: relative; overflow: hidden; padding: 48px; break-after: page }
table { border-collapse: collapse; width: 100% }
${css}</style>${body}`;

const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("");
const photo = () => {
  // a made-up picture: coloured blobs as an SVG
  const blobs = rows(40, (i) => `<circle cx="${(i * 97) % 700}" cy="${(i * 53) % 300}" r="${20 + (i % 7) * 11}" fill="hsl(${(i * 37) % 360},45%,${30 + (i % 5) * 9}%)" opacity="0.7"/>`);
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="300"><rect width="700" height="300" fill="#234"/>${blobs}</svg>`)}`;
};

const documents = {
  resume: doc(
    `<div class="page" style="font-family:Calibri">
<h1>Aarav Mehta</h1>
<p class="sub">Product Engineer &middot; Gurugram, India</p>
<p class="contact"><span>aarav.mehta@example.com</span> | <span>+91 98765 00000</span> | <a href="#">linkedin.com/in/example</a></p>
<h2>Experience</h2>
<div class="row"><b>Senior Engineer, Northwind Labs</b><span>Jan 2023 &ndash; Present</span></div>
<ul><li>Built a billing service that processes 40,000 invoices every month.</li>
<li>Cut page load time from <b>4.2 s</b> to <i>1.1 s</i> by splitting the bundle.</li>
<li>Mentored four interns; two of them joined the team full time after graduating from their programmes last summer.</li></ul>
<div class="row"><b>Engineer, Bluefin Systems</b><span>Jun 2020 &ndash; Dec 2022</span></div>
<ul><li>Owned the mobile checkout used by 120k customers.</li><li>Wrote the data pipeline in Python &amp; SQL.</li></ul>
<h2>Education</h2>
<div class="row"><b>B.Tech, Computer Science</b><span>2016 &ndash; 2020</span></div>
<p><em>Institute of Technology, Jaipur</em> &mdash; CGPA 8.7/10</p>
<h2>Skills</h2>
<div class="skills"><span>TypeScript</span><span>React</span><span>Node.js</span><span>PostgreSQL</span><span>Docker</span><span>AWS</span></div>
<h2>Projects</h2>
<table class="p"><tr><td><b>Ledgerly</b></td><td>Open source bookkeeping tool</td><td class="r">2024</td></tr>
<tr><td><b>Pathfinder</b></td><td>Campus map with offline routing</td><td class="r">2022</td></tr></table>
</div>`,
    `h1{font-size:34px;color:#1f3a5f} .sub{font-size:15px;color:#666} .contact{font-size:12px;margin:4px 0 10px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:2px;color:#1f3a5f;border-bottom:1.5px solid #1f3a5f;margin:18px 0 8px;padding-bottom:2px}
.row{display:flex;justify-content:space-between;margin-top:8px} ul{margin:4px 0 4px 20px} li{line-height:1.45}
.skills{display:flex;gap:8px;flex-wrap:wrap} .skills span{background:#eef2f7;padding:3px 9px;border-radius:10px;font-size:12px}
table.p td{padding:3px 0} td.r{text-align:right}`,
  ),

  "resume-two-column": doc(
    `<div class="page" style="padding:0;display:flex"><aside><h3>CONTACT</h3><p>12 Lake View Road</p><p>Pune 411045</p><p>priya@example.com</p>
<h3>LANGUAGES</h3><p>English</p><p>Hindi</p><p>Marathi</p><h3>SKILLS</h3><p>Figma</p><p>User research</p><p>Prototyping</p></aside>
<main><h1>PRIYA KULKARNI</h1><h2>U X &nbsp; D E S I G N E R</h2><h3>PROFILE</h3>
<p>Designer with six years of experience turning vague requirements into products that people understand without a manual. Comfortable running research, sketching flows and shipping with engineers.</p>
<h3>WORK</h3><p><strong>Lead Designer</strong> &middot; Orbit Health</p><p class="d">2022 - today</p><p>Redesigned appointment booking; drop-off fell by a third.</p>
<p><strong>Designer</strong> &middot; Paperboat Studio</p><p class="d">2019 - 2022</p><p>Delivered 30+ client projects across web and mobile.</p></main></div>`,
    `aside{width:230px;background:#253041;color:#e8ecf2;padding:40px 22px;height:100%} main{flex:1;padding:40px 36px}
aside h3{color:#9fc0ff} h3{font-size:12px;letter-spacing:3px;margin:20px 0 6px} p{line-height:1.6} h1{font-size:30px;letter-spacing:4px} h2{font-size:12px;color:#777;font-weight:normal} .d{color:#888;font-size:11px}`,
  ),

  invoice: doc(
    `<div class="page">
<div class="head"><div><h1>INVOICE</h1><p>Invoice No: INV-2026-0042</p><p>Date: 14 November 2026</p><p>Due: 28 November 2026</p></div>
<div class="from"><b>Kestrel Design Co.</b><p>221 Residency Road</p><p>Bengaluru 560025</p><p>GSTIN 29ABCDE1234F1Z5</p></div></div>
<div class="head"><div><p class="lbl">BILL TO</p><b>Meridian Foods Pvt Ltd</b><p>Plot 7, Sector 18</p><p>Noida 201301</p></div></div>
<table><thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th class="r">Rate (₹)</th><th class="r">Amount (₹)</th></tr></thead><tbody>
${[
  ["Brand identity design", 1, "45,000.00", "45,000.00"],
  ["Packaging artwork", 6, "3,500.00", "21,000.00"],
  ["Website maintenance (November)", 1, "12,000.00", "12,000.00"],
  ["Product photography", 24, "450.00", "10,800.00"],
  ["Print supervision", 2, "2,250.00", "4,500.00"],
]
  .map((r, i) => `<tr><td>${i + 1}</td><td>${r[0]}</td><td class="r">${r[1]}</td><td class="r">${r[2]}</td><td class="r">${r[3]}</td></tr>`)
  .join("")}
</tbody></table>
<table class="tot"><tr><td>Subtotal</td><td class="r">93,300.00</td></tr><tr><td>CGST 9%</td><td class="r">8,397.00</td></tr><tr><td>SGST 9%</td><td class="r">8,397.00</td></tr><tr class="g"><td>Total</td><td class="r">₹1,10,094.00</td></tr></table>
<p class="words"><b>Amount in words:</b> One lakh ten thousand and ninety four rupees only.</p>
<p class="terms">Terms: Payment within 14 days. Late payments attract 1.5% interest per month.</p>
<div class="foot"><span>Thank you for your business</span><span>Page 1 of 1</span></div></div>`,
    `.head{display:flex;justify-content:space-between;margin-bottom:24px} h1{font-size:36px;color:#c2410c;letter-spacing:1px} .from{text-align:right} .lbl{color:#999;font-size:11px;font-weight:bold}
th{background:#c2410c;color:#fff;text-align:left;padding:7px 8px;font-size:12px} td{padding:7px 8px;border-bottom:1px solid #ddd} .r{text-align:right}
.tot{width:260px;margin:14px 0 0 auto} .tot td{border:0;padding:3px 8px} .g td{border-top:2px solid #222;font-weight:bold;font-size:16px;padding-top:7px}
.words{margin-top:30px} .terms{font-size:10px;color:#777;margin-top:8px} .foot{position:absolute;bottom:30px;left:48px;right:48px;display:flex;justify-content:space-between;font-size:11px;color:#888;border-top:1px solid #ccc;padding-top:8px}`,
  ),

  statement: doc(
    `<div class="page"><div class="bank"><b>SUNRISE BANK</b><span>Statement of Account</span></div>
<table class="meta"><tr><td>Account holder</td><td>R. SHARMA</td><td>Branch</td><td>M G ROAD</td></tr><tr><td>Account type</td><td>SAVINGS</td><td>Currency</td><td>INR</td></tr><tr><td>Period</td><td>01-10-2026 to 31-10-2026</td><td>Page</td><td>1 / 1</td></tr></table>
<table class="tx"><tr><th>Date</th><th>Value Dt</th><th>Narration</th><th>Ref</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr>
${rows(30, (i) => {
  const d = String((i % 28) + 1).padStart(2, "0");
  const debit = i % 3 ? `${(137.5 * (i + 1)).toFixed(2)}` : "";
  const credit = i % 3 ? "" : `${(2150.25 * (i + 1)).toFixed(2)}`;
  const what = ["NEFT CR SALARY", "UPI GROCERY STORE", "ATM CASH WDL", "ELECTRICITY BILL", "MOBILE RECHARGE", "INTEREST PAID"][i % 6];
  return `<tr><td>${d}-10-26</td><td>${d}-10-26</td><td>${what} ${1000 + i}</td><td>S${73210 + i * 7}</td><td class="r">${debit}</td><td class="r">${credit}</td><td class="r">${(84210.4 - i * 311.15).toFixed(2)}</td></tr>`;
})}
</table><p class="end">*** End of statement ***</p><p class="small">This is a computer generated statement and does not need a signature.</p></div>`,
    `.bank{display:flex;justify-content:space-between;background:#0b3d91;color:#fff;padding:12px;font-size:18px} .meta{margin:12px 0;font-size:11px} .meta td{padding:2px 4px}
.tx{font-size:9.5px} .tx th,.tx td{border:0.5px solid #999;padding:2px 3px;white-space:nowrap} .tx th{background:#dbe4f5;text-align:left} .r{text-align:right} .tx th.r{text-align:right} .end{text-align:center;margin:14px;font-size:11px} .small{font-size:8px;color:#666}`,
  ),

  certificate: doc(
    `<div class="page"><div class="frame">
<p class="org">THE LAKESIDE ACADEMY OF ARTS</p><h1>Certificate of Achievement</h1><p class="it">This is to certify that</p>
<p class="name">Ananya Iyer</p><p class="it">has successfully completed the course</p><p class="course">Advanced Watercolour Techniques</p>
<p>with distinction, held from 3 March to 30 May 2026.</p>
<div class="sig"><div><p class="line">Dr. S. Raman</p><p>Director</p></div><div><p class="seal">SEAL</p></div><div><p class="line">M. D'Souza</p><p>Course Mentor</p></div></div>
<p class="no">Certificate No. LAA/2026/0187</p></div></div>`,
    `.frame{border:6px double #8a6d1d;height:100%;text-align:center;padding:40px} .org{letter-spacing:6px;font-size:16px;color:#8a6d1d;font-family:Georgia} h1{font-style:italic;font-family:'Monotype Corsiva','Times New Roman';font-size:54px;font-weight:normal;margin:20px}
.it{font-style:italic;font-family:Georgia;margin:12px} .name{font-family:'Segoe Script',cursive;font-size:40px;border-bottom:1px solid #444;display:inline-block;padding:0 40px} .course{font-size:24px;font-weight:bold;font-family:'Times New Roman';margin:10px}
.sig{display:flex;justify-content:space-between;margin-top:70px;align-items:flex-end} .line{border-top:1px solid #222;padding-top:4px;width:190px} .seal{border:2px solid #8a6d1d;border-radius:50%;width:80px;height:80px;line-height:76px;color:#8a6d1d;font-weight:bold} .no{margin-top:30px;font-size:10px;color:#666;font-family:'Courier New'}`,
    [1123, 794],
  ),

  "form-printed": doc(
    `<div class="page" style="font-family:'Times New Roman';font-size:14px">
<h2>GOVERNMENT OF EXAMPLE STATE</h2><h3>Application for Residence Certificate</h3><p class="c">(Form 7-A, see rule 12)</p>
<p>1. Name of applicant: ______________________________</p><p>2. Father's / Mother's name: ________________________</p>
<p>3. Date of birth: ____ / ____ / ________ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 4. Sex: ______</p>
<p class="dots"><span>5. Permanent address</span><i></i></p><p class="dots"><span>6. Village / Town</span><i></i><span>Pin</span><i></i></p>
<p>7. Occupation: ..................................................................</p>
<div class="lead"><span>Application fee</span><span class="d">........................................</span><span>Rs. 50</span></div>
<div class="lead"><span>Processing time</span><span class="d">........................................</span><span>15 days</span></div>
<p>8. Category (tick one): &#9744; General &#9744; OBC &#9744; SC &#9744; ST</p>
<table><tr><th>Sl.</th><th>Document enclosed</th><th>Yes / No</th></tr><tr><td>1</td><td>Proof of identity</td><td></td></tr><tr><td>2</td><td>Proof of address</td><td></td></tr><tr><td>3</td><td>Two photographs</td><td></td></tr></table>
<p class="box">Aadhaar (last 4): <span></span><span></span><span></span><span></span></p>
<p>I hereby declare that the particulars given above are true to the best of my knowledge and belief.</p>
<div class="sg"><span>Place: ____________</span><span>Signature of applicant</span></div><div class="sg"><span>Date: ____________</span><span></span></div>
<p class="off">FOR OFFICE USE ONLY</p><p>Verified by ................................ Designation ................................</p></div>`,
    `h2,h3,.c{text-align:center} p{margin:13px 0} .dots{display:flex;align-items:baseline;gap:4px} .dots i{flex:1;border-bottom:1.5px dotted #000} .lead{display:flex;gap:6px;margin:8px 0} .lead .d{flex:1;overflow:hidden;white-space:nowrap}
table{margin:12px 0} td,th{border:1px solid #000;padding:4px 8px;text-align:left} .box span{display:inline-block;width:22px;height:22px;border:1px solid #000;margin-right:4px;vertical-align:middle} .sg{display:flex;justify-content:space-between;margin-top:18px} .off{font-weight:bold;border-top:2px dashed #000;padding-top:10px}`,
  ),

  ticket: doc(
    `<div class="page"><div class="pass"><header><b>SKYLINE AIRWAYS</b><span>BOARDING PASS</span></header>
<div class="g"><div><label>PASSENGER</label><big>MEHTA / AARAV MR</big></div><div><label>FLIGHT</label><big>SK 482</big></div><div><label>DATE</label><big>28 NOV 26</big></div></div>
<div class="route"><div><huge>DEL</huge><p>Delhi T3</p></div><div class="ar">&rarr;</div><div><huge>BOM</huge><p>Mumbai T2</p></div></div>
<div class="g"><div><label>GATE</label><big>42B</big></div><div><label>BOARDING</label><big>06:15</big></div><div><label>SEAT</label><big>14C</big></div><div><label>ZONE</label><big>2</big></div><div><label>PNR</label><big>X7K9QD</big></div></div>
<p class="mono">M1MEHTA/AARAV  EX7K9QD DELBOMSK 0482 332Y014C0093</p><footer>Gate closes 25 minutes before departure. Carry a valid photo ID.</footer></div>
<div class="pass stub"><div class="g"><div><label>TRAIN</label><big>12952</big></div><div><label>COACH</label><big>A1</big></div><div><label>BERTH</label><big>23 LB</big></div><div><label>FARE</label><big>₹ 3,245</big></div></div></div></div>`,
    `.pass{border:1px solid #aaa;border-radius:12px;overflow:hidden;margin-bottom:30px} header{background:#101935;color:#fff;display:flex;justify-content:space-between;padding:14px 20px;font-size:18px}
.g{display:flex;justify-content:space-between;padding:14px 20px} label{display:block;font-size:9px;color:#888;letter-spacing:1px} big{font-size:17px;font-weight:bold} huge{font-size:58px;font-weight:900;display:block;font-family:'Segoe UI'}
.route{display:flex;justify-content:space-around;align-items:center;text-align:center;border-top:1px dashed #aaa;border-bottom:1px dashed #aaa;padding:10px} .ar{font-size:36px;color:#e11d48} .mono{font-family:Consolas;font-size:12px;padding:6px 20px;white-space:pre} footer{background:#f3f4f6;padding:8px 20px;font-size:10px}`,
  ),

  gdocs: doc(
    `<div class="page" style="padding:96px;font-size:14.67px;line-height:1.72">
<h1>Quarterly Planning Notes</h1><p class="meta">Prepared by the Operations team</p>
<p>This document summarises what we agreed in the planning meeting on <b>Monday</b>. Please add comments before <u>Friday evening</u> so that we can <span style="background:#fff3a3">finalise the budget</span> next week.</p>
<h2>1. Goals</h2><ul><li>Ship the new onboarding flow to all customers.</li><li>Reduce support tickets by <span style="color:#d93025">twenty percent</span>.</li><li>Hire two engineers and one designer.</li></ul>
<h2>2. Timeline</h2><ol><li>Research and interviews: weeks 1 to 3</li><li>Build and review: weeks 4 to 9</li><li>Rollout: weeks 10 to 12</li></ol>
<table><tr><td><b>Owner</b></td><td><b>Task</b></td><td><b>Status</b></td></tr><tr><td>Neha</td><td>Customer interviews</td><td>Done</td></tr><tr><td>Vikram</td><td>Pricing proposal</td><td>In progress</td></tr><tr><td>Sana</td><td>Hiring plan</td><td>Not started</td></tr></table>
<p>Read the <a href="#">full roadmap</a> for details. Footnote markers<sup>1</sup> and formulas such as H<sub>2</sub>O and x<sup>2</sup> should survive editing.</p>
<p style="text-align:right">Last updated: 20 Nov 2026</p><p style="text-align:center"><i>Confidential - internal use only</i></p></div>`,
    `h1{font-size:26.67px;font-weight:400} h2{font-size:21px;font-weight:400;margin:14px 0 6px;color:#222} .meta{color:#666} p{margin:6px 0} ul,ol{margin-left:36px} a{color:#1155cc} td{border:1px solid #000;padding:5px 8px}`,
  ),

  canva: doc(
    `<div class="page" style="padding:0;background:linear-gradient(160deg,#2b1055,#7597de);color:#fff;font-family:'Segoe UI'">
<p class="kick">S U M M E R &nbsp; S O C I A L &nbsp; C L U B</p><h1>THE BIG<br>NIGHT OUT</h1><p class="shadow">LIVE MUSIC &amp; FOOD</p>
<p class="track">saturday 12 december</p><p class="outline">FREE ENTRY</p>
<div class="cards"><div><h3>7 PM</h3><p>Doors open</p></div><div><h3>8 PM</h3><p>Headline set</p></div><div><h3>11 PM</h3><p>After party</p></div></div>
<p class="gradient">Riverside Gardens, Pune</p><p class="wide">RSVP BEFORE FRIDAY</p><p class="tight">BOOK YOUR TABLE NOW</p><p class="faded">limited seats available</p><p class="big">50% OFF</p></div>`,
    `.page{text-align:center} .kick{margin-top:60px;font-size:14px;letter-spacing:1px} h1{font-family:Impact;font-size:110px;line-height:1.05;letter-spacing:3px;margin:20px 0}
.shadow{font-size:40px;font-weight:800;text-shadow:4px 4px 0 #e11d48} .track{letter-spacing:12px;text-transform:uppercase;font-size:18px;margin:24px} .outline{font-size:56px;font-weight:900;-webkit-text-stroke:2px #ffd166;color:transparent}
.cards{display:flex;justify-content:center;gap:30px;margin:30px} .cards div{background:rgba(255,255,255,.15);padding:18px 26px;border-radius:14px} h3{font-size:30px}
.gradient{font-size:30px;font-family:Georgia;font-style:italic;color:#ffd166} .wide{letter-spacing:0.5em;font-size:13px;margin:18px} .tight{letter-spacing:-1px;font-size:28px;font-weight:700} .faded{opacity:.55;font-size:20px;margin-top:10px} .big{font-size:96px;font-weight:900;font-family:'Arial Black';transform:rotate(-8deg);color:#ffd166}`,
  ),

  slides: doc(
    `<div class="page"><h1>Roadmap 2027</h1><p class="sub">Where we are going and why</p><ul><li>Grow active teams from 400 to 1,000</li><li>Launch the mobile app in March</li><li>Open a second support shift</li></ul><span class="num">1</span></div>
<div class="page"><h1>Revenue by region</h1><table><tr><th>Region</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th></tr><tr><td>North</td><td>12.4</td><td>14.1</td><td>15.9</td><td>18.2</td></tr><tr><td>South</td><td>9.8</td><td>11.0</td><td>13.4</td><td>16.1</td></tr><tr><td>West</td><td>15.2</td><td>15.8</td><td>17.0</td><td>19.5</td></tr></table>
<div class="bars">${rows(4, (i) => `<div style="height:${80 + i * 45}px"><span>Q${i + 1}</span></div>`)}</div><span class="num">2</span></div>
<div class="page dark"><h1>Thank you</h1><p class="sub">Questions? Write to hello@example.com</p><span class="num">3</span></div>`,
    `.page{padding:60px 80px} h1{font-size:48px;color:#0f766e} .sub{font-size:22px;color:#64748b;margin:6px 0 30px} li{font-size:28px;margin:16px 0 0 30px} .num{position:absolute;right:30px;bottom:20px;font-size:14px;color:#94a3b8}
td,th{border:1px solid #cbd5e1;padding:8px 14px;font-size:20px;text-align:center} .bars{display:flex;gap:60px;align-items:flex-end;margin:30px 40px} .bars div{width:70px;background:#14b8a6;position:relative} .bars span{position:absolute;bottom:6px;width:100%;text-align:center;color:#fff;font-weight:bold} .dark{background:#0f172a;color:#fff;text-align:center;padding-top:200px} .dark h1{color:#5eead4}`,
    [1280, 720],
  ),

  "tight-table": doc(
    `<div class="page" style="font-size:9px;padding:24px"><h3>Inventory register</h3>
<table class="b"><tr>${["Code", "Item", "UOM", "Open", "In", "Out", "Close", "Rate", "Value", "Bin"].map((h) => `<th>${h}</th>`).join("")}</tr>
${rows(28, (i) => `<tr><td>A${100 + i}</td><td>${["Hex bolt", "Washer", "Lock nut", "Spring pin", "O ring"][i % 5]} M${4 + (i % 9)}</td><td>pcs</td><td>${120 + i}</td><td>${i * 3}</td><td>${i * 2}</td><td>${120 + i * 2}</td><td>${(1.25 + i / 8).toFixed(2)}</td><td>${((120 + i * 2) * (1.25 + i / 8)).toFixed(2)}</td><td>R${i % 6}-${i % 4}</td></tr>`)}</table>
<h3 style="margin-top:14px">Without borders</h3><table class="n">${rows(10, (i) => `<tr><td>Warehouse ${i + 1}</td><td>Block ${"ABCDE"[i % 5]}</td><td>${(i + 1) * 410}</td><td>${(i * 7) % 13}</td><td>${["OK", "Low", "Full"][i % 3]}</td></tr>`)}</table></div>`,
    `.b th,.b td{border:0.5px solid #000;padding:0 1px;white-space:nowrap} .n td{padding:0 2px;white-space:nowrap} .n{width:auto}`,
  ),

  article: doc(
    `<div class="page" style="font-family:Georgia;font-size:12px"><h1>The Slow Return of the City Garden</h1><p class="by">By Our Correspondent &middot; 12 minute read</p>
<div class="cols">${[
      "For most of the last century the small gardens that once fringed our neighbourhoods were treated as spare land, waiting for a better use. Parking arrived first, then storage sheds, then another storey of brick.",
      "Residents in three wards have begun to reverse that pattern. They are lifting paving stones, composting kitchen waste and trading cuttings over compound walls. The results are modest but visible from the street.",
      "Municipal records show that registered community plots rose from eleven to forty seven in five years. Officials credit a simple change: a single page application replaced a process that used to take months.",
      "Not everyone is persuaded. Some shopkeepers argue that the planters narrow already crowded footpaths, and a few have asked for them to be moved. The ward committee will hear both sides in January.",
      "Meanwhile the gardeners keep working. On a recent morning a retired teacher was showing two schoolchildren how to tie tomato vines, while a courier stopped to ask whether the mint was for sale. It was not.",
    ]
      .map((t) => `<p>${t}</p>`)
      .join("")}<blockquote>"We did not ask for permission to care about our own street."</blockquote><p>The committee expects to publish its findings early next year, together with a map of every plot.</p></div>
<div class="foot"><span>The Neighbourhood Weekly</span><span>Page 4</span></div></div>`,
    `h1{font-size:30px;line-height:1.15} .by{color:#666;margin:6px 0 12px;font-style:italic} .cols{column-count:3;column-gap:18px;text-align:justify;line-height:1.5} .cols p{margin-bottom:8px;text-indent:12px} blockquote{font-size:16px;font-style:italic;border-left:3px solid #b45309;padding-left:8px;margin:10px 0;text-align:left;color:#b45309}
.foot{position:absolute;bottom:24px;left:48px;right:48px;display:flex;justify-content:space-between;font-size:10px;border-top:0.5px solid #000;padding-top:6px}`,
  ),

  "header-footer": doc(
    rows(
      3,
      (p) => `<div class="page"><div class="h"><span>ACME CORPORATION</span><span>Employee Handbook</span><span>v3.${p}</span></div>
<h2>${p + 1}. ${["Working hours", "Leave policy", "Travel and expenses"][p]}</h2>
<p>Every employee is expected to read this section carefully and to raise questions with the people team before the end of the first week.</p>
<p>${["Core hours run from eleven in the morning until four in the afternoon.", "Paid leave accrues at one and a half days for each completed month.", "Claims must be submitted within thirty days with the original receipts."][p]}</p>
<h4>${p + 1}.1 Exceptions</h4><p>Managers may approve exceptions in writing. Verbal approval is not sufficient.</p>
<div class="f"><span>&copy; 2026 Acme Corporation</span><span>Confidential</span><span>Page ${p + 1} of 3</span></div></div>`,
    ),
    `.h,.f{position:absolute;left:48px;right:48px;display:flex;justify-content:space-between;font-size:10px;color:#666} .h{top:20px;border-bottom:1px solid #999;padding-bottom:5px} .f{bottom:20px;border-top:1px solid #999;padding-top:5px} h2{margin:30px 0 10px} p{margin:8px 0;line-height:1.6} h4{margin-top:14px}`,
  ),

  rotated: doc(
    `<div class="page"><div class="r" style="left:40px;top:560px;transform:rotate(-90deg)">Vertical label reading upwards</div>
<div class="r" style="left:600px;top:200px;transform:rotate(90deg)">Spine title 2026 edition</div>
<div class="r wm" style="left:140px;top:500px;transform:rotate(-35deg)">DRAFT COPY</div>
<div class="r" style="left:150px;top:150px;transform:rotate(15deg);font-size:22px">Tilted by fifteen degrees</div>
<div class="r" style="left:300px;top:800px;transform:rotate(180deg);font-size:18px">This line is upside down</div>
<div class="r" style="left:150px;top:260px;transform:rotate(-8deg);font-size:30px;font-weight:bold;color:#b91c1c;border:3px solid #b91c1c;padding:4px 12px">APPROVED</div>
<p style="margin-top:40px">Ordinary horizontal text sits next to all of it.</p>
<table style="margin:600px 0 0 80px;width:400px"><tr>${["January", "February", "March", "April"].map((m) => `<th style="height:80px;vertical-align:bottom;border:1px solid #000"><div style="writing-mode:vertical-rl;transform:rotate(180deg);padding:4px">${m}</div></th>`).join("")}</tr></table></div>`,
    `.r{position:absolute;white-space:nowrap} .wm{font-size:90px;color:rgba(200,0,0,.2);font-weight:bold}`,
  ),

  "on-images": doc(
    `<div class="page" style="padding:0;color:#fff"><div style="position:relative;height:340px"><img src="${photo()}" style="width:794px;height:340px"><h1 style="position:absolute;left:40px;top:60px;font-size:52px">Monsoon Trails</h1><p style="position:absolute;left:44px;top:140px;font-size:20px">Five weekend walks near the city</p><p class="tag" style="position:absolute;right:30px;bottom:20px">From ₹799 per person</p></div>
<div style="background:#14532d;padding:30px 48px;font-size:16px"><p>Waterfall loop &middot; 8 km &middot; easy</p><p>Fort ridge &middot; 12 km &middot; moderate</p></div>
<div style="position:relative"><img src="${photo()}" style="width:794px;height:340px;filter:brightness(1.5)"><p style="position:absolute;left:40px;top:40px;color:#111;font-size:28px;font-weight:bold">Dark text on a light picture</p><p style="position:absolute;left:40px;top:260px;background:#000;padding:6px 14px;font-size:15px">Call 98765 00000 to reserve</p></div></div>`,
    `.tag{background:#f59e0b;color:#111;padding:6px 14px;border-radius:20px;font-weight:bold} p{line-height:1.8}`,
  ),

  hindi: doc(
    `<div class="page" style="font-family:'Nirmala UI';font-size:15px;line-height:1.8"><h1>विद्यालय प्रवेश सूचना</h1><h3>Admission Notice 2027-28 / प्रवेश सूचना</h3>
<p>सभी अभिभावकों को सूचित किया जाता है कि कक्षा नर्सरी से कक्षा आठ तक के लिए आवेदन पत्र उपलब्ध हैं।</p>
<p>Forms are available at the school office from <b>5 जनवरी</b> onwards between 9 AM and 1 PM.</p>
<table><tr><th>कक्षा (Class)</th><th>आयु (Age)</th><th>शुल्क (Fee)</th></tr><tr><td>नर्सरी</td><td>3+ वर्ष</td><td>₹ 12,500</td></tr><tr><td>कक्षा एक</td><td>6+ वर्ष</td><td>₹ 15,000</td></tr><tr><td>कक्षा पाँच</td><td>10+ वर्ष</td><td>₹ 18,750</td></tr></table>
<p>आवश्यक दस्तावेज़: जन्म प्रमाण पत्र, पता प्रमाण, दो फ़ोटो</p><p style="font-family:Mangal">प्रधानाचार्य के हस्ताक्षर: ____________</p><p style="font-family:Arial">Contact: office@example.edu | हेल्पलाइन 1800-000-000</p>
<p style="text-align:justify">विद्यार्थियों की सुरक्षा हमारी पहली प्राथमिकता है। प्रत्येक बस में एक सहायिका रहेगी और अभिभावक अपने मोबाइल पर बस की स्थिति देख सकेंगे। किसी भी प्रश्न के लिए कार्यालय से संपर्क करें।</p>
<p style="font-size:12px">क्षेत्रीय भाषा: मराठी माध्यम उपलब्ध नाही. தமிழ் வகுப்பு உண்டு. বাংলা ক্লাস আছে।</p></div>`,
    `h1,h3{text-align:center} p{margin:10px 0} td,th{border:1px solid #333;padding:4px 10px;text-align:left}`,
  ),

  justified: doc(
    `<div class="page" style="font-family:'Times New Roman';font-size:15px;line-height:1.5;padding:72px"><h2>Terms of Service</h2>
${[
  "These terms govern your use of the service and form a binding agreement between you and the company. By creating an account you confirm that you have read them, understood them and agreed to be bound by every clause that follows.",
  "The company may change these terms from time to time. When a change materially affects your rights we will notify you by electronic mail at least thirty days before it takes effect, and your continued use after that date counts as acceptance.",
  "You are responsible for keeping your password confidential. Any activity performed through your account is treated as your own activity, and you agree to inform us immediately if you suspect that someone else has gained access to it.",
]
  .map((t, i) => `<p><b>${i + 1}.</b> ${t}</p>`)
  .join("")}<p style="text-align:center;margin-top:30px">- - - - -</p><p class="s">Signed: ______________ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Date: ______________</p></div>`,
    `p{text-align:justify;margin:12px 0}`,
  ),


  "canva-layers": doc(
    `<div class="page" style="font-family:'Segoe UI';background:#fdf6ec">
<p class="a">GRAND OPENING</p><p class="b">Fresh Bakes Daily</p><p class="c">SALE ENDS SUNDAY</p><p class="d">weekend special</p>
<p class="e">T H E &nbsp; M E N U</p><div class="menu"><p><span>Masala chai</span><span>40</span></p><p><span>Filter coffee</span><span>60</span></p><p><span>Bun maska</span><span>55</span></p></div>
<p class="f">Offer valid on orders above 300</p><p class="g">@bakehouse.example &#8226; 12 Hill Road</p><div class="two"><p>Order<br>online</p><p>Pick up<br>in store</p></div><p class="h">HAND MADE</p></div>`,
    `.page{text-align:center;color:#3b2314} .a{font-size:64px;font-weight:900;text-shadow:10px 10px 0 #f4a261;margin-top:20px} .b{font-size:44px;font-family:Georgia;color:#e76f51;text-shadow:-3px 3px 0 #264653,3px 3px 6px rgba(0,0,0,.4)}
.c{font-size:40px;font-weight:800;color:#fff;-webkit-text-stroke:6px #264653;paint-order:stroke fill;letter-spacing:6px;margin:14px} .d{font-size:30px;font-style:italic;letter-spacing:8px;text-transform:uppercase;text-shadow:0 14px 0 rgba(0,0,0,.18)}
.e{font-size:24px;letter-spacing:2px;margin:30px;border-block:2px solid #3b2314;padding:8px} .menu{width:420px;margin:auto;font-size:22px} .menu p{display:flex;justify-content:space-between;margin:10px 0} .f{font-size:13px;letter-spacing:.35em;text-transform:uppercase;margin:36px} .g{font-size:15px}
.two{display:flex;justify-content:center;gap:60px;font-size:34px;font-weight:700;line-height:1.1;margin:30px} .h{font-size:90px;font-family:Impact;color:transparent;-webkit-text-stroke:1.5px #3b2314;letter-spacing:10px}`,
  ),

  "narrow-columns": doc(
    `<div class="page" style="font-family:'Times New Roman';font-size:13px"><h3>Contents</h3>
<div class="toc"><p><span>Introduction</span><i></i><b>1</b></p><p><span>Scope of the assessment</span><i></i><b>4</b></p><p><span>Findings and recommendations</span><i></i><b>11</b></p></div>
<p class="lead2">Chapter one ........................................................ 7</p><p class="lead2">Chapter two &nbsp;. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . 19</p>
<div class="n"><p>Extraordinarily complicated international telecommunications infrastructure arrangements necessitate comprehensive documentation. We are all set to go on and on about it in a very narrow column of fully justified text so that gaps between the words grow large.</p></div>
<div class="n" style="left:300px"><p>Small words can be set apart by wide spaces when a long word such as incomprehensibilities cannot be broken at the end of a line of this kind.</p></div>
<div class="n" style="left:520px;text-align:right"><p>Ranged right text that a designer set against the margin of the page for effect.</p></div></div>`,
    `.toc p{display:flex;align-items:baseline;gap:6px;margin:6px 0} .toc i{flex:1;border-bottom:1px dotted #000} .lead2{margin:8px 0} .n{position:absolute;left:60px;top:300px;width:170px;text-align:justify;line-height:1.7}`,
  ),

  "mixed-styles": doc(
    `<div class="page" style="font-size:14px;line-height:2"><p>Plain, <b>bold</b>, <i>italic</i>, <b><i>both</i></b>, <u>underlined</u>, <s>struck</s> and <span style="color:#2563eb">blue</span> words on one line.</p>
<p style="font-family:Verdana">Verdana line with numbers 1234567890 and symbols @#%&amp;*()</p><p style="font-family:Tahoma">Tahoma: The quick brown fox jumps over the lazy dog.</p><p style="font-family:'Trebuchet MS'">Trebuchet: Pack my box with five dozen liquor jugs.</p>
<p style="font-family:Garamond;font-size:20px">Garamond: efficient office affairs - fluffy waffles</p><p style="font-family:'Courier New'">Courier:   aligned    columns     here</p><p style="font-family:'Century';font-size:11px">Century small print (c) 2026. All rights reserved.</p>
<p style="font-family:'Bookman Old Style'">Bookman: Voix ambiguë d'un cœur qui préfère — naïve façade</p><p>Greek Ελληνικά, Cyrillic Привет мир, maths ∑ x ≤ π ± 3°</p><p style="font-variant:small-caps">Small capitals heading text</p>
<p style="font-size:7px">Seven pixel fine print that is still meant to be edited by someone with sharp eyes.</p><p style="font-size:64px;line-height:1.2">Huge 64</p>
<p><span style="font-size:24px">Big start</span> <span style="font-size:11px">then small tail on the same baseline</span></p><p style="word-spacing:14px">Wide word spacing on this line</p><p style="margin-left:300px">Indented far to the right</p>
<p>Price: <s>₹999</s> <b style="color:#16a34a">₹499</b> only</p><p>Email: a.b_c-d+e@example.co.in &nbsp; Phone: (011) 2345-6789</p></div>`,
  ),
};

/** every piece of text a reader sees as its own: same block, same visual line */
const segments = () => {
  const blockOf = (node) => {
    let el = node.parentElement;
    while (el && getComputedStyle(el).display.startsWith("inline") && getComputedStyle(el).display !== "inline-block") el = el.parentElement;
    return el;
  };
  return [...document.querySelectorAll(".page")].map((page) => {
    const origin = page.getBoundingClientRect();
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    const blocks = new Map();
    for (let node; (node = walker.nextNode()); ) {
      const el = blockOf(node);
      if (!blocks.has(el)) blocks.set(el, []);
      blocks.get(el).push(node);
    }
    const out = [];
    for (const [el, nodes] of blocks) {
      let turned = null;
      for (let e = el; e && e !== page; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.transform !== "none" || s.writingMode !== "horizontal-tb") turned = e;
      }
      const range = document.createRange();
      const chars = [];
      for (const node of nodes) {
        const style = getComputedStyle(node.parentElement);
        const upper = style.textTransform === "uppercase";
        for (let i = 0; i < node.length; ) {
          const c = String.fromCodePoint(node.data.codePointAt(i));
          range.setStart(node, i);
          range.setEnd(node, i + c.length);
          const r = range.getClientRects()[0];
          i += c.length;
          chars.push({
            c: upper ? c.toUpperCase() : c,
            r: r && r.width > 0 ? { x0: r.left - origin.left, x1: r.right - origin.left, y0: r.top - origin.top, y1: r.bottom - origin.top } : null,
            bold: Number(style.fontWeight) >= 600,
            italic: style.fontStyle !== "normal",
            size: parseFloat(style.fontSize),
            color: style.color,
          });
        }
      }
      const lines = [];
      let line = null;
      for (const ch of chars) {
        const space = !ch.c.trim();
        if (ch.r && !space) {
          const mid = (ch.r.y0 + ch.r.y1) / 2;
          const newLine = !line || (!turned && (mid > line.y1 || mid < line.y0 || ch.r.x0 < line.x1 - (line.y1 - line.y0) * 1.5));
          // a wide hole inside a line (padding, many spaces) separates two pieces
          const hole = line && !newLine && !turned && ch.r.x0 - line.x1 > 4 * ch.size;
          if (newLine || hole) lines.push((line = { chars: [], y0: ch.r.y0, y1: ch.r.y1, x0: ch.r.x0, x1: ch.r.x1 }));
          line.x0 = Math.min(line.x0, ch.r.x0);
          line.x1 = Math.max(line.x1, ch.r.x1);
        }
        if (line) line.chars.push(ch);
      }
      for (const l of lines) {
        const text = l.chars.map((c) => c.c).join("").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const inked = l.chars.filter((c) => c.c.trim());
        const most = (key) => {
          const n = new Map();
          for (const c of inked) n.set(c[key], (n.get(c[key]) ?? 0) + 1);
          return [...n].sort((a, b) => b[1] - a[1])[0][0];
        };
        const rgb = String(most("color")).match(/[\d.]+/g).map(Number);
        out.push({
          text,
          rect: turned ? null : [l.x0 * 0.75, l.y0 * 0.75, l.x1 * 0.75, l.y1 * 0.75],
          size: most("size") * 0.75,
          bold: most("bold"),
          italic: most("italic"),
          color: rgb.slice(0, 3).map((v) => v / 255),
          alpha: rgb[3] ?? 1,
        });
      }
    }
    return out;
  });
};

const browser = await chromium.launch();
const only = process.env.ONLY?.split(",");
for (const [id, html] of Object.entries(documents)) {
  if (only && !only.includes(id)) continue;
  const size = html.match(/@page \{ size: (\d+)px (\d+)px/);
  const page = await browser.newPage({ viewport: { width: Number(size[1]), height: Number(size[2]) } });
  await page.emulateMedia({ media: "print" });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const pages = await page.evaluate(segments);
  await page.pdf({ path: path.join(out, `html-${id}.pdf`), preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(out, `html-${id}.json`), JSON.stringify({ producer: "Chromium print", pages: pages.map((segments) => ({ segments })) }, null, 1));
  await page.close();
  console.log("html", id, pages.map((p) => p.length).join("+"));
}
await browser.close();
