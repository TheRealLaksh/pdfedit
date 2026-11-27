/** Storing a recognition result and presenting it (with edits) as editable lines. */
import type { EngineContext, ModuleChange, OcrPageState } from "../context";
import { transformRect } from "../geom";
import type { Matrix, OcrLine, OcrPageResult, PageText, Point, Rect, TextLine } from "../types";
import { analyzeInk, type Raster } from "./ink";
import { imageCoverage, renderRegion, boxAround, shapeIn, type Region } from "./pdf";
import {
  editOf, findEntry, frameQuad, frameRect, mapFrame, pageMeta, pageObjectNumber, pageTransform, setPageMeta, toPdfMatrix,
  type Frame, type LineMeta, type PageMeta, type WordSpan,
} from "./state";
import { detectAlign, estimateSize, familyFor, looksSerif, markBold, snapSizes } from "./style";

/* ---------- geometry of recognised lines ---------- */

/** size of a box turned by an angle, from the size of its bounding rectangle */
function unturn(rect: Rect, cos: number, sin: number): [number, number] {
  const W = rect[2] - rect[0];
  const H = rect[3] - rect[1];
  const c = Math.abs(cos);
  const s = Math.abs(sin);
  const det = c * c - s * s;
  if (Math.abs(det) < 0.25) {
    const long = Math.max(W, H) * 1.3;
    return [long, Math.max(1, Math.min(W, H) * 0.5)];
  }
  return [Math.max(1, (W * c - H * s) / det), Math.max(1, (H * c - W * s) / det)];
}

export function frameFromLine(line: OcrLine): { frame: Frame; words: WordSpan[] } {
  const base: [Point, Point] = line.baseline ?? [
    [line.rect[0], line.rect[3] - (line.rect[3] - line.rect[1]) * 0.2],
    [line.rect[2], line.rect[3] - (line.rect[3] - line.rect[1]) * 0.2],
  ];
  let angle = Math.atan2(base[1][1] - base[0][1], base[1][0] - base[0][0]);
  // short lines give unreliable slopes
  const quarter = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(angle - quarter) < 0.004) angle = quarter;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [w, h] = unturn(line.rect, cos, sin);
  const cx = (line.rect[0] + line.rect[2]) / 2;
  const cy = (line.rect[1] + line.rect[3]) / 2;
  const down = [-sin, cos] as const;
  const d = ((base[0][0] + base[1][0]) / 2 - cx) * down[0] + ((base[0][1] + base[1][1]) / 2 - cy) * down[1];
  const frame: Frame = {
    o: [cx - (cos * w) / 2 + down[0] * d, cy - (sin * w) / 2 + down[1] * d],
    u: { x: cos, y: sin },
    up: { x: sin, y: -cos },
    width: w,
    asc: Math.max(h * 0.4, h / 2 + d),
    desc: Math.max(0, h / 2 - d),
  };
  const words = line.words.map((word) => {
    const [ww, wh] = unturn(word.rect, cos, sin);
    const x = (word.rect[0] + word.rect[2]) / 2 - frame.o[0];
    const y = (word.rect[1] + word.rect[3]) / 2 - frame.o[1];
    const along = x * cos + y * sin;
    const above = x * frame.up.x + y * frame.up.y;
    return { text: word.text, from: along - ww / 2, to: along + ww / 2, asc: above + wh / 2, desc: wh / 2 - above };
  });
  return { frame, words };
}

/** how much of the smaller rectangle the two share */
export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return smaller > 0 ? (w * h) / smaller : 0;
}

/* ---------- storing ---------- */

