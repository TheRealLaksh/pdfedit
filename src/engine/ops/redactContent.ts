/**
 * The parts of redaction MuPDF does not do well: cutting line art exactly at the redaction edges, wiping
 * the transparency masks of images (they keep the shape of what was there) and removing the text copies
 * that marked content carries in /ActualText.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { parseContent, spliceContent, type Operand, type Operation } from "../content/tokenizer";
import { apply, intersects, invert, multiply, num, rectFromPoints, transformRect } from "../geom";
import type { Matrix, Point, Rect } from "../types";
import { addResource, area, contains, copyDict, copyResources, latin1, streamBytes } from "./shared";
import { formState, walk, xobjectOf, type GraphicsState, type PaintedPath, type Subpath } from "./walk";

type Obj = MuPDF.PDFObject;
type Edit = { start: number; end: number; replacement: string };

/* ---------- rectangle and segment subtraction ---------- */

export function subtractRect(piece: Rect, hole: Rect): Rect[] {
  if (!intersects(piece, hole)) return [piece];
  const [x0, y0, x1, y1] = piece;
  const top = Math.max(y0, hole[1]);
  const bottom = Math.min(y1, hole[3]);
  const out: Rect[] = [
    [x0, y0, x1, hole[1]],
    [x0, hole[3], x1, y1],
    [x0, top, hole[0], bottom],
    [hole[2], top, x1, bottom],
  ];
  return out.filter((r) => r[2] - r[0] > 0.01 && r[3] - r[1] > 0.01);
}

/** what is left of an axis parallel segment after cutting out the rectangles */
function cutSegment(a: Point, b: Point, halfWidth: number, holes: Rect[]): [Point, Point][] {
  const horizontal = Math.abs(a[1] - b[1]) < 1e-3;
  const [i, j] = horizontal ? [0, 1] : [1, 0];
  const across = a[j]!;
  let spans: [number, number][] = [[Math.min(a[i]!, b[i]!), Math.max(a[i]!, b[i]!)]];
  for (const h of holes) {
    if (across + halfWidth <= h[j]! || across - halfWidth >= h[j + 2]!) continue;
    const from = h[i]! - halfWidth;
    const to = h[i + 2]! + halfWidth;
    spans = spans.flatMap(([s, e]) => {
      if (to <= s || from >= e) return [[s, e]] as [number, number][];
      const left: [number, number][] = [];
      if (from > s) left.push([s, from]);
      if (to < e) left.push([to, e]);
      return left;
    });
  }
  const point = (v: number): Point => (horizontal ? [v, across] : [across, v]);
  return spans.filter(([s, e]) => e - s > 0.1).map(([s, e]) => [point(s), point(e)]);
}

/* ---------- line art ---------- */

const rectilinear = (m: Matrix) =>
  (Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6) || (Math.abs(m[0]) < 1e-6 && Math.abs(m[3]) < 1e-6);

/** corners of a subpath that is an axis parallel rectangle (in its own space), else null */
function asRectangle(s: Subpath): Point[] | null {
  if (s.curved) return null;
  let points = s.points;
  if (points.length === 5 && Math.hypot(points[0]![0] - points[4]![0], points[0]![1] - points[4]![1]) < 1e-4)
    points = points.slice(0, 4);
  if (points.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % 4]!;
    if (Math.abs(a[0] - b[0]) > 1e-4 && Math.abs(a[1] - b[1]) > 1e-4) return null;
  }
  return points;
}

