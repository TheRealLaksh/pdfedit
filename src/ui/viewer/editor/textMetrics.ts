/** Browser-side stand-ins for PDF fonts, and measuring with them. */
import type { FontStyle, TextStyle } from "../../../engine/types";

const KNOWN: [RegExp, string][] = [
  [/times|tinos|liberation ?serif|nimbus ?rom/i, '"Times New Roman", Tinos, "Liberation Serif", serif'],
  [/arial|helvetica|arimo|liberation ?sans|nimbus ?san/i, 'Arial, Helvetica, Arimo, "Liberation Sans", sans-serif'],
  [/courier|cousine|nimbus ?mon/i, '"Courier New", Cousine, monospace'],
  [/calibri|carlito/i, "Calibri, Carlito, sans-serif"],
  [/cambria|caladea/i, "Cambria, Caladea, serif"],
  [/georgia|gelasio/i, "Georgia, Gelasio, serif"],
  [/verdana/i, "Verdana, sans-serif"],
];

/** a style to preview: `css` is a font-family list of loaded fonts to use before the local stand-ins */
export type PreviewStyle = TextStyle & { css?: string };

export function cssFamily(style: FontStyle & { css?: string }): string {
  if (style.css) return `${style.css}, ${cssFamily({ ...style, css: undefined })}`;
  const known = KNOWN.find(([re]) => re.test(style.family));
  if (known) return known[1];
  // "NotoSans-BoldItalic,Bold" -> "Noto Sans"
  const name = style.family
    .replace(/[,-].*$/, "")
    .replace(/(PS)?MT$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/["\\]/g, "")
    .trim();
  const generic = style.mono ? "monospace" : style.serif ? "serif" : "sans-serif";
  return name ? `"${name}", ${generic}` : generic;
}

export interface Metrics {
  width: number;
  ascent: number;
  descent: number;
}

let context: CanvasRenderingContext2D | null = null;
const REF = 100;

/** metrics of `text` drawn at `px` CSS pixels */
export function measureText(text: string, style: TextStyle, px: number): Metrics {
  context ??= document.createElement("canvas").getContext("2d")!;
  context.font = `${style.italic ? "italic " : ""}${style.bold ? "700 " : "400 "}${REF}px ${cssFamily(style)}`;
  const m = context.measureText(text);
  const k = px / REF;
  return {
    width: m.width * k,
    ascent: (m.fontBoundingBoxAscent ?? 90) * k,
    descent: (m.fontBoundingBoxDescent ?? 22) * k,
  };
}

/** UTF-16 offset in `text` closest to `x` px from the start of the line */
export function offsetAtX(text: string, style: TextStyle, px: number, x: number): number {
  let previous = 0;
  let offset = 0;
  // step by grapheme so that Indic clusters and emoji are never split
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  for (const { segment, index } of segments) {
    const width = measureText(text.slice(0, index + segment.length), style, px).width;
    if (x < (previous + width) / 2) return offset;
    previous = width;
    offset = index + segment.length;
  }
  return offset;
}
