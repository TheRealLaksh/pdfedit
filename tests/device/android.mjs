/**
 * Drive the app in real Chrome on an Android emulator or phone: real touches (adb input), the real
 * on-screen keyboard, real screenshots; the page is inspected over the Chrome DevTools protocol.
 *
 *   node tests/device/android.mjs <command> [args]
 *
 * Needs: adb (ANDROID_HOME or C:/dev/android-sdk), a booted device (ANDROID_SERIAL, default emulator-5584),
 * the app served on this PC (PDFEDIT_URL, default http://localhost:4180).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const sdk = process.env.ANDROID_HOME || "C:/dev/android-sdk";
const serial = process.env.ANDROID_SERIAL || "emulator-5584";
export const URL_BASE = process.env.PDFEDIT_URL || "http://localhost:4180";
const DEVTOOLS = 9333;

export const adb = (...args) =>
  execFileSync(join(sdk, "platform-tools", "adb"), ["-s", serial, ...args], { maxBuffer: 64 << 20 });
export const shell = (cmd) => adb("shell", cmd).toString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** first run: no welcome screens, forward the server and DevTools ports, open the app */
export async function setup() {
  shell(`echo "chrome --disable-fre --no-first-run --no-default-browser-check --disable-notifications" > /data/local/tmp/chrome-command-line`);
  shell("am set-debug-app --persistent com.android.chrome");
  const port = new URL(URL_BASE).port;
  if (/localhost/.test(URL_BASE)) adb("reverse", `tcp:${port}`, `tcp:${port}`);
  adb("forward", `tcp:${DEVTOOLS}`, "localabstract:chrome_devtools_remote");
  shell("am force-stop com.android.chrome");
  shell(`am start -a android.intent.action.VIEW -d "${URL_BASE}/" com.android.chrome`);
  await sleep(5000);
}

let socket;
let nextId = 0;
const waiting = new Map();
export const errors = [];

async function connect() {
  if (socket?.readyState === 1) return;
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json();
      const open = targets.filter((t) => t.type === "page" && t.url.startsWith(URL_BASE));
      page = open.find((t) => /PDFEdit/.test(t.title));
      // tabs left over from earlier runs or failed loads never answer: close them
      if (page) for (const t of open) if (t !== page) await fetch(`http://127.0.0.1:${DEVTOOLS}/json/close/${t.id}`);
    } catch {
      /* Chrome is still starting */
    }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("The app is not open in Chrome (run: node tests/device/android.mjs setup)");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("DevTools connection failed"));
  });
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
    // "Leave site?" after unsaved changes: a test reload always means yes
    else if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  await send("Runtime.enable");
  await send("Page.enable");
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/** upright, no keyboard, a freshly loaded app (the newest build) */
export async function reload() {
  shell("settings put system accelerometer_rotation 0; settings put system user_rotation 0");
  if (keyboardShown()) shell("input keyevent 4");
  await cdp("Page.reload", { ignoreCache: true });
  await sleep(2000);
  await waitFor("!!window.__pdfedit && document.readyState === 'complete'");
  mapping = undefined;
}

/** evaluate an expression in the page (promises are awaited) */
export async function evaluate(expression) {
  await connect();
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** a raw DevTools protocol call */
export async function cdp(method, params = {}) {
  await connect();
  return send(method, params);
}

/**
 * Two fingers through the DevTools protocol (adb "input" can only move one): from `start` apart to `end`
 * apart around (x, y), optionally moving the centre by (dx, dy). CSS client coordinates. They go through
 * Chrome's own gesture handling, touch-action included. (Kernel events from the emulator console would make
 * Gboard believe a stylus is in use.)
 */
export async function pinch(x, y, start, end, { dx = 0, dy = 0, steps = 12, wait = 16 } = {}) {
  const points = (t) => {
    const half = (start + (end - start) * t) / 2;
    const cx = x + dx * t;
    const cy = y + dy * t;
    return [{ x: cx - half, y: cy, id: 0 }, { x: cx + half, y: cy, id: 1 }];
  };
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points(0)[0]] });
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
  for (let i = 1; i <= steps; i++) {
    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(i / steps) });
    await sleep(wait);
  }
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** one finger along a path of CSS client points, through the DevTools protocol (smooth, many samples) */
export async function stroke(path, { wait = 16 } = {}) {
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...path[0], id: 0 }] });
  for (const point of path.slice(1)) {
    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 0 }] });
    await sleep(wait);
  }
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export function disconnect() {
  socket?.close();
  socket = undefined;
}

