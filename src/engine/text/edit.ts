/** Turns line edits into the smallest possible change of the page content. */
import type { EngineContext, ModuleChange } from "../context";
import * as fonts from "../fonts";
import type { WriteTextRequest } from "../fonts/types";
import { apply, invert, multiply, num, rectFromPoints } from "../geom";
import type { Align, LineEdit, Matrix, Point, RGB, TextStyle } from "../types";
import { analyze, fallbackLines, type Analysis } from "./analyze";
import { diffUnits } from "./diff";
import { documentFont, DOCUMENT_CHOICE } from "./documentFonts";
import { METRIC_LETTERS } from "../fonts/match";
import { Encoder, type NewPiece } from "./encode";
import { redactAndRewrite, verifyLine } from "./fallback";
import type { Glyph, ShowOp } from "./interpret";
import { fromFrame, styleOf, toFrame, type LineModel, type Rule, type Unit } from "./layout";
import type { Code, PdfFont } from "./pdffont";
import { Rewriter } from "./rewrite";
import { rememberLines, type Placed } from "./starts";
import { bidi, CJK, hasRtl, isComplex, reorderByLevels } from "./unicode";

export interface Notes {
  warnings: string[];
  fallbackFonts: string[];
}

export async function applyEdits(ctx: EngineContext, pageIndex: number, edits: LineEdit[]): Promise<ModuleChange> {
  const analysis = analyze(ctx, pageIndex);
  const byId = new Map(analysis.models.map((m) => [m.line.id, m]));
  const notes: Notes = { warnings: [], fallbackFonts: [] };
  const wanted = new Map<LineModel, LineEdit>();
  for (const edit of edits) {
    const model = byId.get(edit.lineId);
    if (!model) throw new Error("That line is no longer on the page. Tap it again and repeat the change.");
    if (!model.line.editable) {
      notes.warnings.push(model.line.note ?? "This line cannot be edited directly.");
      continue;
    }
    wanted.set(model, { ...edit, text: edit.text.replace(/[\r\n\t\f\v\u2028\u2029]+/g, " ").normalize("NFC") });
  }
  if (!wanted.size) return { changedPages: [], ...notes };

  const page = ctx.doc.loadPage(pageIndex);
  try {
    const surgical: [LineModel, LineEdit][] = [];
    const redact: [LineModel, LineEdit][] = [];
    const verify = verifyLine(ctx.mupdf, page);
    for (const entry of wanted) {
      const [model] = entry;
      const usable = !!analysis.interp && model.units.some((u) => u.glyphs.length) && verify(model);
      (usable ? surgical : redact).push(entry);
    }
    let changed = false;
    if (surgical.length) {
      const rewriter = new Rewriter(ctx, page, analysis.interp!);
      const session: Session = { ctx, analysis, rewriter, encoder: new Encoder(ctx, analysis), notes, placed: new Map() };
      let any = false;
      for (const [model, edit] of surgical) if (await editLine(session, model, edit)) any = true;
      if (any) {
        rewriter.apply();
        rememberLines(ctx, pageIndex, analysis.models, session.placed);
        changed = true;
      }
    }
    if (redact.length) {
      // our positions could not be confirmed: take the characters to remove from MuPDF itself
      const seen = redact.some(([m]) => m.units.some((u) => u.glyphs.length)) ? fallbackLines(pageIndex, page) : [];
      await redactAndRewrite(
        ctx,
        page,
        redact.map(([m, edit]) => [asMuPdfSeesIt(m, seen), edit]),
        notes,
      );
      changed = true;
    }
    return {
      changedPages: changed ? [pageIndex] : [],
      warnings: [...new Set(notes.warnings)],
      fallbackFonts: [...new Set(notes.fallbackFonts)],
    };
  } finally {
    page.destroy();
  }
}

/** the same line with the character boxes MuPDF reports for it */
function asMuPdfSeesIt(model: LineModel, seen: LineModel[]): LineModel {
  const r = model.line.rect;
  const slack = 0.25 * (r[3] - r[1]);
  const units = seen
    .flatMap((m) => m.units.map((u) => ({ u, m })))
    .filter(({ u, m }) => {
      const p = fromFrame((u.u0 + u.u1) / 2, u.v - 0.3 * u.size, m.ex, m.ey);
      return p[0] >= r[0] - slack && p[0] <= r[2] + slack && p[1] >= r[1] - slack && p[1] <= r[3] + slack;
    });
  if (!units.length) return model;
  const remapped = units.map(({ u, m }) => {
    const [a, v] = toFrame(fromFrame(u.u0, u.v, m.ex, m.ey), model.ex, model.ey);
    return { ...u, u0: a, u1: a + (u.u1 - u.u0), v };
  });
  return { ...model, units: remapped, visual: remapped };
}

interface Session {
  ctx: EngineContext;
  analysis: Analysis;
  rewriter: Rewriter;
  encoder: Encoder;
  notes: Notes;
  /** where each rewritten line now begins */
  placed: Map<LineModel, Placed>;
}

type Item = {
  /** offset in the new text */
  at: number;
  width: number;
  /** position along the baseline (line frame), assigned during layout */
  u: number;
  /** removed units this new content takes the place of */
  replaces: Unit[];
} & (
  | { kind: "keep"; unit: Unit }
  /** new text typed with a document font */
  | { kind: "glyphs"; piece: NewPiece; ref: Glyph; v: number }
  /** a word gap with nothing drawn */
  | { kind: "space"; ref: Glyph; v: number }
  /** new text for the FONTS module */
  | { kind: "draw"; text: string; ref: Glyph; v: number }
);

