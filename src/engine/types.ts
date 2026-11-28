/**
 * THE CONTRACT. Shared by the engine worker, the store and the UI.
 * Change it only additively (new optional fields / new methods) so parallel modules keep compiling.
 *
 * Coordinates: "page space" unless stated otherwise = MuPDF (fitz) coordinates of the DISPLAYED page
 * (page rotation applied, origin top-left of the crop box, y down, units = PDF points).
 */

export type Point = [number, number];
/** [x0, y0, x1, y1] */
export type Rect = [number, number, number, number];
/** [ulx, uly, urx, ury, llx, lly, lrx, lry] */
export type Quad = [number, number, number, number, number, number, number, number];
/** [a, b, c, d, e, f] */
export type Matrix = [number, number, number, number, number, number];
/** each 0..1 */
export type RGB = [number, number, number];

export interface PageInfo {
  width: number;
  height: number;
  /** bumps every time the page's appearance changes; use it as a render cache key */
  revision: number;
}

export interface DocInfo {
  fileName: string;
  pageCount: number;
  pages: PageInfo[];
  /** the file was password protected when opened */
  encrypted: boolean;
  /** has at least one digital signature (editing invalidates it: the UI must warn) */
  signed: boolean;
  hasForms: boolean;
  /** MuPDF had to repair a damaged file */
  repaired: boolean;
  /** uses XFA forms, which only Adobe's software shows fully */
  xfa?: boolean;
  /** the author restricted editing (owner password only); the exported copy does not carry that */
  restricted?: boolean;
}

export interface FontStyle {
  /** PDF base font name without the ABCDEF+ subset prefix */
  family: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

export interface TextStyle extends FontStyle {
  size: number;
  color: RGB;
  /** FontChoice.id picked by the user. Undefined = keep the document's own font where possible */
  fontChoice?: string;
  underline?: boolean;
  /** extra letter spacing in points */
  letterSpacing?: number;
}

export interface TextSpan {
  /** UTF-16 offsets into TextLine.text */
  start: number;
  end: number;
  style: TextStyle;
}

export type Align = "left" | "center" | "right" | "justify";

export interface TextLine {
  /** stable only for the page revision it came from. OCR lines start with "ocr:"; hidden text layer ids end ".h" */
  id: string;
  page: number;
  /** logical (reading) order Unicode */
  text: string;
  quad: Quad;
  rect: Rect;
  /** LEFT end of the baseline (also for right-to-left text), page space */
  origin: Point;
  /** direction of the left-to-right baseline axis, radians, page space (y down), also for right-to-left text */
  angle: number;
  dir: "ltr" | "rtl";
  /** dominant style */
  style: TextStyle;
  spans: TextSpan[];
  align: Align;
  source: "content" | "ocr";
  /** OCR only, 0..100 */
  confidence?: number;
  editable: boolean;
  /** why it is not editable, or a hint for the user */
  note?: string;
}

/**
 * text: normal. scanned: image-only, needs OCR. garbled: has text but its Unicode mapping is
 * broken (legacy Indic fonts, missing ToUnicode), needs OCR to read. mixed: both. empty: nothing.
 */
export type PageKind = "text" | "scanned" | "garbled" | "mixed" | "empty";

export interface PageText {
  page: number;
  revision: number;
  kind: PageKind;
  lines: TextLine[];
}

export interface LineEdit {
  lineId: string;
  /** new text; "" deletes the line */
  text: string;
  /** only the properties the user changed */
  style?: Partial<TextStyle>;
  align?: Align;
  /** move the line, page space */
  offset?: Point;
  /** preserve (default): keep size, let width change. shrink: squeeze to the original width */
  fit?: "preserve" | "shrink";
}

export interface MutationResult {
  doc: DocInfo;
  changedPages: number[];
  /** human readable, shown as notices */
  warnings: string[];
  /** families substituted because the original font could not draw the new characters */
  fallbackFonts: string[];
  canUndo: boolean;
  canRedo: boolean;
  /** id of a created object/page etc. when relevant */
  createdId?: string;
  /** replaceAll: number of replacements */
  count?: number;
}

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  pages?: number[];
}

