/**
 * Changing a recognised line. The first change measures the original print, removes it (by painting a
 * patch of rebuilt paper over its ink, or by deleting real text operators) and every change then sets the
 * new text to match. All of it lives in one layer form per page that is rebuilt each time, so repeated
 * edits replace each other instead of piling up.
 */
import type { EngineContext, ModuleChange, OcrPageState } from "../context";
import { ownResources, readPageContent, writePageContent } from "../content/page";
import { planText, writeText } from "../fonts";
import { quadToRect } from "../geom";
import {
  censusText, dropUnusedProperties, scrubCopies, shieldStrokeState, strokesText, type Redaction,
} from "../ops/redactContent";
import { analyzePage } from "../text";
import type { LineEdit, Quad, TextStyle } from "../types";
import { Fitter, originalFont, type FitResult } from "./fit";
import { analyzeInk, inpaint } from "./ink";
import { addForm, addPatch, boxAround, buildLayer, gridAt, hideLayer, placedImages, renderRegion, setLayer, shapeIn } from "./pdf";
import { adoptHiddenLayer, HIDDEN, tidyColor } from "./recognised";
import {
  applyVec, editOf, findEntry, framePoint, mapFrame, pageMeta, pageTransform, toPdfMatrix,
  type EditState, type Frame, type LineMeta,
} from "./state";

export const LAYER = "PEOcr";

interface Prepared extends FitResult {
  patch: EditState["patch"];
}

export async function editOcrLines(ctx: EngineContext, page: number, edits: LineEdit[]): Promise<ModuleChange> {
  let entry = findEntry(ctx, page);
  if (!entry && edits.some((e) => e.lineId.startsWith(HIDDEN))) entry = adoptHiddenLayer(ctx, analyzePage(ctx, page));
  if (!entry) throw new Error("Recognise the text on this page first.");
  const meta = pageMeta(entry);
  const warnings: string[] = [];
  const jobs: { edit: LineEdit; line: LineMeta }[] = [];
  for (const edit of edits) {
    const line = meta.lines.find((l) => l.id === edit.lineId);
    if (line) jobs.push({ edit, line });
    else warnings.push("A line that was being changed is no longer on the page.");
  }
  if (!jobs.length) throw new Error("That line is no longer on the page. Try again.");

  // measure and patch against the page as it was before any of our changes
  const fresh = jobs.filter((j) => !editOf(entry, j.line.id));
  const prepared = new Map<string, Prepared>();
  if (fresh.length) {
    hideLayer(ctx, page, LAYER, meta.layer);
    const used = meta.lines.flatMap((l) => editOf(entry, l.id)?.source.family ?? []);
    const fitter = new Fitter(ctx, new Set(used));
    try {
      for (const { line } of fresh) {
        if (!prepared.has(line.id)) prepared.set(line.id, await prepare(ctx, page, line, fitter, warnings));
      }
    } finally {
      fitter.destroy();
    }
  }

  const toPdf = toPdfMatrix(pageTransform(ctx, page));
  let removed = false;
  for (const { edit, line } of jobs) {
    const previous = editOf(entry, line.id);
    const state: EditState = previous ? { ...previous } : initial(line, prepared.get(line.id)!);
    applyEdit(state, edit, line, !previous);
    if (edit.offset) {
      const d = applyVec(toPdf, { x: edit.offset[0], y: edit.offset[1] });
      state.moved = { x: state.moved.x + d.x, y: state.moved.y + d.y };
    }
    await draw(ctx, state, line, warnings);
    if (state.deleted && state.patch) removed = true;
    entry.edits[line.id] = state;
  }

  rebuild(ctx, page, entry);
  if (removed)
    warnings.push("The scanned picture underneath is covered, not erased. Use Redact to remove it from the file for good.");
  return { changedPages: [page], warnings: [...new Set(warnings)] };
}

function initial(line: LineMeta, p: Prepared): EditState {
  return {
    text: line.text,
    deleted: false,
    style: { ...p.style },
    source: { ...p.style },
    align: line.align,
    moved: { x: 0, y: 0 },
    fit: p.fit,
    widthLocked: false,
    shrink: false,
    patch: p.patch,
    textForm: null,
    frame: line.frame,
  };
}

