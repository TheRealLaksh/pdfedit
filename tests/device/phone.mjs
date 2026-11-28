/**
 * The whole phone checklist with real touches, the real keyboard and real screenshots, on an Android
 * emulator (or phone) showing the app in Chrome.
 *
 *   npm run build && npx vite preview --host 127.0.0.1 --port 4180 --strictPort
 *   node tests/device/make-docs.mjs
 *   node tests/device/android.mjs setup
 *   node tests/device/phone.mjs [--only=editing,tools]
 *
 * Needs the corpus in tests/fixtures/pdfs. The Gboard part taps keys of an English Gboard on a
 * 1080 x 2400 screen. Failures leave a screenshot in .tmp/device/checklist/.
 */
import { existsSync } from "node:fs";
import * as d from "./android.mjs";

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const OUT = ".tmp/device/checklist";
const DOCS = ".tmp/device/docs";
const FIXTURES = "tests/fixtures/pdfs";
if (!existsSync(`${DOCS}/invoice.pdf`)) throw new Error("Run node tests/device/make-docs.mjs first");

let failures = 0;
let passes = 0;
let section = "";
function check(name, ok, detail = "") {
  if (ok) {
    passes++;
    console.log(`  ok    ${name}`);
    return true;
  }
  failures++;
  const file = `${OUT}/fail-${failures}.png`;
  try {
    d.screenshot(file);
  } catch {
    /* the device went away */
  }
  console.log(`  FAIL  ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}  [${file}]`);
  return false;
}

/* ---------- looking ---------- */

const state = () =>
  d.evaluate(`(() => { const s = __pdfedit.getState();
    const field = document.querySelector('[data-testid=line-editor]');
    const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const view = document.querySelector('.pv-scroll');
    return { editing: s.editing?.lineId ?? null, zoom: s.zoom, tool: s.tool, panel: s.panel, busy: s.busy, selection: s.selection,
      revision: s.doc?.pages[0]?.revision, canUndo: s.canUndo, value: field?.value ?? null, focused: !!field && document.activeElement === field,
      caretAt: field?.selectionEnd ?? null, fontSize: field ? parseFloat(getComputedStyle(field).fontSize) : null,
      field: rect(field), caret: rect(document.querySelector('[data-pv-caret]')), dock: rect(document.querySelector('[data-testid=editor-dock]')),
      view: rect(view), top: view?.scrollTop, left: view?.scrollLeft, width: innerWidth, vv: visualViewport.height, pageZoom: visualViewport.scale,
      topBar: !!document.querySelector('.sh-top') && getComputedStyle(document.querySelector('.sh-top')).display !== 'none',
      bottomBar: !!document.querySelector('.sh-bottom') && getComputedStyle(document.querySelector('.sh-bottom')).display !== 'none' }; })()`);

const idle = () => d.waitFor("!__pdfedit.getState().busy", 60000);
const lineTexts = (page = 0) =>
  d.evaluate(`[...document.querySelectorAll('[data-page="${page}"] .pv-sr button')].map((b) => b.textContent.replace(/^Edit: /, ''))`);

/** the box of the line with exactly this text (or containing it) */
const lineBox = (text) =>
  d.evaluate(`(() => { for (const layer of document.querySelectorAll('[data-testid=edit-layer]')) {
    const texts = [...layer.querySelectorAll('.pv-sr button')].map((b) => b.textContent.replace(/^Edit: /, ''));
    let i = texts.indexOf(${JSON.stringify(text)}); if (i < 0) i = texts.findIndex((t) => t.includes(${JSON.stringify(text)}));
    if (i < 0) continue; const r = layer.querySelectorAll('[data-line-id]')[i].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, w: r.width, h: r.height }; }
    return null; })()`);

/** scroll a line into the clear middle of the view */
const show = (text) =>
  d.evaluate(`(async () => { const layer = document.querySelector('[data-testid=edit-layer]');
    const texts = [...layer.querySelectorAll('.pv-sr button')].map((b) => b.textContent.replace(/^Edit: /, ''));
    let i = texts.indexOf(${JSON.stringify(text)}); if (i < 0) i = texts.findIndex((t) => t.includes(${JSON.stringify(text)}));
    const el = layer.querySelectorAll('[data-line-id]')[i]; const view = document.querySelector('.pv-scroll');
    const r = el.getBoundingClientRect(), v = view.getBoundingClientRect();
    if (r.top < v.top + 150 || r.bottom > v.top + 260 || r.left < 8 || r.left > v.right - 60) {
      view.scrollTop += r.top - v.top - 200; view.scrollLeft += r.left - 40; await new Promise((ok) => setTimeout(ok, 500)); } })()`);

/** tap a line with a finger; tiny crowded text magnifies first and takes a second tap */
/** notes at the top of the page are tapped away, as a person would */
const clearNotes = async () => {
  await d.evaluate("__pdfedit.setState({ toasts: [] })");
};

async function openLine(text) {
  await idle();
  await clearNotes();
  let box = await lineBox(text);
  if (!box || box.y < 130 || box.y > 640 || box.x < 4 || box.x > 408) {
    await show(text);
    box = await lineBox(text);
  }
  await d.tap(box.x, box.y);
  await d.sleep(1500);
  let s = await state();
  if (!s.editing) {
    box = await lineBox(text);
    await d.tap(box.x, box.y);
  }
  await d.waitFor("!!__pdfedit.getState().editing", 8000).catch(() => {});
  await d.sleep(1600);
  return state();
}

