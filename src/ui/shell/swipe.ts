import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** pull the sheet down by its header to close it */
export function useSwipeToClose(sheet: RefObject<HTMLDivElement | null>, close: () => void, enabled: boolean) {
  const start = useRef<{ y: number; id: number } | null>(null);
  if (!enabled) return {};
  const offset = (e: ReactPointerEvent) => Math.max(0, e.clientY - start.current!.y);
  const finish = (e: ReactPointerEvent, commit: boolean) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    const far = offset(e) > 90;
    start.current = null;
    if (sheet.current) sheet.current.style.transform = "";
    if (commit && far) close();
  };
  return {
    onPointerDown(e: ReactPointerEvent) {
      if ((e.target as HTMLElement).closest("button")) return;
      start.current = { y: e.clientY, id: e.pointerId };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: ReactPointerEvent) {
      if (start.current?.id === e.pointerId && sheet.current) sheet.current.style.transform = `translateY(${offset(e)}px)`;
    },
    onPointerUp: (e: ReactPointerEvent) => finish(e, true),
    onPointerCancel: (e: ReactPointerEvent) => finish(e, false),
  };
}
