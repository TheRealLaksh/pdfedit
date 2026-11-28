/** State private to the viewer: optimistic previews, unconfirmed redactions, new text boxes. */
import { create } from "zustand";
import { engine } from "../../engine/client";
import type { FormField, Point, Rect, RGB, TextLine, TextStyle } from "../../engine/types";
import { useStore } from "../../store";
import type { PreviewSpec } from "./editor/Preview";

/** something drawn over the page until a render that includes it arrives */
export type Ghost = { id: number; page: number; revision: number } & (
  | { kind: "text"; preview: PreviewSpec }
  | { kind: "rect"; rect: Rect; ellipse?: boolean; fill?: RGB | null; stroke?: RGB | null; width?: number; opacity?: number; multiply?: boolean }
  | { kind: "line"; from: Point; to: Point; arrow: boolean; stroke: RGB; width: number; opacity?: number }
  | { kind: "ink"; paths: Point[][]; stroke: RGB; width: number; opacity?: number }
  | { kind: "image"; rect: Rect; url: string }
);

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type NewGhost = DistributiveOmit<Ghost, "id" | "revision">;

export interface TextDraft {
  key: string;
  page: number;
  /** left, top, right of the new text box; height follows the content */
  rect: Rect;
  /** typed already when the box opens (retyping a covered line) */
  text?: string;
  /** the look to write in, when it is not that of the Add text tool */
  style?: TextStyle;
  /** the old line was covered for this box: cancelling it takes the cover away again */
  cover?: boolean;
}

/** what a tap of the Add text tool puts down: writing, or a mark for filling a form that has no fields */
export type Mark = "text" | "tick" | "cross" | "dot" | "date" | "initials";

/** a context menu: what was asked about, and where (client coordinates) */
export interface Menu {
  x: number;
  y: number;
  page: number;
  /** page point under the menu */
  at: Point;
  target:
    | { kind: "line"; line: TextLine }
    | { kind: "object"; id: string }
    | { kind: "image"; id: string }
    | { kind: "page" };
  /** opened from the keyboard: the focus goes back there afterwards */
  from?: HTMLElement | null;
}

/** the look of a line, kept to be given to another */
export interface StyleClip {
  style: TextStyle;
}

export interface InkBuffer {
  page: number;
  paths: Point[][];
  stroke: RGB;
  width: number;
  opacity: number;
}

interface ViewerState {
  ghosts: Ghost[];
  redactions: Record<number, Rect[]>;
  draft: TextDraft | null;
  ink: InkBuffer | null;
  /** extra scroll room under the last page so it can move above the keyboard */
  bottomInset: number;
  /** phones: one line is being saved and the next is about to open; the keyboard and its bar stay */
  switching: boolean;
  /** a short instruction after the view moved by itself */
  hint: string | null;
  /** a line that cannot be edited was asked for: the ways forward are offered */
  locked: { page: number; line: TextLine } | null;
  /** the form field being filled on the page */
  field: FormField | null;
  mark: Mark;
  menu: Menu | null;
  styleClip: StyleClip | null;
  /** after a keyboard edit: give the focus to the line at this spot once the page is read again */
  refocus: { page: number; at: Point } | null;
  /** "recognise text" prompts the user has put away (session:page) */
  dismissed: string[];
}

export const useViewer = create<ViewerState>()(() => ({
  ghosts: [],
  redactions: {},
  draft: null,
  ink: null,
  bottomInset: 0,
  switching: false,
  hint: null,
  locked: null,
  field: null,
  mark: "text",
  menu: null,
  styleClip: null,
  refocus: null,
  dismissed: [],
}));

let hintTimer: ReturnType<typeof setTimeout> | undefined;

export function showHint(hint: string | null) {
  clearTimeout(hintTimer);
  useViewer.setState({ hint });
  if (hint) hintTimer = setTimeout(() => useViewer.setState({ hint: null }), 2800);
}

let ghostId = 1;

