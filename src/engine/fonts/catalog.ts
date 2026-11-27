/** The downloadable font catalog and the rules that map a PDF font name onto it. */
import type { FontChoice } from "../types";
import { GOOGLE_FONTS } from "./catalog.data";
import { SCRIPTS } from "./scripts";

export type Category = FontChoice["category"];
/** "r" regular, "b" bold, "i" italic, "j" bold italic */
export type Variant = "r" | "b" | "i" | "j";

export interface FontFamily {
  key: string;
  family: string;
  category: Category;
  scripts: string[];
  urls: Partial<Record<Variant, string>> & { r: string };
}

const CDN = "https://cdn.jsdelivr.net/npm";
const VARIANT_DIR: Record<Variant, string> = {
  r: "400Regular",
  b: "700Bold",
  i: "400Regular_Italic",
  j: "700Bold_Italic",
};

const MONO = new Set(["cousine", "roboto-mono", "source-code-pro", "noto-sans-mono", "jetbrains-mono", "fira-code", "inconsolata"]);
const HANDWRITING = new Set(["dancing-script", "pacifico", "caveat", "great-vibes", "kalam", "noto-nastaliq-urdu"]);
const SERIF = new Set([
  "tinos", "caladea", "gelasio", "source-serif-4", "merriweather", "pt-serif", "playfair-display", "lora",
  "libre-baskerville", "libre-caslon-text", "eb-garamond", "crimson-text", "domine", "amiri", "scheherazade-new",
  "frank-ruhl-libre", "tiro-devanagari-hindi", "roboto-slab", "noto-naskh-arabic", "stix-two-text", "stix-two-math",
]);

const LGC = ["Latin", "Greek", "Cyrillic"];
const LATIN_EXTRA: Record<string, string[]> = {
  arimo: [...LGC, "Hebrew"],
  tinos: [...LGC, "Hebrew"],
  cousine: [...LGC, "Hebrew"],
  "noto-sans": [...LGC, "Devanagari"],
  "noto-serif": LGC,
  "noto-sans-mono": LGC,
  "frank-ruhl-libre": ["Hebrew", "Latin"],
  heebo: ["Hebrew", "Latin"],
  amiri: ["Arabic", "Latin"],
  cairo: ["Arabic", "Latin"],
  tajawal: ["Arabic", "Latin"],
  "scheherazade-new": ["Arabic", "Latin"],
  "noto-nastaliq-urdu": ["Arabic"],
  "noto-naskh-arabic": ["Arabic"],
  "noto-kufi-arabic": ["Arabic"],
  "noto-sans-arabic": ["Arabic"],
  mukta: ["Devanagari", "Latin"],
  hind: ["Devanagari", "Latin"],
  kalam: ["Devanagari", "Latin"],
  "baloo-2": ["Devanagari", "Latin"],
  poppins: ["Latin", "Devanagari"],
  "tiro-devanagari-hindi": ["Devanagari", "Latin"],
  sarabun: ["Thai", "Latin"],
  "noto-sans-sc": ["Han", "Latin"],
  "noto-serif-sc": ["Han", "Latin"],
  "noto-sans-tc": ["Han", "Bopomofo", "Latin"],
  "noto-serif-tc": ["Han", "Bopomofo", "Latin"],
  "noto-sans-hk": ["Han", "Latin"],
  "noto-sans-jp": ["Hiragana", "Katakana", "Han", "Latin"],
  "noto-serif-jp": ["Hiragana", "Katakana", "Han", "Latin"],
  "noto-sans-kr": ["Hangul", "Han", "Latin"],
  "noto-serif-kr": ["Hangul", "Han", "Latin"],
  "noto-sans-math": ["Math"],
  "stix-two-math": ["Math"],
  "noto-sans-symbols": ["Symbols"],
  "noto-sans-symbols-2": ["Symbols"],
  "noto-emoji": ["Symbols"],
  "noto-music": ["Symbols"],
};

function scriptsFor(key: string): string[] {
  const extra = LATIN_EXTRA[key];
  if (extra) return extra;
  const own = SCRIPTS.filter((s) => s.sans === key || s.serif === key).map((s) => s.name);
  return own.length ? own : LGC.slice(0, 1);
}

function categoryFor(key: string): Category {
  if (MONO.has(key)) return "mono";
  if (HANDWRITING.has(key)) return "script";
  if (SERIF.has(key) || (key.includes("serif") && !key.includes("sans"))) return "serif";
  return "sans";
}

function googleFamilies(): FontFamily[] {
  return GOOGLE_FONTS.map(([slug, family, stem, version, variants]) => {
    const base = `${CDN}/@expo-google-fonts/${slug}@${version}`;
    const urls: Partial<Record<Variant, string>> = {};
    for (const v of ["r", "b", "i", "j"] as const) {
      if (!variants.includes(v)) continue;
      const dir = VARIANT_DIR[v];
      urls[v] = variants.includes("@") ? `${base}/${stem}_${dir}.ttf` : `${base}/${dir}/${stem}_${dir}.ttf`;
    }
    return { key: slug, family, category: categoryFor(slug), scripts: scriptsFor(slug), urls: urls as FontFamily["urls"] };
  });
}

