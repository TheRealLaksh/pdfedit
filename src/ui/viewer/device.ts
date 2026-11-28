import { useEffect, useRef, useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse), (max-width: 699px)";

function subscribe(onChange: () => void) {
  const list = matchMedia(QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

/** phones, tablets and narrow windows: the text field docks above the keyboard */
export function isCompact(): boolean {
  return matchMedia(QUERY).matches;
}

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, isCompact, () => false);
}

/** what the Back gesture would close right now, the newest layer last */
const layers: (() => void)[] = [];

const guarded = (state: unknown) => !!(state as { pdfeditSheet?: boolean } | null)?.pdfeditSheet;

// Registered when the app loads, so that it hears Back before the shell's own listener does
if (typeof window !== "undefined")
  window.addEventListener(
    "popstate",
    (e) => {
      const close = layers[layers.length - 1];
      if (!close || guarded(e.state)) return;
      e.stopImmediatePropagation();
      history.pushState({ pdfeditSheet: true }, "");
      close();
    },
    true,
  );

/**
 * Phones: a layer of the viewer (font sheet, form field, menu, locked line bar) that the Back gesture closes.
 * The shell keeps one history entry while something is at stake; a layer borrows it and puts it back, so the
 * shell never hears of that Back.
 */
export function useBackClose(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || !matchMedia("(pointer: coarse)").matches) return;
    const layer = () => latest.current();
    layers.push(layer);
    if (!guarded(history.state)) history.pushState({ pdfeditSheet: true }, "");
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      // the shell takes the entry off again if nothing else needs it. Not at once: one layer may be
      // replacing another (the next form field), which must not be met by that Back
      setTimeout(() => !layers.length && window.dispatchEvent(new Event("pdfedit:release-back")));
    };
  }, [open]);
}

export function isIOS(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
