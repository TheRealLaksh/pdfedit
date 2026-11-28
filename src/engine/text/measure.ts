/** How wide an edit would come out and how much room it has, without touching the document. */
import type { EngineContext } from "../context";
import { planText } from "../fonts";
import type { MeasureTextRequest } from "../fonts/types";
import type { LineEdit, LineMeasure, PageText, Point, TextLine } from "../types";
import { analyze } from "./analyze";
import { mainFont, standIn } from "./lineFont";

/** fonts that still have to be downloaded are not waited for: an estimate is given meanwhile */
const PATIENCE = 150;

const lengthOf = (line: TextLine) => Math.hypot(line.quad[2] - line.quad[0], line.quad[3] - line.quad[1]);

/** free length along the line's direction, to either side of where it is now */
function room(line: TextLine, others: TextLine[], size: [number, number]): { before: number; after: number } {
  const ex: Point = [Math.cos(line.angle), Math.sin(line.angle)];
  const along = (x: number, y: number) => (x - line.origin[0]) * ex[0] + (y - line.origin[1]) * ex[1];
  const across = (x: number, y: number) => -(x - line.origin[0]) * ex[1] + (y - line.origin[1]) * ex[0];
  const width = lengthOf(line);
  const height = line.style.size;
  // the page edge, keeping a small margin
  const edge = (direction: 1 | -1) => {
    const from: Point = direction > 0 ? [line.origin[0] + ex[0] * width, line.origin[1] + ex[1] * width] : line.origin;
    let free = Infinity;
    for (const axis of [0, 1] as const) {
      const step = ex[axis] * direction;
      if (Math.abs(step) < 1e-6) continue;
      const wall = step > 0 ? size[axis] - 6 : 6;
      free = Math.min(free, (wall - from[axis]) / step);
    }
    return Math.max(0, Number.isFinite(free) ? free : 0);
  };
  let after = edge(1);
  let before = edge(-1);
  for (const o of others) {
    if (o.id === line.id || Math.abs(o.angle - line.angle) > 0.05) continue;
    const corners = [0, 2, 4, 6].map((i) => [along(o.quad[i]!, o.quad[i + 1]!), across(o.quad[i]!, o.quad[i + 1]!)] as const);
    const top = Math.min(...corners.map((c) => c[1]));
    const bottom = Math.max(...corners.map((c) => c[1]));
    // on the same row: its letters share more than a sliver of this line's height
    if (Math.min(bottom, 0.1 * height) - Math.max(top, -0.7 * height) < 0.3 * height) continue;
    const from = Math.min(...corners.map((c) => c[0]));
    const to = Math.max(...corners.map((c) => c[0]));
    const gap = 0.25 * height;
    if (from >= width - gap) after = Math.min(after, Math.max(0, from - width - gap));
    else if (to <= gap) before = Math.min(before, Math.max(0, -to - gap));
  }
  return { before, after };
}

export async function measureLine(
  ctx: EngineContext,
  page: PageText,
  pageSize: [number, number],
  edit: LineEdit,
): Promise<LineMeasure> {
  const line = page.lines.find((l) => l.id === edit.lineId);
  if (!line) throw new Error("That line is no longer on the page. Tap it again and repeat the change.");
  const model = line.source === "content" ? analyze(ctx, page.page).models.find((m) => m.line.id === line.id) : undefined;
  const font = model ? mainFont(model) : null;
  const originalFont = font ? { name: font.name, ...font.flags, bytes: font.fontFile() ?? undefined } : undefined;
  const originalWidth = lengthOf(line);
  const change = edit.style ?? {};
  const text = edit.text.replace(/[\r\n\t]+/g, " ").normalize("NFC");
  const before: MeasureTextRequest = { text: line.text, style: { ...line.style, underline: false }, originalFont };
  const after: MeasureTextRequest = { text, style: { ...line.style, ...change, underline: false }, originalFont };
  const resized = (change.size ?? line.style.size) / line.style.size;

  const key = `measure:${page.page}:${line.id}`;
  let old = ctx.cache.get(key) as Promise<number> | undefined;
  if (!old) {
    old = planText(ctx, before).then((p) => p.width);
    ctx.cache.set(key, old);
    old.catch(() => ctx.cache.delete(key));
  }
  const planned = Promise.all([old, planText(ctx, after)]).then(([was, now]) =>
    was > 0 ? (originalWidth * now.width) / was : now.width,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exact = await Promise.race([
    planned.catch(() => null),
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), PATIENCE))),
  ]);
  clearTimeout(timer);
  // asking also starts the download of whatever the new characters need
  if (exact === null && font) standIn(ctx, { ...line, text }, font);
  const count = (s: string) => [...s].length;
  let width = text.trim() ? (exact ?? originalWidth * (count(text) / Math.max(1, count(line.text))) * resized) : 0;

  const free = room(line, page.lines, pageSize);
  const align = edit.align ?? line.align;
  const available =
    align === "justify"
      ? originalWidth
      : align === "right"
        ? originalWidth + free.before
        : align === "center"
          ? originalWidth + 2 * Math.min(free.before, free.after)
          : originalWidth + free.after;
  const fitSize = Math.round((change.size ?? line.style.size) * Math.min(1, originalWidth / Math.max(0.1, width)) * 10) / 10;
  if (edit.fit === "shrink") width = Math.min(width, originalWidth);
  const overflow = width > available + 0.5 ? "collides" : width > originalWidth * 1.02 + 0.5 ? "longer" : "none";
  return { width, originalWidth, maxWidth: available, overflow, fitSize, estimated: exact === null && !!text.trim() };
}
