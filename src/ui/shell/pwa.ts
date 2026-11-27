/** Offline support (public/sw.js). Production only: it would get in the way of the dev server. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () =>
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((e) => console.warn("service worker", e));
  // after load, so it never competes with the first render
  if (document.readyState === "complete") void register();
  else window.addEventListener("load", () => void register(), { once: true });
}
