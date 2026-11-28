/**
 * The fonts the engine will draw with, loaded into the browser so that the typing preview looks like the saved
 * page: the document's own embedded font, or the file behind a picked font. Whatever cannot be loaded falls
 * back to the local stand-ins of `cssFamily`; characters a font lacks fall back to them one by one.
 */
import { useEffect, useState } from "react";
import { engine } from "../../../engine/client";
import type { PreviewFont } from "../../../engine/types";
import { useStore } from "../../../store";

export interface LoadedFont {
  /** CSS font-family list: the registered face, then the one that draws what it lacks */
  css: string;
  /** name shown to the user */
  name: string;
  /** code points the file can draw; undefined = whatever it declares */
  coverage?: ReadonlySet<number>;
}

/** registered faces kept at once: enough for a long picker session without filling memory */
const LIMIT = 60;
const faces = new Map<string, { font: Promise<LoadedFont | null>; face?: FontFace }>();
let counter = 0;

/** "U+20-7E, U+A0": the code points as a CSS unicode-range */
export function unicodeRange(points: readonly number[]): string {
  const sorted = [...new Set(points)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const from = sorted[i]!.toString(16).toUpperCase();
    out.push(j === i ? `U+${from}` : `U+${from}-${sorted[j]!.toString(16).toUpperCase()}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** cheap identity of a font file: many lines share one */
function fingerprint(data: Uint8Array): string {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(data.length / 4096));
  for (let i = 0; i < data.length; i += step) hash = Math.imul(hash ^ data[i]!, 16777619);
  return `${data.length}:${(hash >>> 0).toString(36)}`;
}

async function register(
  source: PreviewFont,
  descriptors: FontFaceDescriptors,
  family: string,
  entry: { face?: FontFace },
): Promise<LoadedFont | null> {
  const coverage = source.coverage?.length ? source.coverage : undefined;
  try {
    const face = new FontFace(family, source.data as Uint8Array<ArrayBuffer>, {
      ...descriptors,
      ...(coverage ? { unicodeRange: unicodeRange(coverage) } : null),
    });
    await face.load();
    document.fonts.add(face);
    entry.face = face;
    return { css: `"${family}"`, name: source.family, coverage: coverage && new Set(coverage) };
  } catch {
    // the browser rejected the file: keep the stand-in
    return null;
  }
}

/** load a font program as a face drawn under exactly this weight and style (no synthetic bold or slant) */
function load(source: PreviewFont, bold: boolean, italic: boolean): Promise<LoadedFont | null> {
  const key = `${fingerprint(source.data)}:${source.coverage?.length ?? 0}:${bold ? 1 : 0}${italic ? 1 : 0}`;
  const known = faces.get(key);
  if (known) {
    // most recently used last
    faces.delete(key);
    faces.set(key, known);
    return known.font;
  }
  const entry = {} as { font: Promise<LoadedFont | null>; face?: FontFace };
  entry.font = register(source, { weight: bold ? "700" : "400", style: italic ? "italic" : "normal" }, `pe-font-${++counter}`, entry);
  faces.set(key, entry);
  if (faces.size > LIMIT) {
    const [oldest, old] = faces.entries().next().value!;
    faces.delete(oldest);
    void old.font.then(() => old.face && document.fonts.delete(old.face));
  }
  return entry.font;
}

const requests = new Map<string, Promise<LoadedFont | null>>();

function request(key: string, fetch: () => Promise<PreviewFont | null>, bold: boolean, italic: boolean) {
  let found = requests.get(key);
  if (!found) {
    found = fetch().then((font) => (font ? load(font, bold, italic) : null));
    found.then(
      // nothing (yet): ask again next time, a download may succeed then
      (font) => !font && requests.delete(key),
      () => requests.delete(key),
    );
    requests.set(key, found);
    if (requests.size > LIMIT * 2) requests.delete(requests.keys().next().value!);
  }
  return found.catch(() => null);
}

/** which font draws the characters a line's own font lacks */
const fallbacks = new Map<string, string>();

/** the document's own font behind a line, followed by the font that draws the characters it lacks */
export function lineFont(page: number, lineId: string, bold: boolean, italic: boolean): Promise<LoadedFont | null> {
  const { session, doc } = useStore.getState();
  const key = `line:${session}:${page}:${doc?.pages[page]?.revision}:${lineId}`;
  const own = request(
    key,
    () =>
      engine.getLineFont(page, lineId).then((font) => {
        if (font?.fallback) fallbacks.set(key, font.fallback);
        return font;
      }),
    bold,
    italic,
  );
  return own.then(async (font) => {
    const choice = fallbacks.get(key);
    const second = font && choice ? await choiceFont(choice, bold, italic) : null;
    return font && second ? { ...font, css: `${font.css}, ${second.css}` } : font;
  });
}

/** the file the engine would draw with for a font choice */
export function choiceFont(choice: string, bold: boolean, italic: boolean): Promise<LoadedFont | null> {
  // ids of uploaded and document fonts belong to one document
  const key = `choice:${useStore.getState().session}:${choice}:${bold ? 1 : 0}${italic ? 1 : 0}`;
  return request(key, () => engine.getChoiceFont(choice, bold, italic), bold, italic);
}

function useLoaded(key: string | null, get: () => Promise<LoadedFont | null>): LoadedFont | null | undefined {
  const [state, setState] = useState<{ key: string; font: LoadedFont | null }>();
  useEffect(() => {
    if (!key) return;
    let live = true;
    void get().then((font) => live && setState({ key, font }));
    return () => {
      live = false;
    };
  }, [key]);
  if (!key) return null;
  // while the next one loads the previous stays: the text must not flash through the stand-in
  return state?.key === key ? state.font : (state?.font ?? undefined);
}

/**
 * The font to preview with. `choice`: a picked font (or "auto:<family>", the stand in the engine would use
 * for it). Otherwise, with `lineId`, the line's own font. undefined = still loading, null = none.
 */
export function usePreviewFont(options: {
  page: number;
  lineId: string | null;
  choice: string | null;
  bold: boolean;
  italic: boolean;
}): LoadedFont | null | undefined {
  const { page, lineId, choice, bold, italic } = options;
  const key = choice ? `c:${choice}:${bold}:${italic}` : lineId ? `l:${page}:${lineId}` : null;
  return useLoaded(key, () => (choice ? choiceFont(choice, bold, italic) : lineFont(page, lineId!, bold, italic)));
}