const different = (a: RGB, b: RGB) => a.some((v, i) => Math.abs(v - b[i]!) > 0.004);

async function editLine(s: Session, model: LineModel, edit: LineEdit): Promise<boolean> {
  const { rewriter } = s;
  const line = model.line;
  const style = edit.style ?? {};
  const allGlyphs = [...model.units.flatMap((u) => u.glyphs), ...model.padding];
  const shadowsOf = (g: Glyph) => model.shadows.get(g) ?? [];
  for (const u of model.units) u.glyphs.forEach((g, i) => rewriter.labels.set(g, i ? "" : u.text));

  const removeGlyph = (g: Glyph) => {
    rewriter.delete(g);
    for (const copy of shadowsOf(g)) rewriter.delete(copy);
  };

  if (!edit.text.trim()) {
    allGlyphs.forEach(removeGlyph);
    for (const rule of model.rules) removeRule(rewriter, rule);
    s.placed.set(model, null);
    return true;
  }

  const scale = style.size && Math.abs(style.size - line.style.size) > 0.01 ? style.size / line.style.size : 1;
  const recolor = style.color && line.spans.some((sp) => different(style.color!, sp.style.color)) ? style.color : undefined;
  const oldSpacing = line.style.letterSpacing ?? 0;
  const spacing =
    style.letterSpacing !== undefined && Math.abs(style.letterSpacing - oldSpacing) > 0.01 ? style.letterSpacing - oldSpacing : 0;
  const changes = <K extends keyof TextStyle>(key: K) => style[key] !== undefined && line.spans.some((sp) => sp.style[key] !== style[key]);
  const newFace =
    !!style.fontChoice || changes("family") || changes("bold") || changes("italic") || changes("serif") || changes("mono");
  const offset = edit.offset ?? [0, 0];
  const underline = style.underline === undefined || style.underline === !!line.style.underline ? undefined : style.underline;
  const alignChange: Align | undefined = edit.align && edit.align !== line.align ? edit.align : undefined;

  const text = edit.text;
  const textChanged = text !== line.text;
  const restyled = scale !== 1 || !!recolor || spacing !== 0 || newFace;
  if (!textChanged && !restyled && !offset[0] && !offset[1] && underline === undefined && !alignChange && edit.fit !== "shrink") return false;

  // a bold or italic sibling already in the document is better than any substitute
  let variant: PdfFont | null = null;
  if (newFace && !style.fontChoice && (!style.family || style.family === line.style.family))
    variant = await findVariant(s, model, style, text);
  // a font of this document picked by the user types with its own codes wherever it can
  else if (style.fontChoice?.startsWith(DOCUMENT_CHOICE) && !isComplex(text))
    variant = pickedFont(s, style.fontChoice);
  const redraw = newFace && !variant;

  /* ---------- 1. what stays, what is new ---------- */
  const kept = newFace ? new Map<number, { unit: Unit; length: number }>() : diffUnits(model.units, line.text, text);
  await keepWordsInOneFace(s, model, kept, text, style, scale);
  const keptUnits = new Set([...kept.values()].map((k) => k.unit));
  const items: Item[] = [];
  let pending = "";
  let pendingAt = 0;
  let previousIndex = -1;

  const flush = async (nextIndex: number) => {
    if (!pending) return;
    const replaced = model.units.slice(previousIndex + 1, nextIndex).filter((u) => !keptUnits.has(u));
    const before = previousIndex >= 0 ? model.units[previousIndex]! : null;
    const after = nextIndex < model.units.length ? model.units[nextIndex]! : null;
    if (redraw) {
      const ref = referenceGlyph(model, pending, replaced, before, after);
      // a stacked column is redrawn one character below the other
      let at = pendingAt;
      for (const part of model.stacked ? [...pending] : [pending]) {
        items.push({ kind: "draw", text: part, ref, v: model.baseline, at, width: 0, u: 0, replaces: replaced });
        at += part.length;
      }
    } else items.push(...(await newItems(s, model, { text: pending, at: pendingAt, full: text, replaced, before, after, scale, spacing, variant })));
    pending = "";
  };

  for (let at = 0; at < text.length; ) {
    const k = kept.get(at);
    if (k) {
      const index = model.units.indexOf(k.unit);
      await flush(index);
      items.push({ kind: "keep", unit: k.unit, at, width: 0, u: 0, replaces: [] });
      previousIndex = index;
      at += k.length;
    } else {
      if (!pending) pendingAt = at;
      const cp = String.fromCodePoint(text.codePointAt(at)!);
      pending += cp;
      at += cp.length;
    }
  }
  await flush(model.units.length);

  /* ---------- 2. widths ---------- */
  const requests = new Map<Item, Omit<WriteTextRequest, "resources" | "matrix">>();
  for (const item of items) {
    if (item.kind === "keep") item.width = (item.unit.u1 - item.unit.u0) * scale + spacing * item.unit.glyphs.length;
    else if (item.kind === "glyphs") item.width = item.piece.width;
    else if (item.kind === "draw") {
      const { request, unit } = drawRequest(item.text, item.ref, style, scale, recolor, model.tracking);
      // a deliberate change of typeface keeps that face's own proportions
      if (!newFace) request.reference = await s.encoder.heights(item.ref);
      const planned = await fonts.planText(s.ctx, request);
      item.width = planned.width * unit;
      if (model.stacked) item.width = item.ref.size * scale;
      requests.set(item, request);
    }
  }

  /* ---------- 3. visual order and positions ---------- */
  const sequence = visualOrder(model, items, text).map((i) => items[i]!);
  let cursor = model.u0;
  let previous: Item | null = null;
  // letter spacing of a tracked line; new items already carry it in their width
  const tracked = model.tracking * line.style.size * scale;
  for (const item of sequence) {
    // neighbours that were neighbours before keep their kerning
    let gap = 0;
    if (previous?.kind === "keep") {
      if (item.kind === "keep" && item.unit.vis === previous.unit.vis + 1) gap = (item.unit.u0 - previous.unit.u1) * scale;
      else {
        gap = tracked;
        // extra room the producer left behind a space (wide word spacing) stays, whatever follows now
        const next = model.visual[previous.unit.vis + 1];
        if (!previous.unit.text.trim() && next) gap = Math.max(gap, (next.u0 - previous.unit.u1) * scale);
      }
    }
    item.u = cursor + gap;
    cursor = item.u + item.width;
    previous = item;
  }
  // there is no letter spacing after the last letter
  if (previous && previous.kind !== "keep" && previous.kind !== "space") previous.width -= tracked;
  const extent = () => [sequence[0]!.u, Math.max(...sequence.map((i) => i.u + i.width))] as const;
  let [start, end] = extent();
  const origWidth = model.u1 - model.u0;
  const width = end - start;

  const align = edit.align ?? line.align;
  let shift = 0;
  let squeeze = 1;
  if (alignChange) {
    const { left, right } = model.block;
    if (align === "left") shift = left - start;
    else if (align === "right") shift = right - end;
    else if (align === "center") shift = (left + right) / 2 - (start + end) / 2;
    else {
      shift = left - start;
      if (right - left > width + 0.01) squeeze = justify(sequence, right - left - width);
      [start, end] = extent();
    }
  } else {
    if (align === "justify" && Math.abs(width - origWidth) > 0.05) {
      squeeze = justify(sequence, origWidth - width);
      [start, end] = extent();
    }
    if (align === "right") shift = model.u1 - end;
    else if (align === "center") shift = (model.u0 + model.u1) / 2 - (start + end) / 2;
    else shift = model.u0 - start;
  }
  // rounding noise must not disturb glyphs that did not move
  if (Math.abs(shift) < 0.004) shift = 0;
  for (const item of sequence) item.u += shift;
  start += shift;
  end += shift;

  const limit = alignChange && align === "justify" ? model.block.right - model.block.left : origWidth;
  if (edit.fit === "shrink" && (end - start) * squeeze > limit + 0.05) squeeze = limit / (end - start);
  if (squeeze !== 1) {
    const anchor = align === "right" ? end : align === "center" ? (start + end) / 2 : start;
    for (const item of sequence) {
      item.u = anchor + (item.u - anchor) * squeeze;
      item.width *= squeeze;
    }
    start = anchor + (start - anchor) * squeeze;
    end = anchor + (end - anchor) * squeeze;
  }

  const [ou, ov] = toFrame(offset, model.ex, model.ey);
  for (const item of sequence) item.u += ou;
  start += ou;
  end += ou;
  const toPage = (u: number, v: number): Point => fromFrame(u, v, model.ex, model.ey);
  const lineV = (v: number) => model.baseline + (v - model.baseline) * scale + ov;

  /* ---------- 4. emit ---------- */
  // squeezing narrows the letters; upright columns have to shrink them instead
  const narrow = model.stacked ? 1 : squeeze;
  const grow = model.stacked ? scale * squeeze : scale;
  const moved = Math.abs(start - model.u0) > 0.01 || Math.abs(end - model.u1) > 0.01 || ov !== 0 || scale !== 1;
  for (const unit of model.units) if (!keptUnits.has(unit)) unit.glyphs.forEach(removeGlyph);
  if (model.padding.length && (moved || textChanged || redraw)) model.padding.forEach(removeGlyph);

  // once new text lands in a show operator, what follows it there is drawn again after it, so that
  // the content order stays the reading order
  const reflow = new Set<ShowOp>();
  for (const item of sequence) {
    if (item.kind === "glyphs" || item.kind === "draw") reflow.add(item.ref.show);
    if (item.kind === "keep") {
      const unit = item.unit;
      const ordered = unit.glyphs
        .map((g) => ({ g, at: toFrame(g.origin, model.ex, model.ey) }))
        .sort((a, b) => a.at[0] - b.at[0]);
      ordered.forEach(({ g, at }, index) => {
        const target = toPage(item.u + (at[0] - unit.u0) * scale * squeeze + index * spacing * squeeze, lineV(at[1]));
        const color = recolor && different(styleOf(g).color, recolor) ? recolor : undefined;
        const still = Math.hypot(target[0] - g.origin[0], target[1] - g.origin[1]) < 0.012;
        if (still && grow === 1 && narrow === 1 && !color && !spacing && !reflow.has(g.show)) return;
        rewriter.move(g, { origin: target, scale: grow, squeeze: narrow, spacing, color });
        for (const copy of shadowsOf(g)) {
          rewriter.move(copy, {
            origin: [target[0] + (copy.origin[0] - g.origin[0]) * grow, target[1] + (copy.origin[1] - g.origin[1]) * grow],
            scale: grow,
            squeeze: narrow,
            spacing,
          });
        }
      });
    } else if (item.kind === "glyphs") {
      const actual = item.piece.needsActualText ? { text: item.piece.text } : undefined;
      for (const layer of [...shadowsOf(item.ref), item.ref]) {
        // a copy painted from another font cannot take these codes
        if (layer.show.font !== item.ref.show.font) continue;
        const dx = layer.origin[0] - item.ref.origin[0];
        const dy = layer.origin[1] - item.ref.origin[1];
        for (const g of item.piece.glyphs) {
          const p = toPage(item.u + (g.du + (model.stacked ?? 0) * scale) * squeeze, lineV(item.v) + g.dv);
          rewriter.place(layer.show, {
            font: g.font,
            code: g.code,
            origin: [p[0] + dx, p[1] + dy],
            scale: grow * g.scale,
            squeeze: narrow,
            spacing,
            color: layer === item.ref && recolor && different(styleOf(item.ref).color, recolor) ? recolor : undefined,
            actual: layer === item.ref ? (g.actual ?? actual) : undefined,
          });
        }
      }
    } else if (item.kind === "draw") {
      const base = requests.get(item)!;
      for (const layer of [...shadowsOf(item.ref), item.ref]) {
        const dx = layer.origin[0] - item.ref.origin[0];
        const dy = layer.origin[1] - item.ref.origin[1];
        const p = toPage(item.u + (model.stacked ?? 0) * scale, lineV(item.v));
        // the text goes into the layer's own graphics state, so its matrix has to be relative to that
        const matrix = drawMatrix(s, layer, [p[0] + dx, p[1] + dy]);
        if (model.stacked) for (let k = 0; k < 4; k++) matrix[k]! *= squeeze;
        const written = await fonts.writeText(s.ctx, {
          ...base,
          // copies underneath keep their own paint (shadow colour, outline)
          // (the style colour still names the layer's own, for the stroke that thickens a synthetic bold)
          ...(layer === item.ref
            ? {}
            : { colorOps: "", renderMode: layer.show.tr === 7 ? 0 : layer.show.tr % 4, style: { ...base.style, color: styleOf(layer).color } }),
          horizontalScale: (base.horizontalScale ?? 100) * narrow,
          matrix,
          resources: rewriter.resourcesFor(layer.show.node),
        });
        rewriter.substitute(layer.show, written.ops);
        if (layer === item.ref) {
          if (written.substituted && !style.fontChoice) s.notes.fallbackFonts.push(...written.fontsUsed);
          if (written.missing.length) s.notes.warnings.push(`No available font can draw: ${[...new Set(written.missing)].join(" ")}`);
        }
      }
    }
  }

  /* ---------- 5. decorations, clips ---------- */
  for (const rule of model.rules) {
    if (underline === false && rule.kind === "underline") {
      removeRule(rewriter, rule);
      continue;
    }
    if (!(moved || textChanged || squeeze !== 1 || redraw || recolor)) continue;
    const whole = rule.units.length >= model.units.length - 1;
    const covered = new Set(rule.units);
    const members = whole
      ? sequence
      : sequence.filter((i) => (i.kind === "keep" ? covered.has(i.unit) : i.replaces.some((u) => covered.has(u))));
    if (!members.length) {
      removeRule(rewriter, rule);
      continue;
    }
    const from = Math.min(...members.map((i) => i.u)) - rule.before * scale;
    const to = Math.max(...members.map((i) => i.u + i.width)) + rule.after * scale;
    redrawRule(rewriter, model, rule, from, to, lineV, scale, recolor);
  }
  const size = line.style.size * scale;
  const corner = (i: number) => toFrame([line.quad[i]!, line.quad[i + 1]!], model.ex, model.ey)[1];
  const ascent = Math.max(0.7 * line.style.size, model.baseline - corner(0)) * scale;
  const descent = Math.max(0.18 * line.style.size, corner(4) - model.baseline) * scale;
  const baseline = model.baseline + ov;
  if (underline === true) {
    const anchor = [...sequence]
      .reverse()
      .map((i) => (i.kind === "keep" ? i.unit.glyphs[0] : i.ref))
      .find(Boolean);
    if (anchor) drawUnderline(s, model, anchor, start, end, baseline, size, recolor);
  }

  const box = rectFromPoints([
    toPage(start, baseline - ascent),
    toPage(end, baseline - ascent),
    toPage(start, baseline + descent),
    toPage(end, baseline + descent),
  ]);
  s.placed.set(model, { start: toPage(start, baseline), end: toPage(end, baseline), align });
  // each piece of the file is checked against its own clip: text that moves left can leave the clip
  // around it even though the line as a whole did not grow
  const spans = new Map<ShowOp, { was: number[]; now: number[] }>();
  const stretch = (show: ShowOp, key: "was" | "now", a: number, b: number) => {
    let e = spans.get(show);
    if (!e) spans.set(show, (e = { was: [Infinity, -Infinity], now: [Infinity, -Infinity] }));
    e[key][0] = Math.min(e[key][0]!, a);
    e[key][1] = Math.max(e[key][1]!, b);
  };
  for (const unit of model.units) for (const g of unit.glyphs) stretch(g.show, "was", unit.u0, unit.u1);
  for (const item of sequence) {
    if (item.kind === "keep") for (const g of item.unit.glyphs) stretch(g.show, "now", item.u, item.u + item.width);
    else stretch(item.ref.show, "now", item.u, item.u + item.width);
  }
  const area = (a: number, b: number, v: number) =>
    rectFromPoints([toPage(a, v - ascent), toPage(b, v - ascent), toPage(a, v + descent), toPage(b, v + descent)]);
  let clipped = false;
  for (const [show, e] of spans) {
    if (!show.clips.length || e.now[0]! > e.now[1]!) continue;
    const to = area(e.now[0]!, e.now[1]!, baseline);
    const from = e.was[0]! <= e.was[1]! ? area(e.was[0]!, e.was[1]!, model.baseline) : to;
    if (!rewriter.reveal(show, from, to)) clipped = true;
  }
  if (clipped) s.notes.warnings.push("Part of the new text may be hidden by a shape that clips this area of the page.");
  const bounds = s.analysis.interp!.pageRect;
  if (
    (box[0] < bounds[0] - 0.5 && line.rect[0] >= bounds[0] - 0.5) ||
    (box[2] > bounds[2] + 0.5 && line.rect[2] <= bounds[2] + 0.5) ||
    (box[3] > bounds[3] + 0.5 && line.rect[3] <= bounds[3] + 0.5) ||
    (box[1] < bounds[1] - 0.5 && line.rect[1] >= bounds[1] - 0.5)
  )
    s.notes.warnings.push("The new text runs off the page. Use a smaller size or shrink to fit.");
  return true;
}