function applyEdit(state: EditState, edit: LineEdit, line: LineMeta, first: boolean): void {
  const wanted: Partial<TextStyle> = { ...edit.style };
  if (wanted.size !== undefined) {
    // before the first edit the size shown was an estimate: treat a new number as relative to it
    if (first) wanted.size = Math.abs(wanted.size - line.style.size) < 0.01 ? state.fit.size : (state.fit.size * wanted.size) / line.style.size;
    wanted.size = Math.max(1, Math.round(wanted.size * 10) / 10);
  }
  if ((wanted.fontChoice !== undefined && wanted.fontChoice !== state.source.fontChoice) || (wanted.family && wanted.family !== state.source.family))
    state.widthLocked = true;
  state.style = { ...state.style, ...wanted };
  state.align = edit.align ?? state.align;
  if (edit.fit) state.shrink = edit.fit === "shrink";
  state.text = edit.text.replace(/[\r\n\t]+/g, " ").normalize("NFC");
  state.deleted = state.text.trim() === "";
}

/** set the new text so that it sits where, and looks like, the old one */
async function draw(ctx: EngineContext, state: EditState, line: LineMeta, warnings: string[]): Promise<void> {
  const frame = line.frame;
  const { fit, style } = state;
  if (state.deleted) {
    state.textForm = null;
    state.frame = shift(frame, state.moved);
    return;
  }
  let hscale = state.widthLocked ? 100 : fit.hscale;
  const request = {
    text: state.text,
    style,
    originalFont: originalFont(state.source),
    wordSpacing: undefined as number | undefined,
    horizontalScale: hscale,
  };
  let planned = await planText(ctx, request);
  const bearings = () => ((fit.lead + fit.trail) * style.size * hscale) / 100;
  const target = fit.inkTo - fit.inkFrom;
  let squeezed = false;
  if (state.shrink && planned.width - bearings() > target * 1.004) {
    hscale *= target / Math.max(0.1, planned.width - bearings());
    request.horizontalScale = hscale;
    planned = await planText(ctx, request);
    squeezed = true;
  }
  const spaces = state.text.split(" ").length - 1;
  if (state.align === "justify" && spaces > 0 && !squeezed) {
    const ink = planned.width - bearings();
    if (ink > target * 0.78 && ink < target * 1.12) {
      // word spacing is subject to horizontal scaling, as in PDF
      request.wordSpacing = (target - ink) / spaces / (hscale / 100);
      planned = await planText(ctx, request);
    }
  }
  const anchor = state.align === "justify" ? (line.dir === "rtl" && request.wordSpacing === undefined ? "right" : "left") : state.align;
  const lead = (fit.lead * style.size * hscale) / 100;
  const trail = (fit.trail * style.size * hscale) / 100;
  const start =
    anchor === "right"
      ? fit.inkTo + trail - planned.width
      : anchor === "center"
        ? (fit.inkFrom + fit.inkTo) / 2 - planned.width / 2 + (trail - lead) / 2
        : fit.inkFrom - lead;
  const base = framePoint(frame, start, -fit.drop);
  const origin: [number, number] = [base[0] + state.moved.x, base[1] + state.moved.y];
  const resources = ctx.doc.addObject(ctx.doc.newDictionary());
  const written = await writeText(ctx, {
    ...request,
    matrix: [frame.u.x, frame.u.y, frame.up.x, frame.up.y, origin[0], origin[1]],
    resources,
  });
  if (written.missing.length) warnings.push(`No font could draw: ${[...new Set(written.missing)].join(" ")}`);
  state.textForm = addForm(ctx, written.ops, resources).asIndirect();
  const grow = style.size / fit.size;
  state.frame = {
    o: origin,
    u: frame.u,
    up: frame.up,
    width: written.width,
    asc: Math.max(style.size * 0.55, (frame.asc + fit.drop) * grow),
    desc: Math.max(style.size * 0.2, (frame.desc - fit.drop) * grow),
  };
}

function shift(f: Frame, by: { x: number; y: number }): Frame {
  return { ...f, o: [f.o[0] + by.x, f.o[1] + by.y] };
}

/** all patches first, then all new text: no patch can hide a changed line */
function rebuild(ctx: EngineContext, page: number, entry: OcrPageState): void {
  const meta = pageMeta(entry);
  const states = meta.lines.map((l) => editOf(entry, l.id)).filter((s): s is EditState => !!s);
  const items = [
    ...states.flatMap((s) => (s.patch ? [{ object: s.patch.object, matrix: s.patch.matrix }] : [])),
    ...states.flatMap((s) => (s.textForm !== null ? [{ object: s.textForm }] : [])),
  ];
  meta.layer = setLayer(ctx, page, buildLayer(ctx, items, LAYER), LAYER, meta.layer);
}

