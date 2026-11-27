/** Find and replace across pages, including recognised (OCR) lines. */
import type { EngineContext, ModuleChange } from "../context";
import * as ocr from "../ocr";
import { intersects, rectToQuad } from "../geom";
import type { FindMatch, FindOptions, LineEdit, Quad, TextLine } from "../types";
import { analyze } from "./analyze";
import { applyEdits } from "./edit";
import { fromFrame, toFrame, type LineModel } from "./layout";

interface Folded {
  text: string;
  /** UTF-16 range in the original for every unit of `text` */
  from: number[];
  to: number[];
}

const IGNORED = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** one canonical form for both the query and the page text, remembering where every character came from */
export function fold(source: string, matchCase: boolean): Folded {
  const out: Folded = { text: "", from: [], to: [] };
  for (const { segment, index } of new Intl.Segmenter().segment(source)) {
    let s = segment.normalize("NFC");
    if (/[\uFB00-\uFDFF\uFE70-\uFEFF\u2E80-\u2FDF\uF900-\uFAFF\uFF00-\uFFEF]/.test(s)) s = s.normalize("NFKC");
    s = s
      .replace(IGNORED, "")
      .replace(/\s+/g, " ")
      .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
      .replace(/[\u201C\u201D\u2033]/g, '"')
      .replace(/[\u2010\u2011]/g, "-");
    if (!matchCase) s = s.toLowerCase().replace(/\u03C2/g, "\u03C3");
    if (s === " " && out.text.endsWith(" ")) {
      out.to[out.to.length - 1] = index + segment.length;
      continue;
    }
    for (let i = 0; i < s.length; i++) {
      out.from.push(index);
      out.to.push(index + segment.length);
    }
    out.text += s;
  }
  return out;
}

const WORD = /[\p{L}\p{M}\p{N}_]/u;

/** [start, end) UTF-16 ranges of `text` that match the query */
export function matchesIn(text: string, query: string, options: FindOptions = {}): [number, number][] {
  const needle = fold(query, !!options.matchCase).text;
  if (!needle) return [];
  const hay = fold(text, !!options.matchCase);
  const first = String.fromCodePoint(needle.codePointAt(0)!);
  const final = [...needle].pop()!;
  const out: [number, number][] = [];
  let last = 0;
  for (let at = hay.text.indexOf(needle); at >= 0; at = hay.text.indexOf(needle, at + 1)) {
    const start = hay.from[at]!;
    const end = hay.to[at + needle.length - 1]!;
    if (start < last) continue;
    if (options.wholeWord) {
      const before = [...hay.text.slice(Math.max(0, at - 2), at)].pop() ?? "";
      const code = hay.text.codePointAt(at + needle.length);
      const after = code === undefined ? "" : String.fromCodePoint(code);
      if ((WORD.test(before) && WORD.test(first)) || (WORD.test(after) && WORD.test(final))) continue;
    }
    out.push([start, end]);
    last = end;
  }
  return out;
}

function quadsFor(line: TextLine, model: LineModel | undefined, start: number, end: number): Quad[] {
  if (!model) {
    // no glyph positions (OCR lines): share the box out by characters
    const r = line.rect;
    const w = r[2] - r[0];
    const n = line.text.length || 1;
    let a = start / n;
    let b = end / n;
    if (line.dir === "rtl") [a, b] = [1 - b, 1 - a];
    return [rectToQuad([r[0] + a * w, r[1], r[0] + b * w, r[3]])];
  }
  const corner = (i: number) => toFrame([line.quad[i]!, line.quad[i + 1]!], model.ex, model.ey)[1];
  const top = corner(0);
  const bottom = corner(4);
  const pieces: { vis: number; a: number; b: number }[] = [];
  for (const u of model.units) {
    if (u.end <= start || u.start >= end) continue;
    const n = u.end - u.start || 1;
    let a = Math.max(0, start - u.start) / n;
    let b = Math.min(n, end - u.start) / n;
    if (model.rtl) [a, b] = [1 - b, 1 - a];
    const w = u.u1 - u.u0;
    pieces.push({ vis: u.vis, a: u.u0 + a * w, b: u.u0 + b * w });
  }
  pieces.sort((x, y) => x.vis - y.vis);
  // text that is not visually contiguous (mixed directions) gets one box per stretch
  const runs: { vis: number; a: number; b: number }[] = [];
  for (const p of pieces) {
    const run = runs[runs.length - 1];
    if (run && p.vis === run.vis + 1) {
      run.vis = p.vis;
      run.a = Math.min(run.a, p.a);
      run.b = Math.max(run.b, p.b);
    } else runs.push({ ...p });
  }
  return runs.map(
    (r) =>
      [
        ...fromFrame(r.a, top, model.ex, model.ey),
        ...fromFrame(r.b, top, model.ex, model.ey),
        ...fromFrame(r.a, bottom, model.ex, model.ey),
        ...fromFrame(r.b, bottom, model.ex, model.ey),
      ] as Quad,
  );
}

