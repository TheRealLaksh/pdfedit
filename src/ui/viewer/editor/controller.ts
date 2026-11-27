/**
 * Opening, switching and closing the text editor from outside React, including keeping the phone
 * keyboard open while one field replaces another (iOS only opens it from inside a tap).
 */
import { flushSync } from "react-dom";
import type { Point, TextLine } from "../../../engine/types";
import { useStore } from "../../../store";
import { isCompact, isIOS } from "../device";
import { lineFrame, nearestLine, toLocal } from "../geometry";
import { loadPageData } from "../pageData";
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

export const editKey = (session: number, page: number, lineId: string) => `${session}:${page}:${lineId}`;

function open(page: number, lineId: string, u: number | null) {
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
  if (!line.editable) {
    editors.current?.commit();
    useStore.getState().toast(line.note || "This text cannot be edited.", "warning");
    return;
  }
  const pending = editors.current?.commit() ?? null;
  if (!pending) {
    open(page, line.id, at ? toLocal(lineFrame(line), at)[0] : null);
    return;
  }
  // line ids change with the page: wait for the edit, then find the tapped line again
  holdKeyboard();
  const session = useStore.getState().session;
  const point = at ?? line.origin;
  void pending.then(async (result) => {
    if (!result || useStore.getState().session !== session || useStore.getState().editing) return;
    const text = await loadPageData("text", page).catch(() => null);
    const again = text && nearestLine(text.lines, point, 1, true);
    if (again?.editable) open(page, again.id, toLocal(lineFrame(again), point)[0]);
    else (document.activeElement as HTMLElement | null)?.blur();
  });
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