export interface FindMatch {
  page: number;
  lineId: string;
  /** UTF-16 offsets into the line text */
  start: number;
  end: number;
  quads: Quad[];
  context: string;
}

export interface FontChoice {
  id: string;
  family: string;
  /** e.g. "Latin", "Devanagari", "Arabic" */
  scripts: string[];
  category: "sans" | "serif" | "mono" | "script";
  source: "builtin" | "web" | "user" | "document";
}

/* ---------- OCR ---------- */

export interface OcrWord {
  text: string;
  rect: Rect;
  confidence: number;
}

export interface OcrLine {
  text: string;
  rect: Rect;
  /** baseline end points */
  baseline?: [Point, Point];
  confidence: number;
  words: OcrWord[];
  dir?: "ltr" | "rtl";
}

/** Result of recognising a rendered page. All geometry already converted to page space. */
export interface OcrPageResult {
  page: number;
  languages: string[];
  lines: OcrLine[];
}

export interface OcrLanguage {
  /** tesseract code, e.g. "hin" */
  code: string;
  name: string;
  nativeName: string;
  script: string;
}

export interface OcrProgress {
  page: number;
  status: string;
  /** 0..1 */
  progress: number;
}

/* ---------- added objects, existing images, forms ---------- */

export interface ObjectBase {
  id: string;
  page: number;
  /** bounding box before rotation, page space */
  rect: Rect;
  /** degrees clockwise around the rect centre */
  rotation?: number;
  /** 0..1 */
  opacity?: number;
}

export type PageObject = ObjectBase &
  (
    | { kind: "text"; text: string; style: TextStyle; align: Align; lineHeight?: number }
    | { kind: "image"; blobId: string }
    | {
        kind: "rect" | "ellipse" | "highlight" | "whiteout";
        fill?: RGB | null;
        stroke?: RGB | null;
        strokeWidth?: number;
      }
    | { kind: "line" | "arrow"; from: Point; to: Point; stroke: RGB; strokeWidth: number }
    | { kind: "ink"; paths: Point[][]; stroke: RGB; strokeWidth: number }
  );

type DistributiveOmit<T, K extends keyof PageObject> = T extends unknown ? Omit<T, K> : never;
/** an object that does not exist yet. For images pass the bytes; the engine assigns blobId. */
export type NewPageObject =
  | DistributiveOmit<Exclude<PageObject, { kind: "image" }>, "id">
  | (Omit<ObjectBase, "id"> & { kind: "image"; data: Uint8Array });

export interface ImageItem {
  id: string;
  page: number;
  rect: Rect;
  pixelWidth: number;
  pixelHeight: number;
}

export interface FormField {
  id: string;
  page: number;
  name: string;
  label: string;
  type: "text" | "checkbox" | "radio" | "combobox" | "listbox" | "signature" | "button";
  value: string;
  checked?: boolean;
  options?: string[];
  multiline?: boolean;
  readOnly: boolean;
  rect: Rect;
}

export interface ExportOptions {
  /** garbage collect, compress streams, subset added fonts */
  compress?: boolean;
  /** make form fields and annotations part of the page */
  flatten?: boolean;
  /** protect the output with this password */
  password?: string;
  /** export only these pages */
  pages?: number[];
  /** try to get the file at or under this size by re-encoding images (upload portals) */
  maxBytes?: number;
}

/** a font program the browser can load with FontFace, for a faithful typing preview */
export interface PreviewFont {
  data: Uint8Array;
  /** name shown to the user */
  family: string;
  /** code points this file can draw; omitted = all it declares itself */
  coverage?: number[];
}

