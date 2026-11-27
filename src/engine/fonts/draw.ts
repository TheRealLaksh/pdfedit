/** Turns a layout into content stream operators. */
import { encodeLatin1, parseContent } from "../content/tokenizer";
import { multiply, matrixOps, num } from "../geom";
import type { EmbeddedFont } from "./embed";
import type { Layout, PlacedGlyph } from "./layout";
import type { Source } from "./resolve";
import type { WriteTextRequest } from "./types";

/** marked content tag around right to left text whose content order is the reading order */
export const READING_ORDER = "PEOrder";

/** tangent of the slant of synthetic italics */
const SLANT = 0.21;
/** stroke width of synthetic bold, as a fraction of the font size */
const EMBOLDEN = 0.028;

const STROKE_OPERATOR: Record<string, string> = { g: "G", rg: "RG", k: "K", cs: "CS", sc: "SC", scn: "SCN" };

/** the stroking equivalents of the fill colour operators in `ops` ("" when it sets no fill colour) */
export function strokeColourOps(ops: string): string {
  const bytes = encodeLatin1(ops);
  return parseContent(bytes)
    .filter((o) => STROKE_OPERATOR[o.op])
    .map((o) => ops.slice(o.start, o.end - o.op.length) + STROKE_OPERATOR[o.op])
    .join(" ");
}

export function textString(text: string): string {
  let out = "FEFF";
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${out.toUpperCase()}>`;
}

export interface FontUse {
  resource: string;
  font: EmbeddedFont;
}

const decimal = (n: number) => {
  const s = (Math.round(n * 1000) / 1000).toString();
  return s === "-0" ? "0" : s;
};

export function buildOps(request: WriteTextRequest, layout: Layout, fonts: Map<string, FontUse>): string {
  if (!layout.glyphs.length) return "";
  const { style } = request;
  const size = style.size;
  const scale = (request.horizontalScale ?? 100) / 100;
  let mode = request.renderMode ?? 0;
  if (mode >= 4) mode -= 4; // clipping cannot outlive the q ... Q around the text

  const rgb = style.color.map(num).join(" ");
  const fill = request.colorOps ?? `${rgb} rg`;
  const out: string[] = ["q", `${matrixOps(multiply([scale, 0, 0, 1, 0, 0], request.matrix))} cm`];
  if (fill.trim()) out.push(fill.trim());
  if (mode === 0 && layout.glyphs.some((g) => g.source.synthBold)) {
    // the emboldening outline takes the colour of the fill
    const stroke = (request.colorOps !== undefined && strokeColourOps(request.colorOps)) || `${rgb} RG`;
    out.push(stroke, `${num(size * EMBOLDEN)} w [] 0 d 1 J 1 j`);
  } else if ((mode === 1 || mode === 2) && request.colorOps === undefined) {
    // outlined text keeps the line width of the surrounding graphics state
    out.push(`${rgb} RG`);
  }
  out.push("BT", "0 Tc 0 Tw 100 Tz 0 Ts");

  let source: Source | undefined;
  let resource = "";
  let current = 0;
  let currentMode = -1;
  let slant: boolean | undefined;
  /** where the next glyph would be drawn, as the viewer computes it */
  let penX = 0;
  let rise = 0;
  let items: string[] = [];
  let hex = "";

  const closeString = () => {
    if (hex) items.push(`<${hex}>`);
    hex = "";
  };
  const closeShow = () => {
    closeString();
    if (items.length) out.push(`[${items.join(" ")}] TJ`);
    items = [];
  };

  const place = (g: PlacedGlyph) => {
    const { font, resource: name } = fonts.get(g.source.key)!;
    if (g.source !== source) {
      closeShow();
      source = g.source;
      if (name !== resource || g.size !== current) {
        resource = name;
        current = g.size;
        out.push(`/${name} ${num(g.size)} Tf`);
      }
      const wanted = g.source.synthBold && mode === 0 ? 2 : mode;
      if (wanted !== currentMode) {
        currentMode = wanted;
        out.push(`${wanted} Tr`);
      }
      if (g.source.synthItalic !== slant) {
        slant = g.source.synthItalic;
        // restates the text matrix, so the position starts again
        out.push(`1 0 ${slant ? SLANT : 0} 1 ${num(g.x)} 0 Tm`);
        penX = g.x;
      }
    }
    const y = Math.round(g.y * 1000) / 1000;
    if (y !== rise) {
      closeShow();
      rise = y;
      out.push(`${num(y)} Ts`);
    }
    const adjust = Math.round(((penX - g.x) * 1000 * 1000) / g.size) / 1000;
    if (Math.abs(adjust) >= 0.01) {
      closeString();
      items.push(decimal(adjust));
      penX -= (adjust * g.size) / 1000;
    }
    const shown = font.code(g.gid, g.text, g.declared);
    hex += shown.cid.toString(16).padStart(4, "0");
    penX += (shown.width * g.size) / 1000;
  };

  // letters of Nastaliq step down along each word, so positions do not tell their order: say that an
  // Arabic script run is written in reading order (numbers run the other way and are left to positions)
  const cascading = layout.rtl && /[؀-ࣿ]/.test(layout.text) && !/\p{Nd}/u.test(layout.text);
  if (cascading) out.push(`/${READING_ORDER} BMC`);
  /** glyphs left inside the current ActualText span */
  let spanned = 0;
  for (const g of layout.glyphs) {
    if (g.actual) {
      closeShow();
      out.push(`/Span <</ActualText ${textString(g.actual.text)}>> BDC`);
      spanned = g.actual.glyphs;
    }
    place(g);
    if (spanned && --spanned === 0) {
      closeShow();
      out.push("EMC");
    }
  }
  closeShow();
  if (cascading) out.push("EMC");
  out.push("ET");

  if (style.underline && mode !== 3) {
    const face = layout.primary;
    const unit = size / face.info.unitsPerEm;
    const thickness = Math.max(face.info.underlineThickness * unit, size * 0.04);
    const top = face.info.underlinePosition * unit;
    out.push(`0 ${num(top - thickness)} ${num(layout.advance)} ${num(thickness)} re f`);
  }
  out.push("Q");
  return out.join("\n");
}
