/** Font, size, colour and layout controls of the text editor. */
import {
  ArrowCounterClockwiseIcon, ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ArrowsInLineHorizontalIcon,
  ArrowsOutCardinalIcon, MinusIcon, PlusIcon, TextAlignCenterIcon, TextAlignJustifyIcon, TextAlignLeftIcon,
  TextAlignRightIcon, TextBIcon, TextItalicIcon, TextUnderlineIcon, TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { engine } from "../../../engine/client";
import type { Align, FontChoice, Point, TextStyle } from "../../../engine/types";
import { useStore } from "../../../store";
import { hexToRgb, rgbToHex } from "../geometry";

let fontCache: { session: number; list: Promise<FontChoice[]> } | null = null;

function useFonts(): FontChoice[] {
  const session = useStore((s) => s.session);
  // the shell's font panel may add uploads while a document is open
  const panel = useStore((s) => s.panel);
  const [fonts, setFonts] = useState<FontChoice[]>([]);
  useEffect(() => {
    if (fontCache?.session !== session || panel === "fonts")
      fontCache = { session, list: engine.listFonts() };
    let live = true;
    fontCache.list.then(
      (list) => live && setFonts(list),
      () => (fontCache = null),
    );
    return () => {
      live = false;
    };
  }, [session, panel]);
  return fonts;
}

const GROUPS: [FontChoice["source"], string][] = [
  ["document", "In this document"],
  ["user", "Your fonts"],
  ["builtin", "Standard"],
  ["web", "More fonts"],
];

const ALIGN: [Align, string, ReactNode][] = [
  ["left", "Align left", <TextAlignLeftIcon key="l" />],
  ["center", "Align centre", <TextAlignCenterIcon key="c" />],
  ["right", "Align right", <TextAlignRightIcon key="r" />],
  ["justify", "Justify", <TextAlignJustifyIcon key="j" />],
];

export interface StyleBarProps {
  style: TextStyle;
  align: Align;
  /** label of the "keep the document's font" entry */
  defaultFont: string;
  onStyle(patch: Partial<TextStyle>): void;
  onAlign(align: Align): void;
  /** only for existing lines */
  shrink?: boolean;
  onShrink?(value: boolean): void;
  onNudge(delta: Point): void;
  onResetMove(): void;
  moved: boolean;
  onDelete(): void;
  /** the move controls are open */
  moving: boolean;
  onMoving(value: boolean): void;
}

/** buttons must not take the focus: the phone keyboard would close */
const keepFocus = (e: React.MouseEvent) => {
  if (!(e.target as Element).closest("select, input")) e.preventDefault();
};

function Tool({ label, pressed, onClick, children, danger }: {
  label: string;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={danger ? "pv-btn pv-btn-danger" : "pv-btn"}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function StyleBar(props: StyleBarProps) {
  const { style, align, onStyle } = props;
  const fonts = useFonts();
  const { moving } = props;
  const [sizeText, setSizeText] = useState<string | null>(null);
  const repeat = useRef<{ timer?: ReturnType<typeof setTimeout> }>({});
  const stop = () => clearTimeout(repeat.current.timer);
  useEffect(() => stop, []);

  const setSize = (size: number) => onStyle({ size: Math.round(Math.min(600, Math.max(2, size)) * 10) / 10 });
  const nudge = (delta: Point, label: string, icon: ReactNode) => (
    <button
      type="button"
      className="pv-btn"
      aria-label={label}
      title={label}
      onPointerDown={() => {
        props.onNudge(delta);
        const again = (wait: number) => {
          repeat.current.timer = setTimeout(() => {
            props.onNudge(delta);
            again(70);
          }, wait);
        };
        again(400);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={(e) => e.detail === 0 && props.onNudge(delta)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {icon}
    </button>
  );
  const alignIndex = ALIGN.findIndex(([a]) => a === align);
  const current = ALIGN[Math.max(0, alignIndex)]!;

  return (
    <div className="pv-style" onMouseDown={keepFocus}>
      <div className="pv-tools" role="toolbar" aria-label="Text style">
        <select
          className="pv-select"
          aria-label="Font"
          value={style.fontChoice ?? ""}
          onChange={(e) => onStyle({ fontChoice: e.target.value || undefined })}
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
          <Tool label="Smaller text" onClick={() => setSize(Math.ceil(style.size) - 1)}>
            <MinusIcon />
          </Tool>
          <input
            className="pv-size"
            aria-label="Font size"
            inputMode="decimal"
            value={sizeText ?? String(Math.round(style.size * 10) / 10)}
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              setSizeText(e.target.value);
              const n = Number(e.target.value.replace(",", "."));
              if (n >= 2) setSize(n);
            }}
            onBlur={() => setSizeText(null)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          <Tool label="Larger text" onClick={() => setSize(Math.floor(style.size) + 1)}>
            <PlusIcon />
          </Tool>
        </div>
        <label className="pv-btn pv-colour" title="Text colour">
          <span style={{ background: rgbToHex(style.color) }} />
          <input
            type="color"
            aria-label="Text colour"
            value={rgbToHex(style.color)}
            onChange={(e) => onStyle({ color: hexToRgb(e.target.value) })}
          />
        </label>
        <Tool label="Bold" pressed={style.bold} onClick={() => onStyle({ bold: !style.bold })}>
          <TextBIcon />
        </Tool>
        <Tool label="Italic" pressed={style.italic} onClick={() => onStyle({ italic: !style.italic })}>
          <TextItalicIcon />
        </Tool>
        <Tool label="Underline" pressed={!!style.underline} onClick={() => onStyle({ underline: !style.underline })}>
          <TextUnderlineIcon />
        </Tool>
        <Tool label={`${current[1]} (tap to change)`} onClick={() => props.onAlign(ALIGN[(alignIndex + 1) % ALIGN.length]![0])}>
          {current[2]}
        </Tool>
        {props.onShrink && (
          <Tool label="Shrink to fit the original width" pressed={!!props.shrink} onClick={() => props.onShrink!(!props.shrink)}>
            <ArrowsInLineHorizontalIcon />
          </Tool>
        )}
        <Tool label="Move" pressed={moving} onClick={() => props.onMoving(!moving)}>
          <ArrowsOutCardinalIcon />
        </Tool>
        <Tool label="Delete this text" danger onClick={props.onDelete}>
          <TrashIcon />
        </Tool>
      </div>
      {moving && (
        <div className="pv-tools pv-nudge" role="group" aria-label="Move text">
          {nudge([-1, 0], "Move left", <ArrowLeftIcon />)}
          {nudge([0, -1], "Move up", <ArrowUpIcon />)}
          {nudge([0, 1], "Move down", <ArrowDownIcon />)}
          {nudge([1, 0], "Move right", <ArrowRightIcon />)}
          <button type="button" className="pv-btn pv-btn-text" disabled={!props.moved} onClick={props.onResetMove}>
            <ArrowCounterClockwiseIcon /> Reset
          </button>
        </div>
      )}
    </div>
  );
}
