/** Loads HarfBuzz (shaping) and harfbuzz-subset (embedding) in the web worker and in node. */
import type * as HB from "harfbuzzjs";

export type HarfBuzz = typeof HB;

let shaping: Promise<HarfBuzz> | null = null;

export function harfbuzz(): Promise<HarfBuzz> {
  shaping ??= import("harfbuzzjs").catch((e) => {
    shaping = null;
    throw e;
  });
  return shaping;
}

interface SubsetExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, length: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_length(blob: number): number;
  hb_blob_get_data(blob: number, length: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_set_clear(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_glyph_set(input: number): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_input_set(input: number, which: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_input_pin_all_axes_to_default(input: number, face: number): number;
  hb_subset_input_pin_axis_location(input: number, face: number, tag: number, value: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

let subsetting: Promise<SubsetExports> | null = null;

async function loadSubsetter(): Promise<SubsetExports> {
  const url = new URL("../../../node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm", import.meta.url);
  let bytes: BufferSource;
  if (url.protocol === "file:") {
    const fs = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fs)) as typeof import("node:fs/promises");
    bytes = new Uint8Array(await readFile(url));
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load the font subsetter (${res.status})`);
    bytes = await res.arrayBuffer();
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as unknown as SubsetExports;
  exports._initialize?.();
  return exports;
}

const RETAIN_GIDS = 0x2;
const NOTDEF_OUTLINE = 0x40;
const NO_HINTING = 0x1;
const NO_LAYOUT_CLOSURE = 0x200;
const DROP_TABLE_TAG = 3;

const tag = (s: string) =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

export interface SubsetRequest {
  glyphs: Iterable<number>;
  /** kept in the cmap so the embedded font stays usable for later edits */
  unicodes: Iterable<number>;
  /** variable fonts: instance at these axis values (others at default) */
  axes?: Record<string, number>;
}

/** A font containing only the requested glyphs, with unchanged glyph ids. */
export async function subsetFont(bytes: Uint8Array, request: SubsetRequest): Promise<Uint8Array> {
  const hb = await (subsetting ??= loadSubsetter().catch((e) => {
    subsetting = null;
    throw e;
  }));
  const data = hb.malloc(bytes.length);
  if (!data) throw new Error("Out of memory while subsetting a font");
  new Uint8Array(hb.memory.buffer).set(bytes, data);
  const blob = hb.hb_blob_create(data, bytes.length, 2, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  try {
    const glyphSet = hb.hb_subset_input_glyph_set(input);
    hb.hb_set_add(glyphSet, 0);
    for (const g of request.glyphs) hb.hb_set_add(glyphSet, g);
    const unicodeSet = hb.hb_subset_input_unicode_set(input);
    for (const u of request.unicodes) hb.hb_set_add(unicodeSet, u);
    const drop = hb.hb_subset_input_set(input, DROP_TABLE_TAG);
    for (const t of ["GSUB", "GPOS", "GDEF", "BASE", "JSTF", "DSIG", "kern", "morx", "mort", "kerx", "STAT", "MATH"])
      hb.hb_set_add(drop, tag(t));
    hb.hb_subset_input_set_flags(input, RETAIN_GIDS | NOTDEF_OUTLINE | NO_HINTING | NO_LAYOUT_CLOSURE);
    if (request.axes) {
      hb.hb_subset_input_pin_all_axes_to_default(input, face);
      for (const [axis, value] of Object.entries(request.axes))
        hb.hb_subset_input_pin_axis_location(input, face, tag(axis), value);
    }
    const result = hb.hb_subset_or_fail(face, input);
    if (!result) throw new Error("This font could not be subset");
    const out = hb.hb_face_reference_blob(result);
    const length = hb.hb_blob_get_length(out);
    const at = hb.hb_blob_get_data(out, 0);
    const copy = new Uint8Array(hb.memory.buffer, at, length).slice();
    hb.hb_blob_destroy(out);
    hb.hb_face_destroy(result);
    if (!length) throw new Error("This font could not be subset");
    return copy;
  } finally {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(data);
  }
}