export function setOcrResult(ctx: EngineContext, result: OcrPageResult): ModuleChange {
  const page = result.page;
  if (page < 0 || page >= ctx.doc.countPages()) throw new Error("That page no longer exists");
  const prior = findEntry(ctx, page);
  const old = prior ? pageMeta(prior) : null;
  const transform = pageTransform(ctx, page);
  const toPdf = toPdfMatrix(transform);
  const object = pageObjectNumber(ctx, page);

  // lines the user already edited stay exactly as they are
  const kept = old && prior ? old.lines.filter((l) => editOf(prior, l.id)) : [];
  const taken = kept.flatMap((l) => [frameRect(mapFrame(l.frame, transform)), frameRect(mapFrame(editOf(prior!, l.id)!.frame, transform))]);

  let next = old?.next ?? 0;
  const found: { meta: LineMeta; shown: Frame; shownWords: WordSpan[] }[] = [];
  for (const line of result.lines) {
    if (!line.text.trim() || taken.some((r) => overlap(r, line.rect) > 0.35)) continue;
    const { frame, words } = frameFromLine(line);
    const size = estimateSize(line.text, frame.asc, frame.desc);
    found.push({
      shown: frame,
      shownWords: words,
      meta: {
        id: `ocr:${object}:${next++}`,
        text: line.text,
        dir: line.dir ?? "ltr",
        confidence: line.confidence,
        frame: mapFrame(frame, toPdf),
        words,
        align: "left",
        style: { family: familyFor(false), bold: false, italic: false, serif: false, mono: false, size, color: [0, 0, 0] },
      },
    });
  }

  estimateLooks(ctx, page, found);
  const bounds = pageBounds(ctx, page);
  const rects = found.map((f) => frameRect(f.shown));
  const aligns = detectAlign(found.map((f) => f.meta), bounds[2] - bounds[0], rects);
  found.forEach((f, i) => (f.meta.align = aligns[i]!));

  const meta: PageMeta = {
    lines: [...found.map((f) => f.meta), ...kept].sort((a, b) => readingKey(a, transform) - readingKey(b, transform)),
    scan: old?.scan ?? imageCoverage(ctx, page) >= 0.5,
    next,
    layer: old?.layer,
    searchLayer: old?.searchLayer,
  };
  const entry: OcrPageState = { result, edits: {}, pageObject: object };
  setPageMeta(entry, meta);
  for (const line of kept) entry.edits[line.id] = prior!.edits[line.id];
  store(ctx, page, entry);

  // the journal ignores operations that leave the file untouched, which would put undo out of step
  const pageDict = ctx.doc.findPage(page);
  const count = pageDict.get("PEOcrRun");
  pageDict.put("PEOcrRun", (count.isNumber() ? count.asNumber() : 0) + 1);

  const warnings: string[] = [];
  if (!result.lines.length) warnings.push(`No text was recognised on page ${page + 1}.`);
  else {
    const mean = result.lines.reduce((s, l) => s + l.confidence, 0) / result.lines.length;
    if (mean < 55)
      warnings.push(`Text on page ${page + 1} was hard to read. Choosing the right language or a sharper scan helps.`);
  }
  return { changedPages: [page], warnings };
}

/** keep state.ocr keyed by page index without throwing away another page's entry */
function store(ctx: EngineContext, page: number, entry: OcrPageState): void {
  const entries = ctx.state.ocr;
  for (const [key, e] of Object.entries(entries)) if (e.pageObject === entry.pageObject) delete entries[Number(key)];
  const there = entries[page];
  if (there) {
    // the keys lag behind a page move: put the other page's entry where that page is now
    for (let i = 0; i < ctx.doc.countPages(); i++) {
      if (pageObjectNumber(ctx, i) === there.pageObject) {
        entries[i] ??= there;
        break;
      }
    }
  }
  entries[page] = entry;
}

/** top to bottom, then along the line (against it for right to left text) */
function readingKey(line: LineMeta, transform: Matrix): number {
  const r = frameRect(mapFrame(line.frame, transform));
  return Math.round(r[1] / 4) * 10_000 + (line.dir === "rtl" ? 5000 - r[2] : r[0]);
}

function pageBounds(ctx: EngineContext, page: number): Rect {
  const p = ctx.doc.loadPage(page);
  const bounds = p.getBounds() as Rect;
  p.destroy();
  return bounds;
}

