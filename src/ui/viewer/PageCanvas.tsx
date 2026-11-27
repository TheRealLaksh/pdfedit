/**
 * The picture of one page: a whole-page bitmap (capped in size) plus, at deep zoom, a sharp bitmap of
 * just the visible region on top.
 */
import { ArrowClockwiseIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Rect } from "../../engine/types";
import { useStore } from "../../store";
import { ViewerContext } from "./context";
import { registerCanvas } from "./canvasRegistry";
import { baseScale, cachedBitmap, DETAIL_PIXELS, requestRender, type Bitmap, type RenderSpec } from "./renderQueue";
import { settleGhosts } from "./viewerStore";

const deviceScale = () => Math.min(3, window.devicePixelRatio || 1);
const priorityOf = (page: number) => Math.abs(page - useStore.getState().currentPage);

function paint(canvas: HTMLCanvasElement, image: ImageBitmap) {
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
}

export function PageCanvas({ page, width, height, revision, scale, settled }: {
  page: number;
  /** page size in points */
  width: number;
  height: number;
  revision: number;
  /** CSS px per point */
  scale: number;
  settled: number;
}) {
  const session = useStore((s) => s.session);
  const { scroller } = useContext(ViewerContext);
  const base = useRef<HTMLCanvasElement>(null);
  const detail = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<{ session: number; revision: number } | null>(null);
  const sharp = useRef<{ session: number; revision: number; scale: number; region: Rect } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  const wanted = scale * deviceScale();
  const whole = baseScale(width, height, wanted);

  useLayoutEffect(() => {
    const canvas = base.current!;
    registerCanvas(page, canvas);
    const top = detail.current!;
    return () => {
      registerCanvas(page, null);
      // iOS keeps canvas memory until the size is dropped
      canvas.width = canvas.height = 0;
      top.width = top.height = 0;
      drawn.current = sharp.current = null;
    };
  }, [page]);

  useLayoutEffect(() => {
    const spec: RenderSpec = { session, page, revision, scale: whole };
    const show = (bitmap: Bitmap) => {
      paint(base.current!, bitmap.image);
      drawn.current = { session, revision: bitmap.revision };
      setStatus("ready");
      settleGhosts(page, bitmap.revision);
    };
    if (drawn.current && drawn.current.session !== session) base.current!.width = 0;
    const hit = cachedBitmap(spec);
    if (hit) {
      show(hit);
      return;
    }
    let cancel = () => {};
    // while only the zoom changes the old picture is stretched: wait for the gesture to end
    const stretching = drawn.current?.session === session && drawn.current.revision === revision;
    const start = () => {
      cancel = requestRender(spec, () => priorityOf(page), {
        done: show,
        fail: () => setStatus((s) => (s === "ready" ? s : "error")),
      });
    };
    const timer = stretching ? setTimeout(start, 180) : undefined;
    if (!stretching) start();
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [session, page, revision, whole, attempt]);

  useEffect(() => {
    const canvas = detail.current!;
    const have = sharp.current;
    if (have && (have.session !== session || have.revision !== revision)) {
      canvas.hidden = true;
      sharp.current = null;
    }
    if (wanted <= whole * 1.15) {
      canvas.hidden = true;
      canvas.width = canvas.height = 0;
      sharp.current = null;
      return;
    }
    let cancel = () => {};
    const timer = setTimeout(() => {
      const view = scroller.current?.getBoundingClientRect();
      const box = canvas.parentElement?.getBoundingClientRect();
      if (!view || !box) return;
      const seen: Rect = [
        Math.max(0, (view.left - box.left) / scale),
        Math.max(0, (view.top - box.top) / scale),
        Math.min(width, (view.right - box.left) / scale),
        Math.min(height, (view.bottom - box.top) / scale),
      ];
      if (seen[2] <= seen[0] || seen[3] <= seen[1]) return;
      const last = sharp.current;
      if (
        last && Math.abs(last.scale - wanted) / wanted < 0.05 &&
        last.region[0] <= seen[0] && last.region[1] <= seen[1] && last.region[2] >= seen[2] && last.region[3] >= seen[3]
      )
        return;
      const grow = (margin: number): Rect => {
        const mx = (seen[2] - seen[0]) * margin;
        const my = (seen[3] - seen[1]) * margin;
        return [
          Math.floor(Math.max(0, seen[0] - mx)),
          Math.floor(Math.max(0, seen[1] - my)),
          Math.ceil(Math.min(width, seen[2] + mx)),
          Math.ceil(Math.min(height, seen[3] + my)),
        ];
      };
      const pixels = (r: Rect, s: number) => (r[2] - r[0]) * (r[3] - r[1]) * s * s;
      let region = grow(0.3);
      if (pixels(region, wanted) > DETAIL_PIXELS) region = grow(0.05);
      const target = Math.round(Math.min(wanted, wanted * Math.sqrt(DETAIL_PIXELS / pixels(region, wanted))) * 1000) / 1000;
      const spec: RenderSpec = { session, page, revision, scale: target, clip: region };
      const show = (bitmap: Bitmap) => {
        if (bitmap.revision !== revision) return;
        paint(canvas, bitmap.image);
        // the renderer snaps the region outwards to whole device pixels
        const x = Math.floor(region[0] * target) / target;
        const y = Math.floor(region[1] * target) / target;
        Object.assign(canvas.style, {
          left: `${(x / width) * 100}%`,
          top: `${(y / height) * 100}%`,
          width: `${(bitmap.image.width / target / width) * 100}%`,
          height: `${(bitmap.image.height / target / height) * 100}%`,
        });
        canvas.hidden = false;
        sharp.current = { session, revision, scale: wanted, region };
      };
      const hit = cachedBitmap(spec);
      if (hit) show(hit);
      else cancel = requestRender(spec, () => priorityOf(page) + 0.5, { done: show, fail: () => {} });
    }, 160);
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [session, page, revision, wanted, whole, scale, width, height, settled, scroller]);

  return (
    <>
      <canvas ref={base} className="pv-canvas" role="img" aria-label={`Page ${page + 1}`} data-ready={status === "ready"} />
      <canvas ref={detail} className="pv-detail" aria-hidden="true" hidden />
      {status === "loading" && (
        <div className="pv-page-status" aria-hidden="true">
          <SpinnerGapIcon className="pv-spin" />
          <span>{page + 1}</span>
        </div>
      )}
      {status === "error" && (
        <div className="pv-page-status pv-page-error">
          <span>Page {page + 1} could not be shown.</span>
          <button
            type="button"
            className="pv-btn pv-btn-text"
            onClick={(e) => {
              e.stopPropagation();
              setStatus("loading");
              setAttempt((n) => n + 1);
            }}
          >
            <ArrowClockwiseIcon /> Try again
          </button>
        </div>
      )}
    </>
  );
}
