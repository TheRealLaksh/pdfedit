/**
 * Images that are already part of the page (also inside form XObjects and inline). Only the operator that
 * draws the chosen image is touched; shared forms and resource dictionaries are copied before writing.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext, ModuleChange } from "../context";
import { parseContent, spliceContent, type Operation } from "../content/tokenizer";
import { IDENTITY, invert, matrixOps, multiply, transformRect, union } from "../geom";
import type { ImageItem, Matrix, Rect } from "../types";
import { embedImage } from "./imageData";
import {
  addResource, appendToPage, area, contains, copyDict, copyResources, intersection, newArrayOf, normalizeRect,
  numbers, ownResources, readPageContent, streamBytes, withPage, writePageContent,
} from "./shared";
import { formState, walk, xobjectOf, type GraphicsState, type StateOp } from "./walk";

/** one nesting level on the way to an image: the Do (or BI) operator and the state it runs in */
interface Step {
  index: number;
  state: GraphicsState;
  levels: StateOp[][];
}

interface ImageUse {
  chain: Step[];
  /** visible part, page space */
  rect: Rect;
  /** bounds of the whole image, page space */
  full: Rect;
  width: number;
  height: number;
}

/** pictures and text forms the OCR module placed to rewrite scanned lines */
function ocrObjects(ctx: EngineContext): Set<number> {
  const out = new Set<number>();
  for (const entry of Object.values(ctx.state.ocr))
    for (const edit of Object.values(entry.edits)) {
      const e = edit as { patch?: { object?: number } | null; textForm?: number | null } | null;
      if (e?.patch?.object) out.add(e.patch.object);
      if (e?.textForm) out.add(e.textForm);
    }
  return out;
}

/** content we manage through the object registry */
const OWNED = new Set(["PEObj"]);
const MOVE_TAG = "PEImg";

function collect(page: MuPDF.PDFPage, hidden: Set<number>): ImageUse[] {
  const toPage = page.getTransform() as Matrix;
  const found: ImageUse[] = [];
  // forms drawn over and over would otherwise be read for ever
  let forms = 5000;

  const visit = (content: Uint8Array, resources: MuPDF.PDFObject, state: GraphicsState, chain: Step[], seen: number[]) => {
    walk(content, parseContent(content), resources, toPage, state, {
      object(at) {
        if (at.marked.some((m) => OWNED.has(m.tag))) return;
        const step: Step = { index: at.index, state: at.state, levels: at.levels.map((l) => [...l]) };
        const add = (width: number, height: number) => {
          const full = transformRect(multiply(at.state.ctm, toPage), [0, 0, 1, 1]);
          const rect = at.state.clip ? intersection(full, at.state.clip) : full;
          if (rect && area(rect) >= 1) found.push({ chain: [...chain, step], rect, full, width, height });
        };
        if (at.operation.op === "BI") {
          const dict = at.operation.operands[0];
          if (dict?.type !== "dict") return;
          const read = (a: string, b: string) => {
            const v = dict.value[a] ?? dict.value[b];
            return v?.type === "number" ? v.value : 0;
          };
          add(read("W", "Width"), read("H", "Height"));
          return;
        }
        const x = xobjectOf(at.operation, resources);
        if (!x || (x.object.isIndirect() && hidden.has(x.object.asIndirect()))) return;
        if (x.subtype === "Image") add(x.object.get("Width").asNumber(), x.object.get("Height").asNumber());
        else if (x.subtype === "Form") {
          const number = x.object.isIndirect() ? x.object.asIndirect() : 0;
          if (seen.length >= 12 || seen.includes(number) || forms-- <= 0) return;
          const own = x.object.get("Resources");
          visit(
            streamBytes(x.object),
            own.isDictionary() ? own : resources,
            formState(x.object, at.state, toPage),
            [...chain, step],
            [...seen, number],
          );
        }
      },
    });
  };

  visit(
    readPageContent(page),
    page.getObject().getInheritable("Resources"),
    { ctm: [...IDENTITY], clip: null, lineWidth: 1 },
    [],
    [],
  );
  return found;
}

export function listImages(ctx: EngineContext, page: number): ImageItem[] {
  return withPage(ctx.doc, page, (p) =>
    collect(p, ocrObjects(ctx)).map((use, i) => ({
      id: `img-${i}`,
      page,
      rect: use.rect,
      pixelWidth: use.width,
      pixelHeight: use.height,
    })),
  );
}

interface Placed {
  replacement: string;
  /** drawn at the end of the page instead (the old place cannot be freed from its clip) */
  append?: Matrix;
}

/**
 * Draw `/name Do` where the old operator was, transformed by `move` (page space) and not cut off by
 * clipping paths that do not cover `target`. A clip that was cropping the image itself moves with it.
 */