const signedArea = (p: Point[]) =>
  p.reduce((sum, a, i) => sum + a[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * a[1], 0) / 2;

interface PathResult {
  /** subpaths (operator text) to fill and to stroke */
  fill: string[];
  stroke: string[];
}

function cutPath(path: PaintedPath, state: GraphicsState, toPage: Matrix, holes: Rect[]): PathResult | null {
  const fills = ["f", "F", "f*", "B", "B*", "b", "b*"].includes(path.paint);
  const strokes = ["S", "s", "B", "B*", "b", "b*"].includes(path.paint);
  const m = multiply(state.ctm, toPage);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const half = strokes ? Math.max(0.05, (state.lineWidth * scale) / 2) : 0;
  const inverse = invert(m);
  const parts = path.subpaths.map((s) => {
    const page = s.points.map((p) => apply(m, p));
    const bounds = rectFromPoints(page);
    const reach: Rect = [bounds[0] - half, bounds[1] - half, bounds[2] + half, bounds[3] + half];
    // a lone point paints nothing unless it is stroked with round caps; treat both the same
    if (reach[2] - reach[0] < 0.1) reach[2] = (reach[0] += -0.05) + 0.1;
    if (reach[3] - reach[1] < 0.1) reach[3] = (reach[1] += -0.05) + 0.1;
    return { s, page, bounds, hit: s.points.length > 1 && holes.some((h) => intersects(reach, h)) };
  });
  if (!parts.some((p) => p.hit)) return null;

  const closes = path.paint === "s" || path.paint === "b" || path.paint === "b*";
  const keep = (s: Subpath, last: boolean) => (closes && last && !s.closed ? `${s.source}\nh` : s.source);
  const exact = rectilinear(m);

  /** shapes that cannot be cut are removed whole, together with what lies inside them (holes of letters) */
  const dropped = parts.filter((p) => {
    if (!p.hit || !exact) return p.hit;
    if (asRectangle(p.s)) return false;
    const straight = !p.s.curved && p.page.every((q, i) => i === 0 || Math.abs(q[0] - p.page[i - 1]![0]) < 1e-3 || Math.abs(q[1] - p.page[i - 1]![1]) < 1e-3);
    return fills || !straight || p.s.closed;
  });

  const result: PathResult = { fill: [], stroke: [] };
  parts.forEach((p, index) => {
    if (dropped.includes(p) || dropped.some((d) => !p.hit && contains(d.bounds, p.bounds, 0.01))) return;
    if (!p.hit) {
      const text = keep(p.s, index === parts.length - 1);
      if (fills) result.fill.push(text);
      if (strokes) result.stroke.push(text);
      return;
    }
    const corners = asRectangle(p.s);
    if (corners) {
      if (fills) {
        const negative = signedArea(corners) < 0;
        for (const piece of holes.reduce((list, h) => list.flatMap((r) => subtractRect(r, h)), [p.bounds])) {
          const [x0, y0, x1, y1] = transformRect(inverse, piece);
          result.fill.push(
            negative
              ? `${num(x1)} ${num(y0)} ${num(x0 - x1)} ${num(y1 - y0)} re`
              : `${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re`,
          );
        }
      }
      if (!strokes) return;
    }
    // stroked edges, one by one
    const closed = !!corners || closes;
    const line = corners ? corners.map((c) => apply(m, c)) : p.page;
    for (let i = 0; i + 1 < line.length + (closed ? 1 : 0); i++) {
      for (const [a, b] of cutSegment(line[i]!, line[(i + 1) % line.length]!, half, holes)) {
        const from = apply(inverse, a);
        const to = apply(inverse, b);
        result.stroke.push(`${num(from[0])} ${num(from[1])} m ${num(to[0])} ${num(to[1])} l`);
      }
    }
  });
  return result;
}

const PATH_OPS = new Set("m l c v y h re W W* S s f F f* B B* b b* n".split(" "));

function pathReplacement(content: Uint8Array, ops: Operation[], path: PaintedPath, cut: PathResult): string {
  const out: string[] = [];
  // anything that is not part of the path (rare) keeps its effect
  for (let i = path.first; i <= path.last; i++)
    if (!PATH_OPS.has(ops[i]!.op)) out.push(latin1(content.subarray(ops[i]!.start, ops[i]!.end)));
  if (cut.fill.length) out.push(...cut.fill, path.paint.includes("*") ? "f*" : "f");
  if (cut.stroke.length) out.push(...cut.stroke, "S");
  if (path.clip) out.push(...path.subpaths.map((s) => s.source), path.clip, "n");
  return out.join("\n");
}

/* ---------- text copies in marked content ---------- */

const COPIES = ["ActualText", "Alt", "E"];

function propertiesOf(operation: Operation, resources: Obj): { tag: string; texts: string; mcid: number | null } | null {
  if (operation.op !== "BDC") return null;
  const [tag, props] = operation.operands;
  if (tag?.type !== "name" || !props) return null;
  const texts: string[] = [];
  let mcid: number | null = null;
  if (props.type === "dict") {
    for (const key of COPIES) {
      const v = props.value[key];
      if (v?.type === "string") texts.push(`${key}=${latin1(v.value)}`);
    }
    if (props.value.MCID?.type === "number") mcid = props.value.MCID.value;
  } else if (props.type === "name") {
    const dict = resources.get("Properties", props.value);
    if (dict.isDictionary()) {
      for (const key of COPIES) if (dict.get(key).isString()) texts.push(`${key}=${dict.get(key).asString()}`);
      if (dict.get("MCID").isNumber()) mcid = dict.get("MCID").asNumber();
    }
  }
  return texts.length ? { tag: tag.value, texts: texts.join("\u0000"), mcid } : null;
}

const escapeName = (name: string) =>
  name.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** the same marked content operator without its text copies */
function stripped(operation: Operation, resources: Obj): Edit | null {
  const found = propertiesOf(operation, resources);
  if (!found) return null;
  const tag = `/${escapeName(found.tag)}`;
  return {
    start: operation.start,
    end: operation.end,
    replacement: found.mcid === null ? `${tag} BMC` : `${tag} <</MCID ${found.mcid}>> BDC`,
  };
}

const shownBytes = (o: Operand): number =>
  o.type === "string" ? o.value.length : o.type === "array" ? o.value.reduce((n, v) => n + shownBytes(v), 0) : 0;

export interface TextCensus {
  /** how often each (text copy, number of glyph bytes inside) pair occurs */
  spans: Map<string, number>;
  bytes: number;
}

function spansOf(ops: Operation[], resources: Obj) {
  const spans: { index: number; texts: string; bytes: number }[] = [];
  const open: (number | null)[] = [];
  let bytes = 0;
  ops.forEach((operation, index) => {
    const { op, operands } = operation;
    if (op === "BMC" || op === "BDC") {
      const found = propertiesOf(operation, resources);
      open.push(found ? spans.push({ index, texts: found.texts, bytes: 0 }) - 1 : null);
    } else if (op === "EMC") open.pop();
    else if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
      const n = operands.reduce((sum, o) => sum + shownBytes(o), 0);
      bytes += n;
      for (const i of open) if (i !== null) spans[i]!.bytes += n;
    }
  });
  return { spans, bytes };
}

