/** Font matching, shaping (HarfBuzz), embedding and drawing new text. Owner: FONTS module. */
import { addResource } from "../content/page";
import type { EngineContext } from "../context";
import type { FontChoice } from "../types";
import { catalogChoices } from "./catalog";
import { buildOps, type FontUse } from "./draw";
import { embeddedFont } from "./embed";
import { layoutText, type Layout } from "./layout";
import type { MeasureTextRequest, PlannedText, WriteTextRequest, WrittenText } from "./types";
import { listUserFonts, registerUserFont } from "./user";

export * from "./types";
export { inspectFont } from "./inspect";
export { LOOKALIKE } from "./layout";

export function listFonts(ctx: EngineContext): FontChoice[] {
  return [...listUserFonts(ctx), ...catalogChoices()];
}

export function addUserFont(ctx: EngineContext, name: string, bytes: Uint8Array): FontChoice {
  return registerUserFont(ctx, name, bytes);
}

const planned = (l: Layout): PlannedText => ({
  width: l.width,
  ascent: l.ascent,
  descent: l.descent,
  fontsUsed: l.fontsUsed,
  substituted: l.substituted,
  missing: l.missing,
});

/** measure without touching the document */
export async function planText(ctx: EngineContext, request: MeasureTextRequest): Promise<PlannedText> {
  return planned(await layoutText(ctx, request));
}

/**
 * MuPDF keeps loaded fonts in its store and does not notice that a font object changed, so after the
 * embedded fonts grow (or shrink again through undo / redo) the store must be dropped, or new glyphs
 * render as blanks. The engine clears ctx.cache after every mutation, undo and redo: follow that.
 */
const watched = new WeakSet<Map<string, unknown>>();
function dropStaleFonts(ctx: EngineContext): void {
  if (watched.has(ctx.cache)) return;
  watched.add(ctx.cache);
  const clear = ctx.cache.clear;
  ctx.cache.clear = () => {
    clear.call(ctx.cache);
    ctx.mupdf.emptyStore();
  };
}

/** one write at a time per document: they grow the same embedded fonts */
const queues = new WeakMap<object, Promise<unknown>>();

/** embed whatever is needed and return the operators */
export async function writeText(ctx: EngineContext, request: WriteTextRequest): Promise<WrittenText> {
  const layout = await layoutText(ctx, request);
  const previous = queues.get(ctx.doc) ?? Promise.resolve();
  const job = previous.then(async () => {
    const fonts = new Map<string, FontUse>();
    for (const { source, face } of layout.glyphs) {
      if (fonts.has(source.key)) continue;
      const font = embeddedFont(ctx, source, face);
      fonts.set(source.key, { font, resource: addResource(ctx.doc, request.resources, "Font", "PEF", font.object) });
    }
    const ops = buildOps(request, layout, fonts);
    let changed = false;
    for (const { font } of fonts.values()) changed = (await font.flush()) || changed;
    if (changed) {
      dropStaleFonts(ctx);
      ctx.mupdf.emptyStore();
    }
    return ops;
  });
  queues.set(
    ctx.doc,
    job.catch(() => undefined),
  );
  return { ...planned(layout), ops: await job };
}