/** colour, weight and serif from one rendering of the page */
function estimateLooks(ctx: EngineContext, page: number, found: { meta: LineMeta; shown: Frame; shownWords: WordSpan[] }[]) {
  if (!found.length) return;
  const bounds = pageBounds(ctx, page);
  const scale = Math.min(260 / 72, 2800 / Math.max(1, bounds[2] - bounds[0], bounds[3] - bounds[1]));
  const grid = { toPixel: [scale, 0, 0, scale, 0, 0] as Matrix, gray: false, limit: null };
  const whole = renderRegion(ctx, page, grid, transformRect(grid.toPixel, bounds));
  if (!whole) return;
  const strokes: (number | null)[] = [];
  const serifs: boolean[] = [];
  for (const { meta, shown, shownWords } of found) {
    const region = crop(whole, boxAround(shown, grid.toPixel, 1.2, 0.5));
    if (!region) {
      strokes.push(null);
      continue;
    }
    const { shape, sa, sb } = shapeIn(region, shown, shownWords);
    const ink = analyzeInk(region, shape);
    // some models report boxes much taller than the letters (Chinese): trust the ink when it is tighter
    const height = ink.metrics ? (ink.metrics.bottom - ink.metrics.top) / sb : 0;
    if (height > 3 && height < (shown.asc + shown.desc) * 0.96) meta.style.size = estimateSize(meta.text, height, 0);
    meta.style.color = tidyColor(ink.color);
    if (ink.underline) meta.style.underline = true;
    strokes.push(ink.metrics ? ink.metrics.stroke / sa : null);
    const serif = looksSerif(meta.text, ink, region.width, shape);
    if (serif !== null) serifs.push(serif);
  }
  // one page rarely mixes serif and sans in body text: decide by majority
  const serif = serifs.filter(Boolean).length * 2 > serifs.length;
  for (const { meta } of found) {
    meta.style.serif = serif;
    meta.style.family = familyFor(serif);
  }
  snapSizes(found.map((f) => f.meta));
  markBold(found.map((f) => f.meta), strokes);
}

/** scanned black is rarely exactly black or grey: remove tiny colour casts only */
export function tidyColor(c: [number, number, number]): [number, number, number] {
  const hi = Math.max(...c);
  const lo = Math.min(...c);
  if (hi - lo < 0.045) {
    const g = Math.round(((c[0] + c[1] + c[2]) / 3) * 1000) / 1000;
    return [g, g, g];
  }
  return c;
}

function crop(whole: Region, box: Rect): (Region & Raster) | null {
  const x0 = Math.max(0, Math.floor(box[0]) - whole.x);
  const y0 = Math.max(0, Math.floor(box[1]) - whole.y);
  const x1 = Math.min(whole.width, Math.ceil(box[2]) - whole.x);
  const y1 = Math.min(whole.height, Math.ceil(box[3]) - whole.y);
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const width = x1 - x0;
  const height = y1 - y0;
  const n = whole.n;
  const data = new Uint8Array(width * height * n);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * whole.width + x0) * n;
    data.set(whole.data.subarray(from, from + width * n), y * width * n);
  }
  return { width, height, n, data, x: whole.x + x0, y: whole.y + y0, grid: whole.grid };
}

/* ---------- scans with a hidden text layer ---------- */

/** ids of lines taken from a hidden text layer */
export const HIDDEN = "ocr:h:";

/** the text module marks the invisible layer of a scan with this id ending */
const isHidden = (l: TextLine) => l.source === "content" && !l.editable && l.id.endsWith(".h");

/**
 * The hidden layer of a scan presented as recognised lines: editing one then changes the picture the
 * reader sees, exactly as after our own recognition.
 */
function fromHiddenLayer(ctx: EngineContext, base: PageText): PageText {
  if (!base.lines.some(isHidden) || imageCoverage(ctx, base.page) < 0.5) return base;
  return {
    ...base,
    lines: base.lines.map((l) =>
      isHidden(l) ? { ...l, id: HIDDEN + l.id, source: "ocr" as const, editable: true, note: undefined } : l,
    ),
  };
}