/** record every text copy and how much text it stands for, including nested forms */
export function censusText(content: Uint8Array, resources: Obj, into: TextCensus = { spans: new Map(), bytes: 0 }, seen = new Set<number>()): TextCensus {
  const ops = parseContent(content);
  const found = spansOf(ops, resources);
  into.bytes += found.bytes;
  for (const s of found.spans) {
    const key = `${s.bytes}\u0001${s.texts}`;
    into.spans.set(key, (into.spans.get(key) ?? 0) + 1);
  }
  for (const operation of ops) {
    const x = xobjectOf(operation, resources);
    if (x?.subtype !== "Form" || seen.size > 200) continue;
    const number = x.object.isIndirect() ? x.object.asIndirect() : 0;
    if (seen.has(number)) continue;
    seen.add(number);
    const own = x.object.get("Resources");
    censusText(streamBytes(x.object), own.isDictionary() ? own : resources, into, seen);
  }
  return into;
}

/* ---------- stroke state ---------- */

/** operators MuPDF's redaction filter forgets when the only thing they affect is stroked text */
const STROKE_KEYS: Record<string, string> = { w: "LW", J: "LC", j: "LJ", M: "ML", d: "D" };
/** marks a graphics state that stands in for one of those operators */
const STAND_IN = "PEOp";