function linesOfPage(ctx: EngineContext, page: number) {
  const analysis = analyze(ctx, page);
  let lines = analysis.text.lines;
  try {
    lines = ocr.mergePageText(ctx, analysis.text).lines;
  } catch {
    // recognised text is optional
  }
  const recognised = lines.filter((l) => l.source === "ocr");
  // the hidden layer of a scan duplicates what OCR found
  if (recognised.length) lines = lines.filter((l) => l.source === "ocr" || l.editable || !recognised.some((o) => intersects(o.rect, l.rect)));
  return { lines, models: new Map(analysis.models.map((m) => [m.line.id, m])) };
}

export function find(ctx: EngineContext, query: string, options: FindOptions = {}): FindMatch[] {
  const out: FindMatch[] = [];
  if (!query) return out;
  const count = ctx.doc.countPages();
  const pages = options.pages ?? Array.from({ length: count }, (_, i) => i);
  for (const page of pages) {
    if (page < 0 || page >= count) continue;
    const cached = ctx.cache.has(`text:${page}`);
    const { lines, models } = linesOfPage(ctx, page);
    for (const line of lines) {
      for (const [start, end] of matchesIn(line.text, query, options))
        out.push({
          page,
          lineId: line.id,
          start,
          end,
          quads: quadsFor(line, models.get(line.id), start, end),
          context: line.text.slice(Math.max(0, start - 30), end + 30),
        });
    }
    // long documents would otherwise keep every page's glyphs in memory
    if (!cached && count > 40) ctx.cache.delete(`text:${page}`);
  }
  return out;
}

export async function replace(
  ctx: EngineContext,
  query: string,
  replacement: string,
  options: FindOptions = {},
  matches?: FindMatch[],
): Promise<ModuleChange> {
  const list = matches ?? find(ctx, query, options);
  const pages = new Map<number, Map<string, FindMatch[]>>();
  for (const m of list) {
    let lines = pages.get(m.page);
    if (!lines) pages.set(m.page, (lines = new Map()));
    let group = lines.get(m.lineId);
    if (!group) lines.set(m.lineId, (group = []));
    group.push(m);
  }
  const changed: number[] = [];
  const warnings: string[] = [];
  const fallbackFonts: string[] = [];
  let count = 0;
  let skipped = 0;
  for (const [page, byLine] of [...pages].sort((a, b) => a[0] - b[0])) {
    const { lines } = linesOfPage(ctx, page);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const content: LineEdit[] = [];
    const recognised: LineEdit[] = [];
    for (const [lineId, group] of byLine) {
      const line = byId.get(lineId);
      if (!line || !line.editable) {
        skipped += group.length;
        continue;
      }
      let text = line.text;
      let limit = text.length;
      for (const m of group.slice().sort((a, b) => b.start - a.start)) {
        if (m.end > limit || m.start < 0 || m.start >= m.end) continue;
        text = text.slice(0, m.start) + replacement + text.slice(m.end);
        limit = m.start;
        count++;
      }
      if (text !== line.text) (line.source === "ocr" ? recognised : content).push({ lineId, text });
    }
    const results: ModuleChange[] = [];
    if (content.length) results.push(await applyEdits(ctx, page, content));
    if (recognised.length) results.push(await ocr.editOcrLines(ctx, page, recognised));
    ctx.cache.delete(`text:${page}`);
    for (const r of results) {
      changed.push(...r.changedPages);
      warnings.push(...(r.warnings ?? []));
      fallbackFonts.push(...(r.fallbackFonts ?? []));
    }
    if (pages.size > 40) await new Promise((resolve) => setTimeout(resolve));
  }
  if (skipped) warnings.push(`${skipped} match${skipped === 1 ? "" : "es"} could not be replaced because the text there is not editable.`);
  return {
    changedPages: [...new Set(changed)],
    warnings: [...new Set(warnings)],
    fallbackFonts: [...new Set(fallbackFonts)],
    count,
  };
}
