/** The edit-text tool: every line of the page is a tap target. */
import { useRef, useState, type MouseEvent } from "react";
import { useStore } from "../../../store";
import {
  cancelQueuedTap, editLineAt, editLineWhenReady, editors, isEcho, isReady, magnifyIfUnsure, moveCaretTo, openAt,
} from "../editor/controller";
import { nearestLine, quadPoints } from "../geometry";
import { peekPageData, usePageData } from "../pageData";
import { pagePoint } from "./pointer";

export function EditTextLayer({ page, width, height, scale }: { page: number; width: number; height: number; scale: number }) {
  const { data, last } = usePageData("text", page, true);
  const editingId = useStore((s) => (s.editing?.page === page ? s.editing.lineId : null));
  const [hover, setHover] = useState<string | null>(null);
  const touch = useRef(false);

  const lineAt = (e: MouseEvent<HTMLDivElement>) =>
    data ? nearestLine(data.lines, pagePoint(e, e.currentTarget, width, height), scale, touch.current) : null;

  /** a tap (or a long press, which people try on stubborn text) on the page */
  const activate = (e: MouseEvent<HTMLDivElement>) => {
    if (isEcho(e)) return;
    const at = pagePoint(e, e.currentTarget, width, height);
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
    if (editors.current) editors.current.commit();
    else if (!text.lines.length && text.kind === "empty")
      useStore.getState().toast("There is no text on this page. Use Add text to write on it.");
  };

  return (
    <div
      className="pv-layer pv-edit-layer"
      data-testid="edit-layer"
      style={{ cursor: hover ? "text" : "default" }}
      onPointerDown={(e) => (touch.current = e.pointerType !== "mouse")}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        touch.current = false;
        setHover(lineAt(e)?.id ?? null);
      }}
      onPointerLeave={() => setHover(null)}
      // keep the focus in the open editor: the click decides what happens next
      onMouseDown={(e) => useStore.getState().editing && e.preventDefault()}
      onClick={activate}
      onContextMenu={(e) => {
        if (!touch.current) return;
        e.preventDefault();
        activate(e);
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
      {/* keyboard and screen reader access to the same targets */}
      <ul className="pv-sr">
        {data?.lines.map((line) => (
          <li key={line.id}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                editLineAt(page, line, null);
              }}
            >
              Edit: {line.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