export async function waitFor(expression, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await evaluate(expression);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${expression}`);
    await sleep(300);
  }
}

/* ---------- CSS pixels <-> screen pixels ---------- */

let mapping;
/** where the page's layout viewport sits on the screen, measured from the Android UI tree */
export function webViewBounds() {
  // uiautomator is sometimes killed on a busy emulator: try again
  for (let attempt = 1; ; attempt++) {
    try {
      shell("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1");
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      shell("sleep 3");
    }
  }
  const xml = adb("exec-out", "cat", "/sdcard/ui.xml").toString();
  const node = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]).find((n) => /class="android\.webkit\.WebView"/.test(n) || /compositor_view_holder/.test(n));
  const b = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!b) throw new Error("Could not find the web view on screen");
  return b.slice(1).map(Number);
}

/** tap a transparent shield over the page and see where the touch lands: browser toolbars shift the page */
export async function calibrate() {
  const [left, top, right, bottom] = webViewBounds();
  const v = await evaluate("({s: visualViewport.scale, vw: visualViewport.width})");
  const scale = (right - left) / (v.vw * v.s);
  await evaluate(`(() => { const shield = document.createElement('div'); shield.id = '__shield';
    shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;touch-action:none';
    window.__probe = null;
    shield.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); const t = e.touches[0]; window.__probe = [t.clientX, t.clientY]; }, { passive: false });
    for (const type of ['pointerdown', 'pointerup', 'click', 'mousedown']) shield.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); });
    document.body.appendChild(shield); })()`);
  const sx = Math.round((left + right) / 2);
  const sy = Math.round(top + (bottom - top) * 0.55);
  shell(`input tap ${sx} ${sy}`);
  const probe = await waitFor("window.__probe", 8000);
  await sleep(250);
  await evaluate("document.getElementById('__shield')?.remove()");
  mapping = { left: sx - probe[0] * scale, top: sy - probe[1] * scale, scale };
  return mapping;
}

/** CSS client coordinates -> screen pixels (accounts for visual viewport panning and zoom) */
export async function toScreen(x, y) {
  if (!mapping) await calibrate();
  const v = await evaluate("({x: visualViewport.offsetLeft, y: visualViewport.offsetTop, s: visualViewport.scale})");
  return [Math.round(mapping.left + (x - v.x) * v.s * mapping.scale), Math.round(mapping.top + (y - v.y) * v.s * mapping.scale)];
}

/* ---------- real input ---------- */

export async function tap(x, y) {
  const [sx, sy] = await toScreen(x, y);
  shell(`input tap ${sx} ${sy}`);
}

export async function swipe(x1, y1, x2, y2, ms = 300) {
  const a = await toScreen(x1, y1);
  const b = await toScreen(x2, y2);
  shell(`input swipe ${a[0]} ${a[1]} ${b[0]} ${b[1]} ${ms}`);
}

export const typeText = (text) => shell(`input text '${text.replace(/ /g, "%s").replace(/'/g, "")}'`);
export const key = (code) => shell(`input keyevent ${code}`);
export function keyboardShown() {
  for (let attempt = 0; ; attempt++) {
    try {
      // grep on the device: the full dump is large and adb sometimes drops it half way
      return /mInputShown=true/.test(shell("dumpsys input_method | grep mInputShown; true"));
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

/** centre of the first visible element matching the selector */
export async function centre(selector) {
  const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!box) throw new Error(`No element ${selector}`);
  return box;
}

export async function tapOn(selector) {
  const c = await centre(selector);
  await tap(c.x, c.y);
}

export function screenshot(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, adb("exec-out", "screencap", "-p"));
}

/** open a local PDF in the app without the system file picker */
export async function openPdf(path, password) {
  const b64 = readFileSync(path).toString("base64");
  await evaluate(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    await window.__pdfedit.getState().openBytes(bytes, ${JSON.stringify(basename(path))}, ${password ? JSON.stringify(password) : "undefined"}); })()`);
  await waitFor("!!window.__pdfedit.getState().doc && !window.__pdfedit.getState().busy");
  await sleep(1500);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [command, ...args] = process.argv.slice(2);
  const commands = {
    setup,
    shot: () => screenshot(args[0] ?? ".tmp/device/shot.png"),
    eval: async () => console.log(JSON.stringify(await evaluate(args[0]))),
    open: () => openPdf(args[0], args[1]),
    tap: () => tap(Number(args[0]), Number(args[1])),
    tapon: () => tapOn(args[0]),
    type: () => typeText(args.join(" ")),
  };
  if (!commands[command]) {
    console.error(`commands: ${Object.keys(commands).join(", ")}`);
    process.exit(1);
  }
  await commands[command]();
  if (errors.length) console.log("page errors:", errors);
  disconnect();
}
