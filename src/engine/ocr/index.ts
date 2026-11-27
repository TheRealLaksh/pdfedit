/** Engine side of OCR: turn recognised lines into editable lines and write edits back. Owner: OCR module. */
import type { EngineContext, ModuleChange } from "../context";
import type { LineEdit, OcrPageResult, PageText } from "../types";

/** merge stored OCR results into the lines found in the page content */
export function mergePageText(ctx: EngineContext, base: PageText): PageText {
  return base;
}

export function setOcrResult(ctx: EngineContext, result: OcrPageResult): ModuleChange {
  throw new Error("ocr.setOcrResult not implemented");
}

export async function editOcrLines(ctx: EngineContext, page: number, edits: LineEdit[]): Promise<ModuleChange> {
  throw new Error("ocr.editOcrLines not implemented");
}

export async function makeSearchable(ctx: EngineContext, pages: number[]): Promise<ModuleChange> {
  throw new Error("ocr.makeSearchable not implemented");
}
