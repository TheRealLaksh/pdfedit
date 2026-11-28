/**
 * Fonts the image editor can match and draw with: free families from @expo-google-fonts (OFL / Apache),
 * with every weight they publish (posters and screenshots need more than regular and bold).
 * Versions are pinned; tests/image/tools/gen-metrics.test.ts checks every address.
 */

export type Category = "sans" | "serif" | "mono" | "script" | "condensed";

export interface ImageFamily {
  key: string;
  name: string;
  category: Category;
  scripts: string[];
  weights: number[];
  italic: boolean;
  url(weight: number, italic: boolean): string;
}

const CDN = "https://cdn.jsdelivr.net/npm";
const WEIGHT_NAMES: Record<number, string> = {
  100: "100Thin", 200: "200ExtraLight", 300: "300Light", 400: "400Regular", 500: "500Medium",
  600: "600SemiBold", 700: "700Bold", 800: "800ExtraBold", 900: "900Black",
};

const range = (from: number, to: number) => Array.from({ length: (to - from) / 100 + 1 }, (_, i) => from + i * 100);
const LATIN = ["Latin"];
const LGC = ["Latin", "Greek", "Cyrillic"];

function google(
  slug: string,
  version: string,
  name: string,
  category: Category,
  weights: number[],
  italic = false,
  scripts: string[] = LATIN,
): ImageFamily {
  const stem = name.replace(/ /g, "");
  return {
    key: slug,
    name,
    category,
    scripts,
    weights,
    italic,
    url(weight, slanted) {
      const dir = WEIGHT_NAMES[weight]! + (slanted && italic ? "_Italic" : "");
      return `${CDN}/@expo-google-fonts/${slug}@${version}/${dir}/${stem}_${dir}.ttf`;
    },
  };
}

function dejavu(key: string, name: string, stem: string, category: Category, slant: string): ImageFamily {
  return {
    key,
    name,
    category,
    scripts: LGC,
    weights: [400, 700],
    italic: true,
    url(weight, italic) {
      const style = (weight >= 600 ? "Bold" : "") + (italic ? slant : "");
      return `${CDN}/dejavu-fonts-ttf@2.37.3/ttf/${stem}${style ? "-" + style : ""}.ttf`;
    },
  };
}

const RB = [400, 700];

