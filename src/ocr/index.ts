/** Main-thread OCR (tesseract.js, runs fully in the browser). Owner: OCR module. */
import type { OcrLanguage, OcrPageResult, OcrProgress, RenderedPage } from "../engine/types";

export const OCR_LANGUAGES: OcrLanguage[] = [];

export interface RecognizeOptions {
  /** tesseract codes; empty = detect automatically */
  languages: string[];
  /** pixels per point used to render `image` (to convert boxes to page space) */
  scale: number;
  onProgress?: (p: OcrProgress) => void;
  signal?: AbortSignal;
}

/** recommended render scale for recognition */
export const OCR_SCALE = 300 / 72;

export async function recognizePage(image: RenderedPage, options: RecognizeOptions): Promise<OcrPageResult> {
  throw new Error("ocr.recognizePage not implemented");
}

export async function terminateOcr(): Promise<void> {}
