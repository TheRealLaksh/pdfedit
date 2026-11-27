/**
 * Editing without trusting our own reading of the content stream: MuPDF redaction removes the line's
 * characters (images and line art untouched) and the new line is drawn in their place.
 */
import type * as MuPDF from "mupdf";
import { appendPageContent, ownResources, readPageContent, writePageContent } from "../content/page";
import type { EngineContext } from "../context";
import * as fonts from "../fonts";
import { invert, multiply } from "../geom";
import { censusText, dropUnusedProperties, scrubCopies, shieldStrokeState, strokesText, type Redaction } from "../ops/redactContent";
import type { LineEdit, Matrix, Point, Rect, TextStyle } from "../types";
import type { Notes } from "./edit";
import { fromFrame, toFrame, type LineModel } from "./layout";

/** returns a test of whether MuPDF draws the line's glyphs where our interpreter put them */
export function verifyLine(mupdf: typeof MuPDF, page: MuPDF.PDFPage): (model: LineModel) => boolean {
  let origins: Map<string, Point[]> | null = null;
  const load = () => {
    const map = new Map<string, Point[]>();
    // a device sees every glyph as it is drawn, whatever ActualText says about it
    const record = (text: MuPDF.Text, ctm: MuPDF.Matrix) =>
      text.walk({
        showGlyph(_font, trm) {
          const x = trm[4] * ctm[0] + trm[5] * ctm[2] + ctm[4];
          const y = trm[4] * ctm[1] + trm[5] * ctm[3] + ctm[5];
          const key = `${Math.round(x / 4)},${Math.round(y / 4)}`;
          let list = map.get(key);
          if (!list) map.set(key, (list = []));
          list.push([x, y]);
        },
      });
    const device = new mupdf.Device({
      fillText: record,
      clipText: record,
      ignoreText: record,
      strokeText: (text: MuPDF.Text, _stroke: unknown, ctm: MuPDF.Matrix) => record(text, ctm),
      clipStrokeText: (text: MuPDF.Text, _stroke: unknown, ctm: MuPDF.Matrix) => record(text, ctm),
    } as never);
    page.runPageContents(device, mupdf.Matrix.identity);
    device.close();
    device.destroy();
    return map;
  };
  return (model) => {
    if (model.vertical) return true;
    const glyphs = model.units.flatMap((u) => u.glyphs);
    if (!glyphs.length) return true;
    origins ??= load();
    const bounds = page.getBounds();
    let found = 0;
    let total = 0;
    for (const g of glyphs) {
      const [x, y] = g.origin;
      if (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3] || g.show.rise) continue;
      total++;
      const cx = Math.round(x / 4);
      const cy = Math.round(y / 4);
      search: for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const o of origins.get(`${cx + dx},${cy + dy}`) ?? [])
            if (Math.abs(o[0] - x) < 0.8 && Math.abs(o[1] - y) < 0.8) {
              found++;
              break search;
            }
    }
    return found >= total * 0.85;
  };
}