/**
 * A word that needs letters the document font cannot supply, and whose substitute looks different, is
 * redrawn as a whole: one odd looking word reads better than odd looking letters inside a word.
 */
async function keepWordsInOneFace(
  s: Session,
  model: LineModel,
  kept: Map<number, { unit: Unit; length: number }>,
  text: string,
  change: Partial<TextStyle>,
  scale: number,
): Promise<void> {
  if (model.stacked) return;
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    // joined and unspaced scripts are handled elsewhere
    if (isComplex(word) || CJK.test(word) || hasRtl(word)) continue;
    const from = match.index;
    const inside = [...kept].filter(([at]) => at >= from && at < from + word.length);
    if (!inside.length) continue;
    const covered = new Set(inside.flatMap(([at, k]) => Array.from({ length: k.length }, (_, i) => at + i)));
    const ref = inside[0]![1].unit.glyphs[0];
    if (!ref) continue;
    let missing = "";
    for (const part of new Intl.Segmenter().segment(word)) {
      if (covered.has(from + part.index)) continue;
      let found = false;
      for (const font of s.encoder.candidates(part.segment, ref, model))
        if (await s.encoder.encode(part.segment, font)) {
          found = true;
          break;
        }
      if (!found) missing += part.segment;
    }
    if (!missing) continue;
    const { request } = drawRequest(missing, ref, change, scale, undefined, model.tracking);
    const plan = await fonts.planText(s.ctx, request);
    if (!plan.substituted || plan.fontsUsed.every((f) => fonts.LOOKALIKE[f]?.test(ref.show.font.name))) continue;
    for (const [at] of inside) kept.delete(at);
  }
}

