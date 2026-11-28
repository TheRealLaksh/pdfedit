/** Selecting, moving, resizing and rotating added objects and existing images. */
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useContext, useEffect, useRef, useState, type PointerEvent } from "react";
import { engine } from "../../../engine/client";
import type { ImageItem, PageObject, Point, Rect } from "../../../engine/types";
import { useStore, type Selection } from "../../../store";
import { ViewerContext } from "../context";
import { useCompact } from "../device";
import { editTextObject, isReady, whenReady } from "../editor/controller";
import { hitObject, insideRect, rectCentre, rectH, rectW, resizeRect, withRect, type Handle } from "../geometry";
import { snapshot } from "../canvasRegistry";
import { peekPageData, usePageData } from "../pageData";
import { pagePoint } from "./pointer";

type Item = { type: "object"; object: PageObject } | { type: "image"; image: ImageItem };

interface Geometry {
  rect: Rect;
  rotation: number;
  from?: Point;
  to?: Point;
}

function geometryOf(item: Item): Geometry {
  if (item.type === "image") return { rect: item.image.rect, rotation: 0 };
  const o = item.object;
  const base = { rect: o.rect, rotation: o.rotation ?? 0 };
  return o.kind === "line" || o.kind === "arrow" ? { ...base, from: o.from, to: o.to } : base;
}

function translate(g: Geometry, dx: number, dy: number): Geometry {
  const move = (p: Point): Point => [p[0] + dx, p[1] + dy];
  return {
    ...g,
    rect: [g.rect[0] + dx, g.rect[1] + dy, g.rect[2] + dx, g.rect[3] + dy],
    from: g.from && move(g.from),
    to: g.to && move(g.to),
  };
}

/** where the selected image is being moved to */
let moving: { page: number; rect: Rect } | null = null;

const distance = (a: Rect, b: Rect) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0);

/**
 * Existing images are numbered in drawing order, so an id can mean another image after any change to the
 * page: follow the selected one by where it sits.
 */
function useFollowImage(page: number, images: ImageItem[] | undefined, revision: number) {
  const selection = useStore((s) => (s.selection?.page === page && s.selection.type === "image" ? s.selection : null));
  const seen = useRef<{ id: string; rect: Rect; revision: number } | null>(null);
  useEffect(() => {
    if (!selection) {
      seen.current = null;
      return;
    }
    if (!images) return;
    const before = seen.current;
    let current = images.find((i) => i.id === selection.id);
    if (before && before.id === selection.id && before.revision !== revision) {
      const target = moving?.page === page ? moving.rect : before.rect;
      moving = null;
      const best = [...images].sort((a, b) => distance(a.rect, target) - distance(b.rect, target))[0];
      if (!best || distance(best.rect, target) > 12) {
        useStore.getState().select(null);
        return;
      }
      current = best;
      if (best.id !== selection.id) useStore.getState().select({ type: "image", page, id: best.id });
    }
    seen.current = current ? { id: current.id, rect: current.rect, revision } : null;
  }, [selection, images, revision, page]);
}

function save(item: Item, g: Geometry): Promise<unknown> {
  const store = useStore.getState();
  if (item.type === "image") {
    const { page, id } = item.image;
    moving = { page, rect: g.rect };
    return store.run("Moving image", () => engine.moveImage(page, id, g.rect)).then((result) => {
      if (!result) moving = null;
      return result;
    });
  }
  const next = withRect(item.object, g.rect);
  if (g.rotation !== (item.object.rotation ?? 0)) next.rotation = g.rotation;
  if ((next.kind === "line" || next.kind === "arrow") && g.from && g.to) {
    next.from = g.from;
    next.to = g.to;
  }
  return store.updateObject(next);
}

