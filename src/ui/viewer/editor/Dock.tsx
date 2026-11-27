/**
 * A panel glued to the bottom of the visual viewport, that is, to the top edge of the on-screen keyboard.
 * iOS Safari keeps the layout viewport full height behind the keyboard, so position:fixed bottom:0 would
 * be hidden; the visual viewport is the only reliable measure. Android (resizes-content) works the same way.
 */
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export function Dock({ children, dockRef, onMoved, short }: {
  children: ReactNode;
  dockRef: RefObject<HTMLDivElement | null>;
  /** the dock moved or changed height */
  onMoved(): void;
  short: boolean;
}) {
  const moved = useRef(onMoved);
  moved.current = onMoved;

  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const vv = window.visualViewport;
    let last = "";
    let frame = 0;
    let until = 0;
    const place = () => {
      const height = el.offsetHeight;
      const viewTop = vv?.offsetTop ?? 0;
      const viewHeight = vv?.height ?? window.innerHeight;
      const left = vv?.offsetLeft ?? 0;
      const width = vv?.width ?? window.innerWidth;
      const top = Math.max(viewTop, viewTop + viewHeight - height);
      el.style.width = `${width}px`;
      el.style.maxHeight = `${viewHeight}px`;
      el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      el.classList.toggle("pv-dock-keyboard", window.innerHeight - viewHeight > 100);
      const now = `${left}:${top}:${width}:${height}`;
      if (now !== last) {
        last = now;
        moved.current();
      }
    };
    // iOS reports the new viewport late and in steps: follow it for a moment
    const follow = () => {
      until = performance.now() + 900;
      if (frame) return;
      const tick = () => {
        place();
        frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
      };
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      place();
      follow();
    };
    update();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    document.addEventListener("focusin", follow);
    document.addEventListener("focusout", follow);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
      document.removeEventListener("focusin", follow);
      document.removeEventListener("focusout", follow);
    };
  }, [dockRef]);

  return createPortal(
    <div ref={dockRef} className={short ? "pv-dock pv-dock-short" : "pv-dock"} data-pv-ui="" data-testid="editor-dock">
      {children}
    </div>,
    document.body,
  );
}
