/**
 * The phone editor's controls, docked above the keyboard: one row that always fits (nothing scrolls out of
 * sight) and a second row that opens for size and font, colour, the less common actions and moving.
 */
import {
  ArrowCounterClockwiseIcon, ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ArrowsInLineHorizontalIcon,
  ArrowsOutCardinalIcon, CaretLeftIcon, CheckIcon, DotsThreeIcon, MinusIcon, PlusIcon, TextAaIcon, TextBIcon,
  TextItalicIcon, TextUnderlineIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { RGB } from "../../../engine/types";
import { useStore } from "../../../store";
import { useCompact } from "../device";
import { hexToRgb, rgbToHex } from "../geometry";
import { useViewer } from "../viewerStore";
import { Dock } from "./Dock";
import { ALIGN, GROUPS, shownSize, useFonts, useNudge, type StyleBarProps } from "./StyleBar";

const SWATCHES: [string, string][] = [
  ["#111114", "Black"],
  ["#5f5f66", "Grey"],
  ["#ffffff", "White"],
  ["#c0262d", "Red"],
  ["#1d4ed8", "Blue"],
  ["#15803d", "Green"],
];

type Panel = "size" | "colour" | "more" | null;

/** controls must not take the focus (the keyboard would close), except the ones that open a native picker */
const keepFocus = (e: MouseEvent) => {
  if (!(e.target as Element).closest("select, input[type=color]")) e.preventDefault();
};

function Key({ label, pressed, expanded, danger, caption, onClick, children }: {
  label: string;
  pressed?: boolean;
  expanded?: boolean;
  danger?: boolean;
  /** visible text under the icon */
  caption?: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`pv-btn pv-key${danger ? " pv-btn-danger" : ""}${caption ? " pv-key-captioned" : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      title={label}
      onClick={onClick}
    >
      {children}
      {caption && <span>{caption}</span>}
    </button>
  );
}

export function PhoneBar(props: StyleBarProps & {
  /** very little height (a phone held sideways): the second row takes the place of the first */
  short: boolean;
  /** hardly any height left above the keyboard: only Cancel and Done, in a corner */
  tiny: boolean;
  /** after a native picker closed */
  refocus(): void;
  onCancel(): void;
  onDone(): void;
}) {
  const { style, align, onStyle, short, moving } = props;
  const [open, setOpen] = useState<Panel>(null);
  const fonts = useFonts();
  const nudge = useNudge(props.onNudge);
  const panel = moving ? "move" : open;
  const toggle = (next: Panel) => {
    props.onMoving(false);
    setOpen(panel === next ? null : next);
  };
  const back = () => {
    props.onMoving(false);
    setOpen(moving ? "more" : null);
  };
  const setSize = (size: number) => onStyle({ size: Math.round(Math.min(600, Math.max(2, size)) * 10) / 10 });
  const colour = rgbToHex(style.color);
  const setColour = (c: RGB) => onStyle({ color: c });

  const cancel = (
    <button type="button" className="pv-btn pv-key" aria-label="Cancel" title="Cancel" onClick={props.onCancel} data-testid="editor-cancel">
      <XIcon />
    </button>
  );
  const done = (
    <button type="button" className="pv-btn pv-key pv-btn-primary pv-key-done" aria-label="Done" title="Done" onClick={props.onDone} data-testid="editor-done">
      <CheckIcon weight="bold" />
    </button>
  );

  const alignKeys = ALIGN.map(([value, label, icon]) => (
    <Key key={value} label={label} pressed={align === value} onClick={() => props.onAlign(value)}>
      {icon}
    </Key>
  ));
  const underline = (
    <Key label="Underline" pressed={!!style.underline} onClick={() => onStyle({ underline: !style.underline })}>
      <TextUnderlineIcon />
    </Key>
  );
  const extras = (captions: boolean) => (
    <>
      {props.onShrink && (
        <Key
          label="Shrink to fit the original width"
          caption={captions ? "Fit width" : undefined}
          pressed={!!props.shrink}
          onClick={() => props.onShrink!(!props.shrink)}
        >
          <ArrowsInLineHorizontalIcon />
        </Key>
      )}
      <Key label="Move" caption={captions ? "Move" : undefined} onClick={() => props.onMoving(true)}>
        <ArrowsOutCardinalIcon />
      </Key>
      <Key label="Delete this text" caption={captions ? "Delete" : undefined} danger onClick={props.onDelete}>
        <TrashIcon />
      </Key>
    </>
  );

  let content: ReactNode = null;
  if (panel === "size")
    content = (
      <div className="pv-row">
        <select
          className="pv-select pv-select-fill"
          aria-label="Font"
          value={style.fontChoice ?? ""}
          onChange={(e) => {
            onStyle({ fontChoice: e.target.value || undefined });
            props.refocus();
          }}
        >
          <option value="">{props.defaultFont}</option>
          {GROUPS.map(([source, label]) => {
            const list = fonts.filter((f) => f.source === source);
            return list.length ? (
              <optgroup key={source} label={label}>
                {list.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.family}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
        <div className="pv-stepper">
          <Key label="Smaller text" onClick={() => setSize(Math.ceil(shownSize(style.size)) - 1)}>
            <MinusIcon />
          </Key>
          <input className="pv-size" aria-label="Font size" readOnly tabIndex={-1} value={String(shownSize(style.size))} />
          <Key label="Larger text" onClick={() => setSize(Math.floor(shownSize(style.size)) + 1)}>
            <PlusIcon />
          </Key>
        </div>
      </div>
    );
  else if (panel === "colour")
    content = (
      <div className="pv-row pv-row-even">
        {SWATCHES.map(([hex, name]) => (
          <Key key={hex} label={name} pressed={colour === hex} onClick={() => setColour(hexToRgb(hex))}>
            <i className="pv-dot" style={{ background: hex }} />
          </Key>
        ))}
        <label className="pv-btn pv-key pv-colour" title="Other colour">
          <i className="pv-dot pv-dot-any" />
          <input
            type="color"
            aria-label="Text colour"
            value={colour}
            onChange={(e) => {
              setColour(hexToRgb(e.target.value));
              props.refocus();
            }}
          />
        </label>
      </div>
    );
  else if (panel === "more")
    content = short ? (
      <div className="pv-row pv-row-even">
        {alignKeys}
        {underline}
        {extras(false)}
      </div>
    ) : (
      <>
        <div className="pv-row pv-row-even" role="group" aria-label="Alignment">
          {alignKeys}
          {underline}
        </div>
        <div className="pv-row pv-row-even">{extras(true)}</div>
      </>
    );
  else if (panel === "move")
    content = (
      <div className="pv-row pv-row-even" role="group" aria-label="Move text">
        {nudge([-1, 0], "Move left", <ArrowLeftIcon />, "pv-key")}
        {nudge([0, -1], "Move up", <ArrowUpIcon />, "pv-key")}
        {nudge([0, 1], "Move down", <ArrowDownIcon />, "pv-key")}
        {nudge([1, 0], "Move right", <ArrowRightIcon />, "pv-key")}
        <button type="button" className="pv-btn pv-key" aria-label="Reset" title="Reset" disabled={!props.moved} onClick={props.onResetMove}>
          <ArrowCounterClockwiseIcon />
        </button>
      </div>
    );

  if (props.tiny)
    return (
      <div className="pv-phonebar" onMouseDown={keepFocus}>
        <div className="pv-actions" role="toolbar" aria-label="Text style">
          {cancel}
          {done}
        </div>
      </div>
    );

  const swapped = short && content !== null;
  return (
    <div className="pv-phonebar" onMouseDown={keepFocus}>
      {content && !swapped && (
        <div className="pv-sheetrow">
          {panel === "move" && (
            <div className="pv-sheetrow-head">
              <button type="button" className="pv-btn pv-btn-text" onClick={back}>
                <CaretLeftIcon /> Back
              </button>
              <span>Drag the round handle, or nudge</span>
            </div>
          )}
          {content}
        </div>
      )}
      {swapped ? (
        <div className="pv-actions pv-actions-swapped">
          <Key label="Back" onClick={back}>
            <CaretLeftIcon />
          </Key>
          <div className="pv-swap">{content}</div>
          {done}
        </div>
      ) : (
        <div className="pv-actions" role="toolbar" aria-label="Text style">
          {cancel}
          <Key label="Bold" pressed={style.bold} onClick={() => onStyle({ bold: !style.bold })}>
            <TextBIcon />
          </Key>
          <Key label="Italic" pressed={style.italic} onClick={() => onStyle({ italic: !style.italic })}>
            <TextItalicIcon />
          </Key>
          <Key label="Font and size" expanded={panel === "size"} onClick={() => toggle("size")}>
            <TextAaIcon />
          </Key>
          <Key label="Colour" expanded={panel === "colour"} onClick={() => toggle("colour")}>
            <i className="pv-dot" style={{ background: colour }} />
          </Key>
          <Key label="More options" expanded={panel === "more" || panel === "move"} onClick={() => toggle("more")}>
            <DotsThreeIcon weight="bold" />
          </Key>
          {done}
        </div>
      )}
    </div>
  );
}

/** keeps the bar (and so the layout) in place while one line is saved and the next one opens */
export function SwitchingDock() {
  const compact = useCompact();
  const switching = useViewer((s) => s.switching);
  const editing = useStore((s) => s.editing !== null);
  const ref = useRef<HTMLDivElement>(null);
  if (!compact || !switching || editing) return null;
  return (
    <Dock dockRef={ref} short={false} onMoved={() => {}}>
      <div className="pv-actions pv-actions-waiting" role="status">
        Saving the line
      </div>
    </Dock>
  );
}