/** is there real (visible or invisible) text where the line is? */
function textUnder(ctx: EngineContext, page: number, frame: Frame): boolean {
  const p = ctx.doc.loadPage(page);
  const text = p.toStructuredText("preserve-whitespace");
  const h = frame.asc + frame.desc;
  let found = false;
  text.walk({
    onChar(c, _origin, _font, _size, q) {
      if (found || !c.trim()) return;
      const x = (q[0] + q[2] + q[4] + q[6]) / 4 - frame.o[0];
      const y = (q[1] + q[3] + q[5] + q[7]) / 4 - frame.o[1];
      const along = x * frame.u.x + y * frame.u.y;
      const above = x * frame.up.x + y * frame.up.y;
      if (along > -h * 0.1 && along < frame.width + h * 0.1 && above > -frame.desc - h * 0.15 && above < frame.asc + h * 0.1) found = true;
    },
  });
  text.destroy();
  p.destroy();
  return found;
}

/** delete the text operators under the line; pictures and drawings stay */
function removeText(ctx: EngineContext, page: number, frame: Frame): void {
  const h = frame.asc + frame.desc;
  // a band through the middle of the letters cannot catch the lines above or below
  const top = frame.asc * 0.5;
  const bottom = frame.asc * 0.18;
  const quad: Quad = [
    ...framePoint(frame, -h * 0.1, top),
    ...framePoint(frame, frame.width + h * 0.1, top),
    ...framePoint(frame, -h * 0.1, bottom),
    ...framePoint(frame, frame.width + h * 0.1, bottom),
  ];
  const job: Redaction = { ctx, toPage: pageTransform(ctx, page), holes: [quadToRect(quad)] };
  const doc = ctx.doc;
  /** rewrite the page content with a page loaded afresh (redaction replaces it under our feet) */
  const withPage = <T>(fn: (p: ReturnType<typeof doc.loadPage>) => T): T => {
    const p = doc.loadPage(page);
    try {
      return fn(p);
    } finally {
      p.destroy();
    }
  };
  // MuPDF's filter forgets line widths and dashes that only stroked text uses: keep them safe
  withPage((p) => {
    const resources = ownResources(doc, p);
    const content = readPageContent(p);
    if (strokesText(content, resources)) writePageContent(doc, p, shieldStrokeState(job, content, resources).content);
  });
  const before = withPage((p) => censusText(readPageContent(p), p.getObject().getInheritable("Resources")));
  withPage((p) => {
    const annotation = p.createAnnotation("Redact");
    annotation.setQuadPoints([quad]);
    // no black box, pictures untouched, line art untouched, text removed
    annotation.applyRedaction(0, 0, 0, 0);
  });
  // undo the shielding and drop copies (ActualText) of text that is gone
  withPage((p) => {
    const content = readPageContent(p);
    const resources = ownResources(doc, p);
    const result = scrubCopies(job, content, resources, before);
    if (result.changed) writePageContent(doc, p, result.content);
    dropUnusedProperties(result.content, resources);
  });
}

async function prepare(ctx: EngineContext, page: number, line: LineMeta, fitter: Fitter, warnings: string[]): Promise<Prepared> {
  const transform = pageTransform(ctx, page);
  const frame = mapFrame(line.frame, transform);
  const centre = framePoint(frame, frame.width / 2, (frame.asc - frame.desc) / 2);
  const grid = gridAt(placedImages(ctx, page), centre);
  const box = boxAround(frame, grid.toPixel, 1.6, 0.75);

  const look = () => {
    const region = renderRegion(ctx, page, grid, box);
    if (!region) return null;
    const placed = shapeIn(region, frame, line.words);
    return { region, ink: analyzeInk(region, placed.shape), ...placed };
  };
  const before = look();
  let source = before;
  if (textUnder(ctx, page, frame)) {
    removeText(ctx, page, frame);
    source = look();
    // when the letters were real text, nothing is left to paint over
    const left = source?.ink.letters.reduce((s, v) => s + v, 0) ?? 0;
    const had = before?.ink.letters.reduce((s, v) => s + v, 0) ?? 0;
    if (left < had * 0.2) source = null;
  }

  let patch: EditState["patch"] = null;
  if (source) {
    const rebuilt = inpaint(source.region, source.ink, line.id.length * 31 + Math.round(frame.o[1]));
    if (rebuilt) patch = await addPatch(ctx, source.region, rebuilt, toPdfMatrix(transform));
    else warnings.push("The original letters of a line could not be found, so they were not covered.");
  }

  const metrics = before?.ink.metrics ?? null;
  const fitted = await fitter.fit(line, before && metrics ? { metrics, sa: before.sa, sb: before.sb } : null);
  const color = before && metrics ? tidyColor(before.ink.color) : line.style.color;
  const underline = before?.ink.underline || undefined;
  return { fit: fitted.fit, style: { ...fitted.style, color, underline }, patch };
}


