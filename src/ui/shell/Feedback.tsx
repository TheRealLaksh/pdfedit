/** Busy overlay, notices, drop target, spoken announcements and the small status chips. */
import { CheckCircle, FileArrowUp, Info, Warning, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { engineReady } from "../../engine/client";
import { useStore, type Toast } from "../../store";
import { useBoot } from "./boot";
import { Button, IconButton, Progress } from "./controls";
import { useCompactNotices } from "./hooks";

/** quick edits must not flash a spinner */
const DELAY = 350;
/** after this long, say that the wait is still going somewhere */
const LONG = 5000;
/**
 * Changes to one thing on a page. Saving them must not cover the screen: the viewer keeps a tap made in the
 * meantime and answers it when the page is ready, so the next line can be picked at once.
 */
const QUIET = new Set(["Updating text", "Adding", "Updating", "Moving image", "Replacing image", "Highlighting", "Deleting"]);

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
  const [long, setLong] = useState(false);
  const active = busy !== null;
  const quiet = busy !== null && QUIET.has(busy);
  const slowStart = !!busy && /^(Opening|Preparing|Turning|Adding|Reading|Making)/.test(busy);
  const downloading = useDownloadingEditor(active);
  const percent = useBoot((s) => s.percent);

  useEffect(() => {
    setLong(false);
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), slowStart ? 60 : quiet ? DELAY * 2 : DELAY);
    const later = setTimeout(() => setLong(true), LONG);
    return () => {
      clearTimeout(timer);
      clearTimeout(later);
    };
  }, [active, slowStart, quiet]);

  // the overlay stops the pointer; the keyboard must not reach the controls behind it either
  const blocking = visible && active && !quiet;
  useEffect(() => {
    if (!blocking) return;
    const before = document.activeElement as HTMLElement | null;
    const behind = Array.from(document.querySelectorAll<HTMLElement>(".sh-app, .sh-start, .sh-modal"));
    for (const node of behind) node.inert = true;
    return () => {
      for (const node of behind) node.inert = false;
      if (before?.isConnected && document.activeElement === document.body) before.focus({ preventScroll: true });
    };
  }, [blocking]);

  return (
    <div className="sh-busy" data-visible={(visible && active) || undefined} data-quiet={quiet || undefined} role="status" aria-live="polite">
      {visible && busy && (
        <div className="sh-busy-card">
          <span className="sh-spinner" aria-hidden />
          <span className="sh-break">
            {downloading ? "Downloading the editor (first visit only)" : busy}…
            {long && !quiet && !downloading && <small>Still working. A font may be downloading.</small>}
            {downloading && percent !== null && (
              <>
                <small>{percent}% of about 5 MB</small>
                <Progress value={percent / 100} label="Editor download" />
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

const ICONS = { info: Info, success: CheckCircle, warning: Warning, error: WarningCircle };

/** how long a passing notice stays, in milliseconds */
const lifetime = (t: Toast) => (t.kind === "error" || t.kind === "warning" ? 12_000 : t.action ? 10_000 : 6000);

/** counts the notice's time only while it can be read */
function useExpiry(toast: Toast, paused: boolean) {
  const dismiss = useStore((s) => s.dismissToast);
  const left = useRef(lifetime(toast));
  useEffect(() => {
    if (toast.sticky || paused) return;
    let since = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      if (since) left.current -= Date.now() - since;
      since = 0;
    };
    const run = () => {
      stop();
      if (document.hidden) return;
      since = Date.now();
      // after being held, it stays long enough to be seen again
      left.current = Math.max(2000, left.current);
      timer = setTimeout(() => dismiss(toast.id), left.current);
    };
    run();
    document.addEventListener("visibilitychange", run);
    return () => {
      document.removeEventListener("visibilitychange", run);
      stop();
    };
  }, [toast.id, toast.sticky, paused, dismiss]);
}

function ToastItem({ toast, hidden, more }: { toast: Toast; hidden: boolean; more: number }) {
  const dismiss = useStore((s) => s.dismissToast);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  useExpiry(toast, hidden || hover || focus);
  const Glyph = ICONS[toast.kind];
  return (
    <li
      className={`sh-toast sh-toast-${toast.kind}`}
      role={toast.kind === "error" ? "alert" : undefined}
      hidden={hidden}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocus(false)}
      // a finger on the note puts it away at once, so it is never in the way of the page
      onPointerUp={(e) => {
        if (e.pointerType === "mouse" || (e.target as Element).closest("button")) return;
        // after this tap's click, so that it does not land on what is underneath
        setTimeout(() => dismiss(toast.id), 80);
      }}
    >
      <Glyph size={20} weight="fill" aria-label={toast.kind} />
      <div className="sh-toast-body">
        <p>{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            className="sh-link"
            onClick={() => {
              // straight from the click: sharing and file pickers need it
              toast.action!.run();
              dismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
        {more > 0 && <small className="sh-toast-more">{more === 1 ? "1 more notice" : `${more} more notices`}</small>}
      </div>
      <IconButton icon={X} size={18} label="Dismiss notice" onClick={() => dismiss(toast.id)} />
    </li>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const editing = useStore((s) => s.editing !== null);
  const compact = useCompactNotices();
  // phones show one at a time, the newest; errors always show
  const newest = [...toasts].reverse().find((t) => t.kind !== "error");
  const waiting = compact ? toasts.filter((t) => t.kind !== "error" && t !== newest).length : 0;
  return (
    <ol className="sh-toasts" aria-live="polite" aria-label="Notices">
      {toasts.map((t) => {
        // while a line is being typed only errors may appear: nothing else is worth covering the page for
        const hidden = t.kind !== "error" && (editing || (compact && t !== newest));
        return <ToastItem key={t.id} toast={t} hidden={hidden} more={t === newest ? waiting : 0} />;
      })}
    </ol>
  );
}

/** tells screen readers what changed, because the page itself is a picture to them */
export function Announcer() {
  const { text, nonce } = useStore((s) => s.announcement);
  return (
    <div className="sh-sr" role="status" aria-live="polite" data-testid="announcer">
      {/* a new node each time, so the same words are read again */}
      <span key={nonce}>{text}</span>
    </div>
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