const button = async (selector, wait = 700) => {
  await d.tapOn(selector);
  await d.sleep(wait);
};
const named = async (selector, text, wait = 900) => {
  const c = await d.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.getAttribute('aria-label') || e.textContent).trim().startsWith(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0);
    if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!c) throw new Error(`No ${selector} "${text}"`);
  await d.tap(c.x, c.y);
  await d.sleep(wait);
};
const type = async (text) => {
  d.typeText(text);
  await d.sleep(800);
};
/* above the bar; a corner card (hardly any height left) leaves the space left of it */
const caretSeen = (s) =>
  !!s.caret && !!s.dock && s.caret.y >= s.view.y - 2 && s.caret.x >= -1 && s.caret.x <= s.width + 1 &&
  (s.dock.w < s.width * 0.6 ? s.caret.bottom <= s.view.bottom + 2 && (s.caret.x <= s.dock.x || s.caret.bottom <= s.dock.y + 2) : s.caret.bottom <= s.dock.y + 2);
const closeEditor = async () => {
  if (!(await state()).editing) return;
  // the bar rides up with the keyboard: tap it once it has arrived
  await d.sleep(1500);
  await button("[data-testid=editor-cancel]", 1200);
};
const open = async (file) => {
  await d.evaluate("__pdfedit.getState().closeDoc()");
  await d.openPdf(file);
  await d.waitFor("document.querySelectorAll('[data-page]').length > 0");
  await d.sleep(900);
};

/* Gboard (English, 1080 x 2400): screen pixels of the keys */
const KEYS = { " ": [592, 2186], "\b": [994, 2028] };
"qwertyuiop".split("").forEach((c, i) => (KEYS[c] = [Math.round(59 + i * 106.8), 1722]));
"asdfghjkl".split("").forEach((c, i) => (KEYS[c] = [Math.round(112 + i * 106.8), 1872]));
"zxcvbnm".split("").forEach((c, i) => (KEYS[c] = [Math.round(218 + i * 106.8), 2028]));
async function gboard(keys) {
  for (const c of keys) {
    d.shell(`input tap ${KEYS[c][0]} ${KEYS[c][1]}`);
    await d.sleep(200);
  }
  await d.sleep(900);
}

/* ---------- the checklist ---------- */

