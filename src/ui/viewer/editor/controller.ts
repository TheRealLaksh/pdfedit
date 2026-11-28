/**
 * Opening, switching and closing the text editor from outside React, including keeping the phone
 * keyboard open while one field replaces another (iOS only opens it from inside a tap).
 */
import { flushSync } from "react-dom";
import type { Point, TextLine } from "../../../engine/types";
import { useStore } from "../../../store";
import { isCompact, isIOS } from "../device";
import { ambiguousTap, lineFrame, MAX_SCALE, meansOpenLine, nearestLine, toLocal } from "../geometry";
import { loadPageData, peekPageData, type PageDataKind } from "../pageData";
import { zoomAt } from "../viewerApi";
import { flushInk, showHint, useViewer } from "../viewerStore";

export interface ActiveEditor {
  key: string;
  /** save and close; returns the pending mutation if there was something to save */
  commit(): Promise<unknown> | null;
  cancel(): void;
  /** `u`: put the caret at this distance (points) along the line */
  focus(u?: number): void;
  /** is the point on, or right beside, what the field shows now (it may have grown past the old line)? */
  reaches(clientX: number, clientY: number): boolean;
}

export const editors: { current: ActiveEditor | null; caret: { key: string; u: number } | null } = {
  current: null,
  caret: null,
};

let keeper: HTMLTextAreaElement | null = null;

/** park the focus (and with it the keyboard) in an invisible field */
export function holdKeyboard() {
  if (!isCompact()) return;
  if (!keeper) {
    keeper = document.createElement("textarea");
    keeper.className = "pv-keeper";
    keeper.setAttribute("aria-hidden", "true");
    keeper.dataset.pvUi = "";
    keeper.tabIndex = -1;
    // the keyboard must not change its face (capitals, Enter key) for the moment it waits here
    keeper.setAttribute("autocapitalize", "off");
    keeper.setAttribute("autocorrect", "off");
    keeper.setAttribute("enterkeyhint", "done");
    keeper.spellcheck = false;
    document.body.appendChild(keeper);
  }
  keeper.value = "";
  keeper.focus({ preventScroll: true });
}

/**
 * Focus the editor field. On iOS, focusing a field that sits where the keyboard is about to appear makes
 * Safari pan the whole page, so the keyboard is opened from a field at the top of the screen first and the
 * line is brought into view (`reveal`) before the focus moves to it.
 */
export function focusField(field: HTMLTextAreaElement, ready: () => void, reveal?: () => void): () => void {
  const vv = window.visualViewport;
  const keyboardClosed = !vv || vv.height > window.innerHeight * 0.8;
  if (!isIOS() || !isCompact() || !keyboardClosed || document.activeElement === keeper) {
    reveal?.();
    field.focus({ preventScroll: true });
    ready();
    return () => {};
  }
  holdKeyboard();
  let done = false;
  const move = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    vv?.removeEventListener("resize", later);
    reveal?.();
    field.focus({ preventScroll: true });
    ready();
  };
  const later = () => setTimeout(move, 60);
  const timer = setTimeout(move, 450);
  vv?.addEventListener("resize", later);
  return () => {
    done = true;
    clearTimeout(timer);
    vv?.removeEventListener("resize", later);
  };
}

/** nothing opened after all: let the keyboard go */
function releaseKeyboard() {
  if (keeper && document.activeElement === keeper) keeper.blur();
}

export const editKey = (session: number, page: number, lineId: string) => `${session}:${page}:${lineId}`;

/* ---------- taps that arrive while the page is being rewritten ---------- */

let queued = 0;

/** drop a tap that is still waiting (the user has done something else since) */
export function cancelQueuedTap() {
  queued++;
  switched();
  releaseKeyboard();
}

function switched() {
  if (useViewer.getState().switching) useViewer.setState({ switching: false });
}

/* ---------- taps on the page ---------- */

export interface Tap {
  clientX: number;
  clientY: number;
}

let acted = { at: -1000, x: 0, y: 0 };

/**
 * A tap that opened a line or magnified the page moves what is under the finger. The second tap of a double
 * tap would then hit something else (or close what the first opened): such an echo is ignored.
 */
export function isEcho(tap: Tap): boolean {
  return performance.now() - acted.at < 450 && Math.hypot(tap.clientX - acted.x, tap.clientY - acted.y) < 40;
}

const actedOn = (tap: Tap) => (acted = { at: performance.now(), x: tap.clientX, y: tap.clientY });

/** the user closed the field on purpose (button or key): the next tap is a new one, however soon */
export function forgetTap() {
  acted.at = -1000;
}

/**
 * A finger on tiny, crowded text: magnify the spot instead of opening whichever line happened to be nearest.
 * False when the tap can be answered as it is.
 */
export function magnifyIfUnsure(page: number, at: Point, scale: number, tap: Tap): boolean {
  if (!isCompact()) return false;
  const lines = peekPageData("text", page)?.lines;
  if (!lines || !ambiguousTap(lines, at, scale)) return false;
  const line = nearestLine(lines, at, scale, true)!;
  const next = Math.min(MAX_SCALE, scale * 4, Math.max(16 / line.style.size, scale * 1.8));
  // as large as it gets: answer the tap
  if (next < scale * 1.25) return false;
  actedOn(tap);
  editors.current?.commit();
  cancelQueuedTap();
  zoomAt(next, page, at, tap.clientX, tap.clientY);
  showHint("Zoomed in. Tap the line you want to change");
  return true;
}

