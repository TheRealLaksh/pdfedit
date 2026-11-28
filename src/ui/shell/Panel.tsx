/** Hosts store.panel: a side panel on desktop, a bottom sheet on phones. */
import { X } from "@phosphor-icons/react";
import { useId, useRef, type ReactNode } from "react";
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
import { useSwipeToClose } from "./swipe";
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
