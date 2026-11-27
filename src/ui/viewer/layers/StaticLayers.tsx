/** Non-interactive drawings over a page: search hits, optimistic previews, buffered ink. */
import { useMemo } from "react";
import type { Point, RGB } from "../../../engine/types";
import { useStore } from "../../../store";
import { Preview } from "../editor/Preview";
import { quadPoints, rgbToHex, smoothPath } from "../geometry";
import { useViewer, type Ghost } from "../viewerStore";

export function SearchLayer({ page, width, height }: { page: number; width: number; height: number }) {
  const matches = useStore((s) => s.search.matches);
  const active = useStore((s) => s.search.matches[s.search.active]);
  const mine = useMemo(() => matches.filter((m) => m.page === page), [matches, page]);
  if (!mine.length) return null;
  return (
    <svg className="pv-svg pv-search" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {mine.map((m, i) =>
        m.quads.map((q, j) => (
          <polygon
            key={`${i}:${j}`}
            className={m === active ? "pv-hit pv-hit-active" : "pv-hit"}
            points={quadPoints(q).join(" ")}
          />
        )),
      )}
    </svg>
  );
}

export function arrowHead(from: Point, to: Point, width: number): string {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const size = Math.max(6, width * 4);
  const p = (d: number) => `${to[0] - size * Math.cos(a + d)} ${to[1] - size * Math.sin(a + d)}`;
  return `M${p(0.45)}L${to[0]} ${to[1]}L${p(-0.45)}`;
}

export function InkPaths({ paths, stroke, width, opacity }: { paths: Point[][]; stroke: RGB; width: number; opacity?: number }) {
  return (
    <g fill="none" stroke={rgbToHex(stroke)} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" opacity={opacity}>
      {paths.map((p, i) => (
        <path key={i} d={smoothPath(p)} />
      ))}
    </g>
  );
}

function Shape({ ghost }: { ghost: Extract<Ghost, { kind: "rect" | "line" | "ink" }> }) {
  if (ghost.kind === "ink") return <InkPaths {...ghost} />;
  if (ghost.kind === "line")
    return (
      <g fill="none" stroke={rgbToHex(ghost.stroke)} strokeWidth={ghost.width} opacity={ghost.opacity} strokeLinecap="round">
        <path d={`M${ghost.from}L${ghost.to}`} />
        {ghost.arrow && <path d={arrowHead(ghost.from, ghost.to, ghost.width)} />}
      </g>
    );
  const [x0, y0, x1, y1] = ghost.rect;
  const paint = {
    fill: ghost.fill ? rgbToHex(ghost.fill) : "none",
    stroke: ghost.stroke ? rgbToHex(ghost.stroke) : "none",
    strokeWidth: ghost.width ?? 0,
    opacity: ghost.opacity,
  };
  return ghost.ellipse ? (
    <ellipse cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={(x1 - x0) / 2} ry={(y1 - y0) / 2} {...paint} />
  ) : (
    <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} {...paint} />
  );
}

export function PendingLayer({ page, width, height, scale }: { page: number; width: number; height: number; scale: number }) {
  const ghosts = useViewer((s) => s.ghosts);
  const ink = useViewer((s) => (s.ink?.page === page ? s.ink : null));
  const mine = ghosts.filter((g) => g.page === page);
  const view = `0 0 ${width} ${height}`;
  return (
    <>
      {mine.map((g) => {
        if (g.kind === "text") return <Preview key={g.id} spec={g.preview} scale={scale} />;
        if (g.kind === "image")
          return (
            <img
              key={g.id}
              className="pv-ghost-image"
              alt=""
              src={g.url}
              style={{
                left: g.rect[0] * scale,
                top: g.rect[1] * scale,
                width: (g.rect[2] - g.rect[0]) * scale,
                height: (g.rect[3] - g.rect[1]) * scale,
              }}
            />
          );
        return (
          <svg
            key={g.id}
            className="pv-svg"
            style={g.kind === "rect" && g.multiply ? { mixBlendMode: "multiply" } : undefined}
            viewBox={view}
            preserveAspectRatio="none"
          >
            <Shape ghost={g} />
          </svg>
        );
      })}
      {ink && (
        <svg className="pv-svg" viewBox={view} preserveAspectRatio="none">
          <InkPaths {...ink} />
        </svg>
      )}
    </>
  );
}