/** remember a page's hidden layer as its recognition result (called when one of its lines is first edited) */
export function adoptHiddenLayer(ctx: EngineContext, base: PageText): OcrPageState | undefined {
  const lines = fromHiddenLayer(ctx, base).lines.filter((l) => l.id.startsWith(HIDDEN));
  if (!lines.length) return undefined;
  const page = base.page;
  const result: OcrPageResult = { page, languages: [], lines: lines.map(asRecognised) };
  setOcrResult(ctx, result);
  const entry = findEntry(ctx, page)!;
  const meta = pageMeta(entry);
  // keep the ids and styles the user has been shown (stored lines are in reading order)
  const toPdf = toPdfMatrix(pageTransform(ctx, page));
  for (const line of lines) {
    const frame = mapFrame(frameFromLine(asRecognised(line)).frame, toPdf);
    const stored = meta.lines.find((m) => m.text === line.text && Math.hypot(m.frame.o[0] - frame.o[0], m.frame.o[1] - frame.o[1]) < 0.5);
    if (!stored) continue;
    stored.id = line.id;
    stored.style.size = line.style.size;
  }
  return entry;
}

/** a content line described the way the recogniser describes lines, with words sharing the width */
function asRecognised(line: TextLine): OcrLine {
  const [ox, oy] = line.origin;
  const length = Math.hypot(line.quad[2] - line.quad[0], line.quad[3] - line.quad[1]);
  const cos = Math.cos(line.angle);
  const sin = Math.sin(line.angle);
  const parts = line.text.split(/(\s+)/);
  const total = Math.max(1, line.text.length);
  let at = 0;
  const words: OcrLine["words"] = [];
  const h = line.rect[3] - line.rect[1];
  for (const part of parts) {
    const from = (at / total) * length;
    at += part.length;
    if (!part.trim()) continue;
    const to = (at / total) * length;
    const rect: Rect =
      Math.abs(sin) < 0.1
        ? [
            line.dir === "rtl" ? line.rect[2] - to : line.rect[0] + from,
            line.rect[1],
            line.dir === "rtl" ? line.rect[2] - from : line.rect[0] + to,
            line.rect[1] + h,
          ]
        : line.rect;
    words.push({ text: part, rect, confidence: 90 });
  }
  return {
    text: line.text,
    rect: line.rect,
    baseline: [
      [ox, oy],
      [ox + cos * length, oy + sin * length],
    ],
    confidence: 90,
    words,
    dir: line.dir,
  };
}

/* ---------- presenting ---------- */

export function mergePageText(ctx: EngineContext, base: PageText): PageText {
  const entry = findEntry(ctx, base.page);
  if (!entry) return fromHiddenLayer(ctx, base);
  const meta = pageMeta(entry);
  const transform = pageTransform(ctx, base.page);
  // on scans and broken-encoding pages the recognised text is what can be trusted
  const ocrWins = meta.scan || base.kind === "scanned" || base.kind === "garbled";

  const lines: { line: TextLine; edited: boolean }[] = [];
  /** places where the page content is described by recognised lines instead */
  const claimed: Rect[] = [];
  for (const source of meta.lines) {
    const edit = editOf(entry, source.id);
    const original = frameRect(mapFrame(source.frame, transform));
    if (edit) claimed.push(original, frameRect(mapFrame(edit.frame, transform)));
    else if (ocrWins) claimed.push(original);
    if (edit?.deleted) continue;
    const frame = mapFrame(edit?.frame ?? source.frame, transform);
    const text = edit?.text ?? source.text;
    const style = { ...(edit?.style ?? source.style) };
    lines.push({
      edited: !!edit,
      line: {
        id: source.id,
        page: base.page,
        text,
        quad: frameQuad(frame),
        rect: frameRect(frame),
        origin: frame.o,
        angle: Math.atan2(frame.u.y, frame.u.x),
        dir: source.dir,
        style,
        spans: [{ start: 0, end: text.length, style }],
        align: edit?.align ?? source.align,
        source: "ocr",
        confidence: source.confidence,
        editable: true,
        note: !edit && source.confidence < 60 ? "Recognised with low confidence. Check the text before saving." : undefined,
      },
    });
  }

  const content = base.lines.filter((l) => !claimed.some((r) => overlap(r, l.rect) > 0.35));
  const ocr = lines
    .filter(({ line, edited }) => ocrWins || edited || !content.some((c) => overlap(c.rect, line.rect) > 0.35))
    .map((l) => l.line);
  return { ...base, kind: meta.scan ? "scanned" : base.kind, lines: [...ocr, ...content] };
}
