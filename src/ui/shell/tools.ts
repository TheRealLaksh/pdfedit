/** Names and icons for every tool and panel, so all menus agree. */
import {
  ArrowUpRight, Circle, Cursor, CursorText, DownloadSimple, EyeSlash, Highlighter, ImageSquare, Info, LineSegment,
  ListChecks, MagnifyingGlass, PaintRoller, Rectangle, Scan, ScribbleLoop, Signature, SquaresFour, Stamp, TextAa, TextT,
  type Icon,
} from "@phosphor-icons/react";
import type { PanelId, ToolId } from "../../store";

export interface ToolMeta {
  id: ToolId;
  label: string;
  /** shown in the options bar while the tool is active */
  hint: string;
  icon: Icon;
  /** single-letter desktop shortcut */
  key: string;
}

export const TOOLS: Record<ToolId, ToolMeta> = {
  "edit-text": { id: "edit-text", label: "Edit text", hint: "Tap a line of text to change it", icon: CursorText, key: "E" },
  select: { id: "select", label: "Select", hint: "Tap an added item or image to move or resize it", icon: Cursor, key: "V" },
  "add-text": { id: "add-text", label: "Add text", hint: "Tap the page to type new text", icon: TextT, key: "T" },
  image: { id: "image", label: "Image", hint: "Tap the page to place the image", icon: ImageSquare, key: "I" },
  signature: { id: "signature", label: "Sign", hint: "Tap the page to place your signature", icon: Signature, key: "S" },
  highlight: { id: "highlight", label: "Highlight", hint: "Drag across text to highlight it", icon: Highlighter, key: "H" },
  ink: { id: "ink", label: "Draw", hint: "Draw on the page", icon: ScribbleLoop, key: "P" },
  rect: { id: "rect", label: "Rectangle", hint: "Drag to draw a rectangle", icon: Rectangle, key: "R" },
  ellipse: { id: "ellipse", label: "Ellipse", hint: "Drag to draw an ellipse", icon: Circle, key: "O" },
  line: { id: "line", label: "Line", hint: "Drag to draw a line", icon: LineSegment, key: "L" },
  arrow: { id: "arrow", label: "Arrow", hint: "Drag to draw an arrow", icon: ArrowUpRight, key: "A" },
  whiteout: { id: "whiteout", label: "Whiteout", hint: "Drag to cover. The content underneath stays in the file", icon: PaintRoller, key: "W" },
  redact: { id: "redact", label: "Redact", hint: "Drag to permanently remove what is underneath", icon: EyeSlash, key: "X" },
};

/** order of the desktop rail; null is a divider */
export const RAIL: (ToolId | null)[] = [
  "select", "edit-text", "add-text", null,
  "image", "signature", null,
  "highlight", "ink", "rect", "ellipse", "line", "arrow", null,
  "whiteout", "redact",
];

/** tools offered in the phone "More" sheet (the others sit in the bottom bar) */
export const MORE_GROUPS: { title: string; tools: ToolId[] }[] = [
  { title: "Add", tools: ["image", "highlight", "ink", "rect", "ellipse", "line", "arrow"] },
  { title: "Select and remove", tools: ["select", "whiteout", "redact"] },
];

export const PANELS: Record<PanelId, { title: string; icon: Icon }> = {
  pages: { title: "Pages", icon: SquaresFour },
  find: { title: "Find and replace", icon: MagnifyingGlass },
  forms: { title: "Fill forms", icon: ListChecks },
  export: { title: "Download", icon: DownloadSimple },
  ocr: { title: "Recognise text", icon: Scan },
  signature: { title: "Signature", icon: Signature },
  stamp: { title: "Watermark and numbers", icon: Stamp },
  fonts: { title: "Fonts", icon: TextAa },
  about: { title: "About and privacy", icon: Info },
};
