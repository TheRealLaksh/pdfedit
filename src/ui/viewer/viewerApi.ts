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
  /** zoom into a spot the finger touched: the page point stays about where it was on screen */
  zoomAt(scale: number, page: number, point: Point, clientX: number, clientY: number): void;
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

/** zoom into a spot the finger touched, keeping it about where it was on screen */
export function zoomAt(scale: number, page: number, point: Point, clientX: number, clientY: number) {
  if (api) api.zoomAt(scale, page, point, clientX, clientY);
  else useStore.getState().setZoom(scale);
}