/** spread `extra` over the word gaps; returns the squeeze needed when that is not possible */
function justify(sequence: Item[], extra: number): number {
  const isGap = (i: Item) => (i.kind === "keep" ? !i.unit.text.trim() : i.kind === "space");
  const gaps = sequence.filter((i) => isGap(i) || (i.kind === "glyphs" && !i.piece.text.trim()));
  const width = Math.max(...sequence.map((i) => i.u + i.width)) - sequence[0]!.u;
  const each = gaps.length ? extra / gaps.length : 0;
  const head = sequence[0]!;
  const size = head.kind === "keep" ? head.unit.size : head.ref.size;
  // a line that became much shorter reads as the last line of its paragraph: it is not blown up
  if (extra > 0.25 * (width + extra)) return 1;
  if (gaps.length && gaps.every((g) => g.width + each > 0.12 * size) && each < 1.2 * size) {
    let added = 0;
    for (const item of sequence) {
      item.u += added;
      if (gaps.includes(item)) {
        item.width += each;
        added += each;
      }
    }
    return 1;
  }
  const ratio = (width + extra) / width;
  return ratio > 0.82 && ratio < 1.12 ? ratio : 1;
}

/** left to right order of the items, following the bidirectional algorithm for mixed text */
function visualOrder(model: LineModel, items: Item[], text: string): number[] {
  const identity = items.map((_, i) => i);
  if (!model.rtl && !hasRtl(text)) return identity;
  const base = model.rtl ? "rtl" : "ltr";
  const levels = bidi().getEmbeddingLevels(text, base).levels;
  const itemLevels = items.map((i) => levels[i.at] ?? (model.rtl ? 1 : 0));
  // the algorithm must reproduce what is on the page now, otherwise the page order wins
  const oldLevels = bidi().getEmbeddingLevels(model.line.text, base).levels;
  const oldOrder = reorderByLevels(model.units.map((u) => oldLevels[u.start] ?? 0));
  if (oldOrder.every((index, vis) => model.units[index]!.vis === vis)) return reorderByLevels(itemLevels);
  const unitOf = (i: number) => (items[i] as { unit: Unit }).unit;
  const visual = identity.filter((i) => items[i]!.kind === "keep").sort((a, b) => unitOf(a).vis - unitOf(b).vis);
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind === "keep") continue;
    const at = i ? visual.indexOf(i - 1) : -1;
    if (at < 0) visual.splice(model.rtl ? visual.length : 0, 0, i);
    else visual.splice(itemLevels[i]! % 2 ? at : at + 1, 0, i);
  }
  return visual;
}