export interface RenderedPage {
  page: number;
  revision: number;
  width: number;
  height: number;
  /** RGBA, width*height*4 */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface PageNumberOptions {
  /** e.g. "{n} / {total}" */
  format: string;
  position: "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
  style: TextStyle;
  margin: number;
  startAt: number;
  pages?: number[];
}

export interface WatermarkOptions {
  text: string;
  style: TextStyle;
  opacity: number;
  /** degrees counter clockwise */
  angle: number;
  pages?: number[];
}

/* ---------- worker API ---------- */

export type OpenResult = { status: "ok"; doc: DocInfo } | { status: "password"; wrong: boolean };

export interface EngineAPI {
  open(bytes: Uint8Array, fileName: string, password?: string): Promise<OpenResult>;
  createFromImages(images: Uint8Array[], fileName: string): Promise<OpenResult>;
  close(): Promise<void>;
  /** scale: pixels per point. clip: page-space region to render (for deep zoom tiles) */
  renderPage(page: number, scale: number, clip?: Rect): Promise<RenderedPage>;

  getPageText(page: number): Promise<PageText>;
  editLines(page: number, edits: LineEdit[]): Promise<MutationResult>;
  findText(query: string, options?: FindOptions): Promise<FindMatch[]>;
  /** matches omitted = replace every match of query */
  replaceText(query: string, replacement: string, options?: FindOptions, matches?: FindMatch[]): Promise<MutationResult>;

  listFonts(): Promise<FontChoice[]>;
  /** the document's own font behind a line, rebuilt so the browser can use it; null when impossible */
  getLineFont(page: number, lineId: string): Promise<PreviewFont | null>;
  /** the file the engine would draw with for a font choice (picked, uploaded or substitute) */
  getChoiceFont(choiceId: string, bold: boolean, italic: boolean): Promise<PreviewFont | null>;
  addUserFont(name: string, bytes: Uint8Array): Promise<FontChoice>;

  setOcrResult(result: OcrPageResult): Promise<MutationResult>;
  /** add an invisible selectable text layer from stored OCR results */
  makeSearchable(pages: number[]): Promise<MutationResult>;

  listObjects(page: number): Promise<PageObject[]>;
  addObject(object: NewPageObject): Promise<MutationResult>;
  updateObject(object: PageObject): Promise<MutationResult>;
  removeObject(id: string): Promise<MutationResult>;

  listImages(page: number): Promise<ImageItem[]>;
  moveImage(page: number, id: string, rect: Rect): Promise<MutationResult>;
  deleteImage(page: number, id: string): Promise<MutationResult>;
  replaceImage(page: number, id: string, data: Uint8Array): Promise<MutationResult>;

  listFormFields(): Promise<FormField[]>;
  setFormField(page: number, id: string, value: string | boolean): Promise<MutationResult>;

  rotatePages(pages: number[], degrees: 90 | 180 | 270): Promise<MutationResult>;
  deletePages(pages: number[]): Promise<MutationResult>;
  /** order[i] = old index of the page that should end up at i */
  reorderPages(order: number[]): Promise<MutationResult>;
  duplicatePage(page: number): Promise<MutationResult>;
  insertBlankPage(at: number, width: number, height: number): Promise<MutationResult>;
  insertPdf(bytes: Uint8Array, at: number, password?: string): Promise<MutationResult>;
  insertImagesAsPages(images: Uint8Array[], at: number): Promise<MutationResult>;
  extractPages(pages: number[]): Promise<Uint8Array>;
  splitDocument(ranges: number[][]): Promise<Uint8Array[]>;

  /** permanently remove everything under the rects (true redaction) */
  redactAreas(page: number, rects: Rect[]): Promise<MutationResult>;
  addWatermark(options: WatermarkOptions): Promise<MutationResult>;
  addPageNumbers(options: PageNumberOptions): Promise<MutationResult>;

  exportPdf(options?: ExportOptions): Promise<Uint8Array>;
  exportPageImage(page: number, dpi: number, format: "png" | "jpeg"): Promise<Uint8Array>;
  exportText(pages?: number[]): Promise<string>;

  undo(): Promise<MutationResult>;
  redo(): Promise<MutationResult>;
}

export type EngineMethod = keyof EngineAPI;

export interface EngineRequest {
  id: number;
  method: EngineMethod;
  args: unknown[];
}

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; stack?: string };