export async function redactAndRewrite(
  ctx: EngineContext,
  page: MuPDF.PDFPage,
  edits: [LineModel, LineEdit][],
  notes: Notes,
): Promise<void> {
  const doc = ctx.doc;
  // redaction annotations the file already carries must not be applied as a side effect
  const annots = page.getObject().get("Annots");
  const parked: MuPDF.PDFObject[] = [];
  if (annots.isArray()) {
    for (let i = annots.length - 1; i >= 0; i--) {
      const a = annots.get(i);
      const subtype = a.get("Subtype");
      if (subtype.isName() && subtype.asName() === "Redact") {
        parked.unshift(a);
        annots.delete(i);
      }
    }
  }
  const index = pageNumber(doc, page);
  const job: Redaction = { ctx, toPage: page.getTransform() as Matrix, holes: [] };
  // MuPDF's filter forgets line width, caps and dashes that only stroked text uses
  const shared = ownResources(doc, page);
  const original = readPageContent(page);
  if (strokesText(original, shared)) writePageContent(doc, page, shieldStrokeState(job, original, shared).content);
  let working = doc.loadPage(index);
  const before = censusText(readPageContent(working), working.getObject().getInheritable("Resources"));
  for (const [model] of edits) {
    for (const unit of model.units) {
      if (!unit.text.trim()) continue;
      // a small box in the middle of each character removes it without touching its neighbours
      const width = unit.u1 - unit.u0;
      const corners = [
        fromFrame(unit.u0 + width * 0.3, unit.v - unit.size * 0.42, model.ex, model.ey),
        fromFrame(unit.u1 - width * 0.3, unit.v - unit.size * 0.18, model.ex, model.ey),
        fromFrame(unit.u0 + width * 0.3, unit.v - unit.size * 0.18, model.ex, model.ey),
        fromFrame(unit.u1 - width * 0.3, unit.v - unit.size * 0.42, model.ex, model.ey),
      ];
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      const rect: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      job.holes.push(rect);
      working.createAnnotation("Redact").setRect(rect);
    }
  }
  working.applyRedactions(false, 0, 0, 0);
  working.destroy();
  working = doc.loadPage(index);
  // stand-ins become the original operators again, and text copies of removed characters go
  const content = readPageContent(working);
  const resources = ownResources(doc, working);
  const scrubbed = scrubCopies(job, content, resources, before);
  if (scrubbed.changed) writePageContent(doc, working, scrubbed.content);
  dropUnusedProperties(scrubbed.content, resources);
  if (parked.length) {
    let list = working.getObject().get("Annots");
    if (!list.isArray()) {
      working.getObject().put("Annots", doc.newArray());
      list = working.getObject().get("Annots");
    }
    for (const a of parked) list.push(a);
  }

  for (const [model, edit] of edits) {
    if (!edit.text.trim()) continue;
    const line = model.line;
    const style: TextStyle = { ...line.style, ...edit.style };
    const request = {
      text: edit.text,
      style: { ...style, underline: style.underline },
      originalFont: {
        name: line.style.family,
        bold: line.style.bold,
        italic: line.style.italic,
        serif: line.style.serif,
        mono: line.style.mono,
      },
      charSpacing: style.letterSpacing ?? 0,
      horizontalScale: 100,
    };
    const planned = await fonts.planText(ctx, request);
    const original = model.u1 - model.u0;
    let horizontalScale = 100;
    let width = planned.width;
    if (edit.fit === "shrink" && width > original) {
      horizontalScale = (original / width) * 100;
      width = original;
    }
    const align = edit.align ?? line.align;
    let u = model.u0;
    if (align === "right") u = model.u1 - width;
    else if (align === "center") u = (model.u0 + model.u1 - width) / 2;
    const [ou, ov] = toFrame(edit.offset ?? [0, 0], model.ex, model.ey);
    const origin = fromFrame(u + ou, model.baseline + ov, model.ex, model.ey);
    // text space (y up) to page space (y down), then to the page's default PDF coordinates
    const toPage: Matrix = [model.ex[0], model.ex[1], -model.ey[0], -model.ey[1], origin[0], origin[1]];
    const matrix = multiply(toPage, invert(working.getTransform() as Matrix));
    const written = await fonts.writeText(ctx, { ...request, horizontalScale, matrix, resources: ownResources(doc, working) });
    appendPageContent(doc, working, written.ops);
    notes.fallbackFonts.push(...written.fontsUsed);
    if (written.missing.length) notes.warnings.push(`No available font can draw: ${[...new Set(written.missing)].join(" ")}`);
  }
  working.destroy();
}

function pageNumber(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage): number {
  const target = page.getObject();
  const wanted = target.isIndirect() ? target.asIndirect() : -1;
  for (let i = 0; i < doc.countPages(); i++) {
    const o = doc.findPage(i);
    if (o.isIndirect() && o.asIndirect() === wanted) return i;
  }
  return 0;
}
