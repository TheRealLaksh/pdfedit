/**
 * Added objects. Each one is a Form XObject drawn in "local" coordinates (page space without rotation),
 * referenced from the page content inside `/PEObj <</PEId (id)>> BDC ... EMC`, so it can be rewritten or
 * removed in place and keeps its z position.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext, ModuleChange } from "../context";
import * as fonts from "../fonts";
import { invert, multiply, num, rectFromPoints, transformRect, union } from "../geom";
import { concatBytes, encodeLatin1, parseContent, spliceContent, type Operation } from "../content/tokenizer";
import type { Matrix, NewPageObject, PageObject, Point, RGB, Rect } from "../types";
import { embedImage } from "./imageData";
import { opsState } from "./state";
import {
  appendToPage, assertPage, drawFormOps, fillColor, findSegment, makeForm, normalizeRect, ownResources,
  readPageContent, strokeColor, withPage, writePageContent, type Segment,
} from "./shared";
import { layoutText, missingWarning } from "./textLayout";

const KAPPA = 0.5522847498;
const BLACK: RGB = [0, 0, 0];
const HIGHLIGHT: RGB = [1, 0.9, 0.2];

export function listObjects(ctx: EngineContext, page: number): PageObject[] {
  assertPage(ctx.doc, page);
  return Object.values(ctx.state.objects)
    .filter((o) => o.page === page)
    .map((o) => structuredClone(o));
}

export async function addObject(ctx: EngineContext, object: NewPageObject): Promise<ModuleChange> {
  assertPage(ctx.doc, object.page);
  const id = ctx.newId("obj");
  let full: PageObject;
  if (object.kind === "image") {
    const { data, ...rest } = object;
    const blobId = ctx.newId("img");
    ctx.blobs.set(blobId, data.slice());
    full = { ...rest, id, blobId } as PageObject;
  } else {
    full = { ...structuredClone(object), id } as PageObject;
  }
  full = sanitize(full);
  const built = await build(ctx, full);
  place(ctx, built.object, built);
  ctx.state.objects[id] = built.object;
  return { changedPages: [built.object.page], createdId: id, warnings: built.warnings };
}

export async function updateObject(ctx: EngineContext, object: PageObject): Promise<ModuleChange> {
  const old = ctx.state.objects[object.id];
  if (!old) throw new Error("That item no longer exists");
  assertPage(ctx.doc, object.page);
  const requested = structuredClone(object);
  requested.rect = normalizeRect(requested.rect);
  const next = sanitize(followRect(old, requested));
  if (next.kind === "image" && old.kind === "image" && !ctx.blobs.has(next.blobId)) next.blobId = old.blobId;
  const built = await build(ctx, next);
  if (old.page === built.object.page) {
    place(ctx, built.object, built);
  } else {
    erase(ctx, old);
    place(ctx, built.object, built);
  }
  ctx.state.objects[object.id] = built.object;
  return {
    changedPages: [...new Set([old.page, built.object.page])],
    createdId: object.id,
    warnings: built.warnings,
  };
}

export async function removeObject(ctx: EngineContext, id: string): Promise<ModuleChange> {
  const old = ctx.state.objects[id];
  if (!old) throw new Error("That item no longer exists");
  erase(ctx, old);
  delete ctx.state.objects[id];
  return { changedPages: [old.page] };
}

/* ---------- geometry ---------- */

