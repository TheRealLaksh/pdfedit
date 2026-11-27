/**
 * Stand-in for the FONTS module so that the text engine is tested on its own: draws with the built-in
 * Helvetica (WinAnsi only) and records every request.
 */
import * as mupdf from "mupdf";
import { addResource } from "../../src/engine/content/page";
import type { EngineContext } from "../../src/engine/context";
import type { MeasureTextRequest, PlannedText, WriteTextRequest, WrittenText } from "../../src/engine/fonts/types";

export const calls: WriteTextRequest[] = [];

const metrics = new mupdf.Font("Helvetica");

function plan(r: MeasureTextRequest): PlannedText {
  let width = 0;
  const missing: string[] = [];
  for (const ch of r.text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 255) {
      missing.push(ch);
      width += 0.6 * r.style.size;
    } else width += metrics.advanceGlyph(metrics.encodeCharacter(cp)) * r.style.size;
    width += r.charSpacing ?? 0;
  }
  return {
    width: (width * (r.horizontalScale ?? 100)) / 100,
    ascent: 0.8 * r.style.size,
    descent: 0.2 * r.style.size,
    fontsUsed: ["Helvetica"],
    substituted: true,
    missing,
  };
}

export async function planText(_ctx: EngineContext, r: MeasureTextRequest): Promise<PlannedText> {
  return plan(r);
}

export async function writeText(ctx: EngineContext, r: WriteTextRequest): Promise<WrittenText> {
  calls.push(r);
  const font = ctx.doc.addSimpleFont(metrics, "Latin");
  const name = addResource(ctx.doc, r.resources, "Font", "Mk", font);
  let hex = "";
  for (const ch of r.text) {
    const cp = ch.codePointAt(0)!;
    hex += (cp > 255 ? 63 : cp).toString(16).padStart(2, "0");
  }
  const color = r.colorOps ?? `${r.style.color.join(" ")} rg`;
  const ops = `q ${color} BT /${name} ${r.style.size} Tf ${r.charSpacing ?? 0} Tc ${r.horizontalScale ?? 100} Tz ${r.renderMode ?? 0} Tr ${r.matrix.join(" ")} Tm <${hex}> Tj ET Q`;
  return { ...plan(r), ops };
}

export async function inspectFont() {
  return null;
}

export function listFonts() {
  return [];
}

export function addUserFont() {
  throw new Error("not available in the mock");
}
