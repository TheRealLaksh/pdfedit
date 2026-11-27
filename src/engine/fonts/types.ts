/** Contract between the FONTS module and every module that draws text. */
import type * as MuPDF from "mupdf";
import type { Matrix, TextStyle } from "../types";

export interface WriteTextRequest {
  /** one visual line, logical (reading) order. No newlines */
  text: string;
  /** style.fontChoice overrides font matching */
  style: TextStyle;
  /**
   * Maps text space to the user space in effect where the operators are inserted. Text space: origin at
   * the LEFT end of the baseline (also for right-to-left text), x along the baseline, y up, 1 unit = 1pt
   * (the font size comes from style.size, do not bake it into the matrix).
   */
  matrix: Matrix;
  /** resource dictionary (page or form XObject) that fonts get registered in */
  resources: MuPDF.PDFObject;
  /** the document font being replaced, to pick the closest substitute */
  originalFont?: { name: string; bold: boolean; italic: boolean; serif: boolean; mono: boolean; bytes?: Uint8Array };
  charSpacing?: number;
  wordSpacing?: number;
  /** percent, default 100 */
  horizontalScale?: number;
  /** PDF text rendering mode, default 0. 3 = invisible */
  renderMode?: number;
  /**
   * Raw colour operators to use verbatim (keeps the original colour space exactly). "" = inherit whatever
   * is current. Undefined = set DeviceRGB from style.color.
   */
  colorOps?: string;
  /**
   * Where the ink of characters the original font draws begins and ends above the baseline, in ems. A
   * substitute font is sized and placed so that its letters stand like these.
   */
  reference?: { char: string; top: number; bottom: number }[];
}

export type MeasureTextRequest = Omit<WriteTextRequest, "resources" | "matrix">;

export interface PlannedText {
  /** advance width along the baseline in points, including spacing and scaling */
  width: number;
  /** distance above / below the baseline in points (both positive) */
  ascent: number;
  descent: number;
  /** families that will be used */
  fontsUsed: string[];
  /** true when the family used differs from originalFont / the requested family */
  substituted: boolean;
  /** characters no available font can draw */
  missing: string[];
}

export interface WrittenText extends PlannedText {
  /** self contained operators: "q BT ... ET Q" (plus underline path if asked). Safe to insert outside BT/ET */
  ops: string;
}

export interface FontInspection {
  /** font program can draw this code point through its own cmap */
  hasUnicode(codePoint: number): boolean;
  /** glyph id exists and (unless it is whitespace) has an outline */
  hasGlyphOutline(glyphId: number): boolean;
  glyphForUnicode(codePoint: number): number;
  unitsPerEm: number;
  advance(glyphId: number): number;
  /** upper and lower edge of the ink relative to the baseline, font units (sfnt programs only) */
  ink?(glyphId: number): [top: number, bottom: number] | null;
}
