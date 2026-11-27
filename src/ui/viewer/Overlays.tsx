/** Floating prompts and contextual action bars over the viewer. */
import {
  ArrowCounterClockwiseIcon, CheckIcon, ImageSquareIcon, PencilSimpleIcon, ScanIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { engine } from "../../engine/client";
import type { PageObject, PageText, RGB } from "../../engine/types";
import { toEngineImage, useStore } from "../../store";
import { useCompact } from "./device";
import { editTextObject } from "./editor/controller";
import { hexToRgb, rgbToHex } from "./geometry";
import { usePageData } from "./pageData";
import { flushInk, undoInkStroke, useViewer } from "./viewerStore";

/* ---------- top: scanned pages ---------- */

const needsRecognition = (text: PageText) =>
  (text.kind === "scanned" || text.kind === "garbled" || text.kind === "mixed") &&
  !text.lines.some((l) => l.source === "ocr");

const MESSAGE: Partial<Record<PageText["kind"], string>> = {
  scanned: "This page is a picture. Recognise its text to edit it.",
  garbled: "The text on this page is stored in a broken way. Recognise it to edit it.",
  mixed: "Part of this page is a picture. Recognise it to edit that text too.",
};

export function PageNotice() {
  const tool = useStore((s) => s.tool);
  const page = useStore((s) => s.currentPage);
  const editing = useStore((s) => !!s.editing);
  const ocr = useStore((s) => s.ocr);
  const session = useStore((s) => s.session);
  const { data, error, retry } = usePageData("text", page, tool === "edit-text");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const key = `${session}:${page}`;
  if (tool !== "edit-text" || editing) return null;

  // progress and the stop button are the shell's status chip
  if (ocr.running) return null;
  if (error)
    return (
      <div className="pv-notice" data-pv-ui="" role="status">
        <div className="pv-notice-text">The text on page {page + 1} could not be read.</div>
        <button type="button" className="pv-btn pv-btn-text" onClick={retry}>
          Try again
        </button>
      </div>
    );
  if (!data || !needsRecognition(data) || dismissed.includes(key)) return null;
  return (
    <div className="pv-notice" data-pv-ui="" role="status" data-testid="ocr-prompt">
      <ScanIcon className="pv-notice-icon" />
      <div className="pv-notice-text">{MESSAGE[data.kind]}</div>
      <button type="button" className="pv-btn pv-btn-primary pv-btn-text" onClick={() => void useStore.getState().runOcr([page])}>
        Recognise text on this page
      </button>
      <button type="button" className="pv-btn pv-notice-close" aria-label="Dismiss" onClick={() => setDismissed((d) => [...d, key])}>
        <XIcon />
      </button>
    </div>
  );
}

/* ---------- one contextual bar at a time ---------- */

function Bar({ children, label, bottom }: { children: ReactNode; label: string; bottom?: boolean }) {
  return (
    <div className={bottom ? "pv-bar pv-bar-bottom" : "pv-bar"} data-pv-ui="" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

function RedactionBar() {
  const redactions = useViewer((s) => s.redactions);
  const count = Object.values(redactions).reduce((n, r) => n + r.length, 0);
  const apply = async () => {
    const entries = Object.entries(useViewer.getState().redactions);
    useViewer.setState({ redactions: {} });
    const result = await useStore.getState().run("Redacting", async () => {
      let last;
      for (const [page, rects] of entries) last = await engine.redactAreas(Number(page), rects);
      return last!;
    });
    if (!result) useViewer.setState({ redactions: Object.fromEntries(entries) });
  };
  return (
    <Bar label="Confirm redaction">
      <span className="pv-bar-text">
        Permanently remove everything under {count === 1 ? "this area" : `these ${count} areas`}?
      </span>
      <button type="button" className="pv-btn pv-btn-text" onClick={() => useViewer.setState({ redactions: {} })}>
        Cancel
      </button>
      <button type="button" className="pv-btn pv-btn-text pv-btn-destructive" onClick={apply} data-testid="redact-confirm">
        Redact
      </button>
    </Bar>
  );
}

function SelectionBar() {
  const selection = useStore((s) => s.selection)!;
  const objects = usePageData("objects", selection.page, selection.type === "object");
  const object = selection.type === "object" ? objects.last?.find((o) => o.id === selection.id) : undefined;

  const update = (next: PageObject) => void useStore.getState().updateObject(next);
  const colour: RGB | null | undefined = !object
    ? undefined
    : object.kind === "text"
      ? object.style.color
      : object.kind === "line" || object.kind === "arrow" || object.kind === "ink"
        ? object.stroke
        : object.kind === "highlight"
          ? object.fill
          : object.kind === "rect" || object.kind === "ellipse"
            ? (object.stroke ?? object.fill)
            : undefined;

  const recolour = (c: RGB) => {
    if (!object) return;
    if (object.kind === "text") update({ ...object, style: { ...object.style, color: c } });
    else if (object.kind === "line" || object.kind === "arrow" || object.kind === "ink") update({ ...object, stroke: c });
    else if (object.kind === "highlight") update({ ...object, fill: c });
    else if (object.kind === "rect" || object.kind === "ellipse")
      update(object.stroke ? { ...object, stroke: c } : { ...object, fill: c });
  };

  const width =
    object && (object.kind === "line" || object.kind === "arrow" || object.kind === "ink" || ((object.kind === "rect" || object.kind === "ellipse") && object.stroke))
      ? (object as { strokeWidth?: number }).strokeWidth ?? 1
      : undefined;

  const replace = async (file: File) => {
    if (selection.type !== "image") return;
    try {
      const data = await toEngineImage(file);
      await useStore.getState().run("Replacing image", () => engine.replaceImage(selection.page, selection.id, data));
    } catch (e) {
      useStore.getState().toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // within thumb reach: the shell puts its tool options away while something is selected
  return (
    <Bar label="Selected item" bottom>
      {object?.kind === "text" && (
        <button type="button" className="pv-btn pv-btn-text" onClick={() => editTextObject(selection.page, object.id)}>
          <PencilSimpleIcon /> Edit
        </button>
      )}
      {colour && (
        // saved when the picker closes, not for every shade passed on the way
        <ColourButton key={rgbToHex(colour)} value={rgbToHex(colour)} onPick={(hex) => recolour(hexToRgb(hex))} />
      )}
      {width !== undefined && object && (
        <select
          className="pv-select pv-select-small"
          aria-label="Line width"
          value={String(width)}
          onChange={(e) => update({ ...object, strokeWidth: Number(e.target.value) } as PageObject)}
        >
          {[...new Set([0.5, 1, 2, 4, 6, 10, width])].sort((a, b) => a - b).map((w) => (
            <option key={w} value={w}>
              {Math.round(w * 10) / 10} pt
            </option>
          ))}
        </select>
      )}
      {selection.type === "image" && (
        <label className="pv-btn pv-btn-text">
          <ImageSquareIcon /> Replace
          <input
            type="file"
            accept="image/*"
            className="pv-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void replace(file);
            }}
          />
        </label>
      )}
      <button
        type="button"
        className="pv-btn pv-btn-danger"
        aria-label="Delete"
        title="Delete"
        onClick={() => void useStore.getState().deleteSelection()}
      >
        <TrashIcon />
      </button>
      <button
        type="button"
        className="pv-btn"
        aria-label="Done"
        title="Deselect"
        onClick={() => useStore.getState().select(null)}
      >
        <CheckIcon />
      </button>
    </Bar>
  );
}

function ColourButton({ value, onPick }: { value: string; onPick(hex: string): void }) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="pv-btn pv-colour" title="Colour">
      <span style={{ background: draft }} />
      <input
        type="color"
        aria-label="Colour"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        ref={(el) => {
          if (!el) return;
          // the native "change" event fires once, on close (React's onChange fires continuously)
          const commit = () => el.value !== value && onPick(el.value);
          el.addEventListener("change", commit);
          return () => el.removeEventListener("change", commit);
        }}
      />
    </label>
  );
}

function InkBar() {
  return (
    <Bar label="Drawing">
      <button type="button" className="pv-btn pv-btn-text" onClick={() => undoInkStroke()}>
        <ArrowCounterClockwiseIcon /> Undo stroke
      </button>
      <button type="button" className="pv-btn pv-btn-text" onClick={() => void flushInk()}>
        <CheckIcon /> Save
      </button>
    </Bar>
  );
}

let hinted = false;

/** a one-time nudge for the main feature (the shell explains the other tools) */
function Hint() {
  const compact = useCompact();
  const [shown, setShown] = useState(!hinted);
  // yes or no, so that scrolling between pages does not restart the timer
  const found = !!usePageData("text", useStore((s) => s.currentPage), shown).data?.lines.length;
  useEffect(() => {
    if (!shown || !found) return;
    const timer = setTimeout(() => {
      hinted = true;
      setShown(false);
    }, 3500);
    return () => clearTimeout(timer);
  }, [shown, found]);
  if (!shown || !found) return null;
  return (
    <div className="pv-hint" role="status">
      {compact ? "Tap any text to change it" : "Click any text to change it"}
    </div>
  );
}

/** most actions sit at the top: the shell's tool options own the bottom edge */
export function ActionOverlay() {
  const tool = useStore((s) => s.tool);
  const editing = useStore((s) => !!s.editing);
  const selection = useStore((s) => !!s.selection);
  const redacting = useViewer((s) => Object.keys(s.redactions).length > 0);
  const inking = useViewer((s) => !!s.ink);
  if (editing) {
    // someone who has opened a line does not need to be told how
    hinted = true;
    return null;
  }
  if (redacting) return <RedactionBar />;
  if (selection) return <SelectionBar />;
  if (inking) return <InkBar />;
  return tool === "edit-text" ? <Hint /> : null;
}
