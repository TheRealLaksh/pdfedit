/** Page analysis: interpretation + line models + page classification, cached until the next mutation. */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { intersects, quadToRect } from "../geom";
import type { PageKind, PageText, Point, Quad, Rect, TextLine } from "../types";
import { interpretPage, type Interpretation } from "./interpret";
import { buildLines, toFrame, type LineModel, type Unit } from "./layout";
import { directionOf } from "./unicode";

export interface Analysis {
  interp: Interpretation | null;
  /** every line, editable or not, in the order of PageText.lines */
  models: LineModel[];
  text: PageText;
}

export function analyze(ctx: EngineContext, page: number): Analysis {
  const key = `text:${page}`;
  const cached = ctx.cache.get(key) as Analysis | undefined;
  if (cached) return cached;
  const result = build(ctx, page);
  ctx.cache.set(key, result);
  return result;
}

function build(ctx: EngineContext, pageIndex: number): Analysis {
  const page = ctx.doc.loadPage(pageIndex);
  try {
    let interp: Interpretation | null = null;
    try {
      interp = interpretPage(ctx, pageIndex, page);
    } catch {
      interp = null;
    }
    const pageRect = page.getBounds() as Rect;
    let models: LineModel[] = [];
    let invisible: LineModel[] = [];
    const cover = interp ? coverage(interp.images, pageRect) : 0;
    if (interp) {
      // a line running off the page keeps its hidden end; lines wholly outside are left alone
      models = buildLines(
        pageIndex,
        interp,
        interp.glyphs.filter((g) => !g.invisible),
      ).filter((m) => intersects(m.line.rect, pageRect));
      if (cover > 0.3) {
        const hidden = interp.glyphs.filter((g) => g.invisible && g.show.tr % 4 === 3);
        if (hidden.length) {
          invisible = buildLines(pageIndex, interp, hidden);
          for (const m of invisible) {
            m.line.id += ".h";
            m.line.editable = false;
            m.line.note = "This is the invisible text layer of a scanned page. Recognise the page (OCR) to edit what you see.";
          }
        }
      }
    }
    // our own reading failed: let MuPDF read the page, editing then goes through redaction
    if (!interp || (!interp.glyphs.length && interp.errors.length)) models = fallbackLines(pageIndex, page);

    const visibleChars = models.reduce((n, m) => n + m.line.text.trim().length, 0);
    const garbled = models.reduce((n, m) => n + (m.line.editable ? 0 : m.line.text.trim().length), 0);
    let kind: PageKind;
    if (!visibleChars) {
      // a scan with a hidden text layer has both; one without is purely a picture
      kind = invisible.length ? "mixed" : cover > 0.15 || (interp?.paths ?? 0) > 400 ? "scanned" : "empty";
    } else if (garbled > 0.6 * visibleChars) kind = "garbled";
    else if (garbled > 0.08 * visibleChars) kind = "mixed";
    else if (cover > 0.45 && interp && (invisible.length > models.length || textOverImages(models, interp.images) < 0.05) && visibleChars < 400)
      kind = "mixed";
    else kind = "text";

    const all = [...models, ...invisible];
    const lines: TextLine[] = all.map((m) => m.line);
    return { interp, models: all, text: { page: pageIndex, revision: 0, kind, lines } };
  } finally {
    page.destroy();
  }
}

/** share of the page covered by images, sampled on a grid so overlaps count once */
function coverage(images: Rect[], page: Rect): number {
  if (!images.length) return 0;
  const N = 24;
  const w = (page[2] - page[0]) / N;
  const h = (page[3] - page[1]) / N;
  const hit = new Uint8Array(N * N);
  for (const r of images) {
    const x0 = Math.max(0, Math.ceil((r[0] - page[0]) / w - 0.5));
    const x1 = Math.min(N - 1, Math.floor((r[2] - page[0]) / w - 0.5));
    const y0 = Math.max(0, Math.ceil((r[1] - page[1]) / h - 0.5));
    const y1 = Math.min(N - 1, Math.floor((r[3] - page[1]) / h - 0.5));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hit[y * N + x] = 1;
  }
  return hit.reduce((a, b) => a + b, 0) / (N * N);
}

