/**
 * What the page content cannot say after an edit. Longer text can reach the next column, and nothing in
 * the content then says that the two are separate: without this the next tap would get both in one box.
 * Alignment is read from the neighbours, which an edit changes: a line keeps the alignment it had.
 * Kept in the document state, so it follows undo and redo.
 */
import type { EngineContext } from "../context";
import type { Align, Point } from "../types";
import { fromFrame, type LineModel, type LineStart } from "./layout";

/** where a rewritten line now begins and ends on the page; null when it was deleted */
export type Placed = { start: Point; end: Point; align: Align } | null;

type Aligns = Record<string, [x: number, y: number, align: Align][]>;

type Stored = Record<string, LineStart[]>;

/** the page, whatever its number becomes; turning it moves everything, so what was noted no longer holds */
const key = (ctx: EngineContext, page: number) => {
  const object = ctx.doc.findPage(page);
  const rotate = object.getInheritable("Rotate");
  return `${object.asIndirect()}/${rotate.isNumber() ? rotate.asNumber() : 0}`;
};
const stored = (ctx: EngineContext) => ctx.state.extra.textStarts as Stored | undefined;
/** no sensible page has more lines than this; the rest go unrecorded */
const LIMIT = 4000;

export function lineStarts(ctx: EngineContext, page: number): LineStart[] {
  const all = stored(ctx);
  return (all && all[key(ctx, page)]) || [];
}

/** gives the lines the alignment they had before the page was last edited */
export function keepAlignment(ctx: EngineContext, page: number, models: LineModel[]): void {
  const list = (ctx.state.extra.textAligns as Aligns | undefined)?.[key(ctx, page)];
  if (!list) return;
  const near = new Map<number, Aligns[number]>();
  for (const entry of list) {
    const k = Math.round(entry[1]);
    let row = near.get(k);
    if (!row) near.set(k, (row = []));
    row.push(entry);
  }
  for (const m of models) {
    const [x, y] = m.line.origin;
    for (const d of [0, -1, 1]) {
      const found = near.get(Math.round(y) + d)?.find((e) => Math.abs(e[0] - x) < 0.3 && Math.abs(e[1] - y) < 0.3);
      if (!found) continue;
      m.line.align = found[2];
      break;
    }
  }
}

/**
 * Records the page as it was grouped just before an edit, with the edited lines as they are now. Every
 * line is kept, not only the neighbours: how lines are told apart depends on the lines around them
 * (columns, justified paragraphs, borders), so changing one must not regroup the others.
 */
export function rememberLines(ctx: EngineContext, page: number, models: LineModel[], placed: Map<LineModel, Placed>): void {
  if (!placed.size) return;
  const starts: LineStart[] = [];
  const aligns: Aligns[number] = [];
  for (const m of models) {
    const now = placed.get(m);
    if (now === null || starts.length >= LIMIT) continue;
    if (now) {
      starts.push([now.start[0], now.start[1], "", now.end[0], now.end[1], m.rtl]);
      aligns.push([now.start[0], now.start[1], now.align]);
      continue;
    }
    aligns.push([m.line.origin[0], m.line.origin[1], m.line.align]);
    const g = m.visual.find((u) => u.glyphs.length)?.glyphs[0];
    // stacked columns and stepping scripts are told apart by their own rules, and a hidden text layer lies
    // across the visible text without saying anything about it
    if (!g || m.stacked || m.cascade || m.line.id.endsWith(".h")) continue;
    const end = fromFrame(m.u1, m.baseline, m.ex, m.ey);
    starts.push([g.origin[0], g.origin[1], [...g.unicode][0] ?? "", end[0], end[1], m.rtl]);
  }
  ctx.state.extra.textStarts = { ...stored(ctx), [key(ctx, page)]: starts };
  ctx.state.extra.textAligns = { ...(ctx.state.extra.textAligns as Aligns | undefined), [key(ctx, page)]: aligns };
}