export function SelectLayer({ page, width, height, scale, interactive }: {
  page: number;
  width: number;
  height: number;
  scale: number;
  /** the select tool is active: taps pick things */
  interactive: boolean;
}) {
  const selection = useStore((s) => (s.selection?.page === page ? s.selection : null));
  const editing = useStore((s) => !!s.editing);
  const objects = usePageData("objects", page, interactive || selection?.type === "object");
  const images = usePageData("images", page, interactive || selection?.type === "image");
  const revision = useStore((s) => s.doc?.pages[page]?.revision ?? 0);
  useFollowImage(page, images.data, revision);

  let item: Item | null = null;
  if (selection?.type === "object") {
    const object = objects.last?.find((o) => o.id === selection.id);
    if (object) item = { type: "object", object };
  } else if (selection?.type === "image") {
    const image = images.last?.find((i) => i.id === selection.id);
    if (image) item = { type: "image", image };
  }

  const pick = (at: Point): Selection => {
    const object = [...(peekPageData("objects", page) ?? [])].reverse().find((o) => hitObject(o, at, 10 / scale));
    if (object) return { type: "object", page, id: object.id };
    const image = (peekPageData("images", page) ?? [])
      .filter((i) => insideRect(i.rect, at, 4 / scale))
      .sort((a, b) => rectW(a.rect) * rectH(a.rect) - rectW(b.rect) * rectH(b.rect))[0];
    return image ? { type: "image", page, id: image.id } : null;
  };

  return (
    <div className="pv-select-layer">
      {interactive && (
        <div
          className="pv-layer"
          data-testid="select-layer"
          onClick={(e) => {
            const at = pagePoint(e, e.currentTarget, width, height);
            const answer = () => useStore.getState().select(pick(at));
            if (isReady(page, "objects", "images")) answer();
            else whenReady(page, ["objects", "images"], answer, false);
          }}
          onDoubleClick={(e) => {
            const hit = pick(pagePoint(e, e.currentTarget, width, height));
            if (hit?.type === "object" && peekPageData("objects", page)?.find((o) => o.id === hit.id)?.kind === "text")
              editTextObject(page, hit.id);
          }}
        />
      )}
      {item && selection && !editing && (
        <Frame
          key={selection.id}
          page={page}
          item={item}
          width={width}
          height={height}
          scale={scale}
          fresh={selection.type === "object" ? !!objects.data : !!images.data}
        />
      )}
    </div>
  );
}

type Grip = "move" | "rotate" | "from" | "to" | Handle;

const AT: Record<Handle, [number, number]> = {
  nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50],
};

const CURSORS = ["ns", "nesw", "ew", "nwse"];
function cursorFor(handle: Handle, rotation: number): string {
  const base = { n: 0, ne: 1, e: 2, se: 3, s: 4, sw: 5, w: 6, nw: 7 }[handle];
  return `${CURSORS[(base + Math.round(rotation / 45) + 8) % 4]}-resize`;
}

