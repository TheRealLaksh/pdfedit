import { useSyncExternalStore } from "react";

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

export function isIOS(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
