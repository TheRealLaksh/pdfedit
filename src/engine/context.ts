/** Everything an engine module needs. Created by the Engine (engine.ts) for the open document. */
import type * as MuPDF from "mupdf";
import type { OcrPageResult, PageObject } from "./types";

/**
 * Mutable per-document state that is NOT inside the PDF but must follow undo/redo.
 * The Engine snapshots it (structuredClone) around every operation, so keep it small and
 * cloneable: no MuPDF handles, no large byte arrays (use ctx.blobs for bytes).
 */
export interface DocState {
  ocr: Record<number, OcrPageState>;
  /** added objects by page-independent id. Page index inside the object. */
  objects: Record<string, PageObject>;
  /** free slot for modules, namespaced by module name */
  extra: Record<string, unknown>;
}

export interface OcrPageState {
  result: OcrPageResult;
  /** text currently shown for edited OCR lines, by line id */
  edits: Record<string, unknown>;
  /** pdf object number of the page, so state survives page reordering */
  pageObject: number;
}

export interface AssetLoader {
  /** fetch a binary asset (font etc.), cached for the life of the engine */
  bytes(url: string): Promise<Uint8Array>;
}

export interface EngineContext {
  mupdf: typeof MuPDF;
  doc: MuPDF.PDFDocument;
  state: DocState;
  /** immutable binary blobs (image data etc.), never removed while the doc is open */
  blobs: Map<string, Uint8Array>;
  /** user-uploaded font files by FontChoice.id; survives opening another document */
  userFonts: Map<string, { name: string; bytes: Uint8Array }>;
  assets: AssetLoader;
  /** scratch cache; cleared after every mutation, undo and redo */
  cache: Map<string, unknown>;
  newId(prefix: string): string;
}

export function emptyState(): DocState {
  return { ocr: {}, objects: {}, extra: {} };
}

/** What a mutating module function reports back. All fields optional except changedPages. */
export interface ModuleChange {
  changedPages: number[];
  warnings?: string[];
  fallbackFonts?: string[];
  createdId?: string;
  count?: number;
}

export function createAssetLoader(fetcher: (url: string) => Promise<Uint8Array> = defaultFetch): AssetLoader {
  const cache = new Map<string, Promise<Uint8Array>>();
  return {
    bytes(url) {
      let p = cache.get(url);
      if (!p) {
        p = fetcher(url);
        cache.set(url, p);
        p.catch(() => cache.delete(url));
      }
      return p;
    },
  };
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}
