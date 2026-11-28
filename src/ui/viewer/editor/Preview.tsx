/**
 * Draws edited text on top of the page, at the exact baseline, angle, size and colour of the original.
 * Used as the inline input (desktop and phone) and as the stand-in until the new render arrives.
 */
import { type CSSProperties, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
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
  /** the editable field, laid exactly over the text. Omit for a read-only preview */
  field?: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref: RefObject<HTMLTextAreaElement | null> };
  /** show the original page through (nothing changed yet) */
  ghostText?: boolean;
  /** draw an outline around the text */
  active?: boolean;
  /** UTF-16 offset of the caret: marked (invisibly) so that the view can follow it */
  caret?: number | null;
  /** a touch screen: the field is set in 16px or more, so that iOS does not zoom the page, and scaled back */
  touch?: boolean;
  boxRef?: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}

/** the colour of the caret on phones: it must be seen on paper, whatever the text colour */
const TOUCH_CARET = "#2f5bea";

export function Preview({ spec, scale, field, ghostText, active, caret, touch, boxRef, children }: Props) {
  const [dx, dy] = [spec.offset[0] * scale, spec.offset[1] * scale];
  const px = spec.style.size * scale;
  /** how much larger the field is set than it is shown */
  const k = touch ? Math.max(1, 16.01 / px) : 1;
  const text: CSSProperties = { ...fontCss(spec.style, scale), ...(ghostText ? { color: "transparent" } : null) };
  const caretColor = touch ? TOUCH_CARET : rgbToHex(spec.style.color);

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
        {/* with a field this copy is unseen: it gives the box its height and marks where the caret is */}
        <div className="pv-text pv-text-block" dir="auto" style={field ? { ...style, visibility: "hidden" } : style} aria-hidden={field ? true : undefined}>
          {spec.text.slice(0, caret ?? spec.text.length)}
          {caret != null && <span className="pv-caret-mark" data-pv-caret />}
          {spec.text.slice(caret ?? spec.text.length)}
          {"\u200b"}
        </div>
        {field && (
          <textarea
            {...field}
            className="pv-inline pv-inline-block"
            style={{
              ...style,
              fontSize: px * k,
              letterSpacing: (spec.style.letterSpacing ?? 0) * scale * k,
              width: `${100 * k}%`,
              height: `${100 * k}%`,
              transform: k === 1 ? undefined : `scale(${1 / k})`,
            }}
          />
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
  // room for the caret and the next letters; an emptied line stays easy to tap
  const fieldWidth = Math.max(box.natural + Math.max(4, px * (touch ? 1.2 : 0.5)), touch ? 44 / box.scaleX : 0);
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
            // right-to-left text ends where the line ends: the spare room is on its left
            left: (rtl ? box.left + (box.natural - fieldWidth) * box.scaleX : box.left) + dx,
            top: box.top + dy,
            fontSize: px * k,
            letterSpacing: (spec.style.letterSpacing ?? 0) * scale * k,
            width: fieldWidth * k,
            height: box.height * k,
            lineHeight: `${box.height * k}px`,
            transform: `scale(${box.scaleX / k}, ${1 / k})`,
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
            // the field draws its own caret
            visibility: field ? "hidden" : undefined,
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
