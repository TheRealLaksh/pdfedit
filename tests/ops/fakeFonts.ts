/** A stand-in for the FONTS module (written separately): Helvetica, one byte per character. */
import * as mupdf from "mupdf";
import { addResource } from "../../src/engine/content/page";
import type { EngineContext } from "../../src/engine/context";
import type { MeasureTextRequest, PlannedText, WriteTextRequest, WrittenText } from "../../src/engine/fonts/types";

const helvetica = new mupdf.Font("Helvetica");
/** every string the engine asked to have drawn */
export const written: string[] = [];

export async function planText(_ctx: EngineContext, r: MeasureTextRequest): Promise<PlannedText> {
  let width = 0;
  for (const ch of r.text) {
    const cp = ch.codePointAt(0)!;
    width += (cp > 255 ? 0.6 : helvetica.advanceGlyph(helvetica.encodeCharacter(cp))) * r.style.size;
    width += (r.charSpacing ?? 0) + (r.style.letterSpacing ?? 0);
    if (ch === " ") width += r.wordSpacing ?? 0;
  }
  return {
    width,
    ascent: 0.92 * r.style.size,
    descent: 0.23 * r.style.size,
    fontsUsed: ["Helvetica"],
    substituted: r.style.family !== "Helvetica",
    missing: [],
  };
}

export async function writeText(ctx: EngineContext, r: WriteTextRequest): Promise<WrittenText> {
  written.push(r.text);
  const dict = ctx.doc.newDictionary();
  dict.put("Type", ctx.doc.newName("Font"));
  dict.put("Subtype", ctx.doc.newName("Type1"));
  dict.put("BaseFont", ctx.doc.newName("Helvetica"));
  dict.put("Encoding", ctx.doc.newName("WinAnsiEncoding"));
  const name = addResource(ctx.doc, r.resources, "Font", "FakeF", ctx.doc.addObject(dict));
  const hex = [...r.text]
    .map((c) => (c.codePointAt(0)! > 255 ? "3f" : c.codePointAt(0)!.toString(16).padStart(2, "0")))
    .join("");
  const color = r.colorOps ?? `${r.style.color.join(" ")} rg`;
  const ops = `q BT /${name} ${r.style.size} Tf ${color} ${(r.charSpacing ?? 0) + (r.style.letterSpacing ?? 0)} Tc ${r.wordSpacing ?? 0} Tw ${r.matrix.join(" ")} Tm <${hex}> Tj ET Q`;
  return { ...(await planText(ctx, r)), ops };
}

export const fake = {
  planText,
  writeText,
  listFonts: () => [],
  addUserFont: () => {
    throw new Error("not in this fake");
  },
  inspectFont: async () => null,
};
