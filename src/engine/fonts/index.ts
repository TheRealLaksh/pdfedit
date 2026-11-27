/** Font matching, shaping (HarfBuzz), embedding and drawing new text. Owner: FONTS module. */
import type { EngineContext } from "../context";
import type { FontChoice } from "../types";
import type { FontInspection, MeasureTextRequest, PlannedText, WriteTextRequest, WrittenText } from "./types";

export * from "./types";

export function listFonts(ctx: EngineContext): FontChoice[] {
  throw new Error("fonts.listFonts not implemented");
}

export function addUserFont(ctx: EngineContext, name: string, bytes: Uint8Array): FontChoice {
  throw new Error("fonts.addUserFont not implemented");
}

/** measure without touching the document */
export async function planText(ctx: EngineContext, request: MeasureTextRequest): Promise<PlannedText> {
  throw new Error("fonts.planText not implemented");
}

/** embed whatever is needed and return the operators */
export async function writeText(ctx: EngineContext, request: WriteTextRequest): Promise<WrittenText> {
  throw new Error("fonts.writeText not implemented");
}

/** look inside an embedded font program (TrueType / CFF / OpenType); null if it cannot be parsed */
export async function inspectFont(bytes: Uint8Array): Promise<FontInspection | null> {
  throw new Error("fonts.inspectFont not implemented");
}
