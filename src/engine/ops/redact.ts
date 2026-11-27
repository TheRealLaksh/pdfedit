/** True redaction: what is under the rectangles is removed from the file, not just covered. */
import type { EngineContext, ModuleChange, OcrPageState } from "../context";
import { apply, intersects, rectFromPoints, rectToQuad, transformRect } from "../geom";
import type { Matrix, Point, Rect } from "../types";
import { removeAnnots, scrubStructure } from "./annots";
import { objectBounds } from "./objects";
import {
  censusText, cutContent, dropUnusedProperties, scrubCopies, shieldStrokeState, strokesText, type Redaction,
} from "./redactContent";
import { opsState } from "./state";
import {
  assertPage, normalizeRect, numbers, ownResources, pageBounds, readPageContent, withPage, writePageContent,
} from "./shared";

export async function redactAreas(ctx: EngineContext, page: number, rects: Rect[]): Promise<ModuleChange> {
  const { doc } = ctx;
  assertPage(doc, page);
  const bounds = pageBounds(doc, page);
  const holes = rects
    .map(normalizeRect)
    .filter((r) => r[2] - r[0] > 0.5 && r[3] - r[1] > 0.5 && intersects(r, bounds));
  if (!holes.length) throw new Error("Select an area on the page to redact");

  const toPage = withPage(doc, page, (p) => p.getTransform() as Matrix);
  const ref = doc.findPage(page);
  // edges that merely touch a rectangle (a table border next to it) are left alone
  const job: Redaction = {
    ctx,
    toPage,
    holes: holes.map((r): Rect => [r[0] + 0.1, r[1] + 0.1, r[2] - 0.1, r[3] - 0.1]),
  };

  // links, comments and form fields (with their values)
  const removed = removeAnnots(doc, ref, (annot) => {
    const r = transformRect(toPage, numbers(annot.get("Rect"), [0, 0, 0, 0]) as Rect);
    return job.holes.some((h) => intersects(r, h));
  });

  // line art and image masks
  let cut = false;
  withPage(doc, page, (p) => {
    const resources = ownResources(doc, p);
    const result = cutContent(job, readPageContent(p), resources, { ctm: [1, 0, 0, 1, 0, 0], clip: null, lineWidth: 1 });
    cut = result.changed;
    writePageContent(doc, p, result.content);
  });

  withPage(doc, page, (p) => {
    const resources = ownResources(doc, p);
    const content = readPageContent(p);
    if (strokesText(content, resources)) writePageContent(doc, p, shieldStrokeState(job, content, resources).content);
  });

  // text and image pixels
  const before = withPage(doc, page, (p) => censusText(readPageContent(p), p.getObject().getInheritable("Resources")));
  withPage(doc, page, (p) => {
    const annot = p.createAnnotation("Redact");
    annot.setQuadPoints(holes.map(rectToQuad));
    annot.applyRedaction(1, 2, 0, 0);
  });
  const textGone = withPage(doc, page, (p) => {
    const content = readPageContent(p);
    const left = censusText(content, p.getObject().getInheritable("Resources")).bytes;
    const resources = ownResources(doc, p);
    const result = scrubCopies(job, content, resources, before);
    if (result.changed) writePageContent(doc, p, result.content);
    dropUnusedProperties(result.content, resources);
    return left !== before.bytes;
  });

  for (const key of ["Thumb", "PieceInfo", "Metadata"]) if (!ref.get(key).isNull()) ref.delete(key);
  if (textGone || cut || removed) scrubStructure(doc, new Set([ref.asIndirect()]));

  forgetObjects(ctx, page, holes);
  const ocr = ctx.state.ocr[page];
  if (ocr) forgetOcr(ocr, holes, toPage);
  return { changedPages: [page] };
}

/** added objects under a redaction can no longer be edited, or editing would bring the content back */
function forgetObjects(ctx: EngineContext, page: number, holes: Rect[]) {
  const state = opsState(ctx);
  for (const [id, object] of Object.entries(ctx.state.objects)) {
    if (object.page !== page) continue;
    const bounds = objectBounds(object);
    // thin shapes (a horizontal line) still occupy some area
    const area: Rect = [bounds[0] - 0.5, bounds[1] - 0.5, bounds[2] + 0.5, bounds[3] + 0.5];
    if (!holes.some((h) => intersects(area, h))) continue;
    if (object.kind === "image") delete state.images[object.blobId];
    delete ctx.state.objects[id];
  }
}

/* ---------- recognised text kept outside the PDF ---------- */

interface Frame {
  o: Point;
  u: { x: number; y: number };
  up: { x: number; y: number };
  width: number;
  asc: number;
  desc: number;
}
interface StoredLine {
  id: string;
  text: string;
  frame: Frame;
  words: { text: string; from: number; to: number; asc: number; desc: number }[];
}

/** a stretch of a stored (PDF space) line frame as a page space rectangle */
function frameBox(f: Frame, toPage: Matrix, from: number, to: number, asc: number, desc: number): Rect {
  const at = (along: number, above: number): Point =>
    apply(toPage, [f.o[0] + f.u.x * along + f.up.x * above, f.o[1] + f.u.y * along + f.up.y * above]);
  return rectFromPoints([at(from, asc), at(to, asc), at(from, -desc), at(to, -desc)]);
}

function forgetOcr(entry: OcrPageState, holes: Rect[], toPage: Matrix) {
  const hit = (r: Rect) => holes.some((h) => intersects(r, h));
  for (const line of entry.result.lines) {
    if (!hit(line.rect)) continue;
    const words = line.words.filter((w) => !hit(w.rect));
    if (words.length === line.words.length && words.length) continue;
    line.words = words;
    line.text = words.map((w) => w.text).join(" ");
    delete line.baseline;
  }
  entry.result.lines = entry.result.lines.filter((l) => l.words.length || !hit(l.rect));

  const edits = entry.edits as Record<string, unknown>;
  const meta = edits.__page as { lines?: StoredLine[] } | undefined;
  if (!meta?.lines) {
    // unknown layout: forget every remembered edit rather than keep redacted words
    for (const key of Object.keys(edits)) delete edits[key];
    return;
  }
  meta.lines = meta.lines.filter((line) => {
    const edit = edits[line.id] as { frame?: Frame; text?: string } | undefined;
    const f = line.frame;
    const drawn = edit?.frame;
    const whole = hit(frameBox(f, toPage, 0, f.width, f.asc, f.desc));
    const moved = !!drawn && hit(frameBox(drawn, toPage, 0, drawn.width, drawn.asc, drawn.desc));
    if (!whole && !moved) return true;
    const words = line.words.filter((w) => !hit(frameBox(f, toPage, w.from, w.to, w.asc, w.desc)));
    if (!moved && words.length === line.words.length && words.length) return true;
    delete edits[line.id];
    line.words = words;
    line.text = words.map((w) => w.text).join(" ");
    return !moved && words.length > 0;
  });
}
