/** The fonts a document carries, offered as font choices ("doc:<object number>"). */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { SCRIPTS } from "../fonts/scripts";
import type { FontChoice } from "../types";
import { nameOf, PdfFont } from "./pdffont";

/** pages looked through for fonts: later pages almost always reuse the same ones */
const MOST_PAGES = 300;
const MOST_FONTS = 80;

export const DOCUMENT_CHOICE = "doc:";

interface Found {
  object: number;
  name: string;
  /** length of the font program: of several subsets the largest is offered */
  size: number;
}

/** the font program stream of a font dictionary, if it has one a browser or the engine can reuse */
function program(font: MuPDF.PDFObject): MuPDF.PDFObject | null {
  const subtype = nameOf(font.get("Subtype"));
  let owner = font;
  if (subtype === "Type0") {
    const list = font.get("DescendantFonts");
    if (!list.isArray()) return null;
    owner = list.get(0);
  } else if (subtype !== "TrueType" && subtype !== "Type1" && subtype !== "MMType1") return null;
  const descriptor = owner.get("FontDescriptor");
  if (descriptor.isNull()) return null;
  // Type 1 programs (FontFile) cannot be turned into a browser font
  for (const key of ["FontFile2", "FontFile3"]) {
    const stream = descriptor.get(key);
    if (stream.isStream()) return stream;
  }
  return null;
}

function search(ctx: EngineContext): Found[] {
  const doc = ctx.doc;
  // fonts this editor embedded itself are already in the list under their own names
  const own = new Set(Object.values((ctx.state.extra.fonts ?? {}) as Record<string, { type0: number }>).map((r) => r.type0));
  const byName = new Map<string, Found>();
  const seen = new Set<number>();
  let forms = 2000;

  const visit = (resources: MuPDF.PDFObject, depth: number) => {
    if (!resources.isDictionary() || depth > 8) return;
    const fonts = resources.get("Font");
    if (fonts.isDictionary())
      fonts.forEach((font) => {
        if (!font.isIndirect() || byName.size >= MOST_FONTS) return;
        const object = font.asIndirect();
        if (seen.has(object) || own.has(object)) return;
        seen.add(object);
        const stream = program(font);
        if (!stream) return;
        const name = nameOf(font.get("BaseFont")).replace(/^[A-Z]{6}\+/, "");
        if (!name) return;
        const length = stream.get("Length");
        const size = length.isNumber() ? length.asNumber() : 0;
        const before = byName.get(name);
        if (!before || size > before.size) byName.set(name, { object, name, size });
      });
    const objects = resources.get("XObject");
    if (objects.isDictionary())
      objects.forEach((x) => {
        if (!x.isIndirect() || seen.has(x.asIndirect()) || forms <= 0) return;
        if (nameOf(x.get("Subtype")) !== "Form") return;
        seen.add(x.asIndirect());
        forms--;
        visit(x.get("Resources"), depth + 1);
      });
  };

  const count = Math.min(MOST_PAGES, doc.countPages());
  for (let i = 0; i < count; i++) {
    try {
      visit(doc.findPage(i).getInheritable("Resources"), 0);
    } catch {
      /* a damaged page offers no fonts */
    }
  }
  return [...byName.values()];
}

/** "ABCDEF+TimesNewRomanPS-BoldItalicMT" -> "Times New Roman Bold Italic" */
export function readableName(name: string): string {
  // names some producers give embedded fonts mean nothing to the user
  if (/^(OTS-derived-font|CIDFont\+|[FT]\d+(_\d+)?$|Unknown$)/i.test(name)) return "Document font";
  const spaced = name
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/(PSMT|PS|MT)(?=$|[-,])/g, "")
    .replace(/[-,_+]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\b(Regular|Identity [HV])\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return spaced || name;
}

export function documentFont(ctx: EngineContext, id: string): PdfFont | null {
  const object = Number(id.slice(DOCUMENT_CHOICE.length));
  if (!id.startsWith(DOCUMENT_CHOICE) || !Number.isInteger(object) || object < 1 || object >= ctx.doc.countObjects()) return null;
  const key = `docfont:${object}`;
  let font = ctx.cache.get(key) as PdfFont | null | undefined;
  if (font === undefined) {
    const ref = ctx.doc.newIndirect(object);
    font = ref.isDictionary() && program(ref) ? new PdfFont(ctx.mupdf, ref, key) : null;
    ctx.cache.set(key, font);
  }
  return font;
}

const SCRIPT_TESTS: [string, RegExp][] = SCRIPTS.flatMap((s): [string, RegExp][] => {
  try {
    return [[s.name, new RegExp(`\\p{Script=${s.name}}`, "u")]];
  } catch {
    return [];
  }
});

export function documentChoices(ctx: EngineContext): FontChoice[] {
  const cached = ctx.cache.get("docfonts") as FontChoice[] | undefined;
  if (cached) return cached;
  const out: FontChoice[] = [];
  for (const found of search(ctx)) {
    let font: PdfFont | null = null;
    try {
      font = documentFont(ctx, DOCUMENT_CHOICE + found.object);
    } catch {
      font = null;
    }
    if (!font) continue;
    const letters = new Map<string, number>();
    for (const [, text] of font.described().slice(0, 2000)) {
      const script = SCRIPT_TESTS.find(([, re]) => re.test(text))?.[0];
      if (script) letters.set(script, (letters.get(script) ?? 0) + 1);
    }
    const scripts = [...letters].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    out.push({
      id: DOCUMENT_CHOICE + found.object,
      family: readableName(found.name),
      scripts: scripts.length ? scripts : ["Latin"],
      category: font.flags.mono ? "mono" : font.flags.serif ? "serif" : "sans",
      source: "document",
    });
  }
  out.sort((a, b) => a.family.localeCompare(b.family));
  ctx.cache.set("docfonts", out);
  return out;
}
