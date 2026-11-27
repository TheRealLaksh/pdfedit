/** Busy overlay, toasts, drop target and the small status chips (placement, text recognition). */
import { CheckCircle, FileArrowUp, Info, Warning, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { engineReady } from "../../engine/client";
import { useStore, type Toast } from "../../store";
import { Button, IconButton, Progress } from "./controls";

/** quick edits must not flash a spinner */
const DELAY = 350;

let engineLoaded = false;
void engineReady.then(() => (engineLoaded = true));

/** true while the wait is really for the first download of the editor (a cached start is over sooner) */
function useDownloadingEditor(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting || engineLoaded) return;
    let live = true;
    const timer = setTimeout(() => live && !engineLoaded && setSlow(true), 800);
    void engineReady.then(() => live && setSlow(false));
    return () => {
      live = false;
      clearTimeout(timer);
      setSlow(false);
    };
  }, [waiting]);
  return slow;
}

export function BusyOverlay() {
  const busy = useStore((s) => s.busy);
  const [visible, setVisible] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const active = busy !== null;
  const slowStart = !!busy && /^(Opening|Preparing|Turning|Adding|Reading)/.test(busy);
  const downloading = useDownloadingEditor(active);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), slowStart ? 60 : DELAY);
    return () => clearTimeout(timer);
  }, [active, slowStart]);

  return (
    <div className="sh-busy" data-visible={(visible && active) || undefined} role="status" aria-live="polite">
      {visible && busy && (
        <div ref={card} className="sh-busy-card">
          <span className="sh-spinner" aria-hidden />
          <span className="sh-break">{downloading ? "Downloading the editor (first visit only)" : busy}…</span>
        </div>
      )}
    </div>
  );
}

const ICONS = { info: Info, success: CheckCircle, warning: Warning, error: WarningCircle };

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  const Glyph = ICONS[toast.kind];
  return (
    <li className={`sh-toast sh-toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : undefined}>
      <Glyph size={20} weight="fill" aria-label={toast.kind} />
      <div className="sh-toast-body">
        <p>{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            className="sh-link"
            onClick={() => {
              toast.action!.run();
              dismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <IconButton icon={X} size={18} label="Dismiss notice" onClick={() => dismiss(toast.id)} />
    </li>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <ol className="sh-toasts" aria-live="polite" aria-label="Notices">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </ol>
  );
}

/** highlights the window while files are dragged over it, then hands them to `onFiles` */
export function DropTarget({ onFiles, label }: { onFiles(files: File[]): void; label: string }) {
  const [over, setOver] = useState(false);
  const handler = useRef(onFiles);
  useEffect(() => {
    handler.current = onFiles;
  });

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const move = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!hasFiles(e)) return;
      // a component further down may already have taken the files
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length && !useStore.getState().busy) handler.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", move);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", move);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  if (!over) return null;
  return (
    <div className="sh-drop" aria-hidden>
      <div>
        <FileArrowUp size={32} />
        {label}
      </div>
    </div>
  );
}

export function StatusChips() {
  const placement = useStore((s) => s.placement);
  const setPlacement = useStore((s) => s.setPlacement);
  const setTool = useStore((s) => s.setTool);
  const ocr = useStore((s) => s.ocr);
  const panel = useStore((s) => s.panel);
  const cancelOcr = useStore((s) => s.cancelOcr);
  const openPanel = useStore((s) => s.openPanel);
  const showOcr = ocr.running && panel !== "ocr";
  if (!placement && !showOcr) return null;
  return (
    <div className="sh-chips">
      {placement && (
        <div className="sh-chip" role="status">
          <span>Tap the page to place your {placement.kind === "ink" ? "signature" : "image"}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setPlacement(null);
              setTool("edit-text");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {showOcr && (
        <div className="sh-chip">
          <button type="button" className="sh-chip-main" onClick={() => openPanel("ocr")}>
            <span>Recognising page {(ocr.progress?.page ?? 0) + 1}</span>
            <Progress value={ocr.progress?.progress ?? 0} label="Text recognition progress" />
          </button>
          <Button variant="ghost" onClick={cancelOcr}>
            Stop
          </Button>
        </div>
      )}
    </div>
  );
}
