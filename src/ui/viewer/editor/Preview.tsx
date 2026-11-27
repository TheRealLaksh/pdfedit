/**
 * Draws edited text on top of the page, at the exact baseline, angle, size and colour of the original.
 * Used as the live preview, as the desktop inline input, and as the stand-in until the new render arrives.
 */
import { useLayoutEffect, type CSSProperties, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import type { Align, Point, Rect, TextStyle } from "../../../engine/types";
import { rgbToHex, type LineFrame } from "../geometry";
import { cssFamily, measureText } from "./textMetrics";

export type PreviewSpec = {
  text: string;
  style: TextStyle;
  align: Align;
  offset: Point;
  /** colour hiding the original text; null = nothing to hide */
  cover: string | null;
} & (
  | {
      kind: "line";
      frame: LineFrame;
      /** horizontal squeeze that makes the substitute font match the original width */
      scaleX: number;
      shrink: boolean;
      /** extra cover above and below, as a fraction of the line height (recognised boxes are tight) */
      bleed?: number;
    }
  | { kind: "block"; rect: Rect; rotation: number; lineHeight: number }
);

export interface LineBox {
  /** all CSS px, relative to the baseline origin */
  left: number;
  top: number;
  height: number;
  /** unscaled text width and the horizontal scale applied to it */
  natural: number;
  scaleX: number;
  baseline: number;
}

export function lineBox(spec: Extract<PreviewSpec, { kind: "line" }>, scale: number): LineBox {
  const { frame, style, text } = spec;
  const px = style.size * scale;
  const m = measureText(text, style, px);
  const spacing = (style.letterSpacing ?? 0) * scale * [...text].length;
  const natural = Math.max(1, m.width + spacing);
  const original = (frame.uMax - frame.uMin) * scale;
  let scaleX = spec.scaleX;
  if ((spec.shrink || spec.align === "justify") && natural * scaleX > original) scaleX = original / natural;
  const visual = natural * scaleX;
  const left =
    spec.align === "right"
      ? frame.uMax * scale - visual
      : spec.align === "center"
        ? ((frame.uMin + frame.uMax) / 2) * scale - visual / 2
        : frame.uMin * scale;
  const height = Math.max(m.ascent + m.descent, px * 1.1);
  const baseline = (height - (m.ascent + m.descent)) / 2 + m.ascent;
  return { left, top: -baseline, height, natural, scaleX, baseline };
}

function fontCss(style: TextStyle, scale: number): CSSProperties {
  return {
    fontFamily: cssFamily(style),
    fontSize: style.size * scale,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    letterSpacing: (style.letterSpacing ?? 0) * scale,
    textDecoration: style.underline ? "underline" : "none",
    color: rgbToHex(style.color),
  };
}

interface Props {
  spec: PreviewSpec;
  scale: number;
  /** editable inline field (desktop). Omit for a read-only preview */
  field?: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref: RefObject<HTMLTextAreaElement | null> };
  /** show the original page through (nothing changed yet) */
  ghostText?: boolean;
  /** draw an outline around the text */
  active?: boolean;
  /** UTF-16 offset: draw a caret marker there (read-only previews) */
  caret?: number | null;
  boxRef?: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}

