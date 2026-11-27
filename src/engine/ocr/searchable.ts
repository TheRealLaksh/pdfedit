/** An invisible, selectable text layer laid exactly over the recognised words. */
import type { EngineContext, ModuleChange } from "../context";
import type { Point } from "../types";
import { addForm, setLayer } from "./pdf";
import { editOf, findEntry, mapFrame, pageMeta, pageTransform, type Frame, type LineMeta } from "./state";
import { textLayer } from "./textlayer";

export const SEARCH_LAYER = "PEOcrText";

export async function makeSearchable(ctx: EngineContext, pages: number[]): Promise<ModuleChange> {
  const changedPages: number[] = [];
  const skipped: number[] = [];
  for (const page of [...new Set(pages)].sort((a, b) => a - b)) {
    const exists = page >= 0 && page < ctx.doc.countPages();
    const entry = exists ? findEntry(ctx, page) : undefined;
    if (!entry) {
      // a scan that already carries a hidden text layer needs nothing
      if (!exists || !textPositions(ctx, page).length) skipped.push(page + 1);
      continue;
    }
    const meta = pageMeta(entry);
    // empty an earlier layer first, so that it does not count as text already there
    if (meta.searchLayer) setLayer(ctx, page, addForm(ctx, "", ctx.doc.newDictionary(), SEARCH_LAYER), SEARCH_LAYER, meta.searchLayer);
    const transform = pageTransform(ctx, page);
    const present = textPositions(ctx, page);
    const layer = textLayer(ctx);
    let content = "";
    for (const line of meta.lines) {
      // changed lines already carry real text
      if (editOf(entry, line.id) || line.confidence < 25) continue;
      content += layLine(layer, line, mapFrame(line.frame, transform), present);
    }
    if (!content && !meta.searchLayer) continue;
    const resources = content ? layer.resources() : ctx.doc.newDictionary();
    meta.searchLayer = setLayer(ctx, page, addForm(ctx, content, resources, SEARCH_LAYER), SEARCH_LAYER, meta.searchLayer);
    changedPages.push(page);
  }
  if (!changedPages.length) {
    throw new Error(
      skipped.length ? "Recognise the text on these pages first." : "These pages already have selectable text.",
    );
  }
  const warnings = skipped.length ? [`Not recognised yet, so left unchanged: page ${skipped.join(", ")}.`] : [];
  return { changedPages, warnings };
}

/** the words of one line, with real spaces between them so that copying and searching keep them apart */
function layLine(layer: ReturnType<typeof textLayer>, line: LineMeta, shown: Frame, present: Point[]): string {
  const spaced = spacesAfter(line.text, line.words);
  let out = "";
  line.words.forEach((word, i) => {
    if (word.to - word.from <= 0.2 || !word.text.trim() || covered(present, shown, word.from, word.to)) return;
    out += layer.word(word.text, line.frame, word.from, word.to, spaced[i] && i < line.words.length - 1);
  });
  return out;
}

/** for each word, whether white space follows it in the line (Chinese and the like join words) */
function spacesAfter(text: string, words: { text: string }[]): boolean[] {
  let at = 0;
  const found = words.map((w) => {
    const start = text.indexOf(w.text, at);
    if (start >= 0) at = start + w.text.length;
    return start >= 0 ? at : -1;
  });
  return found.map((end) => end < 0 || /^\s/.test(text.slice(end)));
}

/** centres of the characters already on the page, in page space */
function textPositions(ctx: EngineContext, page: number): Point[] {
  const p = ctx.doc.loadPage(page);
  const text = p.toStructuredText("preserve-whitespace");
  const out: Point[] = [];
  text.walk({
    onChar(c, _origin, _font, _size, q) {
      if (c.trim()) out.push([(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4]);
    },
  });
  text.destroy();
  p.destroy();
  return out;
}

function covered(points: Point[], frame: Frame, from: number, to: number): boolean {
  return points.some((p) => {
    const x = p[0] - frame.o[0];
    const y = p[1] - frame.o[1];
    const along = x * frame.u.x + y * frame.u.y;
    const above = x * frame.up.x + y * frame.up.y;
    return along >= from && along <= to && above >= -frame.desc && above <= frame.asc;
  });
}
