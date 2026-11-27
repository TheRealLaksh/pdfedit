/** Multi-line, wrapped text for any script, measured with the FONTS module. */
import type { EngineContext } from "../context";
import * as fonts from "../fonts";
import type { Align, TextStyle } from "../types";

export interface LaidLine {
  text: string;
  width: number;
  /** left end of the baseline, relative to the box's left edge */
  x: number;
  wordSpacing: number;
  /** extra spacing for justification, on top of the style's own letter spacing */
  charSpacing: number;
  /** last line of its paragraph */
  last: boolean;
}

export interface Layout {
  lines: LaidLine[];
  ascent: number;
  descent: number;
  /** distance between baselines */
  advance: number;
  height: number;
  /** baseline of line i, measured down from the top of the box */
  baseline(i: number): number;
  missing: string[];
  fontsUsed: string[];
  substituted: boolean;
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** scripts that are written without spaces between words */
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}　-〿＀-｠]/u;
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-｠]/u;
const NO_BREAK_BEFORE = /^[\s!%),.:;?\]}»’”…、。〉》」』】〕！），．：；？｝ーぁぃぅぇぉっゃゅょァィゥェォッャュョฯๆ]/u;
const NO_BREAK_AFTER = /[([{«‘“〈《「『【〔（｛]$/u;

export const splitGraphemes = (s: string) => Array.from(graphemes.segment(s), (g) => g.segment);

/** pieces of a paragraph between which a line may be broken */
export function breakUnits(paragraph: string): string[] {
  const pieces: string[] = [];
  for (const { segment } of words.segment(paragraph)) {
    if (IDEOGRAPHIC.test(segment)) pieces.push(...splitGraphemes(segment));
    else pieces.push(segment);
  }
  const units: string[] = [];
  for (const piece of pieces) {
    const previous = units.at(-1);
    if (previous === undefined) {
      units.push(piece);
      continue;
    }
    const allowed =
      !NO_BREAK_BEFORE.test(piece) &&
      !NO_BREAK_AFTER.test(previous) &&
      (/[ \t​　]$/.test(previous) ||
        (/[-‐–—]$/.test(previous) && /^\p{L}/u.test(piece) && previous.length > 1) ||
        NO_SPACE.test(piece) ||
        NO_SPACE.test(previous.slice(-1)));
    if (allowed) units.push(piece);
    else units[units.length - 1] = previous + piece;
  }
  return units;
}

const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;

export function isRtl(text: string): boolean {
  const strong = text.match(/\p{L}/u)?.[0];
  return !!strong && RTL.test(strong);
}

export interface LayoutRequest {
  text: string;
  style: TextStyle;
  /** wrap width in points; Infinity = only break at newlines */
  width: number;
  align: Align;
  /** multiple of the font size */
  lineHeight?: number;
}

export async function layoutText(ctx: EngineContext, request: LayoutRequest): Promise<Layout> {
  const { style, width, align } = request;
  const missing = new Set<string>();
  const used = new Set<string>();
  let substituted = false;
  let ascent = 0;
  let descent = 0;

  const measure = async (text: string): Promise<number> => {
    // style.letterSpacing is applied by the fonts module itself
    const plan = await fonts.planText(ctx, { text, style });
    for (const m of plan.missing) missing.add(m);
    for (const f of plan.fontsUsed) used.add(f);
    substituted ||= plan.substituted;
    ascent = Math.max(ascent, plan.ascent);
    descent = Math.max(descent, plan.descent);
    return plan.width;
  };

  /** largest n in 1..max whose prefix fits, 0 if even one item is too wide */
  const fit = async (items: string[], max: number): Promise<{ count: number; width: number }> => {
    let best = { count: 0, width: 0 };
    let low = 1;
    let high = 0;
    // grow quickly, then bisect: long paragraphs must not be measured whole for every line
    for (let n = 1; ; n = Math.min(max, n * 2)) {
      const w = await measure(items.slice(0, n).join("").trimEnd());
      if (w > width + 0.01) {
        high = n - 1;
        break;
      }
      best = { count: n, width: w };
      low = n + 1;
      high = n;
      if (n === max) break;
    }
    while (low <= high) {
      const mid = (low + high) >> 1;
      const w = await measure(items.slice(0, mid).join("").trimEnd());
      if (w <= width + 0.01) {
        best = { count: mid, width: w };
        low = mid + 1;
      } else high = mid - 1;
    }
    return best;
  };

  const lines: LaidLine[] = [];
  const paragraphs = request.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  for (const paragraph of paragraphs) {
    const mine: { text: string; width: number }[] = [];
    let units = paragraph.trim() ? breakUnits(paragraph) : [];
    while (units.length) {
      if (!Number.isFinite(width)) {
        const text = units.join("").trimEnd();
        mine.push({ text, width: await measure(text) });
        break;
      }
      let { count, width: w } = await fit(units, units.length);
      if (count === 0) {
        // one unit wider than the box: break it between graphemes
        const parts = splitGraphemes(units[0]!);
        const cut = await fit(parts, parts.length);
        const take = Math.max(1, cut.count);
        const text = parts.slice(0, take).join("");
        mine.push({ text, width: cut.count ? cut.width : await measure(text) });
        const rest = parts.slice(take).join("");
        units = rest.trim() ? [rest, ...units.slice(1)] : units.slice(1);
        continue;
      }
      mine.push({ text: units.slice(0, count).join("").trimEnd(), width: w });
      units = units.slice(count);
    }
    if (!mine.length) mine.push({ text: "", width: 0 });
    const rtl = isRtl(paragraph);
    mine.forEach((line, i) => {
      const last = i === mine.length - 1;
      let x = 0;
      let wordSpacing = 0;
      let charSpacing = 0;
      let lineWidth = line.width;
      const room = Number.isFinite(width) ? width - line.width : 0;
      if (align === "justify" && !last && room > 0) {
        const spaces = line.text.split(" ").length - 1;
        const parts = splitGraphemes(line.text).length;
        if (spaces > 0) {
          wordSpacing = room / spaces;
          lineWidth = width;
        } else if (IDEOGRAPHIC.test(line.text) && parts > 1) {
          charSpacing = room / (parts - 1);
          lineWidth = width;
        }
      }
      if (align === "center") x = room / 2;
      else if (align === "right" || (align === "justify" && rtl && lineWidth === line.width)) x = room;
      lines.push({ text: line.text, width: lineWidth, x, wordSpacing, charSpacing, last });
    });
  }

  if (!ascent) await measure("Hg");
  const natural = ascent + descent;
  const advance = request.lineHeight ? style.size * request.lineHeight : Math.max(style.size * 1.2, natural);
  return {
    lines,
    ascent,
    descent,
    advance,
    height: advance * lines.length,
    baseline: (i) => i * advance + (advance - natural) / 2 + ascent,
    missing: [...missing],
    fontsUsed: [...used],
    substituted,
  };
}

export function missingWarning(missing: Iterable<string>): string[] {
  const list = [...new Set(missing)];
  if (!list.length) return [];
  const shown = list.slice(0, 12).join(" ");
  return [`No available font can draw: ${shown}${list.length > 12 ? " ..." : ""}. Upload a font that includes them.`];
}
