/** Page canvas, inline text editing and on-page tools. Owner: VIEWER module. */
import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import { ViewerContext } from "./context";
import { cancelQueuedTap, editors, isEcho } from "./editor/controller";
import { SwitchingDock } from "./editor/PhoneBar";
import { boundsOf, quadPoints, rectCentre } from "./geometry";
import { ActionOverlay, PageNotice } from "./Overlays";
import { PageView } from "./PageView";
import { clearRenderCache } from "./renderQueue";
import { useViewport } from "./useViewport";
import { zoomBy } from "./viewerApi";
import { flushInk, resetViewer, undoInkStroke, useViewer } from "./viewerStore";
import "./viewer.css";

export { getViewerScale, zoomBy } from "./viewerApi";

/**
 * Undo or redo with a text field open: the draft is saved first, so undo takes back exactly that edit
 * (and redo can bring it back). Returns false when there was nothing to save.
 */
function saveThen(action: "undo" | "redo"): boolean {
  const saving = editors.current?.commit();
  if (!saving) return false;
  // after a new edit there is nothing left to redo
  if (action === "undo") void saving.then((saved) => saved && useStore.getState().undo());
  return true;
}

export function Viewer() {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const context = useRef({ root, scroller }).current;

  const session = useStore((s) => s.session);
  const hasDoc = useStore((s) => !!s.doc);
  const tool = useStore((s) => s.tool);
  const editingPage = useStore((s) => s.editing?.page);
  const selectedPage = useStore((s) => s.selection?.page);
  const viewport = useViewport(scroller, content);

  useEffect(
    () => () => {
      resetViewer();
      clearRenderCache();
    },
    [session],
  );

  // leaving a tool finishes its unsaved work
  useEffect(() => {
    void flushInk();
    if (tool !== "redact") useViewer.setState({ redactions: {} });
  }, [tool]);

  /* tapping anywhere else (top bar, panels) saves the open editor before that control acts */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.isConnected || root.current?.contains(target) || target.closest("[data-pv-ui]")) return;
      const label = target.closest("button")?.getAttribute("aria-label") ?? "";
      // zooming keeps the field open
      if (/^(zoom|show at actual|fit to)/i.test(label)) return;
      const history = /^(undo|redo)/i.exec(label)?.[1]?.toLowerCase() as "undo" | "redo" | undefined;
      if (history && editors.current) {
        // the button's own handler would run while the save is still busy and do nothing: take over
        if (saveThen(history)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      cancelQueuedTap();
      editors.current?.commit();
      void flushInk();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  /* save / open shortcuts belong to the shell: finish the open field before they run */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !["s", "o", "p"].includes(e.key.toLowerCase())) return;
      editors.current?.commit();
      void flushInk();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* keyboard shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useStore.getState();
      if (e.defaultPrevented || !store.doc) return;
      const target = e.target as Element;
      const typing = !!target.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]");
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && (key === "=" || key === "+" || key === "-" || key === "0")) {
        e.preventDefault();
        if (key === "0") store.setZoom("fit");
        else zoomBy(key === "-" ? 1 / 1.2 : 1.2);
        return;
      }
      if (typing) return;
      if (mod && !e.altKey && key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (!undoInkStroke() && !saveThen("undo")) void store.undo();
      } else if (mod && !e.altKey && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        if (!saveThen("redo")) void store.redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && store.selection && !mod) {
        e.preventDefault();
        void store.deleteSelection();
      } else if (e.key === "Escape") {
        if (store.placement) store.setPlacement(null);
        else if (store.selection) store.select(null);
        else if (Object.keys(useViewer.getState().redactions).length) useViewer.setState({ redactions: {} });
        else return;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* bring the active search hit into view */
  const hit = useStore((s) => s.search.matches[s.search.active]);
  useEffect(() => {
    const el = scroller.current;
    if (!hit || !el || !hit.quads.length) return;
    const rect = boundsOf(hit.quads.flatMap(quadPoints));
    const page = el.querySelector(`[data-page="${hit.page}"]`)?.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    if (page) {
      const info = useStore.getState().doc!.pages[hit.page]!;
      const [cx, cy] = rectCentre(rect);
      const x = page.left + (cx / info.width) * page.width;
      const y = page.top + (cy / info.height) * page.height;
      if (x > view.left + 16 && x < view.right - 16 && y > view.top + 64 && y < view.bottom - 64) return;
    }
    useStore.getState().scrollTo(hit.page, rect);
  }, [hit]);

  if (!hasDoc) return null;

  const { layout, range, settled } = viewport;
  const mounted: number[] = [];
  for (let i = range[0]; i <= range[1] && i < layout.boxes.length; i++) mounted.push(i);
  // the page being worked on stays alive however far it is scrolled away
  for (const page of [editingPage, selectedPage])
    if (page !== undefined && layout.boxes[page] && !mounted.includes(page)) mounted.push(page);
  mounted.sort((a, b) => a - b);

  return (
    <ViewerContext.Provider value={context}>
      <div ref={root} className="pv-root" data-tool={tool} data-testid="viewer">
        <div
          ref={scroller}
          className="pv-scroll"
          tabIndex={0}
          aria-label="Document pages"
          onClick={(e) => {
            // a tap on the empty space around the pages
            if ((e.target !== e.currentTarget && e.target !== content.current) || isEcho(e)) return;
            cancelQueuedTap();
            editors.current?.commit();
            useStore.getState().select(null);
          }}
        >
          <div ref={content} className="pv-content" style={{ width: layout.width, height: layout.height }}>
            {mounted.map((i) => (
              <PageView key={`${session}:${i}`} index={i} {...layout.boxes[i]!} settled={settled} />
            ))}
          </div>
        </div>
        <PageNotice />
        <ActionOverlay />
        <SwitchingDock />
      </div>
    </ViewerContext.Provider>
  );
}