const sections = {
  async editing() {
    await open(`${DOCS}/invoice.pdf`);
    await d.calibrate();

    // tiny crowded text: magnify first, never guess
    let box = await lineBox("Item 3 cable set");
    await d.tap(box.x, box.y);
    await d.sleep(1500);
    let s = await state();
    check("tiny crowded text: first tap magnifies, opens nothing", !s.editing && typeof s.zoom === "number" && s.zoom > 1, s);
    check("no keyboard while only magnifying", !d.keyboardShown());
    box = await lineBox("Item 3 cable set");
    const before = await state();
    await d.tap(box.x, box.y);
    await d.sleep(2200);
    s = await state();
    check("second tap opens exactly that line", s.value === "Item 3 cable set", s.value);
    check("opening a readable line does not zoom or scroll", s.zoom === before.zoom && Math.abs(s.top - before.top) < 3, [before.zoom, s.zoom, before.top, s.top]);
    check("typing happens on the page, over the line", s.focused && Math.abs(s.field.y + s.field.h / 2 - box.y) < 8 && Math.abs(s.field.x - box.left) < 8, [s.field, box]);
    check("field is set in 16px or more (no iOS page zoom)", s.fontSize >= 16, s.fontSize);
    check("keyboard is up", d.keyboardShown());
    check("caret is above the keyboard bar", caretSeen(s), s);
    check("tool bar leaves while typing", !s.bottomBar);
    const bar = await d.evaluate(`(() => { const keys = [...document.querySelectorAll('.pv-actions button, .pv-actions label')].map((e) => e.getBoundingClientRect());
      const strip = document.querySelector('.pv-actions'); return { n: keys.length, outside: keys.filter((r) => r.left < -0.5 || r.right > innerWidth + 0.5).length,
        small: keys.filter((r) => r.width < 40 || r.height < 44).length, scrolls: strip.scrollWidth - strip.clientWidth }; })()`);
    check("style bar: every control on screen, finger sized, nothing scrolled away", bar.n === 7 && !bar.outside && !bar.small && bar.scrolls <= 0, bar);
    d.screenshot(`${OUT}/editing.png`);

    // Gboard
    await d.evaluate("(() => { const f = document.querySelector('[data-testid=line-editor]'); f.setSelectionRange(f.value.length, f.value.length); })()");
    await gboard(" red");
    s = await state();
    check("Gboard keys type into the line", s.value === "Item 3 cable set red", s.value);
    await gboard("\b\b\b\b");
    s = await state();
    check("Gboard backspace deletes", s.value === "Item 3 cable set", s.value);

    // caret moves
    await d.tap(s.field.x + 6, s.field.y + s.field.h / 2);
    await d.sleep(700);
    s = await state();
    check("tap inside the line moves the caret", s.editing && s.caretAt <= 2, s.caretAt);
    await d.tap(s.field.right + 4, s.field.y + s.field.h / 2);
    await d.sleep(700);
    s = await state();
    check("tap just past the end keeps the line open, caret at the end", s.editing && s.caretAt === s.value.length, [s.editing, s.caretAt]);

    // switching boxes
    await type(" A");
    const zoom = (await state()).zoom;
    box = await lineBox("Item 6 cable set");
    await d.tap(box.x, box.y);
    await d.waitFor("document.querySelector('[data-testid=line-editor]')?.value === 'Item 6 cable set'", 15000).catch(() => {});
    await d.sleep(900);
    s = await state();
    check("one tap switches to another line", s.value === "Item 6 cable set" && s.focused, s.value);
    check("switching keeps keyboard and zoom", d.keyboardShown() && s.zoom === zoom, [s.zoom, zoom]);
    check("the first line was saved", (await lineTexts()).some((t) => /Item 3.*A/.test(t)));

    // done keeps the view
    await type(" B");
    const here = await state();
    await button("[data-testid=editor-done]", 2500);
    await idle();
    s = await state();
    check("Done saves and closes", !s.editing && (await lineTexts()).some((t) => /Item 6.*B/.test(t)), [s.editing, await lineTexts()]);
    check("the view stays put after Done", s.zoom === here.zoom && Math.abs(s.top - here.top) < 3 && Math.abs(s.left - here.left) < 3, [here.top, s.top, here.left, s.left, here.zoom, s.zoom]);
    check("a Fit page button offers the way back", await d.evaluate("!!document.querySelector('.pv-fit')"));

    // enter, cancel
    s = await openLine("Item 5 cable set");
    await type(" C");
    d.key(66);
    await d.sleep(2200);
    await idle();
    // the lines are read again after the save
    await d.waitFor("[...document.querySelectorAll('.pv-sr button')].some((b) => /Item 5.*C/.test(b.textContent))", 8000).catch(() => {});
    check("Enter saves", !(await state()).editing && (await lineTexts()).some((t) => /Item 5.*C/.test(t)));
    s = await openLine("Item 7 cable set");
    const revision = s.revision;
    await type(" D");
    await button("[data-testid=editor-cancel]", 1500);
    s = await state();
    check("Cancel discards", !s.editing && s.revision === revision);

    // back button
    s = await openLine("Item 8 cable set");
    await type("E");
    d.key(4);
    await d.sleep(1500);
    s = await state();
    check("Back first hides only the keyboard", !!s.editing && !d.keyboardShown(), s.editing);
    await d.tap(s.field.x + s.field.w / 2, s.field.y + s.field.h / 2);
    await d.sleep(1500);
    check("tapping the line brings the keyboard back", d.keyboardShown());
    d.key(4);
    await d.sleep(1000);
    d.key(4);
    await d.sleep(2500);
    await idle();
    s = await state();
    check("Back again saves and closes, without leaving the app", !s.editing && s.revision > revision && (await lineTexts()).some((t) => /Item 8.*E/.test(t)));

    // double tap and long press
    await clearNotes();
    await show("Item 9 cable set");
    box = await lineBox("Item 9 cable set");
    const [x, y] = await d.toScreen(box.x, box.y);
    d.shell(`input tap ${x} ${y}; input tap ${x} ${y}`);
    await d.sleep(2200);
    s = await state();
    check("double tap opens the line and it stays open", s.value === "Item 9 cable set", s);
    await closeEditor();
    await show("Item 10 cable set");
    box = await lineBox("Item 10 cable set");
    const [lx, ly] = await d.toScreen(box.x, box.y);
    d.shell(`input swipe ${lx} ${ly} ${lx} ${ly} 900`);
    await d.sleep(2200);
    s = await state();
    check("long press opens the line too", s.value === "Item 10 cable set", s.value);

    // the field is a real text field: a long press in it selects, with the system's handles and menu
    s = await state();
    const [fx, fy] = await d.toScreen(s.field.x + 20, s.field.y + s.field.h / 2);
    d.shell(`input swipe ${fx} ${fy} ${fx} ${fy} 900`);
    await d.sleep(1500);
    const picked = await d.evaluate("(() => { const f = document.querySelector('[data-testid=line-editor]'); return f && f.value.slice(f.selectionStart, f.selectionEnd); })()");
    check("long press inside the line selects a word", !!picked && !picked.includes(" 10 "), picked);
    d.screenshot(`${OUT}/selection.png`);
    // tap while a change is still saving
    await type(" F");
    await button("[data-testid=editor-done]", 150);
    box = await lineBox("Item 11 cable set");
    await d.tap(box.x, box.y);
    await d.waitFor("document.querySelector('[data-testid=line-editor]')?.value === 'Item 11 cable set'", 20000).catch(() => {});
    check("a tap made during a save is answered", (await state()).value === "Item 11 cable set", (await state()).value);
    await closeEditor();

    // Fit page
    await button(".pv-fit", 1200);
    check("Fit page returns to the whole page", (await state()).zoom === "fit");
  },

  async panels() {
    await open(`${DOCS}/invoice.pdf`);
    let s = await openLine("Billed to");
    check("a line opens", s.value === "Billed to", s.value);
    const inside = () =>
      d.evaluate(`(() => { const all = [...document.querySelectorAll('[data-testid=editor-dock] :is(button, select, input:not([type=color]), label)')].filter((e) => e.getBoundingClientRect().width > 1);
        const dock = document.querySelector('[data-testid=editor-dock]').getBoundingClientRect();
        return all.filter((e) => { const r = e.getBoundingClientRect(); return r.left < -0.5 || r.right > innerWidth + 0.5 || r.bottom > dock.bottom + 0.5 || r.height < 40; }).map((e) => e.getAttribute('aria-label')); })()`);
    for (const name of ["Font and size", "Colour", "More options"]) {
      await button(`.pv-phonebar [aria-label="${name}"]`);
      s = await state();
      check(`${name}: all controls visible, keyboard stays, line visible`, !(await inside()).length && d.keyboardShown() && caretSeen(s), await inside());
      d.screenshot(`${OUT}/panel-${name.split(" ")[0]}.png`);
    }
    await button('.pv-phonebar [aria-label="Move"]');
    const from = (await state()).field;
    await button('.pv-phonebar [aria-label="Move down"]', 400);
    await button('.pv-phonebar [aria-label="Move right"]', 600);
    s = await state();
    check("nudge buttons move the text", s.field.x > from.x && s.field.y > from.y, [from, s.field]);
    const handle = await d.centre(".pv-move-handle");
    await d.swipe(handle.x, handle.y, handle.x + 50, handle.y + 30, 500);
    await d.sleep(900);
    const dragged = (await state()).field;
    check("the round handle drags the text", dragged.x > s.field.x + 30 && dragged.y > s.field.y + 15, [s.field, dragged]);
    await named(".pv-phonebar button", "Back", 500);
    await button('.pv-phonebar [aria-label="Colour"]', 500);
    await button('.pv-phonebar [aria-label="Red"]', 500);
    await button('.pv-phonebar [aria-label="Font and size"]', 500);
    const size = await d.evaluate("document.querySelector('.pv-size').value");
    await button('.pv-phonebar [aria-label="Larger text"]', 600);
    check("larger text changes the size", Number(await d.evaluate("document.querySelector('.pv-size').value")) > Number(size));
    const colour = await d.evaluate("getComputedStyle(document.querySelector('[data-testid=line-editor]')).color");
    check("colour shows on the page", colour === "rgb(192, 38, 45)", colour);
    check("keyboard survived the whole style bar", d.keyboardShown());
    await button("[data-testid=editor-done]", 3000);
    await idle();
    check("styled text saved", (await state()).canUndo);
  },

  async gestures() {
    await open(`${DOCS}/invoice.pdf`);
    await d.calibrate();
    await d.pinch(200, 400, 80, 240);
    await d.sleep(1200);
    let s = await state();
    check("pinch zooms the page", typeof s.zoom === "number" && s.zoom > 1.3, s.zoom);
    await d.pinch(200, 400, 280, 60);
    await d.sleep(1200);
    check("pinching back returns to fit", (await state()).zoom === "fit", (await state()).zoom);
    await d.pinch(200, 24, 60, 260);
    await d.sleep(700);
    check("pinch on the top bar does not zoom the app", (await state()).pageZoom === 1, (await state()).pageZoom);
    await d.pinch(200, 750, 60, 260);
    await d.sleep(700);
    check("pinch on the tool bar does not zoom the app", (await state()).pageZoom === 1, (await state()).pageZoom);

    s = await openLine("Tax Invoice");
    check("heading opens", s.value === "Tax Invoice", s.value);
    await d.swipe(250, 330, 250, 130, 300);
    await d.sleep(1200);
    s = await state();
    check("scrolling while typing keeps the line open", !!s.editing && d.keyboardShown());
    await type("X");
    s = await state();
    check("typing after scrolling brings the caret back above the keyboard", s.value.includes("X") && caretSeen(s), s.caret);
    const zoom = s.zoom;
    await d.pinch(200, 280, 80, 200);
    await d.sleep(1200);
    s = await state();
    check("pinch while typing zooms and keeps the line open", !!s.editing && s.zoom > zoom * 1.3 && s.pageZoom === 1, [zoom, s.zoom]);
    await type("Y");
    s = await state();
    check("typing after a pinch shows the caret", s.value.includes("Y") && caretSeen(s), s.caret);
    await d.pinch(200, 280, 220, 90);
    await d.sleep(1200);
    check("pinching out while typing keeps the line open", !!(await state()).editing);

    // rotation
    d.shell("settings put system user_rotation 1");
    await d.sleep(3500);
    d.disconnect();
    await d.calibrate();
    s = await state();
    check("landscape: still editing, top bar makes room", !!s.editing && !s.topBar, [s.editing, s.topBar, s.vv]);
    if (!d.keyboardShown()) {
      await d.tap(s.field.x + s.field.w / 2, s.field.y + s.field.h / 2);
      await d.sleep(2000);
    }
    check("landscape: keyboard up", d.keyboardShown());
    await d.cdp("Input.insertText", { text: "Z" });
    await d.sleep(1200);
    s = await state();
    check("landscape: caret visible above the keyboard", caretSeen(s), [s.caret, s.dock, s.view]);
    const done = await d.centre("[data-testid=editor-done]");
    check("landscape: Done is wholly on screen", done.x + done.w / 2 <= s.width + 1 && done.w >= 44, [done, s.width]);
    const bar = await d.evaluate("document.querySelector('[data-testid=editor-dock]').getBoundingClientRect().toJSON()");
    check("landscape: the bar is one row, or a corner card when almost nothing is left", bar.height < 70 && (s.vv >= 130 || bar.width < 140), [s.vv, bar]);
    d.screenshot(`${OUT}/landscape.png`);
    if (d.keyboardShown()) d.key(4);
    d.shell("settings put system user_rotation 0");
    await d.sleep(3500);
    await d.calibrate();
    s = await state();
    check("back upright: still editing", !!s.editing);
    await closeEditor();
  },

  async scripts() {
    await open(`${DOCS}/hindi.pdf`);
    await d.calibrate();
    const texts = await lineTexts();
    let s = await openLine(texts[3]);
    check("a Hindi line opens", s.value === texts[3], s.value);
    await d.evaluate("(() => { const f = document.querySelector('[data-testid=line-editor]'); f.setSelectionRange(f.value.length, f.value.length); })()");
    await d.sleep(500);
    // Gboard commits a composition it did not start after a moment (in any text field, however plain), so
    // what is checked is that each step shows at the end of the line while it is being composed
    const shownSteps = [];
    for (const part of [" न", " नम", " नमस", " नमस्", " नमस्ते"]) {
      await d.cdp("Input.imeSetComposition", { text: part, selectionStart: part.length, selectionEnd: part.length });
      s = await state();
      shownSteps.push(!!s.value?.startsWith(texts[3]) && s.value.endsWith(part));
      await d.sleep(60);
    }
    s = await state();
    check("composing text (input method) appears while it is composed", shownSteps.every(Boolean), [shownSteps, s.value]);
    check("caret visible while composing", caretSeen(s), s.caret);
    await button("[data-testid=editor-done]", 3000);
    await idle();
    await d.sleep(800);
    await d.waitFor("[...document.querySelectorAll('.pv-sr button')].some((b) => b.textContent.includes('नमस्ते'))", 15000).catch(() => {});
    check("Hindi saved", (await lineTexts()).some((t) => t.includes("नमस्ते")), (await lineTexts()).slice(2, 6));
  },

  async tools() {
    await open(`${DOCS}/invoice.pdf`);
    await d.calibrate();
    await named(".sh-bottom button", "Add text");
    await d.tap(60, 520);
    await d.sleep(2500);
    let s = await state();
    check("add text opens a box with the keyboard", s.editing?.startsWith("new:") && d.keyboardShown(), s.editing);
    await type("hello from the phone this is a long new note");
    d.key(66);
    await d.sleep(500);
    await type("second line");
    s = await state();
    check("Enter makes a new line in added text", s.value === "hello from the phone this is a long new note\nsecond line", s.value);
    check("the new box stays on screen", s.field.x >= 0 && s.field.right <= s.width + 1 && caretSeen(s), s.field);
    await button("[data-testid=editor-done]", 3000);
    await idle();
    await d.waitFor("!!document.querySelector('[data-testid=selection-frame]')", 15000).catch(() => {});
    check("the added text is selected, with handles", await d.evaluate("!!document.querySelector('[data-testid=selection-frame]')"));
    const frame = await d.centre("[data-testid=selection-frame]");
    await d.swipe(frame.x, frame.y, frame.x + 10, frame.y - 80, 500);
    await d.sleep(2500);
    await idle();
    const moved = await d.centre("[data-testid=selection-frame]");
    check("a finger moves the added text", moved.y < frame.y - 50, [frame, moved]);
    await named(".pv-bar button", "Edit", 2000);
    s = await state();
    check("Edit reopens added text", s.editing?.startsWith("object:") && d.keyboardShown(), s.editing);
    await closeEditor();
    await named(".sh-bottom button", "Edit text");
    await button(".pv-fit", 1200);
    // where a table row sits on the screen at fit width (for the highlighter)
    const row = await lineBox("Item 4 cable set");

    const pick = async (tool) => {
      await named(".sh-bottom button", "More", 700);
      await named(".sh-toolgrid button", tool, 900);
    };
    const options = () =>
      d.evaluate(`(() => { const o = document.querySelector('.sh-options'); if (!o) return null; const row = o.querySelector('.sh-options-row');
        const out = [...o.querySelectorAll('button, select, input, label')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && (r.left < -0.5 || r.right > innerWidth + 0.5); }).length;
        return { out, scrolls: row ? row.scrollWidth - row.clientWidth : 0, height: o.getBoundingClientRect().height, top: o.getBoundingClientRect().top }; })()`);
    // drags in the clear lower half of the page, above the options card
    const drag = async (x1, y1, x2, y2) => {
      const before = (await state()).revision;
      await d.swipe(x1, y1, x2, y2, 400);
      await d.sleep(1800);
      await idle();
      return (await state()).revision > before;
    };
    for (const tool of ["Draw", "Rectangle", "Ellipse", "Line", "Arrow", "Whiteout"]) {
      await pick(tool);
      const o = await options();
      check(`${tool}: options fit the screen, nothing cut off`, o && !o.out && o.scrolls <= 0, o);
      d.screenshot(`${OUT}/tool-${tool}.png`);
      check(`${tool}: a finger drag adds it`, await drag(80, 370, 260, 420));
      if (await d.evaluate("!!__pdfedit.getState().selection")) await d.evaluate("__pdfedit.getState().select(null)");
      await d.sleep(500);
    }
    await pick("Highlight");
    check("Highlight: a swipe across a line marks it", await drag(row.left - 4, row.y, row.right + 4, row.y + 1));
    await pick("Redact");
    await d.swipe(80, 450, 240, 500, 400);
    await d.sleep(900);
    check("Redact asks before removing", await d.evaluate("!!document.querySelector('[data-testid=redact-confirm]')"));
    const before = (await state()).revision;
    await button("[data-testid=redact-confirm]", 3000);
    await idle();
    check("Redact removes after confirming", (await state()).revision > before);

    // select, resize, rotate, delete
    await pick("Rectangle");
    await drag(80, 360, 220, 420);
    await d.sleep(800);
    const handles = () =>
      d.evaluate("Object.fromEntries([...document.querySelectorAll('.pv-handle')].map((h) => { const r = h.getBoundingClientRect(); return [h.dataset.handle, { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }]; }))");
    let h = await handles();
    check("a new shape has finger sized handles", h.se && h.se.w >= 44 && h.rotate, h);
    if (h.se) {
      check("resize by a corner handle", await drag(h.se.x, h.se.y, h.se.x + 50, h.se.y + 30));
      h = await handles();
      check("turn by the rotate handle", await drag(h.rotate.x, h.rotate.y, h.rotate.x + 60, h.rotate.y + 30));
      const revision = (await state()).revision;
      await named(".pv-bar button", "Delete", 2000);
      await idle();
      check("delete the selected shape", (await state()).revision > revision && !(await state()).selection);
    }
    await named(".sh-bottom button", "Edit text");

    // signature
    await named(".sh-bottom button", "Sign", 1200);
    const pad = await d.centre(".sh-signpad");
    await d.stroke([...Array(15)].map((_, i) => ({ x: pad.x - 80 + i * 11, y: pad.y + Math.sin(i) * 25 })));
    await d.sleep(600);
    await named(".sh-panel-body button", "Use signature", 1200);
    const revision = (await state()).revision;
    await d.tap(220, 560);
    await d.sleep(2500);
    await idle();
    check("a drawn signature is placed", (await state()).revision > revision);
  },

  async panelsAndFiles() {
    await open(`${FIXTURES}/multipage.pdf`);
    await d.calibrate();
    const first = await lineTexts(0);
    await named(".sh-bottom button", "Pages", 1800);
    const grips = await d.evaluate("[...document.querySelectorAll('.sh-grip')].map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })");
    await d.swipe(grips[0][0], grips[0][1], grips[2][0] - 30, grips[2][1] + 40, 900);
    await d.sleep(2500);
    await idle();
    check("pages: drag by the grip reorders", (await state()).canUndo);
    await d.sleep(500);
    d.key(4);
    await d.sleep(1200);
    check("Back closes the sheet", (await state()).panel === null && (await d.evaluate("!!__pdfedit.getState().doc")));
    await d.sleep(500);
    check("the first page changed", JSON.stringify(await lineTexts(0)) !== JSON.stringify(first));

    await named(".sh-bottom button", "More", 700);
    await named(".sh-item", "Find and replace", 1800);
    await type("weather");
    await d.sleep(1200);
    let s = await state();
    check("find: matches found", (await d.evaluate("__pdfedit.getState().search.matches.length")) >= 5);
    check("find: tool bar leaves while the keyboard is up", d.keyboardShown() && !s.bottomBar);
    d.screenshot(`${OUT}/find.png`);
    d.key(4);
    await d.sleep(800);
    d.key(4);
    await d.sleep(1200);
    check("find closes with Back", (await state()).panel === null);

    await open(`${FIXTURES}/forms.pdf`);
    await named(".sh-bottom button", "More", 700);
    await named(".sh-item", "Fill forms", 1500);
    const field = await d.centre(".sh-panel-body input[type=text], .sh-panel-body input:not([type])");
    await d.tap(field.x, field.y);
    await d.sleep(1500);
    await type("Ravi");
    const seen = await d.evaluate("(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= visualViewport.height; })()");
    check("forms: the field stays above the keyboard", seen);
    d.key(66);
    await d.sleep(1500);
    if (d.keyboardShown()) d.key(4);
    await d.sleep(800);
    // the keyboard may already have gone, in which case that Back closed the sheet
    if ((await state()).panel) await named(".sh-panel-head button", "Close panel", 800);
    await idle();
    check("forms: value saved", (await state()).canUndo);

    // an image that was already in the file
    await open(`${FIXTURES}/images.pdf`);
    await named(".sh-bottom button", "More", 700);
    await named(".sh-toolgrid button", "Select", 1500);
    // a point inside the first picture of the fixture, in page points
    const at = await d.evaluate(`(() => { const r = document.querySelector('[data-page="0"]').getBoundingClientRect();
      const w = __pdfedit.getState().doc.pages[0].width; return { x: r.x + (130 * r.width) / w, y: r.y + (135 * r.width) / w }; })()`);
    await d.tap(at.x, at.y);
    await d.sleep(1800);
    check("an image in the file can be picked with a finger", (await state()).selection?.type === "image", (await state()).selection);
    if ((await state()).selection) {
      const before = (await state()).revision;
      await d.swipe(at.x, at.y, at.x + 50, at.y + 60, 500);
      await d.sleep(2500);
      await idle();
      check("and moved", (await state()).revision > before);
    }

    // download (the click is caught so Android does not leave Chrome for a viewer)
    await d.evaluate("window.__saved = null; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__saved = this.download; }");
    await button(".sh-iconbtn-primary", 2500);
    // phones get a sheet to share or save from
    if (await d.evaluate("!!document.querySelector('[data-testid=finish-save]')")) await button("[data-testid=finish-save]", 1500);
    check("download saves the edited file", (await d.evaluate("window.__saved")) === "images (edited).pdf", await d.evaluate("window.__saved"));
  },
};

