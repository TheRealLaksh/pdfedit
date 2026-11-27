/** Top bar: file, history, zoom, page, search, download. */
import {
  ArrowUUpLeft, ArrowUUpRight, CaretDown, CaretLeft, CaretRight, CaretUpDown, DotsThreeVertical, DownloadSimple,
  House, ListChecks, MagnifyingGlass, MagnifyingGlassMinus, MagnifyingGlassPlus, SquaresFour,
} from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import type { DocInfo } from "../../engine/types";
import { useStore, type PanelId } from "../../store";
import { closeDocument, downloadWhenReady } from "./actions";
import { Button, IconButton } from "./controls";
import { Logo } from "./Logo";
import { useShell } from "./uiStore";

export function togglePanel(panel: PanelId): void {
  const state = useStore.getState();
  useShell.getState().setMenu(false);
  state.openPanel(state.panel === panel ? null : panel);
}

/** CSS pixels per point that "fit width" currently stands for (close enough to step from) */
function fitScale(doc: DocInfo, page: number): number {
  const width = document.querySelector(".sh-viewer")?.clientWidth ?? window.innerWidth;
  return Math.max(0.2, (width - 32) / (doc.pages[page]?.width || 612));
}

export function useZoom() {
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const step = (factor: number) => {
    const { doc, currentPage, zoom } = useStore.getState();
    if (!doc) return;
    setZoom((zoom === "fit" ? fitScale(doc, currentPage) : zoom) * factor);
  };
  return {
    zoom,
    // 100% = actual size (96 CSS px per inch)
    label: zoom === "fit" ? "Fit" : `${Math.round(zoom * 75)}%`,
    zoomIn: () => step(1.25),
    zoomOut: () => step(0.8),
    toggleFit: () => setZoom(zoom === "fit" ? 96 / 72 : "fit"),
  };
}

function PageNav() {
  const page = useStore((s) => s.currentPage);
  const count = useStore((s) => s.doc!.pageCount);
  const scrollTo = useStore((s) => s.scrollTo);
  const [draft, setDraft] = useState<string | null>(null);
  const go = (index: number) => scrollTo(Math.min(count - 1, Math.max(0, index)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(draft);
    if (draft !== null && Number.isInteger(n)) go(n - 1);
    setDraft(null);
  };
  return (
    <div className="sh-group sh-pagenav">
      <IconButton icon={CaretLeft} size={18} label="Previous page" disabled={page <= 0} onClick={() => go(page - 1)} />
      <form onSubmit={submit}>
        <input
          className="sh-input sh-page-input"
          inputMode="numeric"
          name="page"
          autoComplete="off"
          aria-label="Page number"
          value={draft ?? String(page + 1)}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
          onBlur={() => setDraft(null)}
        />
      </form>
      <span className="sh-page-count">/ {count}</span>
      <IconButton icon={CaretRight} size={18} label="Next page" disabled={page >= count - 1} onClick={() => go(page + 1)} />
    </div>
  );
}

export function TopBar({ desktop }: { desktop: boolean }) {
  const doc = useStore((s) => s.doc)!;
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const busy = useStore((s) => s.busy !== null);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const panel = useStore((s) => s.panel);
  const page = useStore((s) => s.currentPage);
  const menuOpen = useShell((s) => s.menuOpen);
  const setMenu = useShell((s) => s.setMenu);
  const zoom = useZoom();

  const history = (
    <div className="sh-group">
      <IconButton icon={ArrowUUpLeft} label="Undo" hint={desktop ? "Ctrl+Z" : undefined} disabled={!canUndo || busy} onClick={() => void undo()} />
      <IconButton icon={ArrowUUpRight} label="Redo" hint={desktop ? "Ctrl+Y" : undefined} disabled={!canRedo || busy} onClick={() => void redo()} />
    </div>
  );

  const name = (
    <>
      <span className="sh-filename-text" title={doc.fileName}>
        {doc.fileName}
      </span>
      {dirty && (
        <span className="sh-dirty" title="Changes not downloaded">
          <span className="sh-sr">Changes not downloaded</span>
        </span>
      )}
    </>
  );

  if (!desktop)
    return (
      <header className="sh-top">
        <IconButton icon={House} label="Close document" onClick={() => void closeDocument()} />
        <button
          type="button"
          className="sh-filename sh-filename-btn"
          aria-label={`${doc.fileName}, page ${page + 1} of ${doc.pageCount}${dirty ? ", changes not downloaded" : ""}. Open pages`}
          onClick={() => togglePanel("pages")}
        >
          <span className="sh-filename-line">{name}</span>
          <span className="sh-filename-sub">
            Page {page + 1} of {doc.pageCount}
            <CaretUpDown size={12} aria-hidden />
          </span>
        </button>
        {history}
        <button
          type="button"
          className="sh-iconbtn sh-iconbtn-primary"
          aria-label="Download PDF"
          title="Download PDF"
          onClick={() => void downloadWhenReady()}
        >
          <DownloadSimple size={22} weight="bold" aria-hidden />
        </button>
      </header>
    );

  return (
    <header className="sh-top">
      <button type="button" className="sh-home" aria-label="Close document" title="Close document" onClick={() => void closeDocument()}>
        <Logo />
      </button>
      <h1 className="sh-filename">{name}</h1>
      <Button variant="ghost" icon={SquaresFour} aria-pressed={panel === "pages"} onClick={() => togglePanel("pages")}>
        Pages
      </Button>
      {doc.hasForms && (
        <Button variant="ghost" icon={ListChecks} aria-pressed={panel === "forms"} onClick={() => togglePanel("forms")}>
          Forms
        </Button>
      )}
      <span className="sh-spacer" />
      {history}
      <div className="sh-group sh-zoom">
        <IconButton icon={MagnifyingGlassMinus} size={20} label="Zoom out" onClick={zoom.zoomOut} />
        <button
          type="button"
          className="sh-zoom-value"
          title={zoom.zoom === "fit" ? "Show at actual size" : "Fit to width"}
          aria-label={`Zoom: ${zoom.label}. ${zoom.zoom === "fit" ? "Show at actual size" : "Fit to width"}`}
          onClick={zoom.toggleFit}
        >
          {zoom.label}
        </button>
        <IconButton icon={MagnifyingGlassPlus} size={20} label="Zoom in" onClick={zoom.zoomIn} />
      </div>
      <PageNav />
      <span className="sh-spacer" />
      <IconButton icon={MagnifyingGlass} label="Find and replace" hint="Ctrl+F" pressed={panel === "find"} onClick={() => togglePanel("find")} />
      <IconButton
        icon={DotsThreeVertical}
        label="More"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={() => setMenu(!menuOpen)}
      />
      <div className="sh-download">
        <Button variant="primary" icon={DownloadSimple} onClick={() => void downloadWhenReady()}>
          Download
        </Button>
        <IconButton
          icon={CaretDown}
          size={16}
          label="Download options"
          aria-expanded={panel === "export"}
          onClick={() => togglePanel("export")}
          className="sh-download-more"
        />
      </div>
    </header>
  );
}