function textOverImages(models: LineModel[], images: Rect[]): number {
  let inside = 0;
  for (const m of models) {
    const r = m.line.rect;
    const x = (r[0] + r[2]) / 2;
    const y = (r[1] + r[3]) / 2;
    if (images.some((i) => x >= i[0] && x <= i[2] && y >= i[1] && y <= i[3])) inside++;
  }
  return models.length ? inside / models.length : 0;
}

/** lines as MuPDF's structured text sees them (page contents only, no annotations) */
export function fallbackLines(pageIndex: number, page: MuPDF.PDFPage): LineModel[] {
  const out: LineModel[] = [];
  const list = page.toDisplayList(false);
  const stext = list.toStructuredText("preserve-whitespace");
  let chars: { c: string; origin: Point; quad: Quad; size: number; font: MuPDF.Font; color: number[] }[] = [];
  let direction: Point = [1, 0];
  let vertical = false;
  stext.walk({
    beginLine(_bbox, wmode, dir) {
      chars = [];
      direction = dir as Point;
      vertical = wmode === 1;
    },
    onChar(c, origin, font, size, quad, color) {
      chars.push({ c, origin: origin as Point, quad: quad as Quad, size, font, color: color as number[] });
    },
    endLine() {
      const text = chars.map((c) => c.c).join("").normalize("NFC");
      if (!text.trim()) return;
      const angle = Math.atan2(direction[1], direction[0]);
      const ex: Point = [Math.cos(angle), Math.sin(angle)];
      const ey: Point = [-ex[1], ex[0]];
      const first = chars[0]!;
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      const units: Unit[] = [];
      let at = 0;
      for (const ch of chars) {
        const corners = [0, 2, 4, 6].map((i) => toFrame([ch.quad[i]!, ch.quad[i + 1]!], ex, ey));
        const a = Math.min(...corners.map((p) => p[0]));
        const b = Math.max(...corners.map((p) => p[0]));
        u0 = Math.min(u0, a);
        u1 = Math.max(u1, b);
        v0 = Math.min(v0, ...corners.map((p) => p[1]));
        v1 = Math.max(v1, ...corners.map((p) => p[1]));
        units.push({ text: ch.c, glyphs: [], u0: a, u1: b, v: toFrame(ch.origin, ex, ey)[1], size: ch.size, em: ch.size, vis: units.length, start: at, end: at + ch.c.length, actual: false });
        at += ch.c.length;
      }
      const baseline = toFrame(first.origin, ex, ey)[1];
      const p = (u: number, v: number): Point => [u * ex[0] + v * ey[0], u * ex[1] + v * ey[1]];
      const quad = [...p(u0, v0), ...p(u1, v0), ...p(u0, v1), ...p(u1, v1)] as Quad;
      const name = first.font.getName().replace(/^[A-Z]{6}\+/, "");
      const c = first.color;
      const rgb: [number, number, number] =
        c.length >= 4 ? [(1 - c[0]!) * (1 - c[3]!), (1 - c[1]!) * (1 - c[3]!), (1 - c[2]!) * (1 - c[3]!)] : c.length === 3 ? [c[0]!, c[1]!, c[2]!] : [c[0] ?? 0, c[0] ?? 0, c[0] ?? 0];
      const style = {
        family: name,
        bold: first.font.isBold(),
        italic: first.font.isItalic(),
        serif: first.font.isSerif(),
        mono: first.font.isMono(),
        size: Math.round(first.size * 100) / 100,
        color: rgb,
      };
      const rtl = units.filter((u) => directionOf(u.text) === "R").length > units.length / 3;
      const line: TextLine = {
        id: `t${pageIndex}.m${out.length}.${Math.round(u0)}.${Math.round(baseline)}`,
        page: pageIndex,
        text,
        quad,
        rect: quadToRect(quad),
        origin: p(u0, baseline),
        angle,
        dir: rtl ? "rtl" : "ltr",
        style,
        spans: [{ start: 0, end: text.length, style }],
        align: rtl ? "right" : "left",
        source: "content",
        editable: true,
      };
      out.push({
        line,
        units,
        visual: units,
        ex,
        ey,
        baseline,
        u0,
        u1,
        size: first.size,
        rtl,
        vertical,
        padding: [],
        shadows: new Map(),
        rules: [],
        block: { left: u0, right: u1 },
      });
    },
  });
  stext.destroy();
  list.destroy();
  return out;
}
