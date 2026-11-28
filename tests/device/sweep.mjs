/**
 * Tap EVERY text box of a document with a real finger and check that exactly that box opens, with the
 * keyboard, the right text, and the text visible above the keyboard.
 *
 *   node tests/device/sweep.mjs file.pdf [more.pdf] [--limit=40] [--where=centre|left|right|top|bottom]
 */
import { basename } from "node:path";
import * as d from "./android.mjs";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const limit = Number(opt("limit", 40));
const where = opt("where", "centre");

const state = () =>
  d.evaluate(`(() => { const s = __pdfedit.getState(); const field = document.querySelector('[data-testid=line-editor]');
    const box = document.querySelector('.pv-editor [data-pv-caret]')?.parentElement ?? document.querySelector('.pv-editor');
    const caret = document.querySelector('[data-pv-caret]')?.getBoundingClientRect();
    const dock = document.querySelector('[data-testid=editor-dock]')?.getBoundingClientRect();
    const view = document.querySelector('.pv-scroll')?.getBoundingClientRect();
    return { editing: s.editing?.lineId ?? null, zoom: s.zoom, busy: s.busy, value: field?.value ?? null, focused: document.activeElement === field,
      caret: caret ? { top: caret.top, bottom: caret.bottom, left: caret.left } : null, dockTop: dock?.top ?? null,
      viewTop: view?.top ?? 0, width: innerWidth, toasts: s.toasts.map((t) => t.message) }; })()`);

/** scroll the box into the middle of the view and return the point to tap */
const target = (id) =>
  d.evaluate(`(async () => { const el = document.querySelector('[data-line-id="${id}"]'); if (!el) return null;
    const view = document.querySelector('.pv-scroll');
    let r = el.getBoundingClientRect(); const v = view.getBoundingClientRect();
    if (r.top < v.top + 60 || r.bottom > v.bottom - 90 || r.left < 4 || r.left > innerWidth - 40) {
      view.scrollTop += (r.top + r.bottom) / 2 - (v.top + v.bottom) / 2;
      view.scrollLeft += r.left - 24;
      await new Promise((ok) => setTimeout(ok, 450)); r = el.getBoundingClientRect(); }
    const left = Math.max(r.left, 4), right = Math.min(r.right, innerWidth - 4), cx = (left + right) / 2, cy = (r.top + r.bottom) / 2;
    const p = { centre: [cx, cy], left: [left + 3, cy], right: [right - 3, cy], top: [cx, r.top + 1], bottom: [cx, r.bottom - 1] }['${where}'];
    return { x: p[0], y: p[1], w: r.width, h: r.height }; })()`);

let failures = 0;
for (const file of files) {
  await d.evaluate("__pdfedit.getState().closeDoc()");
  await d.openPdf(file);
  await d.waitFor("document.querySelectorAll('[data-line-id]').length > 0");
  await d.sleep(800);
  await d.calibrate();
  const lines = await d.evaluate(`[...document.querySelectorAll('[data-testid=edit-layer]')][0] && (() => {
    const layer = document.querySelector('[data-testid=edit-layer]');
    const ids = [...layer.querySelectorAll('[data-line-id]')].map((e) => e.dataset.lineId);
    const texts = [...layer.querySelectorAll('.pv-sr button')].map((e) => e.textContent.replace(/^Edit: /, ''));
    return ids.map((id, i) => ({ id, text: texts[i] })); })()`);
  const step = Math.max(1, Math.ceil(lines.length / limit));
  const chosen = lines.filter((_, i) => i % step === 0);
  console.log(`\n== ${basename(file)}: ${lines.length} boxes, testing ${chosen.length} (${where})`);
  let ok = 0;
  for (const line of chosen) {
    const point = await target(line.id);
    if (!point) {
      console.log(`  ?? box vanished: ${line.text.slice(0, 40)}`);
      continue;
    }
    await d.tap(point.x, point.y);
    await d.sleep(1700);
    const s = await state();
    const problems = [];
    if (!s.editing) problems.push("nothing opened");
    else if (s.editing !== line.id) problems.push(`wrong box opened: "${(s.value ?? "").slice(0, 30)}"`);
    else {
      if (s.value !== line.text) problems.push(`field text differs: "${(s.value ?? "").slice(0, 40)}"`);
      if (!s.focused) problems.push("field not focused");
      if (!d.keyboardShown()) problems.push("no keyboard");
      if (!s.caret) problems.push("no caret on the page");
      else if (s.caret.top < s.viewTop - 2 || s.caret.bottom > (s.dockTop ?? 9999) + 2) problems.push(`caret hidden (caret ${Math.round(s.caret.top)}-${Math.round(s.caret.bottom)}, view ${Math.round(s.viewTop)}-${Math.round(s.dockTop)})`);
      else if (s.caret.left < 0 || s.caret.left > s.width) problems.push("caret off the side of the screen");
    }
    if (problems.length) {
      failures++;
      d.screenshot(`.tmp/device/fail-${failures}.png`);
      console.log(`  FAIL #${failures} [${Math.round(point.w)}x${Math.round(point.h)}px] "${line.text.slice(0, 40)}": ${problems.join("; ")}`);
    } else ok++;
    if (s.editing) {
      await d.tapOn("[data-testid=editor-cancel]");
      await d.sleep(900);
      const after = await state();
      if (after.editing) {
        console.log(`  FAIL cancel did not close "${line.text.slice(0, 30)}"`);
        failures++;
        await d.evaluate("__pdfedit.getState().stopEditing()");
        await d.sleep(500);
      }
    }
  }
  console.log(`  ${ok}/${chosen.length} boxes fine`);
}
console.log(`\n${failures} failures. page errors: ${JSON.stringify(d.errors.slice(0, 5))}`);
d.disconnect();
process.exit(0);
