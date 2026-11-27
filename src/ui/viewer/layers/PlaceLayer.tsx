/** Tap tools: add a text box, or drop a waiting image / signature on the page. */
import { useState, type MouseEvent } from "react";
import type { NewPageObject, Point, Rect } from "../../../engine/types";
import { useStore, type Placement } from "../../../store";
import { addTextAt, editors, editTextObject } from "../editor/controller";
import { hitObject, rgbToHex, smoothPath } from "../geometry";
import { peekPageData, usePageData } from "../pageData";
import { addGhost, removeGhost, type NewGhost } from "../viewerStore";
import { pagePoint } from "./pointer";

export function AddTextLayer({ page, width, height, scale }: { page: number; width: number; height: number; scale: number }) {
  // loaded so that a tap on text added earlier edits it instead of stacking a new box
  usePageData("objects", page, true);
  return (
    <div
      className="pv-layer pv-text-tool"
      data-testid="add-text-layer"
      onMouseDown={(e) => useStore.getState().editing && e.preventDefault()}
      onClick={(e) => {
        const at = pagePoint(e, e.currentTarget, width, height);
        const existing = [...(peekPageData("objects", page) ?? [])]
          .reverse()
          .find((o) => o.kind === "text" && hitObject(o, at, 8 / scale));
        if (existing) return editTextObject(page, existing.id);
        // tapping away from a box with text in it only saves it
        if (editors.current?.commit()) return;
        addTextAt(page, at);
      }}
    />
  );
}

/** the box a placement gets when dropped with its centre at `at` */
export function placementRect(
  placement: NonNullable<Placement>,
  at: Point,
  pageWidth: number,
  pageHeight: number,
  signature: boolean,
): Rect {
  const aspect = placement.height / Math.max(1, placement.width);
  const limit = signature || placement.kind === "ink" ? Math.min(170, pageWidth * 0.35) : pageWidth * 0.5;
  let w = Math.max(24, Math.min(placement.width, limit));
  let h = w * aspect;
  if (h > pageHeight * 0.6) {
    h = pageHeight * 0.6;
    w = h / Math.max(0.001, aspect);
  }
  const x = Math.max(0, Math.min(pageWidth - w, at[0] - w / 2));
  const y = Math.max(0, Math.min(pageHeight - h, at[1] - h / 2));
  return [x, y, x + w, y + h];
}

function imageUrl(data: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>]));
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return url;
}

function drop(placement: NonNullable<Placement>, page: number, rect: Rect) {
  const store = useStore.getState();
  let object: NewPageObject;
  let ghost: NewGhost;
  if (placement.kind === "image") {
    object = { kind: "image", page, rect, data: placement.data };
    ghost = { kind: "image", page, rect, url: imageUrl(placement.data) };
  } else {
    const k = (rect[2] - rect[0]) / Math.max(1, placement.width);
    const paths = placement.paths.map((path) => path.map(([x, y]): Point => [rect[0] + x * k, rect[1] + y * k]));
    const strokeWidth = Math.max(0.4, placement.strokeWidth * k);
    object = { kind: "ink", page, rect, paths, stroke: placement.color, strokeWidth };
    ghost = { kind: "ink", page, paths, stroke: placement.color, width: strokeWidth };
  }
  const id = addGhost(ghost);
  store.setPlacement(null);
  // the new object stays selected so it can be adjusted at once
  store.setTool("select");
  void useStore.getState().addObject(object).then((result) => {
    if (!result) return removeGhost(id);
    const now = useStore.getState();
    if (result.createdId && now.tool === "select") now.select({ type: "object", page, id: result.createdId });
  });
}

export function PlaceLayer({ page, width, height, scale }: { page: number; width: number; height: number; scale: number }) {
  const placement = useStore((s) => s.placement);
  const signature = useStore((s) => s.tool === "signature");
  const [hover, setHover] = useState<Point | null>(null);
  const [preview, setPreview] = useState<{ data: Uint8Array; url: string }>();
  if (!placement) return null;
  if (placement.kind === "image" && preview?.data !== placement.data)
    setPreview({ data: placement.data, url: imageUrl(placement.data) });
  const at = (e: MouseEvent<HTMLDivElement>) => pagePoint(e, e.currentTarget, width, height);
  const rect = hover && placementRect(placement, hover, width, height, signature);

  return (
    <div
      className="pv-layer pv-place-layer"
      data-testid="place-layer"
      onPointerMove={(e) => e.pointerType === "mouse" && setHover(at(e))}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => drop(placement, page, placementRect(placement, at(e), width, height, signature))}
    >
      {rect && (
        <div
          className="pv-place-ghost"
          style={{
            left: rect[0] * scale,
            top: rect[1] * scale,
            width: (rect[2] - rect[0]) * scale,
            height: (rect[3] - rect[1]) * scale,
          }}
        >
          {placement.kind === "image" ? (
            preview && <img alt="" src={preview.url} />
          ) : (
            <svg viewBox={`0 0 ${placement.width} ${placement.height}`} preserveAspectRatio="none">
              {placement.paths.map((p, i) => (
                <path
                  key={i}
                  d={smoothPath(p)}
                  fill="none"
                  stroke={rgbToHex(placement.color)}
                  strokeWidth={placement.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
          )}
        </div>
      )}
    </div>
  );
}
