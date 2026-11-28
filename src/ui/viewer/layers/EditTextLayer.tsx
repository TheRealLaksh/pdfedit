/** The edit-text tool: every line of the page is a tap target. */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { Point, TextLine } from "../../../engine/types";
import { useStore } from "../../../store";
import { focusViewer } from "../actions";
import { isIOS } from "../device";
import {
  cancelQueuedTap, editLineAt, editLineWhenReady, editors, isEcho, isReady, magnifyIfUnsure, moveCaretTo, openAt,
} from "../editor/controller";
import { boundsOf, nearestLine, quadPoints } from "../geometry";
import { peekPageData, usePageData } from "../pageData";
import { useViewer } from "../viewerStore";
import { closeField } from "./FormLayer";
import { pagePoint } from "./pointer";

interface Press {
  timer?: ReturnType<typeof setTimeout>;
  x: number;
  y: number;
  fired: boolean;
}

export function EditTextLayer({ page, width, height, scale }: { page: number; width: number; height: number; scale: number }) {
  const { data, last } = usePageData("text", page, true);
  const editingId = useStore((s) => (s.editing?.page === page ? s.editing.lineId : null));
  const busy = useStore((s) => s.busy !== null);
  const refocus = useViewer((s) => (s.refocus?.page === page ? s.refocus : null));
  const [hover, setHover] = useState<string | null>(null);
  const touch = useRef(false);
  const keys = useRef<HTMLUListElement>(null);

  const lineAt = (e: MouseEvent<HTMLDivElement>) =>
    data ? nearestLine(data.lines, pagePoint(e, e.currentTarget, width, height), scale, touch.current) : null;

  // after an edit made from the keyboard: back to the same line, found where it sits
  useEffect(() => {
    if (!refocus || !data || busy || editingId) return;
    const line = nearestLine(data.lines, refocus.at, 0.2, true);
    useViewer.setState({ refocus: null });
    const button = line ? keys.current?.querySelectorAll("button")[data.lines.indexOf(line)] : undefined;
    if (button) button.focus({ preventScroll: true });
    else focusViewer();
  }, [refocus, data, busy, editingId]);

  /** a menu for the spot: of the line there, or of the empty paper */
  const openMenu = (x: number, y: number, at: Point, line: TextLine | null, from?: HTMLElement) => {
    editors.current?.commit();
    closeField();
    cancelQueuedTap();
    useViewer.setState({
      locked: null,
      menu: { x, y, page, at, from, target: line ? { kind: "line", line } : { kind: "page" } },
    });
  };

  /** a tap (or a long press, which people try on stubborn text) on the page */
  const activate = (e: MouseEvent<HTMLDivElement>) => {
    if (isEcho(e)) return;
    const at = pagePoint(e, e.currentTarget, width, height);
    closeField();
    useViewer.setState({ locked: null });
    // the boxes on screen may be from before the last save: answer when the new text is in
    if (!isReady(page, "text")) {
      editors.current?.commit();
      // open the keyboard only if there seems to be text under the finger
      const likely = !last || !!nearestLine(last.lines, at, scale, touch.current);
      editLineWhenReady(page, at, scale, touch.current, likely);
      return;
    }
    if (touch.current && (moveCaretTo(page, at, scale, e) || magnifyIfUnsure(page, at, scale, e))) return;
    const text = peekPageData("text", page)!;
    const line = nearestLine(text.lines, at, scale, touch.current);
    if (line) {
      openAt(page, line, at, scale, e);
      return;
    }
    cancelQueuedTap();
    if (editors.current) return void editors.current.commit();
    // a tap on a picture of text brings back the offer to read it
    const prompt = `${useStore.getState().session}:${page}`;
    if (useViewer.getState().dismissed.includes(prompt))
      useViewer.setState((s) => ({ dismissed: s.dismissed.filter((key) => key !== prompt) }));
    if (!text.lines.length && text.kind === "empty")
      useStore.getState().toast("There is no text on this page. Use Add text to write on it.");
  };

  /* iOS has no long press event: empty paper gets its menu from a timer */
  const press = useRef<Press | null>(null);
  const release = () => clearTimeout(press.current?.timer);
  useEffect(() => release, []);

  return (
    <div
      className="pv-layer pv-edit-layer"
      data-testid="edit-layer"
      style={{ cursor: hover ? "text" : "default" }}
      onPointerDown={(e) => {
        touch.current = e.pointerType !== "mouse";
        release();
        press.current = null;
        if (!touch.current || !e.isPrimary || !isIOS() || !data) return;
        const at = pagePoint(e, e.currentTarget, width, height);
        if (nearestLine(data.lines, at, scale, true)) return;
        const { clientX: x, clientY: y } = e;
        const state: Press = { x, y, fired: false };
        state.timer = setTimeout(() => {
          state.fired = true;
          openMenu(x, y, at, null);
        }, 550);
        press.current = state;
      }}
      onPointerMove={(e) => {
        if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) release();
        if (e.pointerType !== "mouse") return;
        touch.current = false;
        setHover(lineAt(e)?.id ?? null);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={() => setHover(null)}
      // keep the focus in the open editor: the click decides what happens next
      onMouseDown={(e) => useStore.getState().editing && e.preventDefault()}
      onClick={(e) => {
        const fired = press.current?.fired;
        press.current = null;
        if (!fired) activate(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (press.current?.fired) return;
        release();
        const at = pagePoint(e, e.currentTarget, width, height);
        const line = data ? nearestLine(data.lines, at, scale, touch.current) : null;
        // a finger pressing text means to edit it; pressing empty paper asks what can be put there
        if (touch.current && (line || !data)) return activate(e);
        openMenu(e.clientX, e.clientY, at, line);
      }}
    >
      <svg className="pv-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {(data ?? last)?.lines.map((line) => (
          <polygon
            key={line.id}
            data-line-id={line.id}
            className={`pv-linebox${line.id === hover ? " pv-linebox-hover" : ""}${line.editable ? "" : " pv-linebox-locked"}`}
            // the open line is drawn by the editor
            visibility={line.id === editingId ? "hidden" : undefined}
            points={quadPoints(line.quad).join(" ")}
          />
        ))}
      </svg>
      {/* keyboard and screen reader access to the same targets, each lying over its line */}
      <ul className="pv-sr" ref={keys}>
        {data?.lines.map((line) => {
          const [x0, y0, x1, y1] = boundsOf(quadPoints(line.quad));
          return (
            <li
              key={line.id}
              style={{
                left: `${(x0 / width) * 100}%`,
                top: `${(y0 / height) * 100}%`,
                width: `${((x1 - x0) / width) * 100}%`,
                height: `${((y1 - y0) / height) * 100}%`,
              }}
            >
              <button
                type="button"
                aria-label={line.editable ? undefined : `Edit: ${line.text} (cannot be edited directly)`}
                aria-keyshortcuts="Shift+F10"
                onFocus={() => setHover(line.id)}
                onBlur={() => setHover(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  editors.keyboard = true;
                  editLineAt(page, line, null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu(r.left, r.bottom + 4, [(x0 + x1) / 2, (y0 + y1) / 2], line, e.currentTarget);
                }}
              >
                Edit: {line.text}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
