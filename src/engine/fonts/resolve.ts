/** Decides which fonts may draw a piece of text, in order of preference. Fonts load lazily. */
import type { EngineContext } from "../context";
import { family, isStyleOf, matchName, normaliseName, type FontFamily, type Variant } from "./catalog";
import { loadFace, type Face } from "./face";
import { scriptInfo } from "./scripts";
import type { MeasureTextRequest } from "./types";
import { userFaces, type UserFace } from "./user";

export interface Source {
  /** identity of the font program (and instance): one embedded PDF font per key */
  key: string;
  family: string;
  synthBold: boolean;
  synthItalic: boolean;
  /** true when this is not the font that was asked for */
  substituted: boolean;
  /** only usable for complex scripts when it has the shaping tables (subset fonts often do not) */
  needsShapingCheck: boolean;
  /** only draw glyphs that have an outline (embedded subsets keep empty glyphs) */
  needsOutlineCheck: boolean;
  axes?: Record<string, number>;
  load(): Promise<Face | null>;
}

export type Cjk = "sc" | "tc" | "jp" | "kr";

export interface Resolver {
  /** fonts asked for by the request: tried first for every character */
  base: Source[];
  /** the normal font(s) of a script */
  forScript(script: string): Source[];
  /** last resort for a character nothing above can draw */
  fallbacks(codePoint: number): Source[];
  language(script: string): string;
  /** downloads that failed, to explain missing characters */
  errors: string[];
}

const hashes = new WeakMap<Uint8Array, string>();

export function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return `${(h >>> 0).toString(36)}-${bytes.length.toString(36)}`;
}

const documentFaces = new Map<string, Promise<Face | null>>();

/**
 * Faces of the fonts embedded in documents, by content, so callers may pass a fresh copy every time.
 * The bytes are copied: they may be a view into MuPDF's memory.
 */
function documentFace(bytes: Uint8Array): { hash: string; load: () => Promise<Face | null> } {
  let hash = hashes.get(bytes);
  if (!hash) hashes.set(bytes, (hash = hashBytes(bytes)));
  const key = hash;
  let face = documentFaces.get(key);
  if (!face) {
    face = loadFace(bytes.slice());
    documentFaces.set(key, face);
    if (documentFaces.size > 48) documentFaces.delete(documentFaces.keys().next().value!);
  }
  const loaded = face;
  return { hash: key, load: () => loaded };
}

/** characters that exist only in traditional Chinese, enough to recognise a traditional text */
const TRADITIONAL = /[們這個來時為說國學會對發過經還沒與點開關當實現問體機電話車書長門見風馬魚鳥龍齊裡後麼樣讓從應種聽寫讀買賣錢銀鐵頭顯題願類飛飯館馬驗驚髮鬧鬥魯齒龜兩專業東絲嚴喪豐臨麗舉義烏樂喬習鄉亂爭虧雲亞產畝親億僅從侖倉儀價眾優傘偉傳傷倫偽佔餘傭俠侶僥偵側僑儈儕儂俁係臺灣萬與醫藥區華協單賣盧鹵臥衛卻廠廳歷厲壓厭廁廂廈廚]/;
const URDU = /[\u0679\u0688\u0691\u06BA\u06BE\u06C1-\u06C3\u06D2\u06D3]/;

function cjkLanguage(text: string, baseKey: string | undefined): Cjk {
  const hinted = /^noto-(?:sans|serif)-(sc|tc|jp|kr|hk)$/.exec(baseKey ?? "")?.[1];
  if (/[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/.test(text)) return "jp";
  if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(text)) return "kr";
  if (hinted) return hinted === "hk" ? "tc" : (hinted as Cjk);
  return TRADITIONAL.test(text) ? "tc" : "sc";
}

const LANG: Record<Cjk, string> = { sc: "zh-Hans", tc: "zh-Hant", jp: "ja", kr: "ko" };

