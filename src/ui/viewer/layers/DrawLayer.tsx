/** Drag tools: highlight, shapes, line and arrow, ink, whiteout and redaction marks. */
import { useContext, useEffect, useRef, useState, type PointerEvent } from "react";
import { engine } from "../../../engine/client";
import { quadToRect } from "../../../engine/geom";
import type { NewPageObject, Point, Rect, RGB, TextLine } from "../../../engine/types";
import { useStore, type ToolId } from "../../../store";
import { ViewerContext } from "../context";
import { boundsOf, normRect, rectH, rectW, rgbToHex, simplify } from "../geometry";
import { loadPageData } from "../pageData";
import { addGhost, addInkStroke, holdInk, removeGhost, resumeInk, useViewer, type NewGhost } from "../viewerStore";
import { pagePoint } from "./pointer";
import { arrowHead, InkPaths } from "./StaticLayers";

export const DRAW_TOOLS: ToolId[] = ["highlight", "rect", "ellipse", "line", "arrow", "ink", "whiteout", "redact"];

const MARKER: RGB = [1, 0.86, 0.2];
const WHITE: RGB = [1, 1, 1];

/** a dark pen colour makes no highlighter: fall back to yellow */
export function highlightColor(c: RGB): RGB {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.3 ? c : MARKER;
}

/** the boxes a highlighter swipe covers: whole line height, only the swiped part of each line */
export function highlightRects(lines: TextLine[], from: Point, to: Point): Rect[] {
  const [x0, y0, x1, y1] = normRect(from, to);
  const out: Rect[] = [];
  for (const line of lines) {
    const r = quadToRect(line.quad);
    const slack = rectH(r) * 0.2;
    const middle = (r[1] + r[3]) / 2;
    const crosses = (y0 <= middle && y1 >= middle) || (y0 >= r[1] - slack && y1 <= r[3] + slack);
    if (!crosses) continue;
    const cut: Rect = [Math.max(r[0], x0), r[1], Math.min(r[2], x1), r[3]];
    if (rectW(cut) > 1) out.push(cut);
  }
  return out;
}

/** add a shape, showing it at once and selecting it afterwards */
function create(object: NewPageObject, ghost: NewGhost, select: boolean) {
  const id = addGhost(ghost);
  void useStore.getState().addObject(object).then((result) => {
    if (!result) return removeGhost(id);
    const now = useStore.getState();
    if (select && result.createdId && now.tool === object.kind && !now.editing)
      now.select({ type: "object", page: object.page, id: result.createdId });
  });
}

async function highlight(page: number, from: Point, to: Point, scale: number) {
  const store = useStore.getState();
  const text = await loadPageData("text", page).catch(() => null);
  let rects = text ? highlightRects(text.lines, from, to) : [];
  const drag = normRect(from, to);
  // away from any text the swipe itself is the highlight
  if (!rects.length && rectW(drag) * scale > 8 && rectH(drag) * scale > 5) rects = [drag];
  if (!rects.length) return;
  const fill = highlightColor(store.toolOptions.color);
  const ghosts = rects.map((rect) => addGhost({ kind: "rect", page, rect, fill, opacity: 0.8, multiply: true }));
  const result = await store.run("Highlighting", async () => {
    let last;
    for (const rect of rects) last = await engine.addObject({ kind: "highlight", page, rect, fill, stroke: null });
    return last!;
  });
  if (!result) ghosts.forEach(removeGhost);
}

function finish(tool: ToolId, page: number, points: Point[], scale: number) {
  const { toolOptions: options } = useStore.getState();
  const from = points[0]!;
  const to = points[points.length - 1]!;
  if (tool === "ink") {
    const path = simplify(points, 0.5 / scale);
    addInkStroke(page, path.length > 1 ? path : [from, [from[0] + 0.01, from[1]]], options.color, options.strokeWidth, options.opacity);
    return;
  }
  if (tool === "highlight") {
    void highlight(page, from, to, scale);
    return;
  }
  if (tool === "line" || tool === "arrow") {
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) * scale < 8) return;
    const stroke = options.color;
    const strokeWidth = Math.max(0.5, options.strokeWidth);
    create(
      { kind: tool, page, rect: boundsOf([from, to]), from, to, stroke, strokeWidth, opacity: options.opacity },
      { kind: "line", page, from, to, arrow: tool === "arrow", stroke, width: strokeWidth, opacity: options.opacity },
      true,
    );
    return;
  }
  const rect = normRect(from, to);
  if (rectW(rect) * scale < 5 || rectH(rect) * scale < 5) return;
  if (tool === "redact") {
    useViewer.setState((s) => ({ redactions: { ...s.redactions, [page]: [...(s.redactions[page] ?? []), rect] } }));
  } else if (tool === "whiteout") {
    create({ kind: "whiteout", page, rect, fill: WHITE, stroke: null }, { kind: "rect", page, rect, fill: WHITE }, false);
  } else if (tool === "rect" || tool === "ellipse") {
    const fill = options.fill;
    const stroke = options.strokeWidth > 0 || !fill ? options.color : null;
    const strokeWidth = stroke ? Math.max(0.5, options.strokeWidth) : 0;
    create(
      { kind: tool, page, rect, fill, stroke, strokeWidth, opacity: options.opacity },
      { kind: "rect", page, rect, ellipse: tool === "ellipse", fill, stroke, width: strokeWidth, opacity: options.opacity },
      true,
    );
  }
}

