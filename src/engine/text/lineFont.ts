/** The font behind one line, for the typing preview. */
import type { EngineContext } from "../context";
import { family } from "../fonts/catalog";
import { createResolver, type Source } from "../fonts/resolve";
import { clusterScript } from "../fonts/scripts";
import type { PreviewFont, TextLine } from "../types";
import { analyze } from "./analyze";
import type { LineModel } from "./layout";
import type { PdfFont } from "./pdffont";
import { buildDocumentFont, type BuiltFont } from "./previewFont";

/** the font most of the line is written in */
export function mainFont(model: LineModel): PdfFont | null {
  const weight = new Map<PdfFont, number>();
  for (const unit of model.units) {
    const font = unit.glyphs[0]?.show.font;
    if (font && unit.text.trim()) weight.set(font, (weight.get(font) ?? 0) + unit.text.length);
  }
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** width of a word gap on this line, as a fraction of the font size */
function wordGap(model: LineModel): number {
  const gaps = model.units
    .filter((u) => !u.text.trim() && u.size > 0)
    .map((u) => (u.u1 - u.u0) / u.size)
    .sort((a, b) => a - b);
  const typical = gaps.length ? gaps[gaps.length >> 1]! : 0;
  return typical > 0.1 && typical < 0.8 ? typical : 0.27;
}

/**
 * The font the engine turns to for characters the document font cannot draw, as a choice id. It is also
 * fetched in the background, so that saving the line does not have to wait for it.
 */
export function standIn(ctx: EngineContext, line: TextLine, font?: PdfFont): string | undefined {
  const resolver = createResolver(ctx, {
    text: line.text,
    style: line.style,
    originalFont: font ? { name: font.name, ...font.flags } : undefined,
  });
  let script = "Latin";
  for (const ch of line.text) {
    const s = clusterScript(ch);
    if (s !== "Common" && s !== "Inherited") {
      script = s;
      if (s !== "Latin") break;
    }
  }
  const covers = (s: Source) => !!s.choice && (!s.choice.startsWith("web:") || family(s.choice.slice(4))!.scripts.includes(script));
  const source = resolver.base.find(covers) ?? resolver.forScript(script)[0] ?? resolver.base.find((s) => s.choice);
  if (!source) return undefined;
  const fetched = source.expand
    ? source.expand(line.text).then((list) => Promise.all(list.slice(0, -1).map((s) => s.load())))
    : source.load();
  void Promise.resolve(fetched).catch(() => null);
  return source.choice;
}

export async function lineFont(ctx: EngineContext, page: number, lineId: string): Promise<PreviewFont | null> {
  if (lineId.startsWith("ocr:")) return null;
  const analysis = analyze(ctx, page);
  const model = analysis.models.find((m) => m.line.id === lineId);
  if (!model || !analysis.interp) return null;
  const font = mainFont(model);
  const fallback = standIn(ctx, model.line, font ?? undefined);
  if (!font) return null;
  const key = `preview:${font.id}`;
  let built = ctx.cache.get(key) as Promise<BuiltFont | null> | undefined;
  if (!built) {
    const drawn = analysis.interp.glyphs.filter((g) => g.show.font === font);
    built = buildDocumentFont(font, drawn, wordGap(model)).catch((e) => {
      console.warn("The document font could not be prepared for typing", e);
      return null;
    });
    ctx.cache.set(key, built);
  }
  const result = await built;
  return result ? { ...result, data: result.data.slice(), fallback } : null;
}
