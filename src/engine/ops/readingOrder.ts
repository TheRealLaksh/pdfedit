/** Arrange text lines in reading order: columns one after the other, table rows left to right. */
import { rectFromPoints } from "../geom";
import type { Point, Quad, Rect } from "../types";

export interface Fragment {
  text: string;
  rect: Rect;
  dir: "ltr" | "rtl";
}

const height = (f: Fragment) => f.rect[3] - f.rect[1];
const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;

/** widest empty band along one axis (0 = x, 1 = y) */
function widestGap(items: Fragment[], axis: 0 | 1): { size: number; at: number } {
  const spans = items.map((f) => [f.rect[axis], f.rect[axis + 2]!] as const).sort((a, b) => a[0] - b[0]);
  let end = spans[0]![1];
  let best = { size: 0, at: 0 };
  for (const [from, to] of spans) {
    if (from - end > best.size) best = { size: from - end, at: (from + end) / 2 };
    end = Math.max(end, to);
  }
  return best;
}

/** returns output rows */
export function readingOrder(items: Fragment[], depth = 0): string[] {
  if (items.length <= 1) return items.map((f) => f.text);
  const h = median(items.map(height)) || 1;
  const rtl = items.filter((f) => f.dir === "rtl").length * 2 > items.length;

  if (depth < 40) {
    const across = widestGap(items, 0);
    if (across.size > h * 0.9) {
      const left = items.filter((f) => f.rect[2] <= across.at);
      const right = items.filter((f) => f.rect[2] > across.at);
      // two sides of running text are columns; short entries are table cells and read row by row
      const prose = (side: Fragment[]) => side.length >= 2 && median(side.map((f) => f.rect[2] - f.rect[0])) > h * 9;
      if (prose(left) && prose(right)) {
        const [first, second] = rtl ? [right, left] : [left, right];
        return [...readingOrder(first, depth + 1), ...readingOrder(second, depth + 1)];
      }
    }
    const down = widestGap(items, 1);
    if (down.size > h * 0.25) {
      const top = items.filter((f) => f.rect[3] <= down.at);
      const bottom = items.filter((f) => f.rect[3] > down.at);
      if (top.length && bottom.length) return [...readingOrder(top, depth + 1), ...readingOrder(bottom, depth + 1)];
    }
  }

  const middle = (f: Fragment) => (f.rect[1] + f.rect[3]) / 2;
  const rows: Fragment[][] = [];
  for (const item of [...items].sort((a, b) => middle(a) - middle(b))) {
    const row = rows.at(-1);
    if (row && Math.abs(middle(item) - middle(row[0]!)) < Math.min(height(item), height(row[0]!)) * 0.5) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => {
    row.sort((a, b) => (rtl ? b.rect[0] - a.rect[0] : a.rect[0] - b.rect[0]));
    return row
      .map((f, i) => {
        if (!i) return f.text;
        const previous = row[i - 1]!;
        const gap = rtl ? previous.rect[0] - f.rect[2] : f.rect[0] - previous.rect[2];
        return (gap > h * 1.5 ? "\t" : gap > h * 0.15 ? " " : "") + f.text;
      })
      .join("");
  });
}

export interface Directed {
  text: string;
  quad: Quad;
  /** baseline direction, radians, page space (y down) */
  angle: number;
  dir: "ltr" | "rtl";
}

/**
 * Reading order for lines running in any direction: lines are grouped by direction, each group is turned
 * level (so "top" means top for its reader) and ordered. The direction with most text comes first.
 */
export function orderByDirection(lines: Directed[]): string[] {
  const groups: { angle: number; lines: Directed[]; size: number }[] = [];
  for (const line of lines) {
    const apart = (angle: number) => Math.abs(Math.atan2(Math.sin(line.angle - angle), Math.cos(line.angle - angle)));
    let group = groups.find((g) => apart(g.angle) < 0.2);
    if (!group) groups.push((group = { angle: line.angle, lines: [], size: 0 }));
    group.lines.push(line);
    group.size += line.text.length;
  }
  return groups
    .sort((a, b) => b.size - a.size)
    .flatMap(({ angle, lines: members }) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const level = (x: number, y: number): Point => [x * cos + y * sin, y * cos - x * sin];
      return readingOrder(
        members.map(({ text, dir, quad: q }) => ({
          text,
          dir,
          rect: rectFromPoints([level(q[0], q[1]), level(q[2], q[3]), level(q[4], q[5]), level(q[6], q[7])]),
        })),
      );
    });
}