function dejavu(key: string, family: string, stem: string, category: Category, italic: string): FontFamily {
  const base = `${CDN}/dejavu-fonts-ttf@2.37.3/ttf/${stem}`;
  return {
    key,
    family,
    category,
    scripts: LGC,
    urls: {
      r: `${base}.ttf`,
      b: `${base}-Bold.ttf`,
      i: `${base}-${italic}.ttf`,
      j: `${base}-Bold${italic}.ttf`,
    },
  };
}

const katex = (name: string) => `${CDN}/katex@0.16.11/dist/fonts/KaTeX_${name}.ttf`;

export const FAMILIES: readonly FontFamily[] = [
  ...googleFamilies(),
  dejavu("dejavu-sans", "DejaVu Sans", "DejaVuSans", "sans", "Oblique"),
  dejavu("dejavu-serif", "DejaVu Serif", "DejaVuSerif", "serif", "Italic"),
  dejavu("dejavu-sans-mono", "DejaVu Sans Mono", "DejaVuSansMono", "mono", "Oblique"),
  {
    key: "computer-modern",
    family: "Computer Modern",
    category: "serif",
    scripts: ["Latin"],
    urls: { r: katex("Main-Regular"), b: katex("Main-Bold"), i: katex("Main-Italic"), j: katex("Main-BoldItalic") },
  },
  {
    key: "computer-modern-sans",
    family: "Computer Modern Sans",
    category: "sans",
    scripts: ["Latin"],
    urls: { r: katex("SansSerif-Regular"), b: katex("SansSerif-Bold"), i: katex("SansSerif-Italic") },
  },
  {
    key: "computer-modern-typewriter",
    family: "Computer Modern Typewriter",
    category: "mono",
    scripts: ["Latin"],
    urls: { r: katex("Typewriter-Regular") },
  },
];

const byKey = new Map(FAMILIES.map((f) => [f.key, f]));
export const family = (key: string): FontFamily | undefined => byKey.get(key);