function drawAt(step: Step, name: string, toPage: Matrix, target: Rect, move: Matrix | null, full: Rect | null): Placed {
  const owns = (rect: Rect) => !!full && area(rect) <= area(full) * 1.5;
  const levels = step.levels;
  let lowest = -1;
  for (let l = 0; l < levels.length && lowest < 0; l++)
    if (levels[l]!.some((s) => s.clip && (owns(s.clip.rect) || !contains(s.clip.rect, target)))) lowest = l;

  /** the cm that has the effect of `move` when inserted while `ctm` is current */
  const local = (ctm: Matrix): string => {
    if (!move) return "";
    const m = multiply(ctm, toPage);
    return `${matrixOps(multiply(multiply(m, move), invert(m)))} cm\n`;
  };

  if (lowest < 0) return { replacement: move ? `q ${local(step.state.ctm)}/${name} Do Q` : `/${name} Do` };
  if (lowest === 0) {
    const absolute = multiply(multiply(multiply(step.state.ctm, toPage), move ?? IDENTITY), invert(toPage));
    return { replacement: "", append: absolute };
  }

  const depth = levels.length - 1;
  let out = "Q\n".repeat(depth - lowest + 1) + "q\n";
  let moved = false;
  for (let l = lowest; l <= depth; l++)
    for (const s of levels[l]!) {
      if (s.clip) {
        if (owns(s.clip.rect)) {
          if (!moved) out += local(s.ctm);
          moved = true;
        } else if (moved || !contains(s.clip.rect, target)) continue;
      }
      out += s.text + "\n";
    }
  if (!moved) out += local(step.state.ctm);
  out += `/${name} Do\nQ\n`;
  // put the graphics state back exactly as it was
  for (let l = lowest; l <= depth; l++) out += "q\n" + levels[l]!.map((s) => s.text).join("\n") + "\n";
  return { replacement: out };
}

/** the operators of an earlier move wrapper around operation `i`, if it has the simple shape */
function wrapper(ops: Operation[], i: number) {
  const [tag, q, cm, , end, emc] = ops.slice(i - 3, i + 3);
  const name = tag?.operands[0];
  return i >= 3 && name?.type === "name" && name.value === MOVE_TAG && q?.op === "q" && cm?.op === "cm" &&
    end?.op === "Q" && emc?.op === "EMC"
    ? { start: tag!.start, end: emc.end, cm }
    : null;
}

type LeafEdit =
  | { kind: "move"; rect: Rect }
  | { kind: "delete" }
  | { kind: "replace"; data: Uint8Array };

async function change(ctx: EngineContext, pageIndex: number, id: string, edit: LeafEdit): Promise<ModuleChange> {
  withPage(ctx.doc, pageIndex, (page) => {
    const use = collect(page, ocrObjects(ctx))[Number(/^img-(\d+)$/.exec(id)?.[1] ?? NaN)];
    if (!use) throw new Error("That image is no longer on the page");
    const toPage = page.getTransform() as Matrix;
    const target: Rect = edit.kind === "move" ? edit.rect : use.rect;
    let move: Matrix | null = null;
    if (edit.kind === "move") {
      const [x0, y0, x1, y1] = use.rect;
      const sx = (target[2] - target[0]) / (x1 - x0);
      const sy = (target[3] - target[1]) / (y1 - y0);
      move = multiply(multiply([1, 0, 0, 1, -x0, -y0], [sx, 0, 0, sy, 0, 0]), [1, 0, 0, 1, target[0], target[1]]);
    }
    let appended: { matrix: Matrix; object: MuPDF.PDFObject } | null = null;

    const rewrite = (level: number, content: Uint8Array, resources: MuPDF.PDFObject): Uint8Array => {
      const ops = parseContent(content);
      const step = use.chain[level]!;
      const op = ops[step.index]!;
      const oldName = op.op === "Do" && op.operands[0]?.type === "name" ? op.operands[0].value : null;
      const leaf = level === use.chain.length - 1;
      let range = { start: op.start, end: op.end };
      let text = "";

      /** place `name` here; a clip we cannot leave sends it to the end of the page */
      const put = (name: string, object: MuPDF.PDFObject, matrix: Matrix | null, full: Rect | null): string => {
        const placed = drawAt(step, name, toPage, target, matrix, full);
        if (!placed.append) return placed.replacement;
        if (level === 0) {
          appended = { matrix: placed.append, object };
          return "";
        }
        return matrix ? drawAt({ ...step, levels: [[]] }, name, toPage, target, matrix, null).replacement : `/${name} Do`;
      };

      if (!leaf) {
        const form = resources.get("XObject", oldName!);
        const own = form.get("Resources");
        const formResources = copyResources(ctx.doc, own.isDictionary() ? own : resources);
        const inner = rewrite(level + 1, streamBytes(form), formResources);
        const dict = copyDict(ctx.doc, form, ["Length", "Filter", "DecodeParms", "Resources"]);
        dict.put("Resources", formResources);
        const inside = formState(form, step.state, toPage);
        const toForm = invert(multiply(inside.ctm, toPage));
        const bbox = union(numbers(form.get("BBox"), [0, 0, 0, 0]) as Rect, transformRect(toForm, target));
        dict.put("BBox", newArrayOf(ctx.doc, bbox.map((v) => ctx.doc.newReal(v))));
        const copy = ctx.doc.addStream(inner, dict);
        const name = addResource(ctx.doc, resources, "XObject", "PEx", copy);
        text = put(name, copy, null, null);
      } else {
        const wrapped = wrapper(ops, step.index);
        if (edit.kind === "delete") {
          if (wrapped) range = wrapped;
        } else if (edit.kind === "move") {
          if (oldName === null) {
            // inline image: wrap the BI operator itself
            const body = content.subarray(op.start, op.end);
            const m = multiply(step.state.ctm, toPage);
            const cm = matrixOps(multiply(multiply(m, move!), invert(m)));
            return spliceContent(content, [
              { start: op.start, end: op.start, replacement: `/${MOVE_TAG} BMC q ${cm} cm` },
              { start: op.start + body.length, end: op.end, replacement: "Q EMC" },
            ]);
          }
          const object = resources.get("XObject", oldName);
          const placed = put(oldName, object, move, use.full);
          const simple = placed.startsWith("q ") && placed.endsWith(" Do Q");
          if (wrapped && simple) {
            // fold into the existing wrapper so repeated moves do not pile up
            const m = multiply(step.state.ctm, toPage);
            const previous = wrapped.cm.operands.map((o) => (o.type === "number" ? o.value : 0)) as Matrix;
            const combined = multiply(multiply(multiply(m, move!), invert(m)), previous);
            range = wrapped.cm;
            text = `${matrixOps(combined)} cm`;
          } else text = placed ? `/${MOVE_TAG} BMC ${placed} EMC` : "";
        } else {
          const image = embedImage(ctx, edit.data);
          const name = addResource(ctx.doc, resources, "XObject", "PEi", image.ref);
          const m = multiply(step.state.ctm, toPage);
          const fit = replacementMatrix(m, use.rect, image.width / image.height, image.orient);
          text = `/${MOVE_TAG} BMC q ${matrixOps(fit)} cm /${name} Do Q EMC`;
        }
      }

      const next = spliceContent(content, [{ ...range, replacement: text }]);
      // drop the old resource when nothing draws it any more, so its data can be garbage collected
      if (oldName !== null && !appended) {
        const stillUsed = parseContent(next).some(
          (o) => o.op === "Do" && o.operands[0]?.type === "name" && o.operands[0].value === oldName,
        );
        const dict = resources.get("XObject");
        if (!stillUsed && !dict.isNull()) dict.delete(oldName);
      }
      return next;
    };

    const resources = ownResources(ctx.doc, page);
    writePageContent(ctx.doc, page, rewrite(0, readPageContent(page), resources));
    const extra = appended as { matrix: Matrix; object: MuPDF.PDFObject } | null;
    if (extra) {
      const name = addResource(ctx.doc, resources, "XObject", "PEx", extra.object);
      appendToPage(ctx.doc, page, `/${MOVE_TAG} BMC q ${matrixOps(extra.matrix)} cm /${name} Do Q EMC`);
    }
  });
  return { changedPages: [pageIndex] };
}

