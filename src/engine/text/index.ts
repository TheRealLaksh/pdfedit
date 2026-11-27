/** Existing-text engine: find the text lines of a page and edit them in place. Owner: TEXT module. */
import type { EngineContext, ModuleChange } from "../context";
import type { FindMatch, FindOptions, LineEdit, PageText } from "../types";
import { analyze } from "./analyze";
import { applyEdits } from "./edit";
import { find, replace } from "./search";

export function analyzePage(ctx: EngineContext, page: number): PageText {
  return analyze(ctx, page).text;
}

export async function editLines(ctx: EngineContext, page: number, edits: LineEdit[]): Promise<ModuleChange> {
  return applyEdits(ctx, page, edits);
}

export function findText(ctx: EngineContext, query: string, options?: FindOptions): FindMatch[] {
  return find(ctx, query, options);
}

export async function replaceText(
  ctx: EngineContext,
  query: string,
  replacement: string,
  options?: FindOptions,
  matches?: FindMatch[],
): Promise<ModuleChange> {
  return replace(ctx, query, replacement, options, matches);
}