export function strokesText(content: Uint8Array, resources: Obj, depth = 0): boolean {
  return parseContent(content).some((operation) => {
    const mode = operation.operands[0];
    if (operation.op === "Tr") return mode?.type === "number" && [1, 2, 5, 6].includes(mode.value);
    const x = depth < 12 ? xobjectOf(operation, resources) : null;
    if (x?.subtype !== "Form") return false;
    const own = x.object.get("Resources");
    return strokesText(streamBytes(x.object), own.isDictionary() ? own : resources, depth + 1);
  });
}

const operandValue = (o: Operand): unknown =>
  o.type === "number" ? o.value : o.type === "array" ? o.value.map(operandValue) : 0;

/**
 * Write line width, caps, joins and dashes as `gs` operators, which survive the filter; scrubCopies turns
 * them back afterwards. `resources` must be private to this stream.
 */
export function shieldStrokeState(job: Redaction, content: Uint8Array, resources: Obj, depth = 0): Rewrite {
  const { doc } = job.ctx;
  const edits: Edit[] = [];
  const replaced = new Set<string>();
  for (const operation of parseContent(content)) {
    const { op, operands, start, end } = operation;
    const key = STROKE_KEYS[op];
    if (key && operands.length) {
      const state = doc.newDictionary();
      state.put("Type", doc.newName("ExtGState"));
      state.put(key, op === "d" ? operands.map(operandValue) : operandValue(operands[0]!));
      state.put(STAND_IN, doc.newString(latin1(content.subarray(start, end))));
      const name = addResource(doc, resources, "ExtGState", "PEs", doc.addObject(state));
      edits.push({ start, end, replacement: `/${name} gs` });
      continue;
    }
    const x = depth < 12 ? xobjectOf(operation, resources) : null;
    if (x?.subtype !== "Form") continue;
    const own = x.object.get("Resources");
    const formResources = copyResources(doc, own.isDictionary() ? own : resources);
    const inner = shieldStrokeState(job, streamBytes(x.object), formResources, depth + 1);
    if (!inner.changed) continue;
    edits.push(replaceForm(job, operation, resources, x.object, inner.content, formResources));
    replaced.add(x.name);
  }
  if (!edits.length) return { content, changed: false };
  const next = spliceContent(content, edits);
  dropUnused(next, resources, replaced);
  return { content: next, changed: true };
}

/* ---------- walking and rewriting ---------- */

export interface Rewrite {
  content: Uint8Array;
  changed: boolean;
}

export interface Redaction {
  ctx: EngineContext;
  toPage: Matrix;
  /** page space */
  holes: Rect[];
}

/** replace a form invocation by a private copy with new content */
function replaceForm(job: Redaction, operation: Operation, resources: Obj, form: Obj, content: Uint8Array, formResources: Obj): Edit {
  const { doc } = job.ctx;
  const dict = copyDict(doc, form, ["Length", "Filter", "DecodeParms", "Resources", "PieceInfo", "Metadata"]);
  dict.put("Resources", formResources);
  const name = addResource(doc, resources, "XObject", "PEr", doc.addStream(content, dict));
  return { start: operation.start, end: operation.end, replacement: `/${name} Do` };
}

function dropUnused(content: Uint8Array, resources: Obj, names: Iterable<string>) {
  const used = new Set(
    parseContent(content).flatMap((o) => (o.op === "Do" && o.operands[0]?.type === "name" ? [o.operands[0].value] : [])),
  );
  const dict = resources.get("XObject");
  if (!dict.isNull()) for (const name of names) if (!used.has(name)) dict.delete(name);
}

