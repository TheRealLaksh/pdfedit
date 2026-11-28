/** Floating prompts and contextual action bars over the viewer. */
import {
  ArrowClockwiseIcon, ArrowCounterClockwiseIcon, ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ArrowsInIcon,
  ArrowsOutCardinalIcon, CalendarBlankIcon, CheckIcon, CircleIcon, CopySimpleIcon, CrosshairSimpleIcon, ImageSquareIcon,
  MinusIcon, PencilSimpleIcon, PlusIcon, ScanIcon, TextTIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { engine } from "../../engine/client";
import type { PageObject, PageText, RGB, TextLine } from "../../engine/types";
import { toEngineImage, useStore, type ToolId } from "../../store";
import {
  addShapeInMiddle, canCopy, coverAndRetype, duplicate, focusViewer, KEYED_TOOLS, placeMark, readInitials, viewCentre,
  writeInitials,
} from "./actions";
import { useBackClose, useCompact } from "./device";
import { addTextAt, editTextObject } from "./editor/controller";
import { hexToRgb, rgbToHex } from "./geometry";
import { placeInMiddle } from "./layers/PlaceLayer";
import { usePageData } from "./pageData";
import { flushInk, undoInkStroke, useViewer, type Mark } from "./viewerStore";

/* ---------- top: scanned pages ---------- */

const needsRecognition = (text: PageText) =>
  (text.kind === "scanned" || text.kind === "garbled" || text.kind === "mixed") &&
  !text.lines.some((l) => l.source === "ocr");

const MESSAGE: Partial<Record<PageText["kind"], string>> = {
  scanned: "This page is a picture. Recognise its text to edit it.",
  garbled: "The text on this page is stored in a broken way. Recognise it to edit it.",
  mixed: "Some text on this page cannot be read. Recognise the page to edit that text too.",
};

export function PageNotice() {
  const tool = useStore((s) => s.tool);
  const page = useStore((s) => s.currentPage);
  const editing = useStore((s) => !!s.editing);
  const ocr = useStore((s) => s.ocr);
  const session = useStore((s) => s.session);
  const { data, error, retry } = usePageData("text", page, tool === "edit-text");
  const dismissed = useViewer((s) => s.dismissed);
  const locked = useViewer((s) => !!s.locked);
  const key = `${session}:${page}`;
  if (tool !== "edit-text" || editing || locked) return null;

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
      <button
        type="button"
        className="pv-btn pv-notice-close"
        aria-label="Dismiss"
        onClick={() => {
          useViewer.setState((s) => ({ dismissed: [...s.dismissed, key] }));
          focusViewer();
        }}
      >
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

  const [adjusting, setAdjusting] = useState(false);
  /** one tap per step: the selection frame gathers the steps and saves them together */
  const adjust = (dx: number, dy: number, grow = 1, turn = 0) =>
    window.dispatchEvent(new CustomEvent("pv-adjust", { detail: { dx, dy, grow, turn } }));
  const step = (label: string, icon: ReactNode, run: () => void) => (
    <button type="button" className="pv-btn" aria-label={label} title={label} onClick={run}>
      {icon}
    </button>
  );

  // within thumb reach: the shell puts its tool options away while something is selected
  return (
    <Bar label="Selected item" bottom>
      {adjusting && (
        <div className="pv-adjust" role="group" aria-label="Move and resize">
          {step("Move left", <ArrowLeftIcon />, () => adjust(-4, 0))}
          {step("Move up", <ArrowUpIcon />, () => adjust(0, -4))}
          {step("Move down", <ArrowDownIcon />, () => adjust(0, 4))}
          {step("Move right", <ArrowRightIcon />, () => adjust(4, 0))}
          {step("Smaller", <MinusIcon />, () => adjust(0, 0, 1 / 1.12))}
          {step("Larger", <PlusIcon />, () => adjust(0, 0, 1.12))}
          {selection.type === "object" && step("Turn", <ArrowClockwiseIcon />, () => adjust(0, 0, 1, 15))}
        </div>
      )}
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
        className="pv-btn"
        aria-label="Move and resize"
        title="Move and resize (arrow keys move)"
        aria-expanded={adjusting}
        onClick={() => setAdjusting((open) => !open)}
      >
        <ArrowsOutCardinalIcon />
      </button>
      {object && canCopy(object) && (
        <button type="button" className="pv-btn" aria-label="Duplicate" title="Duplicate (Ctrl+D)" onClick={() => void duplicate(object)}>
          <CopySimpleIcon />
        </button>
      )}
      <button
        type="button"
        className="pv-btn pv-btn-danger"
        aria-label="Delete"
        title="Delete"
        onClick={() => {
          focusViewer();
          void useStore.getState().deleteSelection();
        }}
      >
        <TrashIcon />
      </button>
      <button
        type="button"
        className="pv-btn"
        aria-label="Done"
        title="Deselect"
        onClick={() => {
          focusViewer();
          useStore.getState().select(null);
        }}
      >
        <CheckIcon />
      </button>
    </Bar>
  );
}

/* ---------- a line that cannot be edited ---------- */

/** why, and what can be done instead */
function lockedAdvice(line: TextLine, recognised: boolean) {
  const note = line.note ?? "";
  if (/too long/i.test(note))
    return { text: "This line is too long to edit in place. Cover it and retype it.", read: false, cover: true, prefill: true };
  if (/hidden|invisible|scanned/i.test(note))
    return { text: "This text is part of a scan. Read the page to edit what you see.", read: !recognised, cover: recognised, prefill: false };
  if (/legacy|broken|mapped|encoding/i.test(note))
    return {
      text: recognised
        ? "The file stores these letters in a way that cannot be read. Cover the line and retype it."
        : "The file stores these letters in a way that cannot be read. Read the page as a picture, or cover the line and retype it.",
      read: !recognised, cover: true, prefill: false,
    };
  return { text: note || "Cover it and retype it.", read: false, cover: true, prefill: false };
}

function LockedBar() {
  const locked = useViewer((s) => s.locked)!;
  const revision = useStore((s) => s.doc?.pages[locked.page]?.revision);
  const recognised = useStore((s) => s.ocr.done.includes(locked.page));
  const reading = useStore((s) => s.ocr.running);
  const [opened] = useState(revision);
  const close = () => {
    useViewer.setState({ locked: null });
    focusViewer();
  };
  useBackClose(true, close);
  // the page changed underneath: the line is not that line any more
  useEffect(() => {
    if (revision !== opened) useViewer.setState({ locked: null });
  }, [revision, opened]);
  const advice = lockedAdvice(locked.line, recognised);

  return (
    <div
      className="pv-locked"
      data-pv-ui=""
      role="dialog"
      aria-labelledby="pv-locked-title"
      data-testid="locked-bar"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <strong id="pv-locked-title">This line cannot be edited directly</strong>
      <p>
        {advice.text}
        {advice.cover ? " The old text stays in the file underneath; Redact removes it." : ""}
      </p>
      <div className="pv-locked-actions">
        {advice.read && !reading && (
          <button
            type="button"
            className="pv-btn pv-btn-text pv-btn-primary"
            autoFocus
            onClick={() => {
              close();
              void useStore.getState().runOcr([locked.page]);
            }}
          >
            Read this page
          </button>
        )}
        {advice.cover && (
          <button
            type="button"
            className={`pv-btn pv-btn-text ${advice.read && !reading ? "pv-btn-outline" : "pv-btn-primary"}`}
            autoFocus={!advice.read || reading}
            onClick={() => void coverAndRetype(locked.line, advice.prefill ? locked.line.text : "")}
          >
            Cover and retype
          </button>
        )}
        <button type="button" className="pv-btn pv-btn-text" onClick={close}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---------- add text: writing, or marks for forms without fields ---------- */

const MARKS: [Mark, string, ReactNode][] = [
  ["text", "Text", <TextTIcon key="t" />],
  ["tick", "Tick", <CheckIcon key="c" weight="bold" />],
  ["cross", "Cross", <XIcon key="x" weight="bold" />],
  ["dot", "Dot", <CircleIcon key="d" weight="fill" />],
  ["date", "Date", <CalendarBlankIcon key="a" />],
  ["initials", "Initials", <span key="i" aria-hidden className="pv-initials">AB</span>],
];

function MarksBar() {
  const mark = useViewer((s) => s.mark);
  const [initials, setInitials] = useState(readInitials);
  return (
    <div className="pv-marks" data-pv-ui="" role="toolbar" aria-label="What a tap adds" data-testid="marks-bar">
      {MARKS.map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          className="pv-btn pv-mark"
          aria-pressed={mark === value}
          onClick={() => useViewer.setState({ mark: value })}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
      <button
        type="button"
        className="pv-btn pv-mark"
        aria-label="Add in the middle of the view"
        title="Add in the middle of the view"
        onClick={() => {
          const spot = viewCentre();
          if (!spot) return;
          if (mark === "text") addTextAt(spot.page, spot.at);
          else void placeMark(spot.page, spot.at, mark);
        }}
      >
        <CrosshairSimpleIcon />
        <span>Middle</span>
      </button>
      {mark === "initials" && (
        <input
          className="pv-initials-input"
          aria-label="Your initials"
          placeholder="Your initials"
          maxLength={12}
          autoComplete="off"
          value={initials}
          onChange={(e) => {
            setInitials(e.target.value);
            writeInitials(e.target.value);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      )}
    </div>
  );
}

const SHAPE_NAMES: Partial<Record<ToolId, string>> = {
  rect: "rectangle", ellipse: "ellipse", line: "line", arrow: "arrow", whiteout: "whiteout", redact: "redaction area",
};

/** tab to it: the same shapes a finger drags, put in the middle of the view */
function KeyedShape({ tool }: { tool: ToolId }) {
  return (
    <button type="button" className="pv-skip" data-pv-ui="" onClick={() => void addShapeInMiddle()}>
      Add a {SHAPE_NAMES[tool]} in the middle of the view
    </button>
  );
}

function PlaceBar() {
  return (
    <button type="button" className="pv-fit pv-place-middle" data-pv-ui="" onClick={placeInMiddle}>
      <CrosshairSimpleIcon aria-hidden /> Place in the middle
    </button>
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

/**
 * Phones: the view stays magnified after editing (it never jumps back on its own), so the way back to the
 * whole page is one tap away.
 */
function FitButton() {
  const compact = useCompact();
  const zoomed = useStore((s) => s.zoom !== "fit");
  if (!compact || !zoomed) return null;
  return (
    <button
      type="button"
      className="pv-fit"
      data-pv-ui=""
      onClick={() => {
        useViewer.setState({ bottomInset: 0 });
        useStore.getState().setZoom("fit");
      }}
    >
      <ArrowsInIcon aria-hidden /> Fit page
    </button>
  );
}

/** most actions sit at the top: the shell's tool options own the bottom edge */
export function ActionOverlay() {
  const tool = useStore((s) => s.tool);
  const editing = useStore((s) => !!s.editing);
  const selection = useStore((s) => !!s.selection);
  const redacting = useViewer((s) => Object.keys(s.redactions).length > 0);
  const inking = useViewer((s) => !!s.ink);
  const notice = useViewer((s) => s.hint);
  const switching = useViewer((s) => s.switching);
  const locked = useViewer((s) => !!s.locked);
  const field = useViewer((s) => !!s.field);
  const placing = useStore((s) => !!s.placement);
  if (switching) return null;
  if (editing) {
    // someone who has opened a line does not need to be told how
    hinted = true;
    return null;
  }
  const keyed = KEYED_TOOLS.includes(tool) ? <KeyedShape key="keyed" tool={tool} /> : null;
  if (redacting)
    return (
      <>
        {keyed}
        <RedactionBar />
      </>
    );
  if (locked && tool === "edit-text") return <LockedBar />;
  if (placing) return <PlaceBar />;
  const hint = notice && (
    <div className="pv-hint" role="status">
      {notice}
    </div>
  );
  if (selection)
    return (
      <>
        {hint}
        <SelectionBar />
      </>
    );
  if (inking) return <InkBar />;
  return (
    <>
      {keyed}
      {tool === "add-text" && <MarksBar />}
      {hint}
      {tool === "edit-text" && !hint && !field && (
        <>
          <Hint />
          <FitButton />
        </>
      )}
    </>
  );
}