/* ---------- fonts, line arrows, fit, locked lines, forms on the page, marks ---------- */

const fieldStyle = () =>
  d.evaluate("(() => { const f = document.querySelector('[data-testid=line-editor]'); return f && getComputedStyle(f).fontFamily; })()");
const exists = (selector) => d.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);

Object.assign(sections, {
  async fonts() {
    await open(`${DOCS}/invoice.pdf`);
    await d.calibrate();
    await openLine("Billed to");
    await d.waitFor("/pe-font-/.test(getComputedStyle(document.querySelector('[data-testid=line-editor]')).fontFamily)", 20000).catch(() => {});
    check("typing preview uses a loaded font (the document's own or the stand in)", /pe-font-/.test(await fieldStyle()), await fieldStyle());
    await button('.pv-phonebar [aria-label="Font and size"]', 600);
    await button('.pv-phonebar [aria-label="Font"]', 1500);
    const sheet = await d.evaluate(`(() => { const p = document.querySelector('[data-testid=font-picker]'); if (!p) return null; const r = p.getBoundingClientRect();
      const small = [...p.querySelectorAll('button, input')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 1 && b.height < 36; }).length;
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vv: visualViewport.height, small, options: p.querySelectorAll('[role=option]').length, details: p.querySelector('.pv-font-details').textContent }; })()`);
    check("font sheet fills the screen, controls finger sized", sheet && sheet.left >= -1 && sheet.right <= 413 && Math.abs(sheet.bottom - sheet.top - sheet.vv) < 3 && !sheet.small, sheet);
    check("font sheet says which font the line uses and lists fonts", sheet && /pt/.test(sheet.details) && sheet.options > 10, sheet);
    check("the keyboard is put away to browse", !d.keyboardShown());
    await d.waitFor("document.querySelectorAll('[data-testid=font-picker] .pv-font-sample[data-loaded]').length >= 3", 30000).catch(() => {});
    check("fonts preview the line in their own letters", (await d.evaluate("document.querySelectorAll('[data-testid=font-picker] .pv-font-sample[data-loaded]').length")) >= 3);
    d.screenshot(`${OUT}/font-sheet.png`);
    d.key(4);
    await d.sleep(1200);
    let s = await state();
    check("Back closes only the font sheet", !(await exists("[data-testid=font-picker]")) && !!s.editing, s.editing);
    await button('.pv-phonebar [aria-label="Font"]', 1200);
    await button('[data-testid=font-picker] input[type=search]', 900);
    await type("lora");
    await named("[data-testid=font-picker] [role=option]", "Lora", 2500);
    s = await state();
    check("picking a font returns to the line with the keyboard", s.editing && s.focused && d.keyboardShown(), [s.editing, s.focused]);
    check("the bar names the picked font", (await d.evaluate("document.querySelector('.pv-font-button')?.textContent")) === "Lora");
    await button("[data-testid=editor-done]", 3500);
    await idle();
    check("the picked font is saved", (await state()).canUndo);
  },

  async stepping() {
    await open(`${DOCS}/invoice.pdf`);
    await d.calibrate();
    let s = await openLine("Item 3 cable set");
    const zoom = s.zoom;
    await button('.pv-phonebar [aria-label="Next line"]', 1800);
    s = await state();
    check("next line opens the neighbour, keyboard and zoom kept", s.editing && s.value !== "Item 3 cable set" && s.focused && d.keyboardShown() && s.zoom === zoom, [s.value, s.zoom, zoom]);
    check("and keeps the caret above the bar", caretSeen(s), s);
    await button('.pv-phonebar [aria-label="Previous line"]', 1800);
    s = await state();
    check("previous line goes back", s.value === "Item 3 cable set", s.value);
    await type(" G");
    await button('.pv-phonebar [aria-label="Next line"]', 600);
    await idle();
    await d.sleep(2000);
    s = await state();
    check("stepping saves the line first", s.editing && s.focused && (await lineTexts()).some((t) => /Item 3 cable set G/.test(t)), [s.value, s.editing]);

    // longer than there is room for
    await closeEditor();
    await openLine("Item 3 cable set G");
    await type(" with a much longer description than the cell holds");
    await d.waitFor("!!document.querySelector('[data-testid=fit-chip]')", 8000).catch(() => {});
    const chip = await d.evaluate("document.querySelector('[data-testid=fit-chip]')?.textContent");
    check("a warning appears while the text grows too long", /Runs|Longer/.test(chip ?? ""), chip);
    s = await state();
    check("the line is still visible above the warning", caretSeen(s), s);
    const wide = s.field.w;
    d.screenshot(`${OUT}/fit.png`);
    await button("[data-testid=fit-chip] button", 900);
    s = await state();
    check("one tap fits it, keyboard stays", s.field.w < wide * 0.9 && d.keyboardShown() && !!s.editing, [wide, s.field.w]);
    await closeEditor();
  },

  async locked() {
    await open(`${FIXTURES}/broken-pua.pdf`);
    await d.calibrate();
    await d.waitFor("!!document.querySelector('.pv-linebox-locked')", 20000).catch(() => {});
    const spot = await d.evaluate(`(() => { const e = document.querySelector('.pv-linebox-locked'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 }; })()`);
    if (!check("a line that cannot be edited is marked", !!spot)) return;
    await d.sleep(700);
    // the offer to read the whole page sits at the bottom, clear of the lines
    check("the recognise offer leaves the top lines free", await d.evaluate(`(() => { const n = document.querySelector('[data-testid=ocr-prompt]'); return !!n && n.getBoundingClientRect().top > ${spot.y} + 40; })()`));
    await d.tap(spot.x, spot.y);
    await d.sleep(1500);
    if (!(await exists("[data-testid=locked-bar]"))) {
      await d.tap(spot.x, spot.y);
      await d.sleep(1500);
    }
    const bar = await d.evaluate(`(() => { const b = document.querySelector('[data-testid=locked-bar]'); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent, left: r.left, right: r.right, bottom: r.bottom, vv: visualViewport.height }; })()`);
    check("tapping it offers the ways forward", bar && /Cover and retype/.test(bar.text) && bar.left >= 0 && bar.right <= 413 && bar.bottom <= bar.vv, bar);
    d.screenshot(`${OUT}/locked.png`);
    d.key(4);
    await d.sleep(900);
    check("Back puts the offer away and stays in the app", !(await exists("[data-testid=locked-bar]")) && (await d.evaluate("!!__pdfedit.getState().doc")));
    await d.tap(spot.x, spot.y);
    await d.sleep(1500);
    await named("[data-testid=locked-bar] button", "Cover and retype", 3500);
    await idle();
    await d.sleep(1500);
    let s = await state();
    check("cover and retype opens a new box", s.editing?.startsWith("new:"), s.editing);
    if (!d.keyboardShown() && s.field) {
      await d.tap(s.field.x + 20, s.field.y + s.field.h / 2);
      await d.sleep(1500);
    }
    await type("Typed again");
    await button("[data-testid=editor-done]", 3000);
    await idle();
    check("the retyped line is saved", (await state()).canUndo);
  },

  async formsOnPage() {
    await open(`${FIXTURES}/forms.pdf`);
    await d.calibrate();
    await d.waitFor("!!document.querySelector('.pv-field')", 20000).catch(() => {});
    const targets = await d.evaluate("[...document.querySelectorAll('.pv-field')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })");
    check("fields on the page are finger sized targets", targets.length > 0 && targets.every(([w, h]) => w >= 44 && h >= 44), targets);
    const textField = ".pv-field[aria-label^=Fill]";
    await d.evaluate(`document.querySelector('${textField}').scrollIntoView({ block: 'center' })`);
    await d.sleep(700);
    await button(textField, 2000);
    check("tapping a field on the page opens the keyboard", (await exists("[data-testid=field-bar]")) && d.keyboardShown());
    await type("Ravi");
    const seen = await d.evaluate(`(() => { const f = document.querySelector('.pv-field-open').getBoundingClientRect(); const dock = document.querySelector('[data-testid=editor-dock]').getBoundingClientRect(); return { ok: f.top >= 40 && f.bottom <= dock.top + 2, f: f.toJSON(), dock: dock.top }; })()`);
    check("the field being filled stays visible above its bar", seen.ok, seen);
    d.screenshot(`${OUT}/form-field.png`);
    const first = await d.evaluate("document.querySelector('.pv-field-open').dataset.field");
    await button('[data-testid=editor-dock] [aria-label="Next field"]', 2500);
    await idle();
    const next = await d.evaluate("({ name: document.querySelector('.pv-field-open')?.dataset.field })");
    check("next field moves on", next.name && next.name !== first, [first, next]);
    await button("[data-testid=field-done]", 2000);
    await idle();
    check("the value is saved", (await state()).canUndo);
    const box = ".pv-field[role=checkbox]";
    await d.evaluate(`document.querySelector('${box}').scrollIntoView({ block: 'center' })`);
    await d.sleep(700);
    const before = await d.evaluate(`document.querySelector('${box}').getAttribute('aria-checked')`);
    await button(box, 2500);
    await idle();
    await d.sleep(800);
    check("a checkbox ticks at one tap", (await d.evaluate(`document.querySelector('${box}').getAttribute('aria-checked')`)) !== before, before);
  },

  async marks() {
    await open(`${DOCS}/invoice.pdf`);
    await d.calibrate();
    await named(".sh-bottom button", "Add text", 900);
    const bar = await d.evaluate(`(() => { const b = document.querySelector('[data-testid=marks-bar]'); if (!b) return null; const all = [...b.querySelectorAll('button')].map((e) => e.getBoundingClientRect());
      return { n: all.length, outside: all.filter((r) => r.left < 0 || r.right > innerWidth).length, small: all.filter((r) => r.height < 44 || r.width < 44).length }; })()`);
    check("add text offers marks, all on screen and finger sized", bar && bar.n >= 7 && !bar.outside && !bar.small, bar);
    await named("[data-testid=marks-bar] button", "Tick", 500);
    let revision = (await state()).revision;
    await d.tap(330, 300);
    await d.sleep(2000);
    await idle();
    let s = await state();
    check("a tap puts a tick, without a keyboard", s.revision > revision && !s.editing && !d.keyboardShown(), s.editing);
    revision = s.revision;
    await d.tap(330, 340);
    await d.sleep(2000);
    await idle();
    check("the tick stays armed for the next", (await state()).revision > revision);
    await named("[data-testid=marks-bar] button", "Date", 500);
    revision = (await state()).revision;
    await d.tap(80, 520);
    await d.sleep(2000);
    await idle();
    check("a date is added at a tap", (await state()).revision > revision);
    d.screenshot(`${OUT}/marks.png`);
    await named(".sh-bottom button", "Edit text", 900);
    // long press on empty paper
    const at = await d.evaluate(`(() => { const p = document.querySelector('[data-page="0"]').getBoundingClientRect(); return { x: p.left + p.width * 0.5, y: p.bottom - 40 }; })()`);
    await d.evaluate("document.querySelector('.pv-scroll').scrollTop = 0");
    const [x, y] = await d.toScreen(at.x, Math.min(at.y, 600));
    d.shell(`input swipe ${x} ${y} ${x} ${y} 900`);
    await d.sleep(1200);
    check("long press on empty paper offers what can be added", await d.evaluate("/Add text here/.test(document.querySelector('[data-testid=context-menu]')?.textContent ?? '')"));
    d.screenshot(`${OUT}/menu.png`);
    d.key(4);
    await d.sleep(800);
    check("Back closes the menu", !(await exists("[data-testid=context-menu]")) && (await d.evaluate("!!__pdfedit.getState().doc")));
  },
});

d.shell("settings put system accelerometer_rotation 0; settings put system user_rotation 0");
for (const [name, run] of Object.entries(sections)) {
  if (only && !only.includes(name)) continue;
  section = name;
  console.log(`\n== ${name}`);
  try {
    // every section starts from a freshly loaded app
    await d.reload();
    await run();
  } catch (error) {
    check(`${section} ran to the end`, false, error.message);
  }
}
d.shell("settings put system user_rotation 0");
check("no page errors", !d.errors.length, d.errors.slice(0, 5));
console.log(`\n${passes} passed, ${failures} failed`);
d.disconnect();
process.exit(failures ? 1 : 0);
