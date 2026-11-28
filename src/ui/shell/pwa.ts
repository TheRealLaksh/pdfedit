/** Offline support (public/sw.js), the install offer and files handed to the installed app. */
import { engineReady } from "../../engine/client";
import { useShell, type InstallEvent } from "./uiStore";

export const installedAlready = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** iPhones and iPads (which also say they are Macs) can only be installed by hand */
export const isAppleTouch = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

// the browser may announce this before the app has rendered, so listen as soon as this file loads
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    useShell.setState({ install: event as InstallEvent });
  });
  window.addEventListener("appinstalled", () => useShell.setState({ install: null }));
}

export function registerServiceWorker(): void {
  // installed apps keep their saved copy even when the device is short of space
  if (installedAlready()) void navigator.storage?.persist?.().catch(() => false);
  // production only: it would get in the way of the dev server
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () =>
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((e) => console.warn("service worker", e));
  // saving the app for offline use must not compete with the first download of the engine
  const waited = new Promise((resolve) => setTimeout(resolve, 45_000));
  void Promise.race([engineReady, waited]).then(register);
}