export const normaliseName = (name: string) =>
  name
    .replace(/^[A-Z]{6}\+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const STYLE_TOKENS =
  /^(?:regular|bold|italic|oblique|medium|light|semibold|demibold|demi|extrabold|ultrabold|extralight|ultralight|thin|black|heavy|book|roman|normal|condensed|narrow|variable|identityh|identity|psmt|ps|mt|bd|it|bi|vf|wght|opsz|ital|\d+)*$/;

/** true when `name` is `base` followed only by style words (both normalised) */
export const isStyleOf = (name: string, base: string) =>
  !!base && name.startsWith(base) && STYLE_TOKENS.test(name.slice(base.length));

const catalogNames = FAMILIES.map((f) => [normaliseName(f.family), f] as const).sort((a, b) => b[0].length - a[0].length);

/** metric-compatible or visually close substitutes for common PDF fonts; first match wins */
const SUBSTITUTES: [RegExp, string][] = [
  // monospace first: "CourierNew" must not fall through to a serif rule
  [/courier|nimbusmon|liberationmono|texgyrecursor|^cour/, "cousine"],
  [/consolas/, "inconsolata"],
  [/menlo|monaco|lucidaconsole|andalemono|lucidasanstypewriter|dejavusansmono/, "dejavu-sans-mono"],
  [/^(cm|lm)(tt|ttb|sltt|itt)\d|lmmono|^sftt\d/, "computer-modern-typewriter"],
  [/^(cm|lm)(ss|ssbx|ssi)\d|lmsans|^sfss?\d/, "computer-modern-sans"],
  [/^(cm|lm)(r|bx|ti|b|sl|bxti|mi|mib|csc|u|dunh)\d|lmroman|computermodern|latinmodern|^sf(rm|bx|ti|bi|sl)\d|^nimbusroman.*cm/, "computer-modern"],
  [/calibri/, "carlito"],
  [/cambriamath/, "stix-two-math"],
  [/cambria/, "caladea"],
  [/timesnewroman|^times|tmsrmn|nimbusrom|liberationserif|texgyretermes|freeserif|^tiro?s/, "tinos"],
  [/arial|helvetica|^helv|nimbussan|liberationsans|texgyreheros|freesans|swiss721|arimo/, "arimo"],
  [/georgia/, "gelasio"],
  [/verdana|bitstreamverasans|dejavusans/, "dejavu-sans"],
  [/dejavuserif|bitstreamveraserif/, "dejavu-serif"],
  [/segoeuisymbol/, "noto-sans-symbols-2"],
  [/segoe|sfprodisplay|sfprotext|sanfrancisco|lucidagrande|lucidasans/, "open-sans"],
  [/tahoma|microsoftsansserif|mssansserif/, "noto-sans"],
  [/trebuchet|myriad|frutiger/, "fira-sans"],
  [/garamond/, "eb-garamond"],
  [/palatino|bookantiqua|pagella|palladio/, "domine"],
  [/bookman|centuryschoolbook|newcentury|schola|bonum|baskerville/, "libre-baskerville"],
  [/centurygothic|avantgarde|adventor/, "questrial"],
  [/futura|avenir|gillsans/, "jost"],
  [/franklingothic|arialnarrow/, "libre-franklin"],
  [/caslon|century/, "libre-caslon-text"],
  [/comicsans/, "comic-neue"],
  [/impact|haettenschweiler/, "anton"],
  [/constantia|charter|minion|sourceserif/, "source-serif-4"],
  [/candara|corbel|optima/, "mulish"],
  [/sourcesanspro/, "source-sans-3"],
  [/zapfdingbats|wingdings|webdings|dingbats/, "noto-sans-symbols-2"],
  [/^symbol/, "noto-sans-math"],
  [/brushscript|lucidahandwriting|segoescript|monotypecorsiva|zapfchancery/, "dancing-script"],
  // fonts of particular scripts (Windows / macOS / legacy encodings)
  [/mangal|krutidev|chanakya|devlys|shivaji|walkman|aparajita|sanskrit/, "noto-sans-devanagari"],
  [/kokila|utsaah/, "noto-serif-devanagari"],
  [/vrinda|shonar|solaimanlipi|sutonny|siyamrupali|kalpurush/, "noto-sans-bengali"],
  [/shruti/, "noto-sans-gujarati"],
  [/raavi|anmollipi/, "noto-sans-gurmukhi"],
  [/kalinga/, "noto-sans-oriya"],
  [/latha|vijaya|bamini/, "noto-sans-tamil"],
  [/gautami|vani/, "noto-sans-telugu"],
  [/tunga/, "noto-sans-kannada"],
  [/kartika/, "noto-sans-malayalam"],
  [/iskoolapota/, "noto-sans-sinhala"],
  [/nastal|nastaliq|jameelnoori|alvi|urdutypesetting|mehr/, "noto-nastaliq-urdu"],
  [/traditionalarabic|simplifiedarabic|arabictypesetting|sakkalmajalla|scheherazade/, "amiri"],
  [/david|frankruehl|narkisim/, "frank-ruhl-libre"],
  [/miriam|gisha|aharoni/, "heebo"],
  [/angsana|browalliaserif|thniramit/, "noto-serif-thai"],
  [/cordia|browallia|leelawadee|thsarabun|sarabun/, "sarabun"],
  [/daunpenh|moolboran|khmerui/, "noto-sans-khmer"],
  [/nyala/, "noto-sans-ethiopic"],
  [/mvboli|farumaa/, "noto-sans-thaana"],
  [/microsofthimalaya|jomolhari/, "noto-serif-tibetan"],
  [/simsun|nsimsun|fangsong|kaiti|stsong|stfangsong|stkaiti|songti|simkai|simfang|sourcehanserifsc|adobesong/, "noto-serif-sc"],
  [/simhei|yahei|dengxian|stheiti|pingfangsc|heiti|sourcehansanssc|notosanscjksc/, "noto-sans-sc"],
  [/mingliu|pmingliu|dfkai|kaiu|songtitc/, "noto-serif-tc"],
  [/jhenghei|pingfangtc|pingfanghk|notosanscjktc/, "noto-sans-tc"],
  [/mincho|ryumin|hiramin|sourcehanserif$|ipamin/, "noto-serif-jp"],
  [/msgothic|mspgothic|msuigothic|meiryo|yugothic|yugo|hirakaku|hirago|ipagothic|kozgo|gothicbbb|notosanscjkjp/, "noto-sans-jp"],
  [/batang|gungsuh|myeongjo|myungjo/, "noto-serif-kr"],
  [/malgun|gulim|dotum|nanumgothic|applegothic|applesdgothic|notosanscjkkr/, "noto-sans-kr"],
];

export interface NameMatch {
  family: FontFamily;
  /** the catalog has the very family asked for (not a substitute) */
  exact: boolean;
}

export function matchName(name: string): NameMatch | undefined {
  const n = normaliseName(name);
  if (!n) return undefined;
  for (const [base, f] of catalogNames) if (isStyleOf(n, base)) return { family: f, exact: true };
  for (const [re, key] of SUBSTITUTES) {
    if (!re.test(n)) continue;
    const f = byKey.get(key);
    if (f) return { family: f, exact: false };
  }
  return undefined;
}

export function catalogChoices(): FontChoice[] {
  const core = new Set(["arimo", "tinos", "cousine", "carlito", "caladea", "noto-sans", "noto-serif"]);
  return FAMILIES.map((f) => ({
    id: `web:${f.key}`,
    family: f.family,
    scripts: f.scripts,
    category: f.category,
    source: core.has(f.key) ? ("builtin" as const) : ("web" as const),
  })).sort((a, b) => Number(b.source === "builtin") - Number(a.source === "builtin") || a.family.localeCompare(b.family));
}