/* ---------- new content ---------- */

/** the glyph whose font, size, colour and graphics state new text should take over */
function referenceGlyph(model: LineModel, token: string, replaced: Unit[], before: Unit | null, after: Unit | null): Glyph {
  const kind = (s: string) => (/\p{Nd}/u.test(s) ? "n" : /\p{L}/u.test(s) ? "l" : "o");
  const usable = (u: Unit | null | undefined): u is Unit => !!u && u.glyphs.length > 0 && !!u.text.trim();
  const own = replaced.filter(usable);
  // where the replaced text mixes styles, the one most of it is written in wins
  const key = (u: Unit) => {
    const s = styleOf(u.glyphs[0]!);
    return `${s.family}|${s.size.toFixed(0)}|${s.color.map((c) => c.toFixed(1))}`;
  };
  const weight = new Map<string, number>();
  for (const u of own) weight.set(key(u), (weight.get(key(u)) ?? 0) + u.text.length);
  const heaviest = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0];
  const main = own.filter((u) => key(u) === heaviest);
  const match = main.find((u) => kind(u.text) === kind(token)) ?? main[0];
  if (match) return match.glyphs[0]!;
  // continue the style of the text before the insertion, or of what follows when a space sits in between
  const index = before ? model.units.indexOf(before) : -1;
  const back = model.units.slice(0, index + 1).reverse().find(usable);
  const forward = after ? model.units.slice(model.units.indexOf(after)).find(usable) : undefined;
  const spaceFirst = /^\s/.test(token);
  if (back && (usable(before) || !forward || spaceFirst)) return back.glyphs[back.glyphs.length - 1]!;
  if (forward) return forward.glyphs[0]!;
  return (back ?? model.units.find(usable) ?? model.units.find((u) => u.glyphs.length)!).glyphs[0]!;
}

