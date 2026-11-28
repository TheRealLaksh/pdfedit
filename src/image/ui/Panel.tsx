/** Settings of the chosen piece of text: what it says, its look, and fine adjustments. */
import { ArrowCounterClockwise, Check, Eraser, Eyedropper, TextAa, Trash } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { familyByKey, nearestWeight } from "../fonts/catalog";
import { S } from "../strings";
import type { Align, Analysis, BoxEdit, LineStyle, RenderResult, Rgb, TextBox } from "../types";

const hex = (c: Rgb) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const fromHex = (s: string): Rgb => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;

const WEIGHTS: Record<number, string> = { 100: "100 Thin", 200: "200 Extra light", 300: "300 Light", 400: "400 Regular", 500: "500 Medium", 600: "600 Semibold", 700: "700 Bold", 800: "800 Extra bold", 900: "900 Black" };

function Slider(props: { label: string; value: number; min: number; max: number; step: number; show?: (v: number) => string; onChange(v: number): void }) {
  const value = Math.min(props.max, Math.max(props.min, props.value));
  return (
    <label className="im-slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <output>{props.show ? props.show(props.value) : Math.round(props.value * 10) / 10}</output>
    </label>
  );
}

function Toggle(props: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className="im-toggle">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>
        {props.label}
        {props.hint && <small>{props.hint}</small>}
      </span>
    </label>
  );
}

export interface PanelProps {
  box: TextBox;
  edit: BoxEdit;
  analysis: Analysis | undefined;
  render: RenderResult | undefined;
  /** name of a font key (uploaded fonts are not in the list) */
  fontName(key: string): string;
  onEdit(patch: Partial<BoxEdit>, tag: string): void;
  onStyle(style: Partial<LineStyle>): void;
  onResetStyle(): void;
  onSays(text: string): void;
  onReadBox(): void;
  reading: boolean;
  onPickColour(): void;
  picking: boolean;
  onFonts(): void;
  onDeleteBox(): void;
  onDone(): void;
}

type Tab = "text" | "style" | "fine";

