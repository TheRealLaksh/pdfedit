/** Existing-text engine: find the text lines of a page and edit them in place. Owner: TEXT module. */
import type { EngineContext, ModuleChange } from "../context";
import type { FindMatch, FindOptions, LineEdit, PageText } from "../types";

export function analyzePage(ctx: EngineContext, page: number): PageText {
  throw new Error("text.analyzePage not implemented");
}

export async function editLines(ctx: EngineContext, page: number, edits: LineEdit[]): Promise<ModuleChange> {
  throw new Error("text.editLines not implemented");
}

export function findText(ctx: EngineContext, query: string, options?: FindOptions): FindMatch[] {
  throw new Error("text.findText not implemented");
}

export async function replaceText(
  ctx: EngineContext,
  query: string,
  replacement: string,
  options?: FindOptions,
  matches?: FindMatch[],
): Promise<ModuleChange> {
  throw new Error("text.replaceText not implemented");
}