/** cut line art and image masks under the holes. `resources` must be private to this stream */
export function cutContent(job: Redaction, content: Uint8Array, resources: Obj, state: GraphicsState, depth = 0): Rewrite {
  const ops = parseContent(content);
  const edits: Edit[] = [];
  const touched = new Set<number>();
  const replaced = new Set<string>();
  const touch = (marked: { index: number }[]) => marked.forEach((m) => touched.add(m.index));

  walk(content, ops, resources, job.toPage, state, {
    path(path, at) {
      if (path.paint === "n") return;
      const cut = cutPath(path, at.state, job.toPage, job.holes);
      if (!cut) return;
      edits.push({ start: ops[path.first]!.start, end: ops[path.last]!.end, replacement: pathReplacement(content, ops, path, cut) });
      touch(at.marked);
    },
    object(at) {
      const bounds = transformRect(multiply(at.state.ctm, job.toPage), [0, 0, 1, 1]);
      if (at.operation.op === "BI") {
        if (job.holes.some((h) => intersects(bounds, h))) touch(at.marked);
        return;
      }
      const x = xobjectOf(at.operation, resources);
      if (!x) return;
      if (x.subtype === "Image") {
        if (!job.holes.some((h) => intersects(bounds, h))) return;
        touch(at.marked);
        const mask = x.object.get("Mask");
        if (mask.isStream()) {
          // a stencil mask keeps the outline of what it covered: remove the picture altogether
          edits.push({ start: at.operation.start, end: at.operation.end, replacement: "" });
          replaced.add(x.name);
        } else if (x.object.get("SMask").isStream()) {
          const image = wipeMask(job, x.object, multiply(at.state.ctm, job.toPage));
          const name = addResource(job.ctx.doc, resources, "XObject", "PEr", image);
          edits.push({ start: at.operation.start, end: at.operation.end, replacement: `/${name} Do` });
          replaced.add(x.name);
        }
      } else if (x.subtype === "Form" && depth < 12) {
        const inside = formState(x.object, at.state, job.toPage);
        if (!job.holes.some((h) => inside.clip && intersects(inside.clip, h))) return;
        const own = x.object.get("Resources");
        const formResources = copyResources(job.ctx.doc, own.isDictionary() ? own : resources);
        const inner = cutContent(job, streamBytes(x.object), formResources, inside, depth + 1);
        if (!inner.changed) return;
        touch(at.marked);
        edits.push(replaceForm(job, at.operation, resources, x.object, inner.content, formResources));
        replaced.add(x.name);
      }
    },
  });

  for (const index of touched) {
    const edit = stripped(ops[index]!, resources);
    if (edit) edits.push(edit);
  }
  if (!edits.length) return { content, changed: false };
  const next = spliceContent(content, edits);
  dropUnused(next, resources, replaced);
  return { content: next, changed: true };
}

/** names of property lists that marked content in this stream (or forms borrowing its resources) refers to */
function usedProperties(content: Uint8Array, resources: Obj, used = new Set<string>(), depth = 0): Set<string> {
  for (const operation of parseContent(content)) {
    const props = operation.operands[1];
    if ((operation.op === "BDC" || operation.op === "DP") && props?.type === "name") used.add(props.value);
    const x = xobjectOf(operation, resources);
    if (x?.subtype === "Form" && depth < 12 && !x.object.get("Resources").isDictionary())
      usedProperties(streamBytes(x.object), resources, used, depth + 1);
  }
  return used;
}

/** a property list nothing points at any more must not keep its text. `resources` must be private */
export function dropUnusedProperties(content: Uint8Array, resources: Obj): void {
  const dict = resources.get("Properties");
  if (!dict.isDictionary()) return;
  const used = usedProperties(content, resources);
  const unused: string[] = [];
  dict.forEach((value, name) => {
    if (!used.has(String(name)) && COPIES.some((key) => !value.get(key).isNull())) unused.push(String(name));
  });
  for (const name of unused) dict.delete(name);
}

