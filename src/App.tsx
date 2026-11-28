/** App shell. Owner: SHELL module. */
import { lazy, Suspense, useEffect, useLayoutEffect } from "react";
import { useStore } from "./store";
import { downloadWhenReady, dropOnDocument, openAnother } from "./ui/shell/actions";
import { useBackGuard } from "./ui/shell/backGuard";
import { Dialogs } from "./ui/shell/Dialogs";
import { BusyOverlay, DropTarget, StatusChips, Toasts } from "./ui/shell/Feedback";
import { useDesktop, useViewportVars } from "./ui/shell/hooks";
import { Panel } from "./ui/shell/Panel";
import { registerServiceWorker } from "./ui/shell/pwa";
import { StartScreen } from "./ui/shell/StartScreen";
import { useToolColors } from "./ui/shell/toolColors";
import { BottomBar, MoreMenu, ToolOptions, ToolRail } from "./ui/shell/ToolBars";
import { togglePanel, TopBar } from "./ui/shell/TopBar";
import { useShell } from "./ui/shell/uiStore";
import { Viewer } from "./ui/viewer/Viewer";
import { useViewer } from "./ui/viewer/viewerStore";
import "./ui/shell/shell.css";

function useTheme() {
  const theme = useStore((s) => s.theme);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    // the browser toolbar follows a forced theme too
    const forced = theme === "system" ? "" : getComputedStyle(root).getPropertyValue("--surface").trim();
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.dataset.system ??= meta.content;
      meta.content = forced || meta.dataset.system;
    }
  }, [theme]);
}

/** file level shortcuts; editing shortcuts (undo, zoom, nudge) belong to the viewer */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "o" && key !== "s" && key !== "f") return;
      const state = useStore.getState();
      const shell = useShell.getState();
      if (key === "f" && !state.doc) return;
      e.preventDefault();
      if (state.passwordPrompt || shell.confirm || shell.prompt) return;
      if (key === "f") {
        if (state.panel === "find") document.querySelector<HTMLInputElement>('input[name="find"]')?.select();
        else togglePanel("find");
        return;
      }
      // an open text field commits before the file is saved or replaced
      (document.activeElement as HTMLElement | null)?.blur?.();
      // opening needs the key press itself (file pickers refuse to appear later), saving can wait
      if (key === "s") void downloadWhenReady();
      else if (!state.busy) void openAnother();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useUnsavedWarning() {
  const unsaved = useStore((s) => s.doc !== null && (s.dirty || s.editing !== null));
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
}

/**
 * While a document is open only the page itself zooms. A pinch that lands on the bars (or iOS ignoring
 * touch-action) would otherwise magnify the whole app and leave its controls off screen.
 */
function useNoAppZoom(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", stop, { passive: false });
    return () => document.removeEventListener("gesturestart", stop);
  }, [active]);
}

function Editor({ desktop }: { desktop: boolean }) {
  const editing = useStore((s) => s.editing !== null);
  // phones: between two lines the keyboard and its bar stay, so the tool bar must not flash back
  const switching = useViewer((s) => s.switching);
  const placing = useStore((s) => s.placement !== null);
  // the viewer shows its own bar for a selected item
  const selected = useStore((s) => s.selection !== null);
  const panel = useStore((s) => s.panel);
  const fileName = useStore((s) => s.doc!.fileName);
  const menuOpen = useShell((s) => s.menuOpen);

  useEffect(() => {
    const before = document.title;
    document.title = `${fileName} · PDFEdit`;
    return () => {
      document.title = before;
    };
  }, [fileName]);

  return (
    <div className="sh-app" data-layout={desktop ? "desktop" : "phone"} data-editing={editing || switching || undefined}>
      <a
        className="sh-skip"
        href="#sh-document"
        // moving the focus without a history step: Back belongs to the guard below
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("sh-document")?.focus();
        }}
      >
        Skip to document
      </a>
      <TopBar desktop={desktop} />
      <div className="sh-body">
        {desktop && <ToolRail />}
        <main className="sh-main" id="sh-document" tabIndex={-1}>
          <div className="sh-viewer">
            <Viewer />
          </div>
          <StatusChips />
          {!editing && !placing && !selected && (desktop || !panel) && <ToolOptions />}
        </main>
        <Panel desktop={desktop} />
      </div>
      {!desktop && !editing && !switching && <BottomBar />}
      {menuOpen && <MoreMenu desktop={desktop} />}
    </div>
  );
}

// loaded only when a picture is opened
const ImageEditor = lazy(() => import("./image/ImageEditor").then((m) => ({ default: m.ImageEditor })));

export function App() {
  const image = useStore((s) => s.image);
  const closeImage = useStore((s) => s.closeImage);
  const hasDoc = useStore((s) => s.doc !== null);
  const openFiles = useStore((s) => s.openFiles);
  const desktop = useDesktop();
  useTheme();
  useViewportVars();
  useShortcuts();
  useUnsavedWarning();
  useToolColors();
  useBackGuard(!desktop);
  useNoAppZoom(hasDoc);
  useEffect(() => registerServiceWorker(), []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-editor", hasDoc);
    if (!hasDoc) useShell.getState().setMenu(false);
  }, [hasDoc]);

  return (
    <>
      {image ? (
        <Suspense fallback={null}>
          <ImageEditor key={`${image.name}:${image.size}:${image.lastModified}`} file={image} onClose={closeImage} />
        </Suspense>
      ) : hasDoc ? (
        <Editor desktop={desktop} />
      ) : (
        <>
          <StartScreen />
          <Panel desktop={desktop} />
        </>
      )}
      <DropTarget
        label={hasDoc ? "Drop to add or open" : "Drop a PDF or images"}
        onFiles={(files) => void (hasDoc ? dropOnDocument(files) : openFiles(files))}
      />
      <Dialogs />
      <BusyOverlay />
      <Toasts />
    </>
  );
}