function Frame({ page, item, width, height, scale, fresh }: {
  page: number;
  item: Item;
  width: number;
  height: number;
  scale: number;
  /** item comes from the current page revision */
  fresh: boolean;
}) {
  const { scroller } = useContext(ViewerContext);
  const compact = useCompact();
  const revision = useStore((s) => s.doc?.pages[page]?.revision ?? 0);
  const [override, setOverride] = useState<{ geometry: Geometry; revision: number; picture: string | null } | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; grip: Grip; start: Point; from: Geometry; moved: boolean } | null>(null);
  const nudge = useRef<{ timer?: ReturnType<typeof setTimeout>; run?: () => void }>({});

  // once the page shows the saved change the engine's geometry takes over
  const stale = override && fresh && revision > override.revision && !drag.current && !nudge.current.run;
  const geometry = override && !stale ? override.geometry : geometryOf(item);
  const latest = useRef({ geometry, item, revision });
  latest.current = { geometry, item, revision };

  const commit = (g: Geometry) => {
    const { item, revision } = latest.current;
    setOverride((o) => ({ geometry: g, revision, picture: o?.picture ?? null }));
    void save(item, g).then((result) => {
      if (!result) setOverride(null);
    });
  };

  const cancel = () => {
    if (!drag.current) return;
    drag.current = null;
    setOverride(null);
  };

  useEffect(() => {
    const el = scroller.current;
    el?.addEventListener("pv-pinch", cancel);
    return () => el?.removeEventListener("pv-pinch", cancel);
  }, [scroller]);

  // arrow keys nudge; several presses become one change
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 1;
      const delta: Record<string, Point> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const d = delta[e.key];
      if (!d || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as Element).closest?.("input, textarea, select, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      const next = translate(latest.current.geometry, d[0], d[1]);
      latest.current.geometry = next;
      setOverride({ geometry: next, revision: latest.current.revision, picture: null });
      clearTimeout(nudge.current.timer);
      nudge.current.run = () => {
        clearTimeout(nudge.current.timer);
        nudge.current.run = undefined;
        commit(latest.current.geometry);
      };
      nudge.current.timer = setTimeout(() => nudge.current.run?.(), 400);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      nudge.current.run?.();
    };
  }, []);

  const down = (grip: Grip) => (e: PointerEvent<HTMLElement>) => {
    if (!e.isPrimary || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = pagePoint(e, layer.current!, width, height);
    drag.current = { id: e.pointerId, grip, start, from: latest.current.geometry, moved: false };
  };

  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = pagePoint(e, layer.current!, width, height);
    const dx = p[0] - d.start[0];
    const dy = p[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) * scale < (e.pointerType === "mouse" ? 3 : 8)) return;
    d.moved = true;
    const { item } = latest.current;
    let next: Geometry;
    if (d.grip === "move") {
      next = translate(d.from, dx, dy);
    } else if (d.grip === "rotate") {
      const c = rectCentre(d.from.rect);
      let deg = (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI + 90;
      const snap = Math.round(deg / 45) * 45;
      if (Math.abs(deg - snap) < 5) deg = snap;
      next = { ...d.from, rotation: Math.round((deg + 360) % 360) };
    } else if (d.grip === "from" || d.grip === "to") {
      const ends = { from: d.from.from!, to: d.from.to!, [d.grip]: p };
      next = {
        ...d.from,
        ...ends,
        rect: [
          Math.min(ends.from[0], ends.to[0]), Math.min(ends.from[1], ends.to[1]),
          Math.max(ends.from[0], ends.to[0]), Math.max(ends.from[1], ends.to[1]),
        ],
      };
    } else {
      const picture = item.type === "image" || item.object.kind === "image" || item.object.kind === "ink";
      next = { ...d.from, rect: resizeRect(d.from.rect, d.from.rotation, d.grip, p, picture && !e.shiftKey, 6 / scale) };
    }
    latest.current.geometry = next;
    setOverride((o) => ({
      geometry: next,
      revision: latest.current.revision,
      picture:
        o?.picture ??
        (!d.from.rotation && d.grip !== "rotate" ? snapshot(page, width, d.from.rect) : null),
    }));
  };

  const up = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) commit(latest.current.geometry);
    else if (d.grip === "move" && item.type === "object" && item.object.kind === "text")
      editTextObject(page, item.object.id);
  };

  const events = { onPointerMove: move, onPointerUp: up, onPointerCancel: cancel };
  const kind = item.type === "image" ? "existing-image" : item.object.kind;
  const linear = kind === "line" || kind === "arrow";
  const [x0, y0, x1, y1] = geometry.rect;
  const w = (x1 - x0) * scale;
  const h = (y1 - y0) * scale;
  const roomy = w > 96 && h > 96;
  // fingers need room: small items get two handles, pushed outwards so the content stays visible
  const small = compact && (w < 90 || h < 60);
  const handles: Handle[] =
    kind === "text"
      ? small
        ? ["w", "e"]
        : ["w", "e", "nw", "ne", "sw", "se"]
      : small
        ? ["nw", "se"]
        : roomy
          ? ["nw", "n", "ne", "e", "se", "s", "sw", "w"]
          : ["nw", "ne", "se", "sw"];
  const out = small ? 10 : 0;
  const place = (percent: number) => `calc(${percent}% + ${Math.sign(percent - 50) * out}px)`;

  const handle = (grip: Grip, left: string, top: string, label: string, cursor: string, extra = "") => (
    <div
      key={grip}
      className={`pv-handle ${extra}`}
      style={{ left, top, cursor }}
      role="button"
      aria-label={label}
      data-handle={grip}
      onPointerDown={down(grip)}
      {...events}
    >
      <span />
    </div>
  );

  return (
    <div ref={layer} className="pv-frame-layer">
      {linear ? (
        <>
          <svg className="pv-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
            <line className="pv-line-guide" x1={geometry.from![0]} y1={geometry.from![1]} x2={geometry.to![0]} y2={geometry.to![1]} />
            <line
              className="pv-line-grab"
              data-testid="selection-frame"
              x1={geometry.from![0]}
              y1={geometry.from![1]}
              x2={geometry.to![0]}
              y2={geometry.to![1]}
              onPointerDown={down("move") as never}
              {...(events as object)}
            />
          </svg>
          {handle("from", `${geometry.from![0] * scale}px`, `${geometry.from![1] * scale}px`, "Move start point", "grab")}
          {handle("to", `${geometry.to![0] * scale}px`, `${geometry.to![1] * scale}px`, "Move end point", "grab")}
        </>
      ) : (
        <div
          className="pv-frame"
          data-testid="selection-frame"
          style={{
            left: x0 * scale,
            top: y0 * scale,
            width: w,
            height: h,
            transform: geometry.rotation ? `rotate(${geometry.rotation}deg)` : undefined,
          }}
          onPointerDown={down("move")}
          {...events}
        >
          {override?.picture && !stale && <img className="pv-frame-picture" alt="" src={override.picture} />}
          {handles.map((id) =>
            handle(id, place(AT[id][0]), place(AT[id][1]), `Resize ${id}`, cursorFor(id, geometry.rotation)),
          )}
          {item.type === "object" && (
            <div
              className="pv-handle pv-handle-rotate"
              role="button"
              aria-label="Rotate"
              data-handle="rotate"
              onPointerDown={down("rotate")}
              {...events}
            >
              <span>
                <ArrowClockwiseIcon />
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
