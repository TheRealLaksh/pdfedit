/** Unicode script table: which font families cover a script and what shaping support a font needs. */

export interface ScriptInfo {
  /** Unicode script property value */
  name: string;
  /** default families (catalog keys) */
  sans: string;
  serif?: string;
  mono?: string;
  /** OpenType script tags; a font needs one of them in GSUB to shape this script correctly */
  ot?: string[];
  /** joined writing: letter spacing must not break it */
  cursive?: boolean;
}

const s = (name: string, sans: string, extra: Partial<ScriptInfo> = {}): ScriptInfo => ({ name, sans, ...extra });
const indic = (name: string, slug: string, ot: string[]) =>
  s(name, `noto-sans-${slug}`, { serif: `noto-serif-${slug}`, ot });
const noto = (name: string, extra: Partial<ScriptInfo> = {}) =>
  s(name, `noto-sans-${name.toLowerCase().replace(/_/g, "-")}`, extra);

export const SCRIPTS: readonly ScriptInfo[] = [
  s("Latin", "arimo", { serif: "tinos", mono: "cousine" }),
  s("Greek", "arimo", { serif: "tinos", mono: "cousine" }),
  s("Cyrillic", "arimo", { serif: "tinos", mono: "cousine" }),
  s("Han", "noto-sans-sc", { serif: "noto-serif-sc" }),
  s("Hiragana", "noto-sans-jp", { serif: "noto-serif-jp" }),
  s("Katakana", "noto-sans-jp", { serif: "noto-serif-jp" }),
  s("Hangul", "noto-sans-kr", { serif: "noto-serif-kr" }),
  s("Bopomofo", "noto-sans-tc", { serif: "noto-serif-tc" }),
  indic("Devanagari", "devanagari", ["dev2", "deva", "dev3"]),
  indic("Bengali", "bengali", ["bng2", "beng"]),
  indic("Gurmukhi", "gurmukhi", ["gur2", "guru"]),
  indic("Gujarati", "gujarati", ["gjr2", "gujr"]),
  indic("Oriya", "oriya", ["ory2", "orya"]),
  indic("Tamil", "tamil", ["tml2", "taml"]),
  indic("Telugu", "telugu", ["tel2", "telu"]),
  indic("Kannada", "kannada", ["knd2", "knda"]),
  indic("Malayalam", "malayalam", ["mlm2", "mlym"]),
  indic("Sinhala", "sinhala", ["sinh"]),
  s("Arabic", "noto-sans-arabic", { serif: "noto-naskh-arabic", ot: ["arab"], cursive: true }),
  s("Hebrew", "arimo", { serif: "tinos", mono: "cousine" }),
  s("Thai", "noto-sans-thai", { serif: "noto-serif-thai" }),
  s("Lao", "noto-sans-lao", { serif: "noto-serif-lao" }),
  s("Khmer", "noto-sans-khmer", { serif: "noto-serif-khmer", ot: ["khmr"] }),
  s("Myanmar", "noto-sans-myanmar", { serif: "noto-serif-myanmar", ot: ["mym2", "mymr"] }),
  s("Tibetan", "noto-serif-tibetan", { ot: ["tibt"] }),
  s("Georgian", "noto-sans-georgian", { serif: "noto-serif-georgian" }),
  s("Armenian", "noto-sans-armenian", { serif: "noto-serif-armenian" }),
  s("Ethiopic", "noto-sans-ethiopic", { serif: "noto-serif-ethiopic" }),
  noto("Thaana"),
  noto("Syriac", { ot: ["syrc"], cursive: true }),
  s("Nko", "noto-sans-nko", { ot: ["nko "], cursive: true }),
  noto("Samaritan"),
  noto("Mandaic", { cursive: true }),
  noto("Adlam", { cursive: true }),
  noto("Hanifi_Rohingya", { cursive: true }),
  noto("Mongolian", { ot: ["mong"], cursive: true }),
  noto("Cherokee"),
  noto("Canadian_Aboriginal"),
  noto("Ogham"),
  noto("Runic"),
  noto("Tagalog"),
  noto("Hanunoo"),
  noto("Buhid"),
  noto("Tagbanwa"),
  noto("Limbu"),
  noto("Tai_Le"),
  noto("New_Tai_Lue"),
  noto("Buginese"),
  noto("Tai_Tham"),
  noto("Balinese", { ot: ["bali"] }),
  noto("Sundanese"),
  noto("Batak"),
  noto("Lepcha"),
  noto("Ol_Chiki"),
  noto("Glagolitic"),
  noto("Tifinagh"),
  noto("Coptic"),
  noto("Yi"),
  noto("Lisu"),
  noto("Vai"),
  noto("Bamum"),
  noto("Syloti_Nagri"),
  noto("Phags_Pa", { cursive: true }),
  noto("Saurashtra"),
  noto("Kayah_Li"),
  noto("Rejang"),
  noto("Javanese", { ot: ["java"] }),
  noto("Cham"),
  noto("Tai_Viet"),
  noto("Meetei_Mayek"),
  noto("Linear_B"),
  noto("Lycian"),
  noto("Carian"),
  noto("Old_Italic"),
  noto("Gothic"),
  noto("Ugaritic"),
  noto("Old_Persian"),
  noto("Deseret"),
  noto("Shavian"),
  noto("Osmanya"),
  noto("Osage"),
  noto("Imperial_Aramaic"),
  noto("Phoenician"),
  noto("Lydian"),
  noto("Kharoshthi"),
  noto("Avestan"),
  noto("Old_Turkic"),
  noto("Brahmi"),
  noto("Sora_Sompeng"),
  noto("Chakma"),
  noto("Mahajani"),
  noto("Sharada"),
  noto("Khojki"),
  noto("Multani"),
  noto("Khudawadi"),
  noto("Grantha"),
  noto("Newa"),
  noto("Tirhuta"),
  noto("Siddham"),
  noto("Modi"),
  noto("Takri"),
  noto("Warang_Citi"),
  noto("Pahawh_Hmong"),
  noto("Medefaidrin"),
  noto("Miao"),
  noto("Nushu"),
  noto("Mro"),
  noto("Wancho"),
  noto("Masaram_Gondi"),
  noto("Gunjala_Gondi"),
  noto("Kaithi"),
  noto("Cuneiform"),
  noto("Egyptian_Hieroglyphs"),
];

