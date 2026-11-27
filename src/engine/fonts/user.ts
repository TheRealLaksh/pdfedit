/** Fonts uploaded by the user (TTF / OTF / TTC). Stored in ctx.userFonts as standalone faces. */
import type { EngineContext } from "../context";
import type { FontChoice } from "../types";
import { hashBytes } from "./resolve";
import { SCRIPTS } from "./scripts";
import { cmapRanges, extractFace, faceCount, fontInfo, sfntKind, type FontInfo } from "./sfnt";

export interface UserFace {
  /** FontChoice id */
  id: string;
  name: string;
  hash: string;
  bytes: Uint8Array;
  info: FontInfo;
}

const parsed = new WeakMap<Uint8Array, Omit<UserFace, "id" | "name"> | null>();

export function userFaces(ctx: EngineContext): UserFace[] {
  const out: UserFace[] = [];
  for (const [id, { name, bytes }] of ctx.userFonts) {
    let entry = parsed.get(bytes);
    if (entry === undefined) {
      const info = fontInfo(bytes);
      entry = info ? { bytes, info, hash: hashBytes(bytes) } : null;
      parsed.set(bytes, entry);
    }
    if (entry) out.push({ id, name, ...entry });
  }
  return out;
}

/** scripts a font has a reasonable set of characters for */
function coveredScripts(bytes: Uint8Array): string[] {
  const ranges = cmapRanges(bytes);
  const count = new Map<string, number>();
  const matchers = SCRIPTS.flatMap((s) => {
    try {
      return [[s.name, new RegExp(`\\p{Script=${s.name}}`, "u")] as const];
    } catch {
      return [];
    }
  });
  let budget = 70000;
  for (const [start, end] of ranges) {
    // sampling is enough: scripts occupy contiguous blocks
    const step = Math.max(1, Math.floor((end - start) / 200));
    for (let cp = start; cp <= end && budget > 0; cp += step, budget--) {
      const ch = String.fromCodePoint(cp);
      const found = matchers.find(([, re]) => re.test(ch));
      if (found) count.set(found[0], (count.get(found[0]) ?? 0) + step);
    }
  }
  return [...count].filter(([, n]) => n >= 20).sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

function choiceFor(face: UserFace): FontChoice {
  const info = face.info;
  const style = [info.bold ? "Bold" : "", info.italic ? "Italic" : ""].filter(Boolean).join(" ");
  const base = info.family || face.name.replace(/\.[a-z0-9]+$/i, "");
  return {
    id: face.id,
    family: style ? `${base} ${style}` : base,
    scripts: coveredScripts(face.bytes),
    category: info.mono ? "mono" : info.serif ? "serif" : "sans",
    source: "user",
  };
}

export function listUserFonts(ctx: EngineContext): FontChoice[] {
  return userFaces(ctx).map(choiceFor);
}

export function registerUserFont(ctx: EngineContext, name: string, bytes: Uint8Array): FontChoice {
  const kind = sfntKind(bytes);
  if (kind === "woff") throw new Error("Web fonts (WOFF) are not supported. Please upload the TTF or OTF file.");
  if (!kind) throw new Error("This file is not a TrueType or OpenType font.");
  const added: string[] = [];
  const faces = Math.min(faceCount(bytes), 32);
  for (let i = 0; i < faces; i++) {
    // always copy: the caller may reuse or detach its buffer
    const face = kind === "ttc" ? extractFace(bytes, i) : bytes.slice();
    const info = fontInfo(face);
    if (!info || info.outlines === "none" || info.outlines === "cff2") continue;
    const id = `user:${hashBytes(face)}`;
    if (!ctx.userFonts.has(id)) ctx.userFonts.set(id, { name, bytes: face });
    added.push(id);
  }
  if (!added.length) throw new Error("This font has no outlines that can be put into a PDF (CFF2 and bitmap fonts are not supported).");
  const all = userFaces(ctx).filter((f) => added.includes(f.id));
  const regular = all.find((f) => !f.info.bold && !f.info.italic) ?? all[0]!;
  return choiceFor(regular);
}
