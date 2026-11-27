/**
 * Just enough of a content stream interpreter for images and line art: transforms, clipping, line width,
 * marked content and paths. Positions are reported in page space.
 */
import type * as MuPDF from "mupdf";
import type { Operand, Operation } from "../content/tokenizer";
import { apply, multiply, num, rectFromPoints, transformRect } from "../geom";
import type { Matrix, Point, Rect } from "../types";
import { intersection, latin1, numbers } from "./shared";

export interface Subpath {
  /** operator text that rebuilds exactly this subpath (user space) */
  source: string;
  /** end and control points, user space */
  points: Point[];
  curved: boolean;
  closed: boolean;
  /** set when created by `re` */
  re?: [number, number, number, number];
}

export interface ClipRecord {
  /** page space bounds of the clip path */
  rect: Rect;
}

/** something that changed the graphics state, kept so that it can be replayed */
export interface StateOp {
  text: string;
  /** transform in effect before this operator */
  ctm: Matrix;
  clip?: ClipRecord;
}

export interface GraphicsState {
  /** current space -> default space of the outermost stream (page user space) */
  ctm: Matrix;
  clip: Rect | null;
  lineWidth: number;
}

export interface Marked {
  tag: string;
  /** index of the BMC / BDC operation */
  index: number;
}

export interface PaintedPath {
  subpaths: Subpath[];
  /** indices of the first path operator and of the painting operator */
  first: number;
  last: number;
  paint: string;
  clip: "W" | "W*" | null;
}

export interface WalkContext {
  index: number;
  operation: Operation;
  state: GraphicsState;
  /** state operators per q level; levels[0] is outside every q */
  levels: StateOp[][];
  marked: Marked[];
}

export interface Visitor {
  /** XObject invocation or inline image */
  object?(at: WalkContext): void;
  path?(path: PaintedPath, at: WalkContext): void;
  marked?(at: WalkContext): void;
  text?(at: WalkContext): void;
}

const REPLAY = new Set("cm gs w J j M d ri i CS cs SC SCN sc scn G g RG rg K k Tc Tw Tz TL Tf Tr Ts".split(" "));
const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const TEXT = new Set(["Tj", "TJ", "'", '"']);

const value = (o: Operand | undefined) => (o?.type === "number" ? o.value : 0);

