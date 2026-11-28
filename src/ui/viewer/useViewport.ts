/** Scroll container logic: virtualised layout, anchored zoom, pinch and ctrl+wheel, scroll requests. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useStore } from "../../store";
import {
  anchorAt, computeLayout, dominantPage, fitScale, MAX_SCALE, MIN_SCALE, pageAtY, pagesBetween, rectCentre, scrollForAnchor,
  type Anchor, type Layout,
} from "./geometry";
import { setZoomApi } from "./viewerApi";
import { useViewer } from "./viewerStore";

export interface Viewport {
  layout: Layout;
  width: number;
  height: number;
  /** pages to mount (visible plus overscan) */
  range: [number, number];
  /** changes shortly after scrolling stops: time to sharpen the visible area */
  settled: number;
}

export function useViewport(scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>): Viewport {
  const doc = useStore((s) => s.doc);
  const zoom = useStore((s) => s.zoom);
  const session = useStore((s) => s.session);
  const scrollRequest = useStore((s) => s.scrollRequest);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [settled, setSettled] = useState(0);

  const narrow = size.width < 640;
  const pad = narrow ? 8 : 24;
  const gap = narrow ? 8 : 16;
  const pages = doc?.pages;
  const layout = useMemo(
    () => (pages && size.width ? computeLayout(pages, zoom, size.width, pad, gap) : { boxes: [], width: 0, height: 0 }),
    [pages, zoom, size.width, pad, gap],
  );

  const layoutRef = useRef(layout);
  const lastScroll = useRef({ left: 0, top: 0 });
  const pendingAnchor = useRef<Anchor | null>(null);
  const programmatic = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(() => {
    const el = scroller.current;
    const l = layoutRef.current;
    if (!el || !l.boxes.length) return;
    const h = el.clientHeight;
    const next = pagesBetween(l, el.scrollTop - h * 0.6, el.scrollTop + h * 1.6);
    setRange((r) => (r[0] === next[0] && r[1] === next[1] ? r : next));
    if (performance.now() > programmatic.current) {
      const page = dominantPage(l, el.scrollTop, h);
      if (page !== useStore.getState().currentPage) useStore.getState().setCurrentPage(page);
    }
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettled((n) => n + 1), 140);
  }, [scroller]);

  /* container size */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () =>
      setSize((s) =>
        s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scroller, session, !!doc]);

  /* new document: start at the top */
  useLayoutEffect(() => {
    const el = scroller.current;
    lastScroll.current = { left: 0, top: 0 };
    pendingAnchor.current = null;
    layoutRef.current = { boxes: [], width: 0, height: 0 };
    el?.scrollTo(0, 0);
  }, [session, scroller]);

  /* keep the same spot in view when the layout changes (zoom, rotation, page ops) */
  useLayoutEffect(() => {
    const el = scroller.current;
    const old = layoutRef.current;
    layoutRef.current = layout;
    if (!el || !layout.boxes.length) return;
    let anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!anchor && old.boxes.length) {
      const { left, top } = lastScroll.current;
      // at the very top stay at the top
      const vy = top <= 1 ? 0 : el.clientHeight / 2;
      anchor = anchorAt(old, left, top, el.clientWidth / 2, vy);
    }
    if (anchor) {
      const to = scrollForAnchor(layout, anchor);
      el.scrollLeft = to.left;
      el.scrollTop = anchor.vy === 0 && lastScroll.current.top <= 1 ? 0 : to.top;
      lastScroll.current = { left: el.scrollLeft, top: el.scrollTop };
    }
    if (content.current) content.current.style.transform = "";
    refresh();
  }, [layout, scroller, content, refresh]);

  useLayoutEffect(refresh, [size.height, refresh]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      lastScroll.current = { left: el.scrollLeft, top: el.scrollTop };
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    // the user taking over ends the programmatic scroll
    const takeOver = () => (programmatic.current = 0);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", takeOver, { passive: true });
    el.addEventListener("touchstart", takeOver, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", takeOver);
      el.removeEventListener("touchstart", takeOver);
      cancelAnimationFrame(frame);
    };
  }, [scroller, refresh, !!doc]);

  /* scroll requests from the shell */
  const handled = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !scrollRequest || handled.current === scrollRequest.nonce || !layout.boxes.length) return;
    handled.current = scrollRequest.nonce;
    const box = layout.boxes[scrollRequest.page];
    if (!box) return;
    programmatic.current = performance.now() + 400;
    if (scrollRequest.rect) {
      const [cx, cy] = rectCentre(scrollRequest.rect);
      el.scrollTop = box.top + cy * box.scale - el.clientHeight * 0.4;
      const x = box.left + cx * box.scale;
      if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = x - el.clientWidth / 2;
    } else {
      el.scrollTop = box.top - pad;
    }
    lastScroll.current = { left: el.scrollLeft, top: el.scrollTop };
    refresh();
  }, [scrollRequest, layout, scroller, pad, refresh]);

  /* ---------- zooming ---------- */

  /** zoom to `scale` keeping the page point under (clientX, clientY) in place */
  const zoomTo = useCallback(
    (scale: number | "fit", clientX?: number, clientY?: number, anchor?: Anchor) => {
      const el = scroller.current;
      const l = layoutRef.current;
      if (!el || !l.boxes.length) return;
      const r = el.getBoundingClientRect();
      const vx = clientX === undefined ? el.clientWidth / 2 : clientX - r.left;
      const vy = clientY === undefined ? el.clientHeight / 2 : clientY - r.top;
      pendingAnchor.current = anchor ?? anchorAt(l, el.scrollLeft, el.scrollTop, vx, vy);
      const next = scale === "fit" ? scale : Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      if (next === useStore.getState().zoom) {
        pendingAnchor.current = null;
        if (content.current) content.current.style.transform = "";
        return;
      }
      useStore.getState().setZoom(next);
    },
    [scroller, content],
  );

  const scaleAt = useCallback(
    (clientY?: number) => {
      const el = scroller.current;
      const l = layoutRef.current;
      if (!el || !l.boxes.length) return 1;
      const vy = clientY === undefined ? el.clientHeight / 2 : clientY - el.getBoundingClientRect().top;
      return l.boxes[pageAtY(l, el.scrollTop + vy)]!.scale;
    },
    [scroller],
  );

  useEffect(() => {
    setZoomApi({
      getScale: () => scaleAt(),
      zoomBy: (factor) => zoomTo(scaleAt() * factor),
      zoomAt: (scale, page, point, clientX, clientY) => {
        const el = scroller.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        // away from the edges (and the keyboard), so the surroundings stay readable
        const within = (v: number, size: number, low: number, high: number) => Math.max(size * low, Math.min(size * high, v));
        zoomTo(scale, undefined, undefined, {
          page,
          px: point[0],
          py: point[1],
          vx: within(clientX - r.left, el.clientWidth, 0.25, 0.75),
          vy: within(clientY - r.top, el.clientHeight, 0.15, 0.5),
        });
      },
    });
    return () => setZoomApi(null);
  }, [scaleAt, zoomTo, scroller]);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;

    /** smallest zoom a pinch can reach: a bit under fit-width */
    const lowest = (page: number) => {
      const p = useStore.getState().doc?.pages[page];
      return p ? Math.max(MIN_SCALE, Math.min(1, fitScale(p, el.clientWidth, pad))) : MIN_SCALE;
    };

    /* two fingers: pan and pinch, previewed with a CSS transform, committed on release */
    let pinch: null | {
      anchor: Anchor;
      distance: number;
      x: number;
      y: number;
      scale: number;
      factor: number;
      dx: number;
      dy: number;
    } = null;

    const two = (t: TouchList) => {
      const a = t[0]!;
      const b = t[1]!;
      return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
        distance: Math.max(10, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      };
    };

    const start = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !layoutRef.current.boxes.length) return;
      if (e.cancelable) e.preventDefault();
      const m = two(e.touches);
      const r = el.getBoundingClientRect();
      const anchor = anchorAt(layoutRef.current, el.scrollLeft, el.scrollTop, m.x - r.left, m.y - r.top);
      pinch = { anchor, ...m, scale: layoutRef.current.boxes[anchor.page]!.scale, factor: 1, dx: 0, dy: 0 };
      inner.style.transformOrigin = `${el.scrollLeft + anchor.vx}px ${el.scrollTop + anchor.vy}px`;
      el.dispatchEvent(new CustomEvent("pv-pinch"));
    };
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length < 2) return;
      if (!e.cancelable) return;
      e.preventDefault();
      const m = two(e.touches);
      const min = lowest(pinch.anchor.page);
      pinch.factor = Math.min(MAX_SCALE / pinch.scale, Math.max((min * 0.8) / pinch.scale, m.distance / pinch.distance));
      pinch.dx = m.x - pinch.x;
      pinch.dy = m.y - pinch.y;
      inner.style.transform = `translate(${pinch.dx}px, ${pinch.dy}px) scale(${pinch.factor})`;
    };
    const end = (e: TouchEvent) => {
      if (!pinch || e.touches.length >= 2) return;
      const p = pinch;
      pinch = null;
      if (Math.abs(p.factor - 1) < 0.02) {
        inner.style.transform = "";
        el.scrollLeft -= p.dx;
        el.scrollTop -= p.dy;
        return;
      }
      const wanted = p.scale * p.factor;
      const fit = lowest(p.anchor.page);
      const next = wanted < fit * 1.06 ? "fit" : wanted;
      const anchor = { ...p.anchor, vx: p.anchor.vx + p.dx, vy: p.anchor.vy + p.dy };
      flushSync(() => zoomTo(next, undefined, undefined, anchor));
    };

    /* ctrl/cmd + wheel (also trackpad pinch on desktop) */
    let wheelScale = 0;
    let wheelFrame = 0;
    let wheelAt = [0, 0];
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // one notch of a mouse wheel is about 15%; a trackpad pinch sends many small steps
      wheelScale = (wheelScale || scaleAt(e.clientY)) * Math.exp(-Math.max(-28, Math.min(28, delta)) * 0.005);
      wheelScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, wheelScale));
      wheelAt = [e.clientX, e.clientY];
      wheelFrame ||= requestAnimationFrame(() => {
        wheelFrame = 0;
        zoomTo(wheelScale, wheelAt[0], wheelAt[1]);
        wheelScale = 0;
      });
    };

    /* Safari trackpad pinch; also stops iOS from zooming the whole page */
    let gestureScale = 1;
    const gestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = scaleAt((e as MouseEvent).clientY);
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      if (pinch || navigator.maxTouchPoints > 0) return;
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(gestureScale * g.scale, g.clientX, g.clientY);
    };

    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gestureStart, { passive: false });
    el.addEventListener("gesturechange", gestureChange, { passive: false });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gestureStart);
      el.removeEventListener("gesturechange", gestureChange);
      cancelAnimationFrame(wheelFrame);
    };
  }, [scroller, content, pad, scaleAt, zoomTo, !!doc]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const inset = useViewer((s) => s.bottomInset);

  /*
   * The extra scroll room made for the keyboard is given back only as far as it is out of sight, so the page
   * never jumps when a field closes: it shrinks while the user scrolls up.
   */
  const editing = useStore((s) => s.editing !== null);
  const switching = useViewer((s) => s.switching);
  const baseHeight = layout.height;
  useEffect(() => {
    const el = scroller.current;
    if (!el || editing || switching || !inset) return;
    let settledDown = false;
    const trim = () => {
      const needed = Math.max(0, Math.ceil(el.scrollTop + el.clientHeight - baseHeight));
      if (needed < useViewer.getState().bottomInset) useViewer.setState({ bottomInset: needed });
    };
    // not at once: the keyboard is still on its way down and the view still short
    const timer = setTimeout(() => {
      settledDown = true;
      trim();
    }, 900);
    const onScroll = () => settledDown && trim();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scroller, editing, switching, inset, baseHeight]);
  return {
    layout: inset ? { ...layout, height: layout.height + inset } : layout,
    width: size.width,
    height: size.height,
    range,
    settled,
  };
}
