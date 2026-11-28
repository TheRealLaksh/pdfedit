/**
 * A stand in for a font whose name says nothing: the catalog face whose letters have the most similar
 * widths. Words typed in it then take the room the originals would.
 */
import { METRICS } from "./metrics.data";

export const METRIC_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** letters needed before widths say anything about a typeface */
const ENOUGH = 14;
/** mean difference of letter widths that still counts as a likeness */
const CLOSE = 0.045;

/**
 * `widths`: advance of letters and figures as the document sets them, fractions of the em.
 * Returns a catalog key, or null when nothing is close enough.
 */
export function closestByMetrics(
  widths: Record<string, number>,
  want: { serif: boolean; mono: boolean; bold: boolean },
): string | null {
  const have = [...METRIC_LETTERS].flatMap((c, i) => ((widths[c] ?? 0) > 0.05 ? [[i, widths[c]! * 1000] as const] : []));
  if (have.length < ENOUGH || want.mono) return null;
  let best: string | null = null;
  let score = CLOSE;
  for (const [key, kind, regular, bold] of METRICS) {
    if (kind === "m") continue;
    const table = (want.bold && bold ? bold : regular).split(" ").map(Number);
    const ratios = have.map(([i, w]) => table[i]! / w).sort((a, b) => a - b);
    const scale = ratios[ratios.length >> 1]!;
    const spread = ratios.reduce((sum, r) => sum + Math.abs(r / scale - 1), 0) / ratios.length;
    // overall width matters too, and a serif face should keep its serifs
    const total = spread + Math.abs(scale - 1) * 0.3 + ((kind === "s") === want.serif ? 0 : 0.025);
    if (total < score) {
      score = total;
      best = key;
    }
  }
  return best;
}
