/** Hosts store.panel: a side panel on desktop, a bottom sheet on phones. */
import { X } from "@phosphor-icons/react";
import { useId, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useStore, type PanelId } from "../../store";
import { IconButton } from "./controls";
import { useDialog } from "./hooks";
import { AboutPanel } from "./panels/AboutPanel";
import { ExportPanel } from "./panels/ExportPanel";
import { FindPanel } from "./panels/FindPanel";
import { FontsPanel } from "./panels/FontsPanel";
import { FormsPanel } from "./panels/FormsPanel";
import { OcrPanel } from "./panels/OcrPanel";
import { PagesPanel } from "./panels/PagesPanel";
import { SignaturePanel } from "./panels/SignaturePanel";
import { StampPanel } from "./panels/StampPanel";
import { PANELS } from "./tools";

const CONTENT: Record<PanelId, () => ReactNode> = {
  pages: () => <PagesPanel />,
  find: () => <FindPanel />,
  forms: () => <FormsPanel />,
  export: () => <ExportPanel />,
  ocr: () => <OcrPanel />,
  signature: () => <SignaturePanel />,
  stamp: () => <StampPanel />,
  fonts: () => <FontsPanel />,
  about: () => <AboutPanel />,
};

/** pull the sheet down by its header to close it */
function useSwipeToClose(sheet: React.RefObject<HTMLDivElement | null>, close: () => void, enabled: boolean) {
  const start = useRef<{ y: number; id: number } | null>(null);
  if (!enabled) return {};
  const offset = (e: ReactPointerEvent) => Math.max(0, e.clientY - start.current!.y);
  const finish = (e: ReactPointerEvent, commit: boolean) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    const far = offset(e) > 90;
    start.current = null;
    if (sheet.current) sheet.current.style.transform = "";
    if (commit && far) close();
  };
  return {
    onPointerDown(e: ReactPointerEvent) {
      if ((e.target as HTMLElement).closest("button")) return;
      start.current = { y: e.clientY, id: e.pointerId };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: ReactPointerEvent) {
      if (start.current?.id === e.pointerId && sheet.current) sheet.current.style.transform = `translateY(${offset(e)}px)`;
    },
    onPointerUp: (e: ReactPointerEvent) => finish(e, true),
    onPointerCancel: (e: ReactPointerEvent) => finish(e, false),
  };
}

function PanelFrame({ panel, desktop }: { panel: PanelId; desktop: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const openPanel = useStore((s) => s.openPanel);
  const hasDoc = useStore((s) => s.doc !== null);
  const close = () => openPanel(null);
  const docked = desktop && hasDoc;
  // find stays on top of the page (no scrim) so matches can be seen, and clear of the keyboard
  const topCard = !desktop && panel === "find";
  const modal = !docked && !topCard;
  useDialog(ref, { modal, onClose: close });
  const swipe = useSwipeToClose(ref, close, modal && !desktop);

  const body = (
    <div
      ref={ref}
      className={docked ? "sh-side" : topCard ? "sh-findcard" : `sh-sheet sh-sheet-${panel}`}
      role={docked ? "complementary" : "dialog"}
      aria-modal={modal || undefined}
      aria-labelledby={id}
      tabIndex={-1}
    >
      <div className="sh-panel-head" data-swipe={(modal && !desktop) || undefined} {...swipe}>
        <h2 id={id}>{PANELS[panel].title}</h2>
        <IconButton icon={X} label="Close panel" onClick={close} />
      </div>
      <div className="sh-panel-body">{CONTENT[panel]()}</div>
    </div>
  );

  if (!modal) return body;
  return (
    <div className="sh-modal">
      <div className="sh-scrim" onClick={close} />
      {body}
    </div>
  );
}

export function Panel({ desktop }: { desktop: boolean }) {
  const panel = useStore((s) => s.panel);
  const hasDoc = useStore((s) => s.doc !== null);
  if (!panel || (!hasDoc && panel !== "about")) return null;
  return <PanelFrame key={`${panel}:${desktop}`} panel={panel} desktop={desktop} />;
}