/** a tap on the open line or just beside it moves the caret there */
export function moveCaretTo(page: number, at: Point, scale: number, tap: Tap): boolean {
  const editing = useStore.getState().editing;
  if (!editing || editing.page !== page || !editors.current) return false;
  const lines = peekPageData("text", page)?.lines;
  const line = lines?.find((l) => l.id === editing.lineId);
  if (!line) return false;
  if (!meansOpenLine(lines!, line, at, scale)) {
    // right on another line: that one is meant, however far the typed text now reaches
    const under = nearestLine(lines!, at, scale, false);
    if ((under && under.id !== line.id) || !editors.current.reaches(tap.clientX, tap.clientY)) return false;
  }
  editors.current.focus(toLocal(lineFrame(line), at)[0]);
  return true;
}

/** a tap that is about to open the line under it */
export function openAt(page: number, line: TextLine, at: Point, scale: number, tap: Tap) {
  actedOn(tap);
  editLineAt(page, line, at, scale);
}

/** can a tap be answered from what is loaded? Not while a change is being saved, or before its data is in */
export const isReady = (page: number, ...kinds: PageDataKind[]) =>
  !useStore.getState().busy && kinds.every((kind) => !!peekPageData(kind, page));

function saved(): Promise<void> {
  if (!useStore.getState().busy) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useStore.subscribe((state) => {
      if (state.busy) return;
      stop();
      resolve();
    });
  });
}

/**
 * Answer a tap once the page has settled: line and object ids change with every save, so acting on what is
 * still on screen would be lost. Only the latest tap counts. `keyboard`: the answer is likely to open a
 * field, so (called from the tap itself) the phone keyboard is claimed now.
 */
export function whenReady(page: number, kinds: PageDataKind[], answer: () => void, keyboard: boolean) {
  const mine = ++queued;
  const { session, tool } = useStore.getState();
  const wanted = () => {
    const s = useStore.getState();
    return mine === queued && s.session === session && s.tool === tool && !s.editing;
  };
  const revision = () => useStore.getState().doc?.pages[page]?.revision;
  if (keyboard) {
    holdKeyboard();
    if (isCompact()) useViewer.setState({ switching: true });
  }
  void (async () => {
    for (;;) {
      await saved();
      if (!wanted()) return;
      const before = revision();
      await Promise.all(kinds.map((kind) => loadPageData(kind, page)));
      if (!useStore.getState().busy && revision() === before) break;
    }
    if (!wanted()) return;
    answer();
    if (!useStore.getState().editing) releaseKeyboard();
  })()
    .catch(releaseKeyboard)
    // a newer tap that is still waiting keeps the bar
    .finally(() => mine === queued && switched());
}

function open(page: number, lineId: string, u: number | null) {
  queued++;
  switched();
  showHint(null);
  const session = useStore.getState().session;
  editors.caret = u === null ? null : { key: editKey(session, page, lineId), u };
  // synchronous so that focus() still counts as part of the tap
  flushSync(() => useStore.getState().startEditing(page, lineId));
  editors.current?.focus();
}

/** edit an existing line; `at` is where it was tapped (page points) */
export function editLineAt(page: number, line: TextLine, at: Point | null, scale = 1) {
  void flushInk();
  const editing = useStore.getState().editing;
  if (editing && editing.page === page && editing.lineId === line.id) {
    editors.current?.focus(at ? toLocal(lineFrame(line), at)[0] : undefined);
    return;
  }
  const pending = editors.current?.commit() ?? null;
  // line ids change with the page: wait for the save, then find the tapped line again
  if (pending || useStore.getState().busy) {
    // the finger meant this very line: after the save it is found again at the same spot
    editLineWhenReady(page, at ?? line.origin, scale, true);
    return;
  }
  if (!line.editable) {
    releaseKeyboard();
    useStore.getState().toast(line.note || "This text cannot be edited.", "warning");
    return;
  }
  open(page, line.id, at ? toLocal(lineFrame(line), at)[0] : null);
}

/** edit whatever line is at `at` once the current text of the page is in */
export function editLineWhenReady(page: number, at: Point, scale: number, touch: boolean, keyboard = true) {
  const answer = () => {
    const line = nearestLine(peekPageData("text", page)?.lines ?? [], at, scale, touch);
    if (line) editLineAt(page, line, at);
  };
  whenReady(page, ["text"], answer, keyboard);
}

/** start writing a new text box with its first baseline near `at` */
export function addTextAt(page: number, at: Point, tap?: Tap) {
  if (tap) actedOn(tap);
  const { doc, toolOptions } = useStore.getState();
  const info = doc?.pages[page];
  if (!info) return;
  editors.current?.commit();
  const size = toolOptions.text.size;
  const margin = 8;
  const x = Math.max(margin, Math.min(at[0], info.width - 80));
  const y = Math.max(0, Math.min(at[1] - size * 0.7, info.height - size * 1.4));
  const width = Math.max(60, Math.min(220, info.width - margin - x));
  const key = `new:${Date.now().toString(36)}`;
  useViewer.setState({ draft: { key, page, rect: [x, y, x + width, y + size * 1.2] } });
  open(page, key, null);
}

/** edit the text of an object that was added earlier */
export function editTextObject(page: number, id: string) {
  editors.current?.commit();
  open(page, `object:${id}`, null);
}