const byName = new Map(SCRIPTS.map((x) => [x.name, x]));
export const scriptInfo = (name: string): ScriptInfo | undefined => byName.get(name);

const matchers: [string, RegExp][] = [];
for (const info of SCRIPTS) {
  try {
    matchers.push([info.name, new RegExp(`\\p{Script=${info.name}}`, "u")]);
  } catch {
    /* a script newer than the runtime's Unicode data */
  }
}
const common = /[\p{Script=Common}\p{Script=Inherited}]/u;
const cache = new Map<number, string>();

/** Unicode script of a code point; "Common" for punctuation, digits, marks shared between scripts. */
export function scriptOf(cp: number): string {
  if (cp < 128) return (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) ? "Latin" : "Common";
  let found = cache.get(cp);
  if (found === undefined) {
    const ch = String.fromCodePoint(cp);
    if (common.test(ch)) found = "Common";
    else found = matchers.find(([, re]) => re.test(ch))?.[0] ?? "Unknown";
    if (cache.size > 20000) cache.clear();
    cache.set(cp, found);
  }
  return found;
}

/** the script a piece of text belongs to ("Common" when it has none of its own) */
export function clusterScript(text: string): string {
  for (const ch of text) {
    const found = scriptOf(ch.codePointAt(0)!);
    if (found !== "Common") return found;
  }
  // punctuation that is only used with one family of scripts (Common in Unicode, but not in fonts)
  const cp = text.codePointAt(0) ?? 0;
  if (cp === 0x60c || cp === 0x61b || cp === 0x61f || cp === 0x640) return "Arabic";
  if ((cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xff65)) return "Han";
  return "Common";
}