interface Chunk {
  text: string;
  at: number;
  full: string;
  replaced: Unit[];
  before: Unit | null;
  after: Unit | null;
  scale: number;
  spacing: number;
  variant: PdfFont | null;
}

type Hit = { font: PdfFont; code: Code; actual: boolean };

async function newItems(s: Session, model: LineModel, c: Chunk): Promise<Item[]> {
  const { encoder } = s;
  const items: Item[] = [];
  const spaces = model.units.filter((u) => !u.text.trim());
  const drawnSpaces = spaces.filter((u) => u.glyphs.length).length;
  const gapWidths = spaces.map((u) => u.u1 - u.u0).sort((a, b) => a - b);
  const typicalGap = gapWidths.length ? gapWidths[gapWidths.length >> 1]! : 0;
  const spacedByGaps = spaces.length > 0 && drawnSpaces < spaces.length / 2;

  /** width in page units of one glyph of `font` drawn like `ref` */
  const advance = (ref: Glyph, font: PdfFont, code: Code) => {
    const show = ref.show;
    const space = code.length === 1 && code.code === 32;
    const w = font.vertical ? Math.abs(font.verticalAdvance(code)) : font.width(code);
    const size = Math.abs(show.size) * encoder.scaleFor(font, ref);
    const tx = (w * size + show.tc + (space ? show.tw : 0)) * (font.vertical ? 1 : Math.abs(show.th));
    return (tx * ref.unit + model.tracking * ref.size) * c.scale + c.spacing;
  };

  const levels = model.rtl || hasRtl(c.full) ? bidi().getEmbeddingLevels(c.full, model.rtl ? "rtl" : "ltr").levels : null;
  let offset = c.at;
  for (const token of c.text.match(model.stacked ? /./gsu : /\s|[^\s]+/gu) ?? []) {
    const at = offset;
    offset += token.length;
    const ref = referenceGlyph(model, token, c.replaced, c.before, c.after);
    // text sits on the line's baseline unless the text it continues is raised or lowered
    const own = toFrame(ref.origin, model.ex, model.ey)[1];
    const v = !model.cascade && Math.abs(own - model.baseline) > 0.18 * ref.size ? own : model.baseline;
    const base = { at, u: 0, replaces: c.replaced };
    const font = c.variant ?? ref.show.font;

    if (!token.trim()) {
      let seen: Hit | null = null;
      if (!spacedByGaps && !model.stacked)
        for (const f of encoder.candidates(" ", ref, model)) {
          const e = await encoder.encode(" ", f);
          if (e && advance(ref, f, e.code) > 0.05 * ref.size) {
            seen = { font: f, ...e };
            break;
          }
        }
      if (seen) {
        const width = advance(ref, seen.font, seen.code);
        const glyph = { font: seen.font, code: seen.code, du: 0, dv: 0, scale: encoder.scaleFor(seen.font, ref) };
        const piece: NewPiece = { text: " ", width, needsActualText: seen.actual, glyphs: [glyph] };
        items.push({ ...base, kind: "glyphs", ref, v, width, piece });
      } else {
        // wide enough to read as a space again, which takes more between East Asian characters
        const gap = typicalGap || (CJK.test(c.full) ? 0.6 : 0.27) * ref.size;
        // in tracked text a word gap is a space between two letter spacings
        items.push({ ...base, kind: "space", ref, v, width: (gap + model.tracking * ref.size) * c.scale + c.spacing });
      }
      continue;
    }

    if (isComplex(token)) {
      const clone = c.variant || c.spacing ? null : encoder.clone(token, ref);
      if (clone) {
        const piece: NewPiece = {
          ...clone,
          width: clone.width * c.scale,
          glyphs: clone.glyphs.map((g) => ({ ...g, du: g.du * c.scale, dv: g.dv * c.scale })),
        };
        items.push({ ...base, kind: "glyphs", ref, v, width: piece.width, piece });
      } else items.push({ ...base, kind: "draw", text: token, ref, v, width: 0 });
      continue;
    }

    const graphemes = [...new Intl.Segmenter().segment(token)].map((g) => g.segment);
    const parts: { text: string; at: number; hit: Hit | null }[] = [];
    let position = at;
    for (let i = 0; i < graphemes.length; ) {
      let hit: Hit | null = null;
      let used = 1;
      // ligatures the font provides are used where the producer would have used them
      for (let n = Math.min(3, graphemes.length - i); n >= 2 && !hit && !c.spacing; n--) {
        const joined = graphemes.slice(i, i + n).join("");
        if (!/^(ff|fi|fl|ffi|ffl)$/.test(joined)) continue;
        const code = font.codesFor(joined)[0];
        if (code && font.probe(code)?.ink && font.width(code) > 0) {
          hit = { font, code, actual: false };
          used = n;
        }
      }
      if (!hit)
        for (const f of c.variant ? [c.variant] : encoder.candidates(graphemes[i]!, ref, model)) {
          const e = await encoder.encode(graphemes[i]!, f);
          if (e) {
            hit = { font: f, ...e };
            break;
          }
        }
      const piece = graphemes.slice(i, i + used).join("");
      parts.push({ text: piece, at: position, hit });
      position += piece.length;
      i += used;
    }
    // a word that is entirely new and cannot be fully typed in the original font is drawn in one font
    const wholeWord = (at === 0 || /\s/.test(c.full[at - 1]!)) && (offset >= c.full.length || /\s/.test(c.full[offset]!));
    if (wholeWord && !CJK.test(token) && parts.some((p) => !p.hit)) {
      // one request per direction, so that the line's own bidirectional order places them
      let from = 0;
      for (let k = 1; k <= token.length; k++) {
        if (k < token.length && (!levels || levels[at + k] === levels[at + from])) continue;
        items.push({ ...base, at: at + from, kind: "draw", text: token.slice(from, k), ref, v, width: 0 });
        from = k;
      }
      continue;
    }
    let last: Item | null = null;
    for (const p of parts) {
      if (!p.hit) {
        if (last?.kind === "draw") last.text += p.text;
        else {
          last = { ...base, at: p.at, kind: "draw", text: p.text, ref, v, width: 0 };
          items.push(last);
        }
        continue;
      }
      const width = advance(ref, p.hit.font, p.hit.code);
      const previous = last as Item | null;
      if (previous?.kind === "glyphs" && previous.piece.glyphs[0]!.font === p.hit.font) {
        const kern = encoder.kern(p.hit.font, previous.piece.glyphs[0]!.code, p.hit.code) * ref.size * c.scale;
        previous.width += kern;
        previous.piece.width += kern;
      }
      last = {
        ...base,
        at: p.at,
        kind: "glyphs",
        ref,
        v,
        width,
        piece: {
          text: p.text,
          width,
          needsActualText: p.hit.actual,
          glyphs: [{ font: p.hit.font, code: p.hit.code, du: 0, dv: 0, scale: encoder.scaleFor(p.hit.font, ref) }],
        },
      };
      items.push(last);
    }
  }
  // characters of a stacked column are placed one below the other
  return model.stacked ? items : mergeDrawn(items, model, c.full);
}