export function Panel(props: PanelProps) {
  const { box, edit, analysis, render } = props;
  const [tab, setTab] = useState<Tab>("text");
  const [says, setSays] = useState(box.text);
  useEffect(() => setSays(box.text), [box.id, box.text]);
  const value = edit.text ?? analysis?.text ?? box.text;
  const style: LineStyle | null = analysis ? { ...analysis.style, ...edit.style } : null;
  const base = analysis?.style;
  const family = style ? familyByKey(style.font) : undefined;
  const align: Align = edit.align ?? analysis?.align ?? "left";
  const commitSays = () => {
    const text = says.replace(/\s+/g, " ").trim();
    if (text !== box.text) props.onSays(text);
  };
  const tabs: [Tab, string][] = [["text", S.tabText], ["style", S.tabStyle], ["fine", S.tabFine]];
  const needsSays = !box.text;
  let notice: ReactNode = null;
  if (render?.missing.length) notice = S.missing(render.missing.slice(0, 8).join(" "));
  else if (render?.overflow) notice = S.overflow;
  else if (analysis?.blank && box.text) notice = S.blank;
  else if (analysis?.busy) notice = S.busy;

  return (
    <div className="im-form">
      {needsSays ? (
        <div className="im-row">
          <label className="im-field">
            <span>{S.says}</span>
            <input
              type="text"
              dir="auto"
              value={says}
              placeholder={props.reading ? S.reading : S.saysHint}
              enterKeyHint="done"
              onChange={(e) => setSays(e.target.value)}
              onBlur={commitSays}
              onKeyDown={(e) => e.key === "Enter" && commitSays()}
            />
          </label>
          <button type="button" className="im-btn" onClick={props.onReadBox} disabled={props.reading}>
            {S.readIt}
          </button>
        </div>
      ) : (
        <div className="im-row">
          <label className="im-field">
            <span className="im-sr">{S.newText}</span>
            <input
              type="text"
              dir="auto"
              className="im-text"
              value={value}
              placeholder={S.newTextHint}
              spellCheck={false}
              autoComplete="off"
              enterKeyHint="done"
              onChange={(e) => props.onEdit({ text: e.target.value === box.text ? undefined : e.target.value }, "text")}
              onKeyDown={(e) => e.key === "Enter" && props.onDone()}
            />
          </label>
          <button type="button" className="im-btn im-primary" onClick={props.onDone}>
            <Check size={18} aria-hidden />
            {S.done}
          </button>
        </div>
      )}
      <p className="im-note" role="status">
        {!analysis && box.text ? <span className="im-spin">{S.matching}</span> : notice}
      </p>
      <div className="im-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="im-tab" role="tabpanel">
        {tab === "text" && (
          <>
            {!needsSays && (
              <label className="im-field">
                <span>{S.says}</span>
                <input type="text" dir="auto" value={says} onChange={(e) => setSays(e.target.value)} onBlur={commitSays} onKeyDown={(e) => e.key === "Enter" && commitSays()} />
                <small>{S.saysHint}</small>
              </label>
            )}
            <div className="im-field">
              <span id="im-align">{S.align}</span>
              <div className="im-segmented" role="group" aria-labelledby="im-align">
                {([["left", S.alignLeft], ["center", S.alignCenter], ["right", S.alignRight]] as const).map(([id, label]) => (
                  <button key={id} type="button" aria-pressed={align === id} onClick={() => props.onEdit({ align: id }, "align")}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <Toggle label={S.keep} hint={S.keepHint} checked={edit.keep !== false} onChange={(v) => props.onEdit({ keep: v ? undefined : false }, "keep")} />
            <div className="im-actions">
              {edit.text === "" ? (
                <button type="button" className="im-btn" onClick={() => props.onEdit({ text: undefined }, "")}>
                  <ArrowCounterClockwise size={18} aria-hidden />
                  {S.restore}
                </button>
              ) : (
                <button type="button" className="im-btn" disabled={!box.text} onClick={() => props.onEdit({ text: "" }, "")}>
                  <Eraser size={18} aria-hidden />
                  {S.remove}
                </button>
              )}
              <button type="button" className="im-btn" onClick={props.onDeleteBox}>
                <Trash size={18} aria-hidden />
                {S.deleteBox}
              </button>
            </div>
          </>
        )}
        {tab === "style" && style && base && (
          <>
            <button type="button" className="im-btn im-fontbtn" onClick={props.onFonts}>
              <TextAa size={20} aria-hidden />
              <span>
                <small>{S.font}</small>
                {props.fontName(style.font)}
              </span>
            </button>
            <Slider label={S.size} value={style.size} min={Math.max(4, base.size * 0.4)} max={base.size * 2.2} step={base.size / 200} onChange={(size) => props.onStyle({ size })} />
            <label className="im-select">
              <span>{S.weight}</span>
              <select value={family ? nearestWeight(family.weights, style.weight) : style.weight} disabled={!family || family.weights.length < 2} onChange={(e) => props.onStyle({ weight: Number(e.target.value) })}>
                {(family?.weights ?? [style.weight]).map((w) => (
                  <option key={w} value={w}>
                    {WEIGHTS[w] ?? w}
                  </option>
                ))}
              </select>
            </label>
            <Toggle label={S.italic} checked={style.italic} onChange={(italic) => props.onStyle({ italic })} />
            <div className="im-row im-colour">
              <label className="im-select">
                <span>{S.color}</span>
                <input type="color" value={hex(style.color)} onChange={(e) => props.onStyle({ color: fromHex(e.target.value) })} />
              </label>
              <button type="button" className="im-btn" aria-pressed={props.picking} onClick={props.onPickColour}>
                <Eyedropper size={18} aria-hidden />
                {S.pick}
              </button>
            </div>
          </>
        )}
        {tab === "fine" && style && base && (
          <>
            <Slider label={S.width} value={style.stretch} min={0.5} max={1.6} step={0.005} show={(v) => `${Math.round(v * 100)}%`} onChange={(stretch) => props.onStyle({ stretch })} />
            <Slider label={S.spacing} value={style.spacing} min={-base.size * 0.12} max={base.size * 0.6} step={base.size / 400} onChange={(spacing) => props.onStyle({ spacing })} />
            <Slider label={S.thickness} value={style.thickness} min={-Math.max(1, base.size * 0.04)} max={Math.max(1.5, base.size * 0.06)} step={0.05} show={(v) => v.toFixed(2)} onChange={(thickness) => props.onStyle({ thickness })} />
            <Slider label={S.edges} value={style.gamma} min={0.5} max={1.7} step={0.02} show={(v) => v.toFixed(2)} onChange={(gamma) => props.onStyle({ gamma })} />
            <Slider label={S.softness} value={style.blur} min={0} max={Math.max(3, base.size * 0.08)} step={0.05} show={(v) => v.toFixed(2)} onChange={(blur) => props.onStyle({ blur })} />
            <Slider label={S.grain} value={style.grain} min={0} max={30} step={0.5} onChange={(grain) => props.onStyle({ grain })} />
            <Slider label={S.moveX} value={style.dx} min={-base.size} max={base.size} step={0.25} onChange={(dx) => props.onStyle({ dx })} />
            <Slider label={S.moveY} value={style.dy} min={-base.size * 0.6} max={base.size * 0.6} step={0.25} onChange={(dy) => props.onStyle({ dy })} />
            <Slider label={S.angle} value={style.rotate} min={-15} max={15} step={0.1} show={(v) => `${v.toFixed(1)}°`} onChange={(rotate) => props.onStyle({ rotate })} />
            <Toggle label={S.screenEdges} checked={style.subpixel} onChange={(subpixel) => props.onStyle({ subpixel })} />
            {base.shadow && <Toggle label={S.shadow} checked={style.shadow} onChange={(shadow) => props.onStyle({ shadow })} />}
            <div className="im-actions">
              <button type="button" className="im-btn" disabled={!edit.style} onClick={props.onResetStyle}>
                <ArrowCounterClockwise size={18} aria-hidden />
                {S.matched}
              </button>
            </div>
          </>
        )}
        {tab !== "text" && !style && <p className="im-note">{box.text ? S.matching : S.saysHint}</p>}
      </div>
    </div>
  );
}
