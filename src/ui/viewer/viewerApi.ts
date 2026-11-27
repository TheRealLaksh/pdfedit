/**
 * Imperative handle on the mounted viewer, for the shell (zoom buttons, zoom percentage) and the
 * viewer's own editor and keyboard shortcuts.
 */
import type { Point } from "../../engine/types";
import { useStore } from "../../store";

export interface ZoomApi {
  /** CSS px per point of the page in the middle of the view (also meaningful while zoom is "fit") */
  getScale(): number;
  zoomBy(factor: number): void;
  /** zoom and bring a page point near the middle */
  zoomAround(scale: number, page: number, point: Point): void;
}

let api: ZoomApi | null = null;

export function setZoomApi(next: ZoomApi | null) {
  api = next;
}

export function getViewerScale(): number {
  const z = useStore.getState().zoom;
  return api?.getScale() ?? (z === "fit" ? 1 : z);
}

export function zoomBy(factor: number) {
  if (api) api.zoomBy(factor);
  else useStore.getState().setZoom(getViewerScale() * factor);
}

export function zoomAround(scale: number, page: number, point: Point) {
  if (api) api.zoomAround(scale, page, point);
  else useStore.getState().setZoom(scale);
}
