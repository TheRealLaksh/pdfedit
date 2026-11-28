/** Shared types of the image text editor. All geometry is in pixels of the (possibly capped) picture. */

export type Pt = [number, number];
/** top left, top right, bottom right, bottom left of a line of text, in reading direction */
export type Quad4 = [Pt, Pt, Pt, Pt];
/** 0..255 */
export type Rgb = [number, number, number];

/** RGBA pixels */
export interface Picture {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** a piece of text in the picture */
export interface TextBox {
  id: string;
  quad: Quad4;
  /** what the picture says, as recognised (the user may correct it) */
  text: string;
  source: "ocr" | "manual";
  /** 0..100, OCR boxes only */
  confidence?: number;
  /** 0..100, the least sure word of the reading */
  weakest?: number;
  /** the user typed or confirmed what the picture says */
  checked?: boolean;
}

export type Align = "left" | "center" | "right";

/** everything that decides how the new lettering looks; every field is adjustable */
export interface LineStyle {
  /** key of the image font list, or "user:..." */
  font: string;
  weight: number;
  italic: boolean;
  /** font size in picture pixels */
  size: number;
  /** horizontal scale, 1 = as designed */
  stretch: number;
  /** extra space between letters, pixels */
  spacing: number;
  color: Rgb;
  /** how far the outlines are pushed out (negative: pulled in), pixels */
  thickness: number;
  /** coverage curve: below 1 heavier edges, above 1 lighter */
  gamma: number;
  /** Gaussian blur, pixels */
  blur: number;
  /** noise strength, 0..255 levels */
  grain: number;
  /** coloured edges of screen text smoothing */
  subpixel: boolean;
  /** draw the drop shadow found behind the original letters */
  shadow: boolean;
  /** moves the text along / across the line, pixels */
  dx: number;
  dy: number;
  /** extra rotation about the box centre, degrees clockwise */
  rotate: number;
}

/** what the user changed about one box */
export interface BoxEdit {
  /** new text; undefined = unchanged, "" = remove the text */
  text?: string;
  style?: Partial<LineStyle>;
  align?: Align;
  /** keep the original pixels of letters that did not change (default true) */
  keep?: boolean;
  /** the line was dragged this far, in picture pixels */
  move?: [number, number];
}

export interface Candidate {
  font: string;
  family: string;
  weight: number;
  italic: boolean;
  /** 0..1, higher is closer */
  score: number;
}

/** what was measured and matched for a box */
export interface Analysis {
  boxId: string;
  text: string;
  /** the box tightened to the ink (manual boxes keep their corners) */
  quad: Quad4;
  style: LineStyle;
  align: Align;
  candidates: Candidate[];
  /** typical background colour behind the text */
  paper: Rgb;
  /** no letters could be separated from the background */
  blank: boolean;
  /** the background is detailed: removing text will be less clean */
  busy: boolean;
}

/** pixels that replace the original ones where `mask` is set; everything else stays untouched */
export interface Patch {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA */
  data: Uint8ClampedArray<ArrayBuffer>;
  /** 1 per changed pixel */
  mask: Uint8Array<ArrayBuffer>;
}

export interface RenderResult {
  patch: Patch | null;
  /** where the new text ends up, for the overlay */
  quad: Quad4;
  /** characters no font could draw */
  missing: string[];
  /** letters of the original that were left untouched */
  kept: number;
  /** the new text runs past the picture */
  overflow: boolean;
  /** the text change was not drawn: the reading looks wrong and the changed words could not be told apart */
  unsafe?: boolean;
}
