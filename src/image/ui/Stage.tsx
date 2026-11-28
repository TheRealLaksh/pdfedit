/** The picture with its text boxes: pan, pinch, wheel zoom, choosing, drawing and adjusting boxes. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MagnifyingGlassMinus, MagnifyingGlassPlus, ArrowsOut } from "@phosphor-icons/react";
import { bounds, centre, isUsableQuad, quadDistance, quadSize, rectQuad } from "../geometry";
import { S } from "../strings";
import type { Patch, Pt, Quad4, RenderResult, Rgb, TextBox } from "../types";
import { drawPatch, type Opened } from "./picture";

export type Mode = "select" | "draw" | "pick";

interface View {
  scale: number;
  x: number;
  y: number;
}

export interface StageProps {
  opened: Opened;
  boxes: TextBox[];
  edited: Record<string, unknown>;
  renders: Record<string, RenderResult>;
  patches: Patch[];
  selected: string | null;
  mode: Mode;
  compare: boolean;
  /** the quad to outline for the selected box (tightened once analysed) */
  selectedQuad: Quad4 | null;
  onSelect(id: string | null): void;
  onDraw(quad: Quad4): void;
  onPick(color: Rgb): void;
  onCorners(id: string, quad: Quad4): void;
}

const clampScale = (s: number) => Math.min(24, Math.max(0.04, s));