function sanitize(o: PageObject): PageObject {
  o.rect = normalizeRect(o.rect);
  if (o.kind === "line" || o.kind === "arrow") o.rect = rectFromPoints([o.from, o.to]);
  else if (o.kind === "ink") {
    const points = o.paths.flat();
    if (!points.length) throw new Error("The drawing is empty");
    o.rect = rectFromPoints(points);
  }
  if (o.opacity !== undefined) o.opacity = Math.min(1, Math.max(0, o.opacity));
  return o;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** lines and ink are defined by points: a caller that only moved/resized the rect means "move the points" */
function followRect(old: PageObject, next: PageObject): PageObject {
  const pointsOf = (o: PageObject): Point[] | null =>
    o.kind === "line" || o.kind === "arrow" ? [o.from, o.to] : o.kind === "ink" ? o.paths.flat() : null;
  const before = pointsOf(old);
  const wanted = next.rect;
  if (!before || !same(pointsOf(next), before) || same(wanted, old.rect)) return next;
  const [x0, y0, x1, y1] = old.rect;
  const map = ([x, y]: Point): Point => [
    x1 - x0 > 1e-6 ? wanted[0] + ((x - x0) / (x1 - x0)) * (wanted[2] - wanted[0]) : x + wanted[0] - x0,
    y1 - y0 > 1e-6 ? wanted[1] + ((y - y0) / (y1 - y0)) * (wanted[3] - wanted[1]) : y + wanted[1] - y0,
  ];
  if (next.kind === "line" || next.kind === "arrow") {
    next.from = map(next.from);
    next.to = map(next.to);
  } else if (next.kind === "ink") next.paths = next.paths.map((p) => p.map(map));
  return next;
}

/** rotation (degrees clockwise on screen) around the centre of the rect, in page space */
export function rotationMatrix(rect: Rect, degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;
  return [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
}

/** the page space box an object covers, rotation included */
export function objectBounds(o: PageObject): Rect {
  const pad = "strokeWidth" in o ? (o.strokeWidth ?? 2) / 2 : 0;
  let rect: Rect = [o.rect[0] - pad, o.rect[1] - pad, o.rect[2] + pad, o.rect[3] + pad];
  if (o.kind === "arrow") {
    const head = headLength(o.strokeWidth);
    rect = union(rect, [o.to[0] - head, o.to[1] - head, o.to[0] + head, o.to[1] + head]);
  }
  return transformRect(rotationMatrix(o.rect, o.rotation ?? 0), rect);
}

/* ---------- drawing ---------- */

interface Built {
  object: PageObject;
  form: MuPDF.PDFObject;
  opacity: number;
  blend: "Normal" | "Multiply";
  warnings: string[];
}

async function build(ctx: EngineContext, object: PageObject): Promise<Built> {
  const resources = ctx.doc.newDictionary();
  const warnings: string[] = [];
  let content = "";
  let blend: Built["blend"] = "Normal";
  let [x0, y0, x1, y1] = object.rect;
  let pad = 20;

  switch (object.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "whiteout": {
      const defaults: { fill: RGB | null; stroke: RGB | null } =
        object.kind === "highlight"
          ? { fill: HIGHLIGHT, stroke: null }
          : object.kind === "whiteout"
            ? { fill: [1, 1, 1], stroke: null }
            : { fill: null, stroke: object.fill ? null : BLACK };
      const fill = object.fill === undefined ? defaults.fill : object.fill;
      const stroke = object.stroke === undefined ? defaults.stroke : object.stroke;
      const sw = object.strokeWidth ?? 2;
      if (object.kind === "highlight") blend = "Multiply";
      const paint = fill && stroke && sw > 0 ? "B" : fill ? "f" : stroke && sw > 0 ? "S" : "n";
      const path = object.kind === "ellipse" ? ellipsePath(object.rect) : `${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re`;
      content = [
        fill ? fillColor(fill) : "",
        stroke ? `${strokeColor(stroke)} ${num(sw)} w` : "",
        path,
        paint,
      ].join("\n");
      pad += sw;
      break;
    }
    case "line":
    case "arrow": {
      content = linePath(object.from, object.to, object.stroke, object.strokeWidth, object.kind === "arrow");
      pad += object.strokeWidth + headLength(object.strokeWidth);
      break;
    }
    case "ink": {
      content = `${strokeColor(object.stroke)} ${num(object.strokeWidth)} w 1 J 1 j\n${object.paths
        .filter((p) => p.length)
        .map(smoothPath)
        .join("\n")}\nS`;
      pad += object.strokeWidth;
      break;
    }
    case "image": {
      const data = ctx.blobs.get(object.blobId);
      if (!data) throw new Error("The image data is no longer available");
      const state = opsState(ctx);
      const image = embedImage(ctx, data, state.images[object.blobId]);
      state.images[object.blobId] = image.ref.asIndirect();
      resources.put("XObject", { Im: image.ref });
      content = `q ${num(x1 - x0)} 0 0 ${num(y0 - y1)} ${num(x0)} ${num(y1)} cm ${image.orient.map(num).join(" ")} cm /Im Do Q`;
      break;
    }
    case "text": {
      const width = Math.max(x1 - x0, object.style.size * 1.2);
      const layout = await layoutText(ctx, {
        text: object.text,
        style: object.style,
        width,
        align: object.align,
        lineHeight: object.lineHeight,
      });
      const missing = new Set(layout.missing);
      const parts: string[] = [];
      for (const [i, line] of layout.lines.entries()) {
        if (!line.text) continue;
        const written = await fonts.writeText(ctx, {
          text: line.text,
          style: object.style,
          matrix: [1, 0, 0, -1, x0 + line.x, y0 + layout.baseline(i)],
          resources,
          charSpacing: line.charSpacing,
          wordSpacing: line.wordSpacing,
        });
        for (const m of written.missing) missing.add(m);
        parts.push(written.ops);
      }
      content = parts.join("\n");
      warnings.push(...missingWarning(missing));
      // grow the box downwards so the whole text is inside it, keeping its top-left corner still
      const height = Math.max(y1 - y0, layout.height);
      if (height > y1 - y0 + 0.01 || width > x1 - x0) {
        object.rect = growRect(object.rect, width, height, object.rotation ?? 0);
        const dx = object.rect[0] - x0;
        const dy = object.rect[1] - y0;
        if (dx || dy) content = `q 1 0 0 1 ${num(dx)} ${num(dy)} cm\n${content}\nQ`;
        [x0, y0, x1, y1] = object.rect;
      }
      pad = object.style.size * 2 + 20;
      break;
    }
  }

  const opacity = object.opacity ?? 1;
  const form = makeForm(ctx.doc, {
    bbox: [x0 - pad, y0 - pad, x1 + pad, y1 + pad],
    content,
    resources,
    group: opacity < 1 || blend !== "Normal",
  });
  return { object, form, opacity, blend, warnings };
}

/** enlarge a (possibly rotated) rect so that its displayed top-left corner does not move */
function growRect(rect: Rect, width: number, height: number, degrees: number): Rect {
  const oldW = rect[2] - rect[0];
  const oldH = rect[3] - rect[1];
  const r = (degrees * Math.PI) / 180;
  const dw = (width - oldW) / 2;
  const dh = (height - oldH) / 2;
  const cx = (rect[0] + rect[2]) / 2 + dw * Math.cos(r) - dh * Math.sin(r);
  const cy = (rect[1] + rect[3]) / 2 + dw * Math.sin(r) + dh * Math.cos(r);
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}

function ellipsePath([x0, y0, x1, y1]: Rect): string {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const ox = ((x1 - x0) / 2) * KAPPA;
  const oy = ((y1 - y0) / 2) * KAPPA;
  const c = (...v: number[]) => `${v.map(num).join(" ")} c`;
  return [
    `${num(x1)} ${num(cy)} m`,
    c(x1, cy + oy, cx + ox, y1, cx, y1),
    c(cx - ox, y1, x0, cy + oy, x0, cy),
    c(x0, cy - oy, cx - ox, y0, cx, y0),
    c(cx + ox, y0, x1, cy - oy, x1, cy),
    "h",
  ].join("\n");
}

const headLength = (strokeWidth: number) => Math.max(8, strokeWidth * 4);

function linePath(from: Point, to: Point, color: RGB, width: number, arrow: boolean): string {
  const out = [`${strokeColor(color)} ${fillColor(color)} ${num(width)} w 1 J 1 j`];
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  let end = to;
  let head = "";
  if (arrow && length > 0.01) {
    const size = Math.min(headLength(width), length);
    const ux = (to[0] - from[0]) / length;
    const uy = (to[1] - from[1]) / length;
    const base: Point = [to[0] - ux * size, to[1] - uy * size];
    const half = size * 0.5;
    end = [to[0] - ux * size * 0.8, to[1] - uy * size * 0.8];
    head =
      `${num(to[0])} ${num(to[1])} m ${num(base[0] - uy * half)} ${num(base[1] + ux * half)} l ` +
      `${num(base[0] + uy * half)} ${num(base[1] - ux * half)} l h f`;
  }
  out.push(`${num(from[0])} ${num(from[1])} m ${num(end[0])} ${num(end[1])} l S`);
  if (head) out.push(head);
  return out.join("\n");
}

/** quadratic smoothing through segment midpoints, written as cubic curves */
function smoothPath(points: Point[]): string {
  const p = (v: Point) => `${num(v[0])} ${num(v[1])}`;
  const first = points[0]!;
  const out = [`${p(first)} m`];
  if (points.length < 3) {
    out.push(`${p(points.at(-1)!)} l`);
    return out.join("\n");
  }
  let current = first;
  for (let i = 1; i < points.length - 1; i++) {
    const control = points[i]!;
    const next = points[i + 1]!;
    const end: Point = i === points.length - 2 ? next : [(control[0] + next[0]) / 2, (control[1] + next[1]) / 2];
    const c1: Point = [current[0] + (2 / 3) * (control[0] - current[0]), current[1] + (2 / 3) * (control[1] - current[1])];
    const c2: Point = [end[0] + (2 / 3) * (control[0] - end[0]), end[1] + (2 / 3) * (control[1] - end[1])];
    out.push(`${p(c1)} ${p(c2)} ${p(end)} c`);
    current = end;
  }
  return out.join("\n");
}

/* ---------- page content ---------- */

/** write (or rewrite in place) the object's segment */
function place(ctx: EngineContext, object: PageObject, built: Built): void {
  withPage(ctx.doc, object.page, (page) => {
    const resources = ownResources(ctx.doc, page);
    const content = readPageContent(page);
    const segment = findSegment(content, resources, object.id);
    if (segment) dropResources(resources, content, segment);
    const toUser = multiply(rotationMatrix(object.rect, object.rotation ?? 0), invert(page.getTransform() as Matrix));
    const draw = drawFormOps(ctx, page, resources, built, toUser);
    const marked = `/PEObj <</PEId (${object.id})>> BDC\n${draw}\nEMC`;
    if (segment)
      writePageContent(
        ctx.doc,
        page,
        spliceContent(content, [{ start: segment.start, end: segment.end, replacement: marked }]),
      );
    else appendToPage(ctx.doc, page, marked);
  });
}

/** remove the object's segment and its resources from its page */
function erase(ctx: EngineContext, object: PageObject): void {
  withPage(ctx.doc, object.page, (page) => {
    const resources = ownResources(ctx.doc, page);
    const content = readPageContent(page);
    const segment = findSegment(content, resources, object.id);
    if (segment) {
      dropResources(resources, content, segment);
      writePageContent(
        ctx.doc,
        page,
        concatBytes([content.subarray(0, segment.start), encodeLatin1("\n"), content.subarray(segment.end)]),
      );
    } else {
      // still record a change so that undo history stays aligned with the registry
      writePageContent(ctx.doc, page, content);
    }
  });
}

/** unregister what only this segment uses (other modules may have renamed the resources) */
function dropResources(resources: MuPDF.PDFObject, content: Uint8Array, segment: Segment): void {
  const used = (op: Operation) => {
    const name = op.operands[0];
    return name?.type === "name" && (op.op === "Do" || op.op === "gs") ? `${op.op} ${name.value}` : null;
  };
  const elsewhere = new Set(
    parseContent(content)
      .filter((op) => op.start < segment.start || op.start >= segment.end)
      .map(used),
  );
  for (const op of segment.ops) {
    const key = used(op);
    if (!key || elsewhere.has(key)) continue;
    const dict = resources.get(op.op === "Do" ? "XObject" : "ExtGState");
    const name = op.operands[0];
    if (!dict.isNull() && name?.type === "name") dict.delete(name.value);
  }
}
