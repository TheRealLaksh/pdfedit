/** Added objects, existing images, forms, page tools, redaction, stamps and export. Owner: OPS module. */
import type { EngineContext, ModuleChange } from "../context";
import type {
  ExportOptions, FormField, ImageItem, NewPageObject, PageNumberOptions, PageObject, Rect, WatermarkOptions,
} from "../types";

const todo = (name: string): never => {
  throw new Error(`ops.${name} not implemented`);
};

export function listObjects(ctx: EngineContext, page: number): PageObject[] { return todo("listObjects"); }
export async function addObject(ctx: EngineContext, object: NewPageObject): Promise<ModuleChange> { return todo("addObject"); }
export async function updateObject(ctx: EngineContext, object: PageObject): Promise<ModuleChange> { return todo("updateObject"); }
export async function removeObject(ctx: EngineContext, id: string): Promise<ModuleChange> { return todo("removeObject"); }

export function listImages(ctx: EngineContext, page: number): ImageItem[] { return todo("listImages"); }
export async function moveImage(ctx: EngineContext, page: number, id: string, rect: Rect): Promise<ModuleChange> { return todo("moveImage"); }
export async function deleteImage(ctx: EngineContext, page: number, id: string): Promise<ModuleChange> { return todo("deleteImage"); }
export async function replaceImage(ctx: EngineContext, page: number, id: string, data: Uint8Array): Promise<ModuleChange> { return todo("replaceImage"); }

export function listFormFields(ctx: EngineContext): FormField[] { return todo("listFormFields"); }
export async function setFormField(ctx: EngineContext, page: number, id: string, value: string | boolean): Promise<ModuleChange> { return todo("setFormField"); }

export async function rotatePages(ctx: EngineContext, pages: number[], degrees: 90 | 180 | 270): Promise<ModuleChange> { return todo("rotatePages"); }
export async function deletePages(ctx: EngineContext, pages: number[]): Promise<ModuleChange> { return todo("deletePages"); }
export async function reorderPages(ctx: EngineContext, order: number[]): Promise<ModuleChange> { return todo("reorderPages"); }
export async function duplicatePage(ctx: EngineContext, page: number): Promise<ModuleChange> { return todo("duplicatePage"); }
export async function insertBlankPage(ctx: EngineContext, at: number, width: number, height: number): Promise<ModuleChange> { return todo("insertBlankPage"); }
export async function insertPdf(ctx: EngineContext, bytes: Uint8Array, at: number, password?: string): Promise<ModuleChange> { return todo("insertPdf"); }
export async function insertImagesAsPages(ctx: EngineContext, images: Uint8Array[], at: number): Promise<ModuleChange> { return todo("insertImagesAsPages"); }
export function extractPages(ctx: EngineContext, pages: number[]): Uint8Array { return todo("extractPages"); }
export function splitDocument(ctx: EngineContext, ranges: number[][]): Uint8Array[] { return todo("splitDocument"); }

export async function redactAreas(ctx: EngineContext, page: number, rects: Rect[]): Promise<ModuleChange> { return todo("redactAreas"); }
export async function addWatermark(ctx: EngineContext, options: WatermarkOptions): Promise<ModuleChange> { return todo("addWatermark"); }
export async function addPageNumbers(ctx: EngineContext, options: PageNumberOptions): Promise<ModuleChange> { return todo("addPageNumbers"); }

export async function exportPdf(ctx: EngineContext, options?: ExportOptions): Promise<Uint8Array> { return todo("exportPdf"); }
export function exportPageImage(ctx: EngineContext, page: number, dpi: number, format: "png" | "jpeg"): Uint8Array { return todo("exportPageImage"); }
export function exportText(ctx: EngineContext, pages?: number[]): string { return todo("exportText"); }