export function Stage(props: StageProps) {
  const { opened, boxes, selected, mode, compare } = props;
  const { width, height } = opened.picture;
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drawing, setDrawing] = useState<[Pt, Pt] | null>(null);
  const [dragging, setDragging] = useState<{ corner: number; quad: Quad4 } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const touched = useRef(false);

  const fitScale = useCallback(() => (size.w ? Math.min((size.w - 16) / width, (size.h - 16) / height) : 1), [size, width, height]);
  const fit = useCallback(() => {
    const scale = clampScale(fitScale());
    touched.current = false;
    setView({ scale, x: (size.w - width * scale) / 2, y: (size.h - height * scale) / 2 });
  }, [fitScale, size, width, height]);

  useLayoutEffect(() => {
    const node = frame.current!;
    const observer = new ResizeObserver(() => setSize({ w: node.clientWidth, h: node.clientHeight }));
    observer.observe(node);
    setSize({ w: node.clientWidth, h: node.clientHeight });
    return () => observer.disconnect();
  }, []);

  // the chosen box stays in sight, also when the keyboard takes half the screen
  const quadRef = useRef(props.selectedQuad);
  quadRef.current = props.selectedQuad;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!size.w) return;
    const quad = quadRef.current;
    if (!selected || !quad) {
      shown.current = null;
      if (!touched.current) fit();
      return;
    }
    const [x0, y0, x1, y1] = bounds(quad);
    const current = viewRef.current;
    const fresh = shown.current !== selected;
    shown.current = selected;
    let scale = current.scale;
    if (fresh) {
      // large enough to judge the lettering, small enough to see the whole line
      const comfortable = Math.max(scale, 30 / Math.max(1, y1 - y0));
      scale = clampScale(Math.max(Math.min(fitScale(), scale), Math.min(comfortable, (size.w - 56) / (x1 - x0), (size.h * 0.6) / (y1 - y0))));
    }
    const inView = x0 * scale + current.x > 12 && x1 * scale + current.x < size.w - 12 && y0 * scale + current.y > 12 && y1 * scale + current.y < size.h - 12;
    if (inView && scale === current.scale) return;
    setView({ scale, x: size.w / 2 - ((x0 + x1) / 2) * scale, y: size.h / 2 - ((y0 + y1) / 2) * scale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, size.w, size.h]);

  // the picture and the changes on top of it
  const painted = useRef<Patch[]>([]);
  const first = useRef<ImageBitmap | null>(null);
  useEffect(() => {
    const node = canvas.current!;
    const context = node.getContext("2d", { willReadFrequently: true })!;
    if (first.current !== opened.bitmap) {
      node.width = width;
      node.height = height;
      context.drawImage(opened.bitmap, 0, 0);
      first.current = opened.bitmap;
    } else {
      // only the places painted before need the original back
      for (const p of painted.current) {
        context.clearRect(p.x, p.y, p.width, p.height);
        context.drawImage(opened.bitmap, p.x, p.y, p.width, p.height, p.x, p.y, p.width, p.height);
      }
    }
    painted.current = compare ? [] : props.patches;
    for (const p of painted.current) drawPatch(context, p);
  }, [opened, props.patches, compare, width, height]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    touched.current = true;
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      return { scale, x: cx - ((cx - v.x) / v.scale) * scale, y: cy - ((cy - v.y) / v.scale) * scale };
    });
  }, []);

  useEffect(() => {
    const node = frame.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0024), e.clientX - r.left, e.clientY - r.top);
      else {
        touched.current = true;
        setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
      }
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  /* ---------- pointers ---------- */
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ start: Pt; moved: boolean; view: View; pinch?: { distance: number; middle: Pt } } | null>(null);
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = frame.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toPicture = ([x, y]: Pt, v = viewRef.current): Pt => [(x - v.x) / v.scale, (y - v.y) / v.scale];
  const inside = ([x, y]: Pt): Pt => [Math.min(width, Math.max(0, x)), Math.min(height, Math.max(0, y))];

  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse" && e.button !== 1) return;
    if ((e.target as Element).closest("button")) return;
    frame.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    const points = [...pointers.current.values()];
    if (points.length === 1) gesture.current = { start: points[0]!, moved: false, view: viewRef.current };
    else if (points.length === 2) {
      const [a, b] = points as [Pt, Pt];
      gesture.current = { start: a, moved: true, view: viewRef.current, pinch: { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), middle: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] } };
      setDrawing(null);
    }
  };

  const move = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    const at = local(e);
    pointers.current.set(e.pointerId, at);
    const g = gesture.current;
    const points = [...pointers.current.values()];
    if (g.pinch && points.length >= 2) {
      const [a, b] = points as [Pt, Pt];
      const middle: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const scale = clampScale((g.view.scale * Math.hypot(a[0] - b[0], a[1] - b[1])) / Math.max(1, g.pinch.distance));
      const anchor = toPicture(g.pinch.middle, g.view);
      touched.current = true;
      setView({ scale, x: middle[0] - anchor[0] * scale, y: middle[1] - anchor[1] * scale });
      return;
    }
    if (points.length !== 1) return;
    if (!g.moved && Math.hypot(at[0] - g.start[0], at[1] - g.start[1]) < (e.pointerType === "mouse" ? 4 : 9)) return;
    g.moved = true;
    if (mode === "draw" && !g.pinch) setDrawing([inside(toPicture(g.start)), inside(toPicture(at))]);
    else if (!g.pinch) {
      touched.current = true;
      setView({ ...g.view, x: g.view.x + at[0] - g.start[0], y: g.view.y + at[1] - g.start[1] });
    }
  };

  const up = (e: ReactPointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size) {
      // one finger left after a pinch: carry on as a pan from here
      const rest = [...pointers.current.values()][0]!;
      gesture.current = { start: rest, moved: true, view: viewRef.current };
      return;
    }
    gesture.current = null;
    if (!g || e.type === "pointercancel") return setDrawing(null);
    if (mode === "draw" && drawing) {
      const [a, b] = drawing;
      const quad = rectQuad(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
      setDrawing(null);
      if (isUsableQuad(quad) && (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 > 64) props.onDraw(quad);
      return;
    }
    if (g.moved) return;
    const p = toPicture(local(e));
    if (mode === "pick") {
      const context = canvas.current!.getContext("2d")!;
      const x = Math.min(width - 3, Math.max(0, Math.round(p[0]) - 1));
      const y = Math.min(height - 3, Math.max(0, Math.round(p[1]) - 1));
      const data = context.getImageData(x, y, 3, 3).data;
      props.onPick([0, 1, 2].map((c) => Math.round([0, 1, 2, 3, 4, 5, 6, 7, 8].reduce((s, i) => s + data[i * 4 + c]!, 0) / 9)) as Rgb);
      return;
    }
    if (mode === "draw") return;
    // the nearest box within a fingertip
    const reach = (e.pointerType === "mouse" ? 6 : 22) / viewRef.current.scale;
    let best: TextBox | null = null;
    let value = reach;
    let smallest = Infinity;
    for (const box of boxes) {
      const quad = props.renders[box.id]?.quad ?? box.quad;
      const d = Math.min(quadDistance(quad, p), quadDistance(box.quad, p));
      const s = quadSize(quad);
      const area = s.width * s.height;
      if (d < value || (d === value && area < smallest)) {
        best = box;
        value = d;
        smallest = area;
      }
    }
    props.onSelect(best?.id ?? null);
  };

  /* ---------- corners ---------- */
  const chosen = boxes.find((b) => b.id === selected);
  const handleQuad = dragging?.quad ?? props.selectedQuad;

  const lens = (point: Pt) => {
    const node = loupe.current;
    if (!node) return;
    const context = node.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, 120, 120);
    const reach = Math.max(12, 22 / viewRef.current.scale);
    context.drawImage(canvas.current!, point[0] - reach, point[1] - reach, reach * 2, reach * 2, 0, 0, 120, 120);
    context.strokeStyle = "#2f5bea";
    context.beginPath();
    context.moveTo(60, 44);
    context.lineTo(60, 76);
    context.moveTo(44, 60);
    context.lineTo(76, 60);
    context.stroke();
  };

  const cornerDown = (corner: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!handleQuad) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const origin = local(e);
    const from = handleQuad[corner]!;
    const quad = handleQuad;
    const node = e.currentTarget;
    let latest: Quad4 | null = null;
    const onMove = (ev: PointerEvent) => {
      const at = local(ev);
      const scale = viewRef.current.scale;
      const point = inside([from[0] + (at[0] - origin[0]) / scale, from[1] + (at[1] - origin[1]) / scale]);
      const next = quad.map((p, i) => (i === corner ? point : p)) as Quad4;
      if (!isUsableQuad(next)) return;
      latest = next;
      setDragging({ corner, quad: next });
      requestAnimationFrame(() => lens(point));
    };
    const onUp = () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
      setDragging(null);
      if (latest && chosen) props.onCorners(chosen.id, latest);
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
  };

  const cornerKey = (corner: number) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (!d || !handleQuad || !chosen) return;
    e.preventDefault();
    const next = handleQuad.map((p, i) => (i === corner ? inside([p[0] + d[0], p[1] + d[1]]) : p)) as Quad4;
    if (isUsableQuad(next)) props.onCorners(chosen.id, next);
  };

  const screen = ([x, y]: Pt): Pt => [x * view.scale + view.x, y * view.scale + view.y];
  const points = (q: Quad4) => q.map((p) => p.join(",")).join(" ");

  return (
    <div
      ref={frame}
      className="im-stage"
      data-mode={mode}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div className="im-sheet" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <canvas ref={canvas} className="im-canvas" data-pixels={view.scale > 3 ? "sharp" : undefined} aria-label="Picture" role="img" />
        <svg className="im-overlay" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={compare ? { display: "none" } : undefined}>
          {boxes.map((box) => {
            const isChosen = box.id === selected;
            const quad = isChosen && handleQuad ? handleQuad : (props.renders[box.id]?.quad ?? box.quad);
            return (
              <polygon
                key={box.id}
                className="im-box"
                data-box={box.id}
                data-chosen={isChosen || undefined}
                data-edited={props.edited[box.id] ? true : undefined}
                points={points(quad)}
                vectorEffect="non-scaling-stroke"
                tabIndex={0}
                role="button"
                aria-label={S.boxLabel(box.text)}
                aria-pressed={isChosen}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  props.onSelect(box.id);
                }}
              />
            );
          })}
          {drawing && <polygon className="im-drawing" points={points(rectQuad(drawing[0][0], drawing[0][1], drawing[1][0], drawing[1][1]))} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      {!compare && mode === "select" && chosen && handleQuad &&
        handleQuad.map((corner, i) => {
          const at = screen(corner);
          const middle = screen(centre(handleQuad));
          // pushed outwards, so that the handles of a small box do not cover it or each other
          const dx = Math.sign(at[0] - middle[0]) || 1;
          const dy = Math.sign(at[1] - middle[1]) || 1;
          return (
            <button
              key={i}
              type="button"
              className="im-handle"
              aria-label={S.corner[i]}
              style={{ left: at[0] + dx * 13, top: at[1] + dy * 13 }}
              data-corner={i}
              onPointerDown={cornerDown(i)}
              onKeyDown={cornerKey(i)}
            >
              <span aria-hidden />
            </button>
          );
        })}
      {dragging && <canvas ref={loupe} className="im-loupe" width={120} height={120} data-side={screen(dragging.quad[dragging.corner]!)[0] < size.w / 2 ? "right" : "left"} aria-hidden />}
      <div className="im-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="im-icon" aria-label={S.zoomOut} title={S.zoomOut} onClick={() => zoomAt(1 / 1.35, size.w / 2, size.h / 2)}>
          <MagnifyingGlassMinus size={20} aria-hidden />
        </button>
        <button type="button" className="im-icon" aria-label={S.fit} title={S.fit} onClick={fit}>
          <ArrowsOut size={20} aria-hidden />
        </button>
        <button type="button" className="im-icon" aria-label={S.zoomIn} title={S.zoomIn} onClick={() => zoomAt(1.35, size.w / 2, size.h / 2)}>
          <MagnifyingGlassPlus size={20} aria-hidden />
        </button>
      </div>
    </div>
  );
}
