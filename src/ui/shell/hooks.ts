import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** tool rail and side panel need width; short landscape phones stay on the phone layout */
export const useDesktop = () => useMediaQuery("(min-width: 900px) and (min-height: 480px)");

/** phones and tablets show one notice at a time, small */
export const useCompactNotices = () => useMediaQuery("(max-width: 699px), (pointer: coarse)");

/** room for page thumbnails beside the page and a side panel */
export const useWide = () => useMediaQuery("(min-width: 1100px) and (min-height: 480px)");

const TYPING = 'textarea, input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file], [type=button], [readonly])';

/**
 * --sh-kb: pixels covered by the on-screen keyboard. --sh-vvh: visible height. Sheets and dialogs use
 * them so inputs are never hidden behind the keyboard (iOS does not resize the layout viewport).
 * html[data-keyboard]: the keyboard is up, so bars that would only take room away can leave.
 */
export function useViewportVars(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    /** the tallest the view has been at each width: Android shrinks the page itself for the keyboard */
    const tallest = new Map<number, number>();
    const update = () => {
      const zoomed = vv.scale > 1.01;
      const width = Math.round(window.innerWidth);
      const full = Math.max(tallest.get(width) ?? 0, window.innerHeight);
      tallest.set(width, full);
      const typing = !!document.activeElement?.matches(TYPING);
      root.toggleAttribute("data-keyboard", !zoomed && typing && full - vv.height > 160);
      const covered = zoomed ? 0 : Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--sh-kb", `${Math.round(covered)}px`);
      root.style.setProperty("--sh-vvh", `${Math.round(zoomed ? window.innerHeight : vv.height)}px`);
    };
    update();
    // after the focus has settled on its new element
    const later = () => setTimeout(update);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      root.removeAttribute("data-keyboard");
    };
  }, []);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** open dialogs, newest last: only the top one reacts to Escape and Tab */
const stack: symbol[] = [];

/**
 * Focus handling for dialogs, sheets and side panels: moves focus in, traps Tab when modal, closes on
 * Escape and gives focus back on close.
 */
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  options: { modal: boolean; onClose(): void },
): void {
  const { modal } = options;
  const close = useRef(options.onClose);
  useLayoutEffect(() => {
    close.current = options.onClose;
  });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const token = Symbol();
    stack.push(token);
    const previous = document.activeElement as HTMLElement | null;
    if (!node.contains(document.activeElement)) {
      const wanted = node.querySelector<HTMLElement>("[data-autofocus]");
      (wanted ?? node).focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (event.key === "Escape" && (modal || node.contains(document.activeElement))) {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !modal) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    // capture, so the viewer's own shortcuts do not also act on an Escape meant for the dialog
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(token), 1);
      if (previous?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body))
        previous.focus({ preventScroll: true });
    };
  }, [ref, modal]);
}