export function createResolver(ctx: EngineContext, request: MeasureTextRequest): Resolver {
  const { style, originalFont, text } = request;
  const bold = style.bold;
  const italic = style.italic;
  const errors: string[] = [];
  const heavy = !style.fontChoice && /(?:extra|ultra)[-_ ]?bold|black|heavy/i.test(originalFont?.name ?? "");

  const catalogSource = (f: FontFamily, substituted: boolean): Source => {
    const want: Variant = bold ? (italic ? "j" : "b") : italic ? "i" : "r";
    let variant: Variant = want;
    if (!f.urls[variant]) {
      if (want === "j") variant = f.urls.b ? "b" : f.urls.i ? "i" : "r";
      else variant = "r";
    }
    const url = f.urls[variant]!;
    return {
      key: url,
      family: f.family,
      // the catalog stops at bold: a heavier original gets a little extra stroke
      synthBold: bold && ((variant !== "b" && variant !== "j") || (heavy && f.key !== "anton")),
      synthItalic: italic && variant !== "i" && variant !== "j",
      substituted,
      needsShapingCheck: false,
      needsOutlineCheck: false,
      async load() {
        try {
          const face = await loadFace(await ctx.assets.bytes(url));
          if (!face) errors.push(`${f.family} is not a usable font file`);
          return face;
        } catch (e) {
          errors.push(`${f.family}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      },
    };
  };

  const userSource = (u: UserFace, substituted: boolean): Source => {
    const axes = u.info.weightAxis && bold && !u.info.bold ? { wght: 700 } : undefined;
    return {
      key: `user:${u.hash}${axes ? ":b" : ""}`,
      family: u.info.family || u.name,
      synthBold: bold && !u.info.bold && !axes,
      synthItalic: italic && !u.info.italic,
      substituted,
      needsShapingCheck: false,
      needsOutlineCheck: false,
      axes,
      load: () => loadFace(u.bytes, axes),
    };
  };

  /** the user face of a family that fits the wanted style best */
  const bestUserFace = (faces: UserFace[]) =>
    [...faces].sort(
      (a, b) =>
        Number(a.info.italic !== italic) * 4 +
        Number(a.info.bold !== bold) * 2 +
        Math.abs(a.info.weight - (bold ? 700 : 400)) / 1000 -
        (Number(b.info.italic !== italic) * 4 + Number(b.info.bold !== bold) * 2 + Math.abs(b.info.weight - (bold ? 700 : 400)) / 1000),
    )[0];

  const userByName = (name: string): UserFace | undefined => {
    const wanted = normaliseName(name);
    if (!wanted) return undefined;
    const matches = userFaces(ctx).filter((u) =>
      [u.info.family, u.info.postScriptName.split("-")[0] ?? "", u.name.replace(/\.[a-z0-9]+$/i, "")].some((candidate) =>
        isStyleOf(wanted, normaliseName(candidate)),
      ),
    );
    return bestUserFace(matches);
  };

  const base: Source[] = [];
  const add = (s: Source) => {
    if (!base.some((b) => b.key === s.key)) base.push(s);
  };

  const requested = originalFont && normaliseName(style.family) === normaliseName(originalFont.name);
  /** the family changed on purpose (style differs from the document font) */
  const wantedName = !originalFont || requested || !style.family ? (originalFont?.name ?? style.family) : style.family;
  const familyChanged = !!originalFont && !!style.family && !requested && !sameFamily(style.family, originalFont.name);

  let primaryKey: string | undefined;

  const choice = style.fontChoice;
  if (choice?.startsWith("user:")) {
    const faces = userFaces(ctx);
    const chosen = faces.find((u) => u.id === choice);
    if (chosen) {
      const siblings = faces.filter((u) => u.info.family === chosen.info.family);
      const best = bestUserFace(siblings)!;
      // an explicitly chosen face wins unless a sibling matches the wanted weight and slant better
      const fits = chosen.info.bold === bold && chosen.info.italic === italic;
      add(userSource(fits ? chosen : best, false));
    }
  } else if (choice?.startsWith("web:")) {
    const f = family(choice.slice(4));
    if (f) {
      primaryKey = f.key;
      add(catalogSource(f, false));
    }
  }

  if (!choice || !base.length) {
    const user = userByName(wantedName);
    if (user) add(userSource(user, false));

    const bytes = originalFont?.bytes;
    if (bytes?.length && !familyChanged && originalFont!.bold === bold && originalFont!.italic === italic) {
      const name = originalFont!.name.replace(/^[A-Z]{6}\+/, "");
      const embedded = documentFace(bytes);
      add({
        key: `doc:${embedded.hash}`,
        family: name,
        synthBold: false,
        synthItalic: false,
        substituted: false,
        needsShapingCheck: true,
        needsOutlineCheck: true,
        load: embedded.load,
      });
    }

    const match = matchName(wantedName) ?? (familyChanged ? undefined : matchName(style.family));
    if (match) {
      primaryKey = match.family.key;
      add(catalogSource(match.family, !match.exact));
    }
  }

  const mono = originalFont && !familyChanged ? originalFont.mono : style.mono;
  const serif = originalFont && !familyChanged ? originalFont.serif : style.serif;
  const generic = family(mono ? "cousine" : serif ? "tinos" : "arimo")!;
  add(catalogSource(generic, true));

  const cjk = cjkLanguage(text, primaryKey);
  const style3 = serif ? "serif" : "sans";
  const nameHint = normaliseName(wantedName);
  const nastaliq = /nasta|jameel|alvi|urdu|mehr/.test(nameHint) || (URDU.test(text) && !matchName(wantedName));

  const keys = (list: (string | undefined)[]) =>
    list.flatMap((k) => {
      const f = k ? family(k) : undefined;
      return f ? [catalogSource(f, true)] : [];
    });

  return {
    base,
    errors,
    forScript(script) {
      if (script === "Han") return keys([`noto-${style3}-${cjk}`, `noto-sans-${cjk}`, "noto-sans-sc", "noto-sans-tc", "noto-sans-jp"]);
      if (script === "Hiragana" || script === "Katakana") return keys([`noto-${style3}-jp`, "noto-sans-jp"]);
      if (script === "Hangul") return keys([`noto-${style3}-kr`, "noto-sans-kr"]);
      const info = scriptInfo(script);
      if (!info) return [];
      const preferred = mono ? (info.mono ?? info.sans) : serif ? (info.serif ?? info.sans) : info.sans;
      if (script === "Arabic" && nastaliq) return keys(["noto-nastaliq-urdu", preferred]);
      return keys([preferred, info.sans, script === "Latin" || script === "Greek" || script === "Cyrillic" ? "noto-sans" : info.serif]);
    },
    fallbacks(cp) {
      const user = () => userFaces(ctx).map((u) => userSource(u, true));
      // private use characters mean something only to the font they came from
      if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) return user();
      const list: string[] = [];
      const cjkRange =
        (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x3ffff) || (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x1f100 && cp <= 0x1f2ff) || (cp >= 0x2460 && cp <= 0x24ff);
      if (cjkRange) list.push(`noto-sans-${cjk}`, "noto-sans-jp", "noto-sans-kr", "noto-sans-sc", "noto-sans-tc");
      else {
        list.push(serif ? "noto-serif" : "noto-sans");
        if (cp >= 0x1d100 && cp <= 0x1d24f) list.push("noto-music");
        const math =
          (cp >= 0x2100 && cp <= 0x214f) || (cp >= 0x2190 && cp <= 0x23ff) || (cp >= 0x27c0 && cp <= 0x2bff) ||
          (cp >= 0x1d400 && cp <= 0x1d7ff) || (cp >= 0x1ee00 && cp <= 0x1eeff);
        if (math) list.push("noto-sans-math");
        if (cp >= 0x2000) list.push("noto-sans-symbols-2", "noto-sans-symbols");
        if (!math && cp >= 0x2000) list.push("noto-sans-math");
        if (cp >= 0x2000 || cp === 0xa9 || cp === 0xae) list.push("noto-emoji");
        list.push("dejavu-sans");
      }
      return [...keys(list), ...user()];
    },
    language(script) {
      if (script === "Han") return LANG[cjk];
      if (script === "Hiragana" || script === "Katakana") return "ja";
      if (script === "Hangul") return "ko";
      if (script === "Arabic") return URDU.test(text) ? "ur" : "ar";
      if (script === "Hebrew") return "he";
      if (script === "Devanagari") return "hi";
      return "und";
    },
  };
}

function sameFamily(a: string, b: string): boolean {
  const x = normaliseName(a);
  const y = normaliseName(b);
  return x === y || isStyleOf(x, y) || isStyleOf(y, x);
}