export function Preview({ spec, scale, field, ghostText, active, caret, boxRef, children }: Props) {
  const blockField = spec.kind === "block" ? field : undefined;
  useLayoutEffect(() => {
    const el = blockField?.ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  });

  const [dx, dy] = [spec.offset[0] * scale, spec.offset[1] * scale];
  const text: CSSProperties = { ...fontCss(spec.style, scale), ...(ghostText ? { color: "transparent" } : null) };
  const caretColor = rgbToHex(spec.style.color);

  if (spec.kind === "block") {
    const [x0, y0, x1, y1] = spec.rect;
    const style: CSSProperties = { ...text, lineHeight: spec.lineHeight, textAlign: spec.align, caretColor };
    return (
      <div
        className="pv-block"
        style={{
          left: x0 * scale + dx,
          top: y0 * scale + dy,
          width: (x1 - x0) * scale,
          minHeight: spec.style.size * spec.lineHeight * scale,
          transform: spec.rotation ? `rotate(${spec.rotation}deg)` : undefined,
          transformOrigin: `50% ${((y1 - y0) * scale) / 2}px`,
        }}
        ref={boxRef}
      >
        {spec.cover && !ghostText && (
          <div
            className="pv-cover"
            style={{ left: -dx, top: -dy, width: (x1 - x0) * scale, height: (y1 - y0) * scale, background: spec.cover }}
          />
        )}
        {field ? (
          <textarea {...field} className="pv-inline pv-inline-block" style={style} />
        ) : (
          <div className="pv-text pv-text-block" dir="auto" style={style}>
            {spec.text.slice(0, caret ?? spec.text.length)}
            {caret != null && <span className="pv-caret" data-pv-caret style={{ background: caretColor }} />}
            {spec.text.slice(caret ?? spec.text.length)}
            {"​"}
          </div>
        )}
        {active && <div className="pv-outline" />}
        {children}
      </div>
    );
  }

  const { frame } = spec;
  const box = lineBox(spec, scale);
  const rtl = /^[^\p{L}]*[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(spec.text);
  let caretX = 0;
  if (caret != null) {
    const before = measureText(spec.text.slice(0, caret), spec.style, spec.style.size * scale).width * box.scaleX;
    caretX = box.left + (rtl ? box.natural * box.scaleX - before : before);
  }
  const outlineLeft = Math.min(box.left + dx, frame.uMin * scale + dx);
  const outlineRight = Math.max(box.left + dx + box.natural * box.scaleX, ghostText ? frame.uMax * scale + dx : -Infinity);
  const vTop = Math.min(frame.vMin * scale, box.top);
  const vBottom = Math.max(frame.vMax * scale, box.top + box.height);

  const bleed = (spec.bleed ?? 0) * (frame.vMax - frame.vMin) * scale;
  return (
    <div
      className="pv-line"
      style={{
        left: frame.ox * scale,
        top: frame.oy * scale,
        transform: frame.angle ? `rotate(${frame.angle}rad)` : undefined,
      }}
    >
      {spec.cover && !ghostText && (
        <div
          className="pv-cover"
          style={{
            left: frame.uMin * scale - 1,
            top: frame.vMin * scale - 0.5 - bleed,
            width: (frame.uMax - frame.uMin) * scale + 2,
            height: (frame.vMax - frame.vMin) * scale + 1 + bleed * 2,
            background: spec.cover,
          }}
        />
      )}
      {field ? (
        <textarea
          {...field}
          className="pv-inline"
          wrap="off"
          style={{
            ...text,
            caretColor,
            left: box.left + dx,
            top: box.top + dy,
            width: box.natural + Math.max(4, spec.style.size * scale * 0.5),
            height: box.height,
            lineHeight: `${box.height}px`,
            transform: `scaleX(${box.scaleX})`,
          }}
        />
      ) : (
        !ghostText && (
          <div
            className="pv-text"
            dir="auto"
            style={{
              ...text,
              left: box.left + dx,
              top: box.top + dy,
              height: box.height,
              lineHeight: `${box.height}px`,
              transform: `scaleX(${box.scaleX})`,
            }}
          >
            {spec.text}
          </div>
        )
      )}
      {caret != null && (
        <span
          className="pv-caret pv-caret-line"
          data-pv-caret
          style={{
            left: caretX + dx,
            top: box.top + dy + box.height * 0.08,
            height: box.height * 0.84,
            background: "var(--accent)",
          }}
        />
      )}
      <div
        ref={boxRef}
        className={active ? "pv-outline" : "pv-measure"}
        style={{
          left: outlineLeft,
          top: vTop + dy,
          width: Math.max(8, outlineRight - outlineLeft),
          height: vBottom - vTop,
          right: "auto",
          bottom: "auto",
        }}
      >
        {children}
      </div>
    </div>
  );
}
