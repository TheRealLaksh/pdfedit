/**
 * Things the viewer does from several places (bars, menus, keys): covering a locked line, putting down form
 * marks and shapes, and copying, pasting and duplicating.
 */
import { toEngineImage, useStore, type ToolId } from "../../store";
import type { NewPageObject, PageObject, Point, Rect, RGB, TextLine, TextStyle } from "../../engine/types";
import { samplePaper } from "./canvasRegistry";
import { addTextAt } from "./editor/controller";
import { measureText } from "./editor/textMetrics";
import { fromLocal, hexToRgb, lineFrame, rectCentre, rectH, rectW, withRect } from "./geometry";
import { peekPageData, loadPageData } from "./pageData";
import { addGhost, removeGhost, showHint, useViewer, type Mark } from "./viewerStore";

/** the viewer's scroll area gets the focus back, so that keys keep working */
export function focusViewer() {
  document.querySelector<HTMLElement>(".pv-scroll")?.focus({ preventScroll: true });
}

/** the page and spot in the middle of what is on screen */
export function viewCentre(): { page: number; at: Point } | null {
  const view = document.querySelector(".pv-scroll")?.getBoundingClientRect();
  const pages = useStore.getState().doc?.pages;
  if (!view || !pages) return null;
  const x = view.left + view.width / 2;
  const y = view.top + view.height / 2;
  let best: { page: number; at: Point; distance: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>(".pv-scroll .pv-page")) {
    const r = el.getBoundingClientRect();
    const info = pages[Number(el.dataset.page)];
    if (!info || !r.width) continue;
    const cx = Math.max(r.left, Math.min(r.right, x));
    const cy = Math.max(r.top, Math.min(r.bottom, y));
    const distance = Math.hypot(cx - x, cy - y);
    if (!best || distance < best.distance)
      best = {
        page: Number(el.dataset.page),
        at: [((cx - r.left) / r.width) * info.width, ((cy - r.top) / r.height) * info.height],
        distance,
      };
  }
  return best && { page: best.page, at: best.at };
}

/* ---------- lines that cannot be edited ---------- */

function paper(css: string): RGB {
  if (css.startsWith("#")) return hexToRgb(css);
  const [r = 255, g = 255, b = 255] = css.match(/\d+/g)?.map(Number) ?? [];
  return [r / 255, g / 255, b / 255];
}

/**
 * Cover a line with the colour of the paper and open a box to retype it, in its size and colour. The old
 * words stay in the file underneath (the bar says so).
 */
export async function coverAndRetype(line: TextLine, text: string) {
  const store = useStore.getState();
  const info = store.doc?.pages[line.page];
  if (!info) return;
  useViewer.setState({ locked: null });
  const frame = lineFrame(line);
  const width = frame.uMax - frame.uMin + 2;
  const height = frame.vMax - frame.vMin + 1;
  const centre = fromLocal(frame, [(frame.uMin + frame.uMax) / 2, (frame.vMin + frame.vMax) / 2]);
  const rect: Rect = [centre[0] - width / 2, centre[1] - height / 2, centre[0] + width / 2, centre[1] + height / 2];
  const result = await store.addObject({
    kind: "whiteout",
    page: line.page,
    rect,
    rotation: Math.round((line.angle * 180) / Math.PI * 100) / 100,
    fill: paper(samplePaper(line.page, info.width, line.rect)),
  });
  if (!result) return;
  const style: TextStyle = { ...line.style, fontChoice: undefined };
  const origin = fromLocal(frame, [frame.uMin, 0]);
  addTextAt(line.page, origin, undefined, { text, style, width: width * 1.1, cover: true });
}

/* ---------- marks for forms without fields ---------- */

const INITIALS_KEY = "pdfedit.initials";