export function addGhost(ghost: NewGhost): number {
  const revision = useStore.getState().doc?.pages[ghost.page]?.revision ?? 0;
  const id = ghostId++;
  useViewer.setState((s) => ({ ghosts: [...s.ghosts, { ...ghost, id, revision } as Ghost] }));
  // safety net if the page is never rendered again (scrolled away, render failed)
  setTimeout(() => removeGhost(id), 20_000);
  return id;
}

export function removeGhost(id: number) {
  useViewer.setState((s) => (s.ghosts.some((g) => g.id === id) ? { ghosts: s.ghosts.filter((g) => g.id !== id) } : s));
}

/** a render of `revision` is on screen: everything added before it is now part of the picture */
export function settleGhosts(page: number, revision: number) {
  useViewer.setState((s) =>
    s.ghosts.some((g) => g.page === page && g.revision < revision)
      ? { ghosts: s.ghosts.filter((g) => g.page !== page || g.revision >= revision) }
      : s,
  );
}

export function resetViewer() {
  clearTimeout(inkTimer);
  showHint(null);
  useViewer.setState({
    ghosts: [], redactions: {}, draft: null, ink: null, bottomInset: 0, switching: false,
    locked: null, field: null, menu: null, refocus: null, dismissed: [],
  });
}

/* ---------- ink: strokes drawn in quick succession become one object ---------- */

let inkTimer: ReturnType<typeof setTimeout> | undefined;
const INK_IDLE = 900;

export function addInkStroke(page: number, path: Point[], stroke: RGB, width: number, opacity: number) {
  clearTimeout(inkTimer);
  const buffer = useViewer.getState().ink;
  const same =
    buffer && buffer.page === page && buffer.width === width && buffer.opacity === opacity && String(buffer.stroke) === String(stroke);
  if (buffer && !same) void flushInk();
  useViewer.setState({
    ink: same ? { ...buffer, paths: [...buffer.paths, path] } : { page, paths: [path], stroke, width, opacity },
  });
  inkTimer = setTimeout(() => void flushInk(), INK_IDLE);
}

/** a new stroke started: do not save in the middle of it */
export function holdInk() {
  clearTimeout(inkTimer);
}

export function resumeInk() {
  clearTimeout(inkTimer);
  if (useViewer.getState().ink) inkTimer = setTimeout(() => void flushInk(), INK_IDLE);
}

export function undoInkStroke(): boolean {
  const ink = useViewer.getState().ink;
  if (!ink) return false;
  clearTimeout(inkTimer);
  const paths = ink.paths.slice(0, -1);
  useViewer.setState({ ink: paths.length ? { ...ink, paths } : null });
  if (paths.length) inkTimer = setTimeout(() => void flushInk(), INK_IDLE);
  return true;
}

export async function flushInk() {
  clearTimeout(inkTimer);
  const ink = useViewer.getState().ink;
  if (!ink || !useStore.getState().doc) return;
  useViewer.setState({ ink: null });
  const xs = ink.paths.flat();
  const pad = ink.width / 2;
  const rect: Rect = [
    Math.min(...xs.map((p) => p[0])) - pad,
    Math.min(...xs.map((p) => p[1])) - pad,
    Math.max(...xs.map((p) => p[0])) + pad,
    Math.max(...xs.map((p) => p[1])) + pad,
  ];
  const ghost = addGhost({ kind: "ink", page: ink.page, paths: ink.paths, stroke: ink.stroke, width: ink.width, opacity: ink.opacity });
  const session = useStore.getState().session;
  try {
    // no busy overlay: it would interrupt writing
    const result = await engine.addObject({
      kind: "ink",
      page: ink.page,
      rect,
      paths: ink.paths,
      stroke: ink.stroke,
      strokeWidth: ink.width,
      opacity: ink.opacity,
    });
    if (useStore.getState().session === session) useStore.getState().applyMutation(result);
  } catch (e) {
    removeGhost(ghost);
    useStore.getState().toast(e instanceof Error ? e.message : String(e), "error");
  }
}