/** neighbouring runs for the substitute font are shaped together, including the spaces between them */
function mergeDrawn(items: Item[], model: LineModel, full: string): Item[] {
  const levels = model.rtl || hasRtl(full) ? bidi().getEmbeddingLevels(full, model.rtl ? "rtl" : "ltr").levels : null;
  const level = (at: number) => levels?.[at] ?? 0;
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const previous = out[out.length - 1];
    if (previous?.kind === "draw") {
      let j = i;
      while (j < items.length && items[j]!.kind !== "draw" && !full.slice(items[j]!.at, items[j + 1]?.at ?? full.length).trim()) j++;
      const next = items[j];
      if (
        next?.kind === "draw" &&
        level(previous.at) === level(next.at) &&
        !full.slice(previous.at + previous.text.length, next.at).trim()
      ) {
        previous.text = full.slice(previous.at, next.at) + next.text;
        i = j;
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

/* ---------- substitute font drawing ---------- */

/** how writeText's text space (1 unit = 1 visible point) relates to the PDF text space of a glyph */
const textFactor = (ref: Glyph) => ((ref.show.size || 1) * ref.show.font.emScale) / (ref.size || 1);

function drawMatrix(s: Session, ref: Glyph, origin: Point): Matrix {
  const factor = textFactor(ref);
  const ctm = multiply(ref.show.ctm, s.analysis.interp!.pageMatrix);
  const user = apply(invert(ctm), origin);
  const m = ref.tm;
  return [m[0] * factor, m[1] * factor, m[2] * factor, m[3] * factor, user[0], user[1]];
}

function drawRequest(text: string, ref: Glyph, change: Partial<TextStyle>, scale: number, color: RGB | undefined, tracking: number) {
  const own = styleOf(ref);
  const show = ref.show;
  const font = show.font;
  const style: TextStyle = { ...own, ...change, size: ref.size * scale, color: color ?? own.color, underline: false };
  // page units per writeText unit along the baseline
  const unit = ref.unit * Math.abs(textFactor(ref));
  const th = Math.abs(show.th) || 1;
  const spacingPage = change.letterSpacing !== undefined ? change.letterSpacing : (show.tc * th * ref.unit + tracking * ref.size) * scale;
  const request: Omit<WriteTextRequest, "resources" | "matrix"> = {
    text,
    style,
    originalFont: {
      name: font.name,
      bold: font.flags.bold,
      italic: font.flags.italic,
      serif: font.flags.serif,
      mono: font.flags.mono,
      bytes: font.fontFile() ?? undefined,
      widths: letterWidths(font),
    },
    charSpacing: spacingPage / (unit * th),
    wordSpacing: (show.tw * scale) / (textFactor(ref) || 1),
    horizontalScale: th * 100,
    // mode 7 only builds a clipping path; substitute text has to be painted
    renderMode: show.tr === 7 ? 0 : show.tr % 4,
    // inherit the colour operators in force, so the colour space stays exactly the original one
    colorOps: color ? undefined : "",
  };
  return { request, unit };
}

/** the same typeface in the requested weight or slant, if the document already carries it and it can type the text */
async function findVariant(s: Session, model: LineModel, change: Partial<TextStyle>, text: string): Promise<PdfFont | null> {
  if (isComplex(text)) return null;
  const stem = (name: string) => name.replace(/[-,+ ]?(bold|italic|oblique|regular|roman|medium|semibold|light|mt|ps)+/gi, "").toLowerCase();
  const own = model.units.find((u) => u.glyphs.length)!.glyphs[0]!.show.font;
  const bold = change.bold ?? own.flags.bold;
  const italic = change.italic ?? own.flags.italic;
  const seen = new Set<PdfFont>();
  for (const g of s.analysis.interp!.glyphs) {
    const f = g.show.font;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f === own || stem(f.name) !== stem(own.name) || f.flags.bold !== bold || f.flags.italic !== italic) continue;
    let all = true;
    for (const ch of new Set(text.replace(/\s/g, ""))) {
      if (!(await s.encoder.encode(ch, f))) {
        all = false;
        break;
      }
    }
    if (all) return f;
  }
  return null;
}

/** how wide the font sets letters and figures, as far as its character map knows them */
function letterWidths(font: PdfFont): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of METRIC_LETTERS) {
    const code = font.codesFor(c)[0];
    if (code && font.hasExplicitWidth(code)) out[c] = font.width(code);
  }
  return out;
}