export const FAMILIES: readonly ImageFamily[] = [
  // sans
  google("arimo", "0.4.3", "Arimo", "sans", RB, true, [...LGC, "Hebrew"]),
  google("inter", "0.4.2", "Inter", "sans", range(100, 900), true, LGC),
  google("roboto", "0.4.3", "Roboto", "sans", range(100, 900), true, LGC),
  google("open-sans", "0.4.2", "Open Sans", "sans", range(300, 800), true, LGC),
  google("noto-sans", "0.4.2", "Noto Sans", "sans", range(100, 900), true, [...LGC, "Devanagari"]),
  google("montserrat", "0.4.2", "Montserrat", "sans", range(100, 900), true),
  google("poppins", "0.4.1", "Poppins", "sans", range(100, 900), true, ["Latin", "Devanagari"]),
  google("lato", "0.4.1", "Lato", "sans", [100, 300, 400, 700, 900], true),
  google("source-sans-3", "0.4.2", "Source Sans 3", "sans", range(200, 900), true, LGC),
  google("nunito", "0.4.2", "Nunito", "sans", range(200, 900), true),
  google("raleway", "0.4.2", "Raleway", "sans", range(100, 900), true),
  google("work-sans", "0.4.2", "Work Sans", "sans", range(100, 900), true),
  google("dm-sans", "0.4.2", "DM Sans", "sans", range(100, 900), true),
  google("rubik", "0.4.2", "Rubik", "sans", range(300, 900), true),
  google("fira-sans", "0.4.1", "Fira Sans", "sans", range(100, 900), true),
  google("libre-franklin", "0.4.2", "Libre Franklin", "sans", range(100, 900), true),
  google("manrope", "0.4.3", "Manrope", "sans", range(200, 800)),
  google("jost", "0.4.2", "Jost", "sans", range(100, 900), true),
  google("ibm-plex-sans", "0.4.1", "IBM Plex Sans", "sans", range(100, 700), true),
  google("figtree", "0.4.1", "Figtree", "sans", range(300, 900), true),
  google("outfit", "0.4.3", "Outfit", "sans", range(100, 900)),
  google("plus-jakarta-sans", "0.4.2", "Plus Jakarta Sans", "sans", range(200, 800), true),
  google("barlow", "0.4.1", "Barlow", "sans", range(100, 900), true),
  google("kanit", "0.4.1", "Kanit", "sans", range(100, 900), true),
  dejavu("dejavu-sans", "DejaVu Sans", "DejaVuSans", "sans", "Oblique"),
  google("carlito", "0.4.1", "Carlito", "sans", RB, true, LGC),
  // condensed (posters, signs, headlines)
  google("roboto-condensed", "0.4.1", "Roboto Condensed", "condensed", range(100, 900), true, LGC),
  google("barlow-condensed", "0.4.1", "Barlow Condensed", "condensed", range(100, 900), true),
  google("oswald", "0.4.2", "Oswald", "condensed", range(200, 700)),
  google("archivo-narrow", "0.4.2", "Archivo Narrow", "condensed", range(400, 700), true),
  google("bebas-neue", "0.4.1", "Bebas Neue", "condensed", [400]),
  google("anton", "0.4.2", "Anton", "condensed", [400]),
  google("fjalla-one", "0.4.1", "Fjalla One", "condensed", [400]),
  google("archivo-black", "0.4.1", "Archivo Black", "sans", [400]),
  // serif
  google("tinos", "0.4.2", "Tinos", "serif", RB, true, [...LGC, "Hebrew"]),
  google("gelasio", "0.4.1", "Gelasio", "serif", RB, true),
  google("noto-serif", "0.4.2", "Noto Serif", "serif", RB, true, LGC),
  google("merriweather", "0.4.2", "Merriweather", "serif", [300, 400, 700, 900], true),
  google("playfair-display", "0.4.2", "Playfair Display", "serif", range(400, 900), true),
  google("lora", "0.4.2", "Lora", "serif", range(400, 700), true),
  google("pt-serif", "0.4.1", "PT Serif", "serif", RB, true),
  google("libre-baskerville", "0.4.3", "Libre Baskerville", "serif", RB, true),
  google("eb-garamond", "0.4.3", "EB Garamond", "serif", RB, true, LGC),
  google("source-serif-4", "0.4.2", "Source Serif 4", "serif", RB, true, LGC),
  google("caladea", "0.4.2", "Caladea", "serif", RB, true),
  google("roboto-slab", "0.4.2", "Roboto Slab", "serif", range(100, 900)),
  google("arvo", "0.4.1", "Arvo", "serif", RB, true),
  // fixed width
  google("cousine", "0.4.3", "Cousine", "mono", RB, true, [...LGC, "Hebrew"]),
  google("roboto-mono", "0.4.2", "Roboto Mono", "mono", range(100, 700), true, LGC),
  google("source-code-pro", "0.4.2", "Source Code Pro", "mono", RB, true, LGC),
  google("jetbrains-mono", "0.4.1", "JetBrains Mono", "mono", RB, true, LGC),
  google("inconsolata", "0.4.2", "Inconsolata", "mono", RB),
  // handwriting and display
  google("comic-neue", "0.4.1", "Comic Neue", "script", RB, true),
  google("caveat", "0.4.2", "Caveat", "script", RB),
  google("dancing-script", "0.4.2", "Dancing Script", "script", RB),
  google("pacifico", "0.4.1", "Pacifico", "script", [400]),
  google("lobster", "0.4.1", "Lobster", "script", [400]),
  google("permanent-marker", "0.4.0", "Permanent Marker", "script", [400]),
  // Indian scripts
  google("noto-sans-devanagari", "0.4.2", "Noto Sans Devanagari", "sans", range(100, 900), false, ["Devanagari"]),
  google("mukta", "0.4.1", "Mukta", "sans", range(200, 800), false, ["Devanagari"]),
  google("hind", "0.4.1", "Hind", "sans", range(300, 700), false, ["Devanagari"]),
  google("noto-serif-devanagari", "0.4.1", "Noto Serif Devanagari", "serif", RB, false, ["Devanagari"]),
  google("kalam", "0.4.1", "Kalam", "script", RB, false, ["Devanagari"]),
  google("noto-sans-bengali", "0.4.4", "Noto Sans Bengali", "sans", RB, false, ["Bengali"]),
  google("noto-serif-bengali", "0.4.4", "Noto Serif Bengali", "serif", RB, false, ["Bengali"]),
  google("noto-sans-gurmukhi", "0.4.1", "Noto Sans Gurmukhi", "sans", RB, false, ["Gurmukhi"]),
  google("noto-sans-gujarati", "0.4.2", "Noto Sans Gujarati", "sans", RB, false, ["Gujarati"]),
  google("noto-serif-gujarati", "0.4.2", "Noto Serif Gujarati", "serif", RB, false, ["Gujarati"]),
  google("noto-sans-oriya", "0.4.2", "Noto Sans Oriya", "sans", RB, false, ["Oriya"]),
  google("noto-sans-tamil", "0.4.3", "Noto Sans Tamil", "sans", RB, false, ["Tamil"]),
  google("noto-serif-tamil", "0.4.1", "Noto Serif Tamil", "serif", RB, false, ["Tamil"]),
  google("noto-sans-telugu", "0.4.2", "Noto Sans Telugu", "sans", RB, false, ["Telugu"]),
  google("noto-sans-kannada", "0.4.3", "Noto Sans Kannada", "sans", RB, false, ["Kannada"]),
  google("noto-sans-malayalam", "0.4.2", "Noto Sans Malayalam", "sans", RB, false, ["Malayalam"]),
  google("noto-sans-sinhala", "0.4.2", "Noto Sans Sinhala", "sans", RB, false, ["Sinhala"]),
  // other scripts
  google("noto-sans-arabic", "0.4.3", "Noto Sans Arabic", "sans", RB, false, ["Arabic"]),
  google("noto-naskh-arabic", "0.4.5", "Noto Naskh Arabic", "serif", RB, false, ["Arabic"]),
  google("cairo", "0.4.2", "Cairo", "sans", RB, false, ["Arabic"]),
  google("amiri", "0.4.1", "Amiri", "serif", RB, true, ["Arabic"]),
  google("noto-nastaliq-urdu", "0.4.2", "Noto Nastaliq Urdu", "script", RB, false, ["Arabic"]),
  google("heebo", "0.4.2", "Heebo", "sans", RB, false, ["Hebrew"]),
  google("frank-ruhl-libre", "0.4.1", "Frank Ruhl Libre", "serif", RB, false, ["Hebrew"]),
  google("noto-sans-thai", "0.4.2", "Noto Sans Thai", "sans", RB, false, ["Thai"]),
  google("noto-serif-thai", "0.4.2", "Noto Serif Thai", "serif", RB, false, ["Thai"]),
  google("sarabun", "0.4.1", "Sarabun", "sans", RB, true, ["Thai"]),
  google("noto-sans-sc", "0.4.4", "Noto Sans SC", "sans", RB, false, ["Han"]),
  google("noto-serif-sc", "0.4.4", "Noto Serif SC", "serif", RB, false, ["Han"]),
  google("noto-sans-tc", "0.4.4", "Noto Sans TC", "sans", RB, false, ["Han", "Bopomofo"]),
  google("noto-sans-jp", "0.4.4", "Noto Sans JP", "sans", RB, false, ["Hiragana", "Katakana", "Han"]),
  google("noto-serif-jp", "0.4.4", "Noto Serif JP", "serif", RB, false, ["Hiragana", "Katakana", "Han"]),
  google("noto-sans-kr", "0.4.4", "Noto Sans KR", "sans", RB, false, ["Hangul"]),
  google("noto-sans-khmer", "0.4.3", "Noto Sans Khmer", "sans", RB, false, ["Khmer"]),
  google("noto-sans-lao", "0.4.2", "Noto Sans Lao", "sans", RB, false, ["Lao"]),
  google("noto-sans-myanmar", "0.4.2", "Noto Sans Myanmar", "sans", RB, false, ["Myanmar"]),
  google("noto-sans-georgian", "0.4.4", "Noto Sans Georgian", "sans", RB, false, ["Georgian"]),
  google("noto-sans-armenian", "0.4.2", "Noto Sans Armenian", "sans", RB, false, ["Armenian"]),
  google("noto-sans-ethiopic", "0.4.2", "Noto Sans Ethiopic", "sans", RB, false, ["Ethiopic"]),
];

