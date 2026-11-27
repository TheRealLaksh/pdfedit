import type { Point } from "../../../engine/types";

/** client coordinates to page points, correct even while the page is CSS-scaled */
export function pagePoint(
  e: { clientX: number; clientY: number },
  element: Element,
  width: number,
  height: number,
): Point {
  const r = element.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height];
}