/** drop text copies whose text is no longer (completely) there, and restore shielded stroke operators */
export function scrubCopies(job: Redaction, content: Uint8Array, resources: Obj, before: TextCensus, depth = 0): Rewrite {
  const ops = parseContent(content);
  const edits: Edit[] = [];
  const replaced = new Set<string>();
  for (const s of spansOf(ops, resources).spans) {
    const key = `${s.bytes}\u0001${s.texts}`;
    const left = before.spans.get(key) ?? 0;
    if (left > 0) before.spans.set(key, left - 1);
    else {
      const edit = stripped(ops[s.index]!, resources);
      if (edit) edits.push(edit);
    }
  }
  const standIns = new Set<string>();
  for (const operation of ops) {
    const name = operation.operands[0];
    if (operation.op !== "gs" || name?.type !== "name") continue;
    const original = resources.get("ExtGState", name.value, STAND_IN);
    if (!original.isString()) continue;
    edits.push({ start: operation.start, end: operation.end, replacement: original.asString() });
    standIns.add(name.value);
  }
  for (const name of standIns) resources.get("ExtGState").delete(name);
  for (const operation of ops) {
    const x = xobjectOf(operation, resources);
    if (x?.subtype !== "Form" || depth >= 12) continue;
    const own = x.object.get("Resources");
    const formResources = copyResources(job.ctx.doc, own.isDictionary() ? own : resources);
    const inner = scrubCopies(job, streamBytes(x.object), formResources, before, depth + 1);
    for (const key of ["PieceInfo", "Metadata"]) if (!x.object.get(key).isNull()) x.object.delete(key);
    const listed = formResources.get("Properties").isDictionary() ? formResources.get("Properties").toString() : "";
    dropUnusedProperties(inner.content, formResources);
    const trimmed = !!listed && formResources.get("Properties").toString() !== listed;
    if (!inner.changed && !trimmed) continue;
    edits.push(replaceForm(job, operation, resources, x.object, inner.content, formResources));
    replaced.add(x.name);
  }
  if (!edits.length) return { content, changed: false };
  const next = spliceContent(content, edits);
  dropUnused(next, resources, replaced);
  return { content: next, changed: true };
}

/** a copy of a soft masked image with the covered part made solid black */
function wipeMask(job: Redaction, ref: Obj, toPage: Matrix): Obj {
  const { mupdf, doc } = job.ctx;
  const inverse = invert(toPage);
  const covered = job.holes
    .map((h) => transformRect(inverse, h))
    .map((r): Rect => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(1, r[2]), Math.min(1, r[3])])
    .filter((r) => area(r) > 0);

  const load = (object: Obj) => {
    const image = doc.loadImage(object);
    let pixmap = image.toPixmap();
    const space = pixmap.getColorSpace();
    if (space && !space.isGray() && !space.isRGB()) pixmap = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
    image.destroy();
    return pixmap;
  };
  const paint = (pixmap: MuPDF.Pixmap, value: number) => {
    const w = pixmap.getWidth();
    const h = pixmap.getHeight();
    const n = pixmap.getNumberOfComponents();
    const stride = pixmap.getStride();
    const pixels = pixmap.getPixels();
    for (const [u0, v0, u1, v1] of covered) {
      // image rows run from the top, the unit square from the bottom
      for (let y = Math.floor((1 - v1) * h); y < Math.min(h, Math.ceil((1 - v0) * h)); y++)
        for (let x = Math.floor(u0 * w); x < Math.min(w, Math.ceil(u1 * w)); x++)
          pixels.fill(value, y * stride + x * n, y * stride + (x + 1) * n);
    }
  };

  const color = load(ref);
  const alpha = load(ref.get("SMask"));
  paint(color, 0);
  paint(alpha, 255);
  const soft = new mupdf.Image(alpha);
  const image = new mupdf.Image(color, soft);
  return doc.addImage(image);
}