const byKey = new Map(FAMILIES.map((f) => [f.key, f]));
export const familyByKey = (key: string) => byKey.get(key);

export const nearestWeight = (weights: readonly number[], wanted: number) =>
  weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), weights[0]!);

/** the script that decides which fonts are candidates (Latin when the text has no script of its own) */
export function scriptOfText(text: string): string {
  const tests: [string, RegExp][] = [
    ["Hiragana", /[぀-ヿ]/g], ["Hangul", /[가-힯ᄀ-ᇿ]/g], ["Han", /[㐀-鿿]/g],
    ["Devanagari", /[ऀ-ॿ]/g], ["Bengali", /[ঀ-৿]/g], ["Gurmukhi", /[਀-੿]/g],
    ["Gujarati", /[઀-૿]/g], ["Oriya", /[଀-୿]/g], ["Tamil", /[஀-௿]/g],
    ["Telugu", /[ఀ-౿]/g], ["Kannada", /[ಀ-೿]/g], ["Malayalam", /[ഀ-ൿ]/g],
    ["Sinhala", /[඀-෿]/g], ["Arabic", /[؀-ۿݐ-ݿﭐ-﷿ﹰ-ﻼ]/g],
    ["Hebrew", /[֐-׿]/g], ["Thai", /[฀-๿]/g], ["Lao", /[຀-໿]/g],
    ["Khmer", /[ក-៿]/g], ["Myanmar", /[က-႟]/g], ["Georgian", /[Ⴀ-ჿ]/g],
    ["Armenian", /[԰-֏]/g], ["Ethiopic", /[ሀ-᎟]/g], ["Cyrillic", /[Ѐ-ӿ]/g],
    ["Greek", /[Ͱ-Ͽ]/g],
  ];
  let best = "Latin";
  let most = 0;
  for (const [name, re] of tests) {
    const n = text.match(re)?.length ?? 0;
    if (n > most) {
      most = n;
      best = name;
    }
  }
  // Japanese mixes kana with Han characters
  if (best === "Han" && /[぀-ヿ]/.test(text)) return "Hiragana";
  return best;
}

/** families that can draw a script, in order of how commonly their look is met */
export function familiesFor(script: string): ImageFamily[] {
  const found = FAMILIES.filter((f) => f.scripts.includes(script));
  return found.length ? found : FAMILIES.filter((f) => f.scripts.includes("Latin"));
}