export function walk(
  content: Uint8Array,
  operations: Operation[],
  resources: MuPDF.PDFObject,
  toPage: Matrix,
  initial: GraphicsState,
  visitor: Visitor,
): void {
  let state: GraphicsState = { ...initial };
  const saved: GraphicsState[] = [];
  const levels: StateOp[][] = [[]];
  const marked: Marked[] = [];
  let subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let pathFirst = -1;
  let pendingClip: "W" | "W*" | null = null;
  let pen: Point = [0, 0];
  const slice = (o: Operation) => latin1(content.subarray(o.start, o.end));
  const record = (text: string, clip?: ClipRecord) => levels.at(-1)!.push({ text, ctm: state.ctm, clip });

  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    const { op, operands } = operation;
    const at = (): WalkContext => ({ index, operation, state, levels, marked });
    const n = operands.map(value);

    if (op === "q") {
      saved.push({ ...state });
      levels.push([]);
    } else if (op === "Q") {
      if (saved.length) {
        state = saved.pop()!;
        levels.pop();
      }
    } else if (REPLAY.has(op)) {
      record(slice(operation));
      if (op === "cm" && n.length === 6) state = { ...state, ctm: multiply(n as Matrix, state.ctm) };
      else if (op === "w") state = { ...state, lineWidth: n[0] ?? 1 };
      else if (op === "gs" && operands[0]?.type === "name") {
        const lw = resources.get("ExtGState", operands[0].value, "LW");
        if (lw.isNumber()) state = { ...state, lineWidth: lw.asNumber() };
      }
    } else if (op === "TD") record(`${num(-(n[1] ?? 0))} TL`);
    else if (op === "m" || op === "re") {
      if (pathFirst < 0) pathFirst = index;
      if (op === "m") {
        pen = [n[0]!, n[1]!];
        current = { source: slice(operation), points: [pen], curved: false, closed: false };
        subpaths.push(current);
      } else {
        const [x, y, w, h] = n as [number, number, number, number];
        subpaths.push({
          source: slice(operation),
          points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
          curved: false,
          closed: true,
          re: [x, y, w, h],
        });
        current = null;
        pen = [x, y];
      }
    } else if (op === "l" || op === "c" || op === "v" || op === "y" || op === "h") {
      if (!current) {
        // drawing continues from the end of a closed subpath
        if (op === "h") continue;
        if (pathFirst < 0) pathFirst = index;
        current = { source: `${num(pen[0])} ${num(pen[1])} m`, points: [pen], curved: false, closed: false };
        subpaths.push(current);
      }
      current.source += "\n" + slice(operation);
      if (op === "h") {
        current.closed = true;
        pen = current.points[0]!;
        current = null;
      } else {
        for (let i = 0; i + 1 < n.length; i += 2) current.points.push([n[i]!, n[i + 1]!]);
        pen = current.points.at(-1)!;
        if (op !== "l") current.curved = true;
      }
    } else if (op === "W" || op === "W*") pendingClip = op;
    else if (PAINT.has(op)) {
      if (pathFirst >= 0) {
        visitor.path?.({ subpaths, first: pathFirst, last: index, paint: op, clip: pendingClip }, at());
        if (pendingClip) {
          const points = subpaths.flatMap((s) => s.points);
          if (points.length) {
            const m = multiply(state.ctm, toPage);
            const rect = rectFromPoints(points.map((p) => apply(m, p)));
            record(`${subpaths.map((s) => s.source).join("\n")}\n${pendingClip} n`, { rect });
            state = { ...state, clip: state.clip ? (intersection(state.clip, rect) ?? [0, 0, 0, 0]) : rect };
          }
        }
      }
      subpaths = [];
      current = null;
      pathFirst = -1;
      pendingClip = null;
    } else if (op === "BMC" || op === "BDC") {
      const tag = operands[0]?.type === "name" ? operands[0].value : "";
      marked.push({ tag, index });
      visitor.marked?.(at());
    } else if (op === "EMC") marked.pop();
    else if (TEXT.has(op)) {
      if (op === '"') record(`${num(n[0] ?? 0)} Tw ${num(n[1] ?? 0)} Tc`);
      visitor.text?.(at());
    } else if (op === "Do" || op === "BI") visitor.object?.(at());
  }
}

export interface XObjectRef {
  name: string;
  object: MuPDF.PDFObject;
  subtype: string;
}

export function xobjectOf(operation: Operation, resources: MuPDF.PDFObject): XObjectRef | null {
  const name = operation.operands[0];
  if (operation.op !== "Do" || name?.type !== "name") return null;
  const object = resources.get("XObject", name.value);
  if (!object.isStream()) return null;
  const subtype = object.get("Subtype");
  return { name: name.value, object, subtype: subtype.isName() ? subtype.asName() : "" };
}

/** transform and clip in effect inside a form XObject */
export function formState(form: MuPDF.PDFObject, state: GraphicsState, toPage: Matrix): GraphicsState {
  const matrix = numbers(form.get("Matrix"), [1, 0, 0, 1, 0, 0]) as Matrix;
  const ctm = multiply(matrix, state.ctm);
  const bbox = numbers(form.get("BBox"), [-1e6, -1e6, 1e6, 1e6]) as Rect;
  const box = transformRect(multiply(ctm, toPage), bbox);
  const clip = state.clip ? (intersection(state.clip, box) ?? [0, 0, 0, 0]) : box;
  return { ...state, ctm, clip: clip as Rect };
}
