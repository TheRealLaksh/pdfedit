/**
 * Chinese, Japanese and Korean fonts in pieces. A whole Noto CJK font is 3 to 7 MB; Fontsource publishes
 * the same fonts (OFL 1.1) cut into about a hundred WOFF files of a few dozen kilobytes each, with the
 * characters of every file listed in its stylesheet. A line only needs the few pieces that hold it.
 */
import type { AssetLoader } from "../context";

const CDN = "https://cdn.jsdelivr.net/npm/@fontsource";
const VERSION = "5.2.8";

export const SLICED = new Set(
  ["sans", "serif"].flatMap((style) => ["sc", "tc", "jp", "kr"].map((region) => `noto-${style}-${region}`)),
);

export interface Slice {
  url: string;
  ranges: [number, number][];
}

/** the stylesheet of a font: which file holds which code points */
export function parseSlices(css: string, base: string): Slice[] {
  const out: Slice[] = [];
  for (const [, rule] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const file = /url\(\s*['"]?\.\/([^'")]+\.woff)['"]?\s*\)/.exec(rule!)?.[1];
    const list = /unicode-range\s*:\s*([^;}]+)/i.exec(rule!)?.[1];
    if (!file || !list) continue;
    const ranges: [number, number][] = [];
    for (const [, from, to] of list.matchAll(/U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?/gi))
      ranges.push([parseInt(from!, 16), parseInt(to ?? from!, 16)]);
    out.push({ url: `${base}/${file}`, ranges });
  }
  return out;
}

const sheets = new WeakMap<AssetLoader, Map<string, Promise<Slice[]>>>();

/** the files needed to draw these code points, or null when the stylesheet cannot be had */
export async function slicesFor(
  assets: AssetLoader,
  key: string,
  bold: boolean,
  codePoints: Iterable<number>,
): Promise<string[] | null> {
  const base = `${CDN}/${key}@${VERSION}`;
  const url = `${base}/${bold ? 700 : 400}.css`;
  let known = sheets.get(assets);
  if (!known) sheets.set(assets, (known = new Map()));
  let sheet = known.get(url);
  if (!sheet) {
    sheet = assets.bytes(url).then((bytes) => parseSlices(new TextDecoder().decode(bytes), base));
    known.set(url, sheet);
    sheet.catch(() => known.delete(url));
  }
  let slices: Slice[];
  try {
    slices = await sheet;
  } catch {
    return null;
  }
  const holds = (s: Slice, cp: number) => s.ranges.some(([from, to]) => cp >= from && cp <= to);
  const wanted: Slice[] = [];
  for (const cp of codePoints) {
    if (wanted.some((s) => holds(s, cp))) continue;
    // later rules win in a stylesheet
    const found = slices.findLast((s) => holds(s, cp));
    if (found) wanted.push(found);
  }
  return wanted.map((s) => s.url);
}
