/**
 * Opening, switching and closing the text editor from outside React, including keeping the phone
 * keyboard open while one field replaces another (iOS only opens it from inside a tap).
 */
import { flushSync } from "react-dom";
import type { Point, TextLine } from "../../../engine/types";
import { useStore } from "../../../store";
import { isCompact, isIOS } from "../device";
import { lineFrame, nearestLine, toLocal } from "../geometry";
import { loadPageData, peekPageData, type PageDataKind } from "../pageData";
import { flushInk, useViewer } from "../viewerStore";

export interface ActiveEditor {
  key: string;
  /** save and close; returns the pending mutation if there was something to save */
  commit(): Promise<unknown> | null;
  cancel(): void;
  /** `u`: put the caret at this distance (points) along the line */
  focus(u?: number): void;
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
    document.body.appendChild(keeper);
  }
  keeper.value = "";
  keeper.focus({ preventScroll: true });
}

/**
 * Focus the editor field. On iOS, focusing a field that sits where the keyboard is about to appear makes
 * Safari pan the whole page, so the keyboard is opened from a field at the top of the screen first.
 */
export function focusField(field: HTMLTextAreaElement, ready: () => void): () => void {
  const vv = window.visualViewport;
  const keyboardClosed = !vv || vv.height > window.innerHeight * 0.8;
  if (!isIOS() || !isCompact() || !keyboardClosed || document.activeElement === keeper) {
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
  releaseKeyboard();
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
  if (keyboard) holdKeyboard();
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
  })().catch(releaseKeyboard);
}

function open(page: number, lineId: string, u: number | null) {
  queued++;
  const session = useStore.getState().session;
  editors.caret = u === null ? null : { key: editKey(session, page, lineId), u };
  // synchronous so that focus() still counts as part of the tap
  flushSync(() => useStore.getState().startEditing(page, lineId));
  editors.current?.focus();
}

/** edit an existing line; `at` is where it was tapped (page points) */
export function editLineAt(page: number, line: TextLine, at: Point | null) {
  void flushInk();
  const editing = useStore.getState().editing;
  if (editing && editing.page === page && editing.lineId === line.id) {
    editors.current?.focus(at ? toLocal(lineFrame(line), at)[0] : undefined);
    return;
  }
  const pending = editors.current?.commit() ?? null;
  // line ids change with the page: wait for the save, then find the tapped line again
  if (pending || useStore.getState().busy) {
    editLineWhenReady(page, at ?? line.origin, 1, true);
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
export function addTextAt(page: number, at: Point) {
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
