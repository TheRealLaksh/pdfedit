/** The quiet offer to install the app: a menu row, a line in About, and one suggestion on the start screen. */
import type { ReactNode } from "react";
import { useStore } from "../../store";
import { installedAlready, isAppleTouch } from "./pwa";
import { INSTALL } from "./strings";
import { useShell } from "./uiStore";

/** what "Install app" should do here, or null when there is nothing to offer */
export function useInstall(): (() => void) | null {
  const event = useShell((s) => s.install);
  if (installedAlready()) return null;
  if (event)
    return () => {
      useShell.getState().setMenu(false);
      // the event can be used once
      useShell.setState({ install: null });
      void event.prompt();
    };
  if (isAppleTouch())
    return () => {
      useShell.getState().setMenu(false);
      useStore.getState().toast(INSTALL.ios, "info", undefined, { sticky: true });
    };
  return null;
}

export function InstallItem({ render }: { render(run: () => void): ReactNode }) {
  const run = useInstall();
  return run ? render(run) : null;
}
