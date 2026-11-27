/**
 * The catalog: names map to sensible families, and (with FONTS_VERIFY_URLS=1) every single URL answers
 * with a real TrueType / OpenType file.
 */
import { describe, expect, test } from "vitest";
import { catalogChoices, FAMILIES, family, matchName } from "../../src/engine/fonts/catalog";
import { SCRIPTS } from "../../src/engine/fonts/scripts";

describe("catalog", () => {
  test("every script points at families that exist", () => {
    for (const s of SCRIPTS)
      for (const key of [s.sans, s.serif, s.mono]) if (key) expect(family(key), `${s.name}: ${key}`).toBeDefined();
  });

  test("urls are pinned TrueType files on jsdelivr", () => {
    for (const f of FAMILIES)
      for (const url of Object.values(f.urls)) expect(url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[\w-]+\/)?[\w-]+@\d+\.\d+\.\d+\/.+\.ttf$/);
  });

  test("ids are unique", () => {
    const ids = catalogChoices().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each([
    ["Arial", "arimo"],
    ["ABCDEF+Arial-BoldMT", "arimo"],
    ["Helvetica-Oblique", "arimo"],
    ["TimesNewRomanPSMT", "tinos"],
    ["Times-Roman", "tinos"],
    ["Courier-Bold", "cousine"],
    ["CourierNewPS-BoldItalicMT", "cousine"],
    ["BCDEFG+Calibri,Bold", "carlito"],
    ["Cambria", "caladea"],
    ["CambriaMath", "stix-two-math"],
    ["Georgia-Italic", "gelasio"],
    ["Verdana", "dejavu-sans"],
    ["SegoeUI-Semibold", "open-sans"],
    ["Roboto-Medium", "roboto"],
    ["RobotoMono-Regular", "roboto-mono"],
    ["OpenSans-BoldItalic", "open-sans"],
    ["Lato-Light", "lato"],
    ["Poppins-SemiBold", "poppins"],
    ["Inter-Regular", "inter"],
    ["Interstate-Regular", undefined],
    ["NotoSansDevanagari-Bold", "noto-sans-devanagari"],
    ["NotoSerifDevanagari-Regular", "noto-serif-devanagari"],
    ["LiberationSerif-Bold", "tinos"],
    ["Mangal", "noto-sans-devanagari"],
    ["Kruti Dev 010", "noto-sans-devanagari"],
    ["Latha", "noto-sans-tamil"],
    ["Vrinda-Bold", "noto-sans-bengali"],
    ["SimSun", "noto-serif-sc"],
    ["MicrosoftYaHei-Bold", "noto-sans-sc"],
    ["MS-Mincho", "noto-serif-jp"],
    ["MalgunGothic", "noto-sans-kr"],
    ["PMingLiU", "noto-serif-tc"],
    ["Jameel-Noori-Nastaleeq", "noto-nastaliq-urdu"],
    ["TraditionalArabic", "amiri"],
    ["CMR10", "computer-modern"],
    ["AAAAAA+CMBX12", "computer-modern"],
    ["CMTT10", "computer-modern-typewriter"],
    ["Wingdings-Regular", "noto-sans-symbols-2"],
    ["SomethingNobodyHas", undefined],
  ])("%s -> %s", (name, key) => {
    expect(matchName(name)?.family.key).toBe(key);
  });

  test.runIf(process.env.FONTS_VERIFY_URLS)(
    "every url is a real font",
    async () => {
      const urls = FAMILIES.flatMap((f) => Object.values(f.urls));
      const failed: string[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: 12 }, async () => {
          while (next < urls.length) {
            const url = urls[next++]!;
            let problem = "";
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const res = await fetch(url, { headers: { Range: "bytes=0-3" } });
                const head = new Uint8Array(await res.arrayBuffer()).slice(0, 4);
                const magic = [...head].join(",");
                if (res.ok && (magic === "0,1,0,0" || magic === "79,84,84,79" || magic === "116,114,117,101")) problem = "";
                else problem = `${res.status} ${magic}`;
              } catch (e) {
                problem = String(e);
              }
              if (!problem) break;
            }
            if (problem) failed.push(`${url} ${problem}`);
          }
        }),
      );
      console.log(`verified ${urls.length - failed.length} of ${urls.length} font URLs`);
      expect(failed).toEqual([]);
    },
    600_000,
  );
});