export function readInitials(): string {
  try {
    return localStorage.getItem(INITIALS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeInitials(value: string) {
  try {
    localStorage.setItem(INITIALS_KEY, value);
  } catch {
    /* private mode */
  }
}

/** marks are sized like the writing next to them */
function sizeNear(page: number, at: Point): number {
  let best = 12;
  let distance = 60;
  for (const line of peekPageData("text", page)?.lines ?? []) {
    const [x0, y0, x1, y1] = line.rect;
    const d = Math.hypot(Math.max(0, x0 - at[0], at[0] - x1), Math.max(0, y0 - at[1], at[1] - y1));
    if (d < distance) [best, distance] = [line.style.size, d];
  }
  return Math.max(7, Math.min(24, best));
}

export const today = () =>
  new Intl.DateTimeFormat(navigator.language, { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());

/** the object a mark puts at `at`: drawn marks are centred there, writing starts there on its baseline */
export function markObject(mark: Exclude<Mark, "text">, page: number, at: Point, size: number, style: TextStyle, initials: string): NewPageObject | null {
  const info = useStore.getState().doc?.pages[page];
  if (!info) return null;
  const color = style.color;
  if (mark === "date" || mark === "initials") {
    const text = mark === "date" ? today() : initials.trim();
    if (!text) return null;
    const own: TextStyle = { ...style, size, underline: false };
    const width = measureText(text, own, size).width * 1.15 + size * 0.5;
    const x = Math.max(0, Math.min(info.width - width, at[0] - 2));
    const y = Math.max(0, Math.min(info.height - size * 1.2, at[1] - size * 0.75));
    return { kind: "text", page, rect: [x, y, x + width, y + size * 1.2], text, style: own, align: "left", lineHeight: 1.2 };
  }
  const s = size * (mark === "dot" ? 0.55 : 1.05);
  const x = at[0] - s / 2;
  const y = at[1] - s / 2;
  const rect: Rect = [x, y, x + s, y + s];
  if (mark === "dot") return { kind: "ellipse", page, rect, fill: color, stroke: null, strokeWidth: 0 };
  const p = (u: number, v: number): Point => [x + u * s, y + v * s];
  const paths =
    mark === "tick"
      ? [[p(0.04, 0.55), p(0.36, 0.9), p(0.96, 0.1)]]
      : [
          [p(0.1, 0.1), p(0.9, 0.9)],
          [p(0.9, 0.1), p(0.1, 0.9)],
        ];
  return { kind: "ink", page, rect, paths, stroke: color, strokeWidth: Math.max(0.8, size * 0.13) };
}

export async function placeMark(page: number, at: Point, mark: Exclude<Mark, "text">) {
  await loadPageData("text", page).catch(() => undefined);
  const store = useStore.getState();
  const object = markObject(mark, page, at, sizeNear(page, at), store.toolOptions.text, readInitials());
  if (!object) {
    showHint("Type your initials in the box first");
    return;
  }
  const ghost =
    object.kind === "ink"
      ? addGhost({ kind: "ink", page, paths: object.paths, stroke: object.stroke, width: object.strokeWidth })
      : object.kind === "ellipse"
        ? addGhost({ kind: "rect", page, rect: object.rect, ellipse: true, fill: object.fill })
        : null;
  const result = await store.addObject(object);
  if (!result && ghost !== null) removeGhost(ghost);
}

/* ---------- shapes without a drag ---------- */

export const KEYED_TOOLS: ToolId[] = ["rect", "ellipse", "line", "arrow", "whiteout", "redact"];

/** the keyboard (or a single tap) route for the drag tools: a ready sized shape in the middle of the view */
export async function addShapeInMiddle() {
  const spot = viewCentre();
  const store = useStore.getState();
  const info = spot && store.doc?.pages[spot.page];
  if (!spot || !info) return;
  const { tool, toolOptions } = store;
  const w = Math.min(160, info.width * 0.4);
  const h = tool === "rect" || tool === "ellipse" ? w * 0.6 : 32;
  const x = Math.max(0, Math.min(info.width - w, spot.at[0] - w / 2));
  const y = Math.max(0, Math.min(info.height - h, spot.at[1] - h / 2));
  const rect: Rect = [x, y, x + w, y + h];
  const page = spot.page;
  if (tool === "redact") {
    useViewer.setState((s) => ({ redactions: { ...s.redactions, [page]: [...(s.redactions[page] ?? []), rect] } }));
    return;
  }
  let object: NewPageObject;
  if (tool === "line" || tool === "arrow")
    object = {
      kind: tool, page, rect: [x, y + h / 2, x + w, y + h / 2], from: [x, y + h / 2], to: [x + w, y + h / 2],
      stroke: toolOptions.color, strokeWidth: toolOptions.strokeWidth, opacity: toolOptions.opacity,
    };
  else if (tool === "whiteout")
    object = { kind: "whiteout", page, rect, fill: paper(samplePaper(page, info.width, rect)) };
  else if (tool === "rect" || tool === "ellipse")
    object = {
      kind: tool, page, rect, stroke: toolOptions.color, fill: toolOptions.fill,
      strokeWidth: toolOptions.strokeWidth, opacity: toolOptions.opacity,
    };
  else return;
  const result = await store.addObject(object);
  if (result?.createdId) {
    // selected, so that arrows move it at once
    useStore.getState().setTool("select");
    useStore.getState().select({ type: "object", page, id: result.createdId });
    focusViewer();
  }
}

/* ---------- copy, paste, duplicate ---------- */

/** bytes of the pictures placed in this session: the engine does not hand them back */
const pictures = new Map<string, Uint8Array>();
const pictureKey = (id: string) => `${useStore.getState().session}:${id}`;

export function rememberPicture(id: string, data: Uint8Array) {
  pictures.set(pictureKey(id), data);
}

export const canCopy = (object: PageObject) => object.kind !== "image" || pictures.has(pictureKey(object.id));

let copied: { object: PageObject; data?: Uint8Array; pasted: number } | null = null;
export const hasCopied = () => !!copied;

export function copyObject(object: PageObject): boolean {
  if (!canCopy(object)) {
    showHint("This picture was already in the file and cannot be copied");
    return false;
  }
  copied = { object: structuredClone(object), data: object.kind === "image" ? pictures.get(pictureKey(object.id)) : undefined, pasted: 0 };
  return true;
}

export async function selectedObject(): Promise<PageObject | null> {
  const selection = useStore.getState().selection;
  if (selection?.type !== "object") return null;
  const list = peekPageData("objects", selection.page) ?? (await loadPageData("objects", selection.page));
  return list.find((o) => o.id === selection.id) ?? null;
}

async function addAndSelect(object: NewPageObject, data?: Uint8Array) {
  const store = useStore.getState();
  const result = await store.addObject(object);
  if (!result?.createdId) return;
  if (data) rememberPicture(result.createdId, data);
  useStore.getState().setTool("select");
  useStore.getState().select({ type: "object", page: object.page, id: result.createdId });
  focusViewer();
}

/** put a copy of `object` on `page`: centred at `at`, or a little beside the original */
async function addCopy(object: PageObject, page: number, at: Point | null, step: number, data?: Uint8Array) {
  const info = useStore.getState().doc?.pages[page];
  if (!info) return;
  const w = rectW(object.rect);
  const h = rectH(object.rect);
  const centre = rectCentre(object.rect);
  const wanted: Point = at ?? [centre[0] + 12 * step, centre[1] + 12 * step];
  const x = Math.max(0, Math.min(info.width - w, wanted[0] - w / 2));
  const y = Math.max(0, Math.min(info.height - h, wanted[1] - h / 2));
  const moved = withRect(object, [x, y, x + w, y + h]);
  const { id: _, ...rest } = { ...moved, page };
  if (rest.kind === "image") {
    if (!data) return;
    const { blobId: __, ...plain } = rest;
    await addAndSelect({ ...plain, data }, data);
  } else await addAndSelect(rest as NewPageObject);
}

export async function pasteCopied(page: number, at: Point | null) {
  if (!copied) return;
  // pasting again on the same page steps further, so the copies do not hide each other
  const here = page === copied.object.page;
  const step = here && !at ? ++copied.pasted : 0;
  const info = useStore.getState().doc?.pages[page];
  const middle: Point | null = at ?? (here ? null : info ? [info.width / 2, info.height / 2] : null);
  await addCopy(copied.object, page, middle, step, copied.data);
}

export async function duplicate(object: PageObject) {
  if (!canCopy(object)) {
    showHint("This picture was already in the file and cannot be duplicated");
    return;
  }
  await addCopy(object, object.page, null, 1, pictures.get(pictureKey(object.id)));
}

/** an image from the clipboard, centred at the spot */
export async function pasteImage(file: Blob, page: number, at: Point) {
  const info = useStore.getState().doc?.pages[page];
  if (!info) return;
  try {
    const data = await toEngineImage(file);
    const bitmap = await createImageBitmap(file);
    const aspect = bitmap.height / Math.max(1, bitmap.width);
    let w = Math.max(24, Math.min(bitmap.width * 0.75, info.width * 0.5));
    bitmap.close();
    if (w * aspect > info.height * 0.6) w = (info.height * 0.6) / aspect;
    const h = w * aspect;
    const x = Math.max(0, Math.min(info.width - w, at[0] - w / 2));
    const y = Math.max(0, Math.min(info.height - h, at[1] - h / 2));
    await addAndSelect({ kind: "image", page, rect: [x, y, x + w, y + h], data }, data);
  } catch {
    useStore.getState().toast("That picture could not be read.", "error");
  }
}

/** plain text from the clipboard becomes a new text box */
export async function pasteText(text: string, page: number, at: Point) {
  const store = useStore.getState();
  const info = store.doc?.pages[page];
  const value = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").slice(0, 5000);
  if (!info || !value.trim()) return;
  const style = store.toolOptions.text;
  const lines = value.split("\n");
  const widest = Math.max(...lines.map((line) => measureText(line, style, style.size).width));
  const w = Math.max(40, Math.min(widest * 1.12 + style.size, info.width - 16));
  const rows = lines.reduce((n, line) => n + Math.max(1, Math.ceil(measureText(line, style, style.size).width / (w - 4))), 0);
  const h = rows * style.size * 1.2;
  const x = Math.max(0, Math.min(info.width - w, at[0] - w / 2));
  const y = Math.max(0, Math.min(info.height - h, at[1] - h / 2));
  await addAndSelect({ kind: "text", page, rect: [x, y, x + w, y + h], text: value, style, align: "left", lineHeight: 1.2 });
}
