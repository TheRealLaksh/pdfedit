/** Page canvas, inline text editing and on-page tools. Owner: VIEWER module. */
import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import { ViewerContext } from "./context";
import { ContextMenu } from "./ContextMenu";
import { isCompact } from "./device";
import { cancelQueuedTap, editors, isEcho } from "./editor/controller";
import { SwitchingDock } from "./editor/PhoneBar";
import { boundsOf, quadPoints, rectCentre } from "./geometry";
import { ActionOverlay, PageNotice } from "./Overlays";
import { closeField } from "./layers/FormLayer";
import { PageView } from "./PageView";
import { clearRenderCache } from "./renderQueue";
import { saveThen, useShortcuts } from "./useShortcuts";
import { useViewport } from "./useViewport";
import { flushInk, resetViewer, useViewer } from "./viewerStore";
import "./viewer.css";

export { getViewerScale, zoomBy } from "./viewerApi";

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
  const fieldPage = useViewer((s) => s.field?.page);
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
    closeField();
    useViewer.setState({ locked: null, menu: null, mark: "text" });
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
      closeField();
      useViewer.setState({ locked: null });
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
      closeField();
      void flushInk();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useShortcuts(scroller);

  // a new document: keys scroll it at once
  useEffect(() => {
    const el = scroller.current;
    if (!el || isCompact()) return;
    const timer = setTimeout(() => {
      if (document.activeElement === document.body) el.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [session, hasDoc]);

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
  for (const page of [editingPage, selectedPage, fieldPage])
    if (page !== undefined && layout.boxes[page] && !mounted.includes(page)) mounted.push(page);
  mounted.sort((a, b) => a - b);

  return (
    <ViewerContext.Provider value={context}>
      <div ref={root} className="pv-root" data-tool={tool} data-testid="viewer">
        <div
          ref={scroller}
          className="pv-scroll"
          tabIndex={0}
          role="region"
          aria-label="Document pages"
          onClick={(e) => {
            // a tap on the empty space around the pages
            if ((e.target !== e.currentTarget && e.target !== content.current) || isEcho(e)) return;
            cancelQueuedTap();
            editors.current?.commit();
            closeField();
            useViewer.setState({ locked: null });
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
        <ContextMenu />
      </div>
    </ViewerContext.Provider>
  );
}