export const moveImage = (ctx: EngineContext, page: number, id: string, rect: Rect) =>
  change(ctx, page, id, { kind: "move", rect: ensureSize(normalizeRect(rect)) });

export const deleteImage = (ctx: EngineContext, page: number, id: string) =>
  change(ctx, page, id, { kind: "delete" });

export const replaceImage = (ctx: EngineContext, page: number, id: string, data: Uint8Array) =>
  change(ctx, page, id, { kind: "replace", data });

function ensureSize(r: Rect): Rect {
  return [r[0], r[1], Math.max(r[2], r[0] + 1), Math.max(r[3], r[1] + 1)];
}

/** shrink-to-fit factors (each at most 1) for a picture of shape `aspect` in a box of shape `box` */
const contain = (aspect: number, box: number): [number, number] =>
  aspect > box ? [1, box / aspect] : [aspect / box, 1];

/**
 * The `cm` for a replacement picture drawn where an image with page space matrix `m` was. A box that is
 * level on screen gets the new picture upright; a tilted one passes its tilt on.
 */
function replacementMatrix(m: Matrix, rect: Rect, aspect: number, orient: Matrix): Matrix {
  const level = (Math.abs(m[1]) < 1e-3 && Math.abs(m[2]) < 1e-3) || (Math.abs(m[0]) < 1e-3 && Math.abs(m[3]) < 1e-3);
  if (level) {
    const [x0, y0, x1, y1] = rect;
    const [sx, sy] = contain(aspect, (x1 - x0) / (y1 - y0));
    const w = (x1 - x0) * sx;
    const h = (y1 - y0) * sy;
    const onScreen: Matrix = [w, 0, 0, -h, (x0 + x1 - w) / 2, (y0 + y1 + h) / 2];
    return multiply(multiply(orient, onScreen), invert(m));
  }
  const [sx, sy] = contain(aspect, Math.hypot(m[0], m[1]) / Math.hypot(m[2], m[3]));
  // a placement that mirrors the old pixels must not mirror the new picture
  const flip: Matrix = m[0] * m[3] - m[1] * m[2] > 0 ? [1, 0, 0, -1, 0, 1] : IDENTITY;
  return multiply(multiply(orient, flip), [sx, 0, 0, sy, (1 - sx) / 2, (1 - sy) / 2]);
}