/** the font behind a "doc:" choice, preferably as this page already uses it */
function pickedFont(s: Session, choice: string): PdfFont | null {
  const object = Number(choice.slice(DOCUMENT_CHOICE.length));
  const used = s.analysis.interp?.glyphs.find((g) => g.show.font.obj.isIndirect() && g.show.font.obj.asIndirect() === object);
  return used?.show.font ?? documentFont(s.ctx, choice);
}

/* ---------- underline and strike-through ---------- */

function removeRule(rewriter: Rewriter, rule: Rule) {
  rewriter.replaceOp(rule.decoration.node, rule.decoration.paint, "n");
}

function redrawRule(
  rewriter: Rewriter,
  model: LineModel,
  rule: Rule,
  from: number,
  to: number,
  lineV: (v: number) => number,
  scale: number,
  color: RGB | undefined,
) {
  const d = rule.decoration;
  const inverse = invert(d.matrix);
  const centre = lineV((toFrame(d.a, model.ex, model.ey)[1] + toFrame(d.b, model.ex, model.ey)[1]) / 2);
  const point = (u: number, v: number) => apply(inverse, fromFrame(u, v, model.ex, model.ey)).map(num).join(" ");
  const half = (d.thickness * scale) / 2;
  const path = d.stroked
    ? `${point(from, centre)} m ${point(to, centre)} l`
    : `${point(from, centre - half)} m ${point(to, centre - half)} l ${point(to, centre + half)} l ${point(from, centre + half)} l h`;
  for (let i = d.first; i < d.paint; i++) rewriter.replaceOp(d.node, i, i === d.first ? path : " ");
  if (color) {
    const c = color.map(num).join(" ");
    rewriter.insertBefore(d.node, d.first, `q ${c} rg ${c} RG`);
    rewriter.insertAfter(d.node, d.paint, "Q");
  }
}

function drawUnderline(
  s: Session,
  model: LineModel,
  anchor: Glyph,
  from: number,
  to: number,
  baseline: number,
  size: number,
  color: RGB | undefined,
) {
  const show = anchor.show;
  const inverse = invert(multiply(show.ctm, s.analysis.interp!.pageMatrix));
  const point = (u: number, v: number) => apply(inverse, fromFrame(u, v, model.ex, model.ey)).map(num).join(" ");
  const top = baseline + 0.09 * size;
  const bottom = top + Math.max(0.35, 0.062 * size);
  const fill = color ? `${color.map(num).join(" ")} rg` : [show.fill.spaceOp, show.fill.colorOp].filter(Boolean).join(" ");
  s.rewriter.draw(show, `q ${fill} ${point(from, top)} m ${point(to, top)} l ${point(to, bottom)} l ${point(from, bottom)} l h f Q`);
}