export function DrawLayer({ page, width, height, scale, tool }: {
  page: number;
  width: number;
  height: number;
  scale: number;
  tool: ToolId;
}) {
  const { scroller } = useContext(ViewerContext);
  const options = useStore((s) => s.toolOptions);
  const stroke = useRef<{ id: number; points: Point[] } | null>(null);
  const [points, setPoints] = useState<Point[] | null>(null);

  const cancel = () => {
    if (!stroke.current) return;
    stroke.current = null;
    setPoints(null);
    resumeInk();
  };

  // a second finger turns the gesture into pan and zoom
  useEffect(() => {
    const el = scroller.current;
    el?.addEventListener("pv-pinch", cancel);
    return () => el?.removeEventListener("pv-pinch", cancel);
  }, [scroller]);

  const at = (e: { clientX: number; clientY: number; shiftKey?: boolean }, element: Element): Point => {
    const p = pagePoint(e, element, width, height);
    return [Math.max(0, Math.min(width, p[0])), Math.max(0, Math.min(height, p[1]))];
  };

  /** shift: squares, circles and 45 degree lines */
  const constrain = (from: Point, to: Point): Point => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (tool === "line" || tool === "arrow") {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return [from[0] + len * Math.cos(a), from[1] + len * Math.sin(a)];
    }
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [from[0] + side * Math.sign(dx || 1), from[1] + side * Math.sign(dy || 1)];
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = stroke.current;
    if (!s || s.id !== e.pointerId) return;
    const element = e.currentTarget;
    if (tool === "ink") {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const each of events.length ? events : [e.nativeEvent]) s.points.push(at(each, element));
    } else {
      let to = at(e, element);
      if (e.shiftKey && tool !== "highlight") to = constrain(s.points[0]!, to);
      s.points = [s.points[0]!, to];
    }
    setPoints([...s.points]);
  };

  return (
    <div
      className={`pv-layer pv-draw-layer pv-draw-${tool}`}
      data-testid="draw-layer"
      onPointerDown={(e) => {
        if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return cancel();
        e.preventDefault();
        useStore.getState().select(null);
        if (tool === "ink") holdInk();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = at(e, e.currentTarget);
        stroke.current = { id: e.pointerId, points: [p] };
        setPoints([p]);
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        const s = stroke.current;
        if (!s || s.id !== e.pointerId) return;
        move(e);
        stroke.current = null;
        setPoints(null);
        finish(tool, page, s.points, scale);
      }}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {points && points.length > 1 && (
        <svg
          className="pv-svg"
          style={tool === "highlight" ? { mixBlendMode: "multiply" } : undefined}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <Draft tool={tool} points={points} options={options} />
        </svg>
      )}
    </div>
  );
}

function Draft({ tool, points, options }: {
  tool: ToolId;
  points: Point[];
  options: { color: RGB; fill: RGB | null; strokeWidth: number; opacity: number };
}) {
  if (tool === "ink")
    return <InkPaths paths={[points]} stroke={options.color} width={options.strokeWidth} opacity={options.opacity} />;
  const from = points[0]!;
  const to = points[points.length - 1]!;
  const color = rgbToHex(options.color);
  if (tool === "line" || tool === "arrow")
    return (
      <g fill="none" stroke={color} strokeWidth={Math.max(0.5, options.strokeWidth)} opacity={options.opacity} strokeLinecap="round">
        <path d={`M${from}L${to}`} />
        {tool === "arrow" && <path d={arrowHead(from, to, options.strokeWidth)} />}
      </g>
    );
  const [x0, y0, x1, y1] = normRect(from, to);
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (tool === "highlight") return <rect {...box} fill={rgbToHex(highlightColor(options.color))} opacity={0.7} />;
  if (tool === "redact") return <rect {...box} className="pv-redaction-draft" />;
  if (tool === "whiteout") return <rect {...box} className="pv-whiteout-draft" fill="#fff" />;
  const paint = {
    fill: options.fill ? rgbToHex(options.fill) : "none",
    stroke: options.strokeWidth > 0 || !options.fill ? color : "none",
    strokeWidth: Math.max(0.5, options.strokeWidth),
    opacity: options.opacity,
  };
  return tool === "ellipse" ? (
    <ellipse cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={box.width / 2} ry={box.height / 2} {...paint} />
  ) : (
    <rect {...box} {...paint} />
  );
}
