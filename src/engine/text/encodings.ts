/** Simple-font encodings and glyph names (a compact subset of the Adobe Glyph List plus its naming rules). */

type Table = string[]; // 256 entries, "" = undefined

const ascii = (): Table => {
  const t: Table = new Array(256).fill("");
  for (let c = 32; c < 127; c++) t[c] = String.fromCharCode(c);
  return t;
};

const fill = (t: Table, start: number, codes: string) => {
  const list = codes.split(" ");
  for (let i = 0; i < list.length; i++) {
    const v = parseInt(list[i]!, 16);
    if (v) t[start + i] = String.fromCharCode(v);
  }
};

const winAnsi = (() => {
  const t = ascii();
  fill(
    t,
    0x80,
    "20AC 0 201A 192 201E 2026 2020 2021 2C6 2030 160 2039 152 0 17D 0 0 2018 2019 201C 201D 2022 2013 2014 2DC 2122 161 203A 153 0 17E 178",
  );
  for (let c = 0xa0; c < 256; c++) t[c] = String.fromCharCode(c);
  t[0xa0] = " ";
  t[0xad] = "-";
  return t;
})();

const macRoman = (() => {
  const t = ascii();
  fill(
    t,
    0x80,
    "C4 C5 C7 C9 D1 D6 DC E1 E0 E2 E4 E3 E5 E7 E9 E8 EA EB ED EC EE EF F1 F3 F2 F4 F6 F5 FA F9 FB FC " +
      "2020 B0 A2 A3 A7 2022 B6 DF AE A9 2122 B4 A8 2260 C6 D8 221E B1 2264 2265 A5 B5 2202 2211 220F 3C0 222B AA BA 3A9 E6 F8 " +
      "BF A1 AC 221A 192 2248 2206 AB BB 2026 A0 C0 C3 D5 152 153 2013 2014 201C 201D 2018 2019 F7 25CA FF 178 2044 20AC 2039 203A FB01 FB02 " +
      "2021 B7 201A 201E 2030 C2 CA C1 CB C8 CD CE CF CC D3 D4 F8FF D2 DA DB D9 131 2C6 2DC AF 2D8 2D9 2DA B8 2DD 2DB 2C7",
  );
  t[0xca] = " ";
  return t;
})();

const standard = (() => {
  const t = ascii();
  t[0x27] = "\u2019";
  t[0x60] = "\u2018";
  const pairs =
    "A1:A1 A2:A2 A3:A3 A4:2044 A5:A5 A6:192 A7:A7 A8:A4 A9:27 AA:201C AB:AB AC:2039 AD:203A AE:FB01 AF:FB02 B1:2013 B2:2020 B3:2021 " +
    "B4:B7 B6:B6 B7:2022 B8:201A B9:201E BA:201D BB:BB BC:2026 BD:2030 BF:BF C1:60 C2:B4 C3:2C6 C4:2DC C5:AF C6:2D8 C7:2D9 C8:A8 " +
    "CA:2DA CB:B8 CD:2DD CE:2DB CF:2C7 D0:2014 E1:C6 E3:AA E8:141 E9:D8 EA:152 EB:BA F1:E6 F5:131 F8:142 F9:F8 FA:153 FB:DF";
  for (const p of pairs.split(" ")) {
    const [c, u] = p.split(":");
    t[parseInt(c!, 16)] = String.fromCharCode(parseInt(u!, 16));
  }
  return t;
})();

const symbol = (() => {
  const t: Table = new Array(256).fill("");
  fill(
    t,
    0x20,
    "20 21 2200 23 2203 25 26 220B 28 29 2217 2B 2C 2212 2E 2F 30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F " +
      "2245 391 392 3A7 394 395 3A6 393 397 399 3D1 39A 39B 39C 39D 39F 3A0 398 3A1 3A3 3A4 3A5 3C2 3A9 39E 3A8 396 5B 2234 5D 22A5 5F " +
      "F8E5 3B1 3B2 3C7 3B4 3B5 3C6 3B3 3B7 3B9 3D5 3BA 3BB 3BC 3BD 3BF 3C0 3B8 3C1 3C3 3C4 3C5 3D6 3C9 3BE 3C8 3B6 7B 7C 7D 223C",
  );
  fill(
    t,
    0xa0,
    "20AC 3D2 2032 2264 2044 221E 192 2663 2666 2665 2660 2194 2190 2191 2192 2193 B0 B1 2033 2265 D7 221D 2202 2022 F7 2260 2261 2248 2026 F8E6 F8E7 21B5 " +
      "2135 2111 211C 2118 2297 2295 2205 2229 222A 2283 2287 2284 2282 2286 2208 2209 2220 2207 AE A9 2122 220F 221A 22C5 AC 2227 2228 21D4 21D0 21D1 21D2 21D3 " +
      "25CA 2329 AE A9 2122 2211 F8EB F8EC F8ED F8EE F8EF F8F0 F8F1 F8F2 F8F3 F8F4 0 232A 222B 2320 F8F5 2321 F8F6 F8F7 F8F8 F8F9 F8FA F8FB F8FC F8FD F8FE",
  );
  return t;
})();

export function baseEncoding(name: string | undefined): Table | null {
  switch (name) {
    case "WinAnsiEncoding":
      return winAnsi;
    case "MacRomanEncoding":
    case "MacExpertEncoding":
      return macRoman;
    case "StandardEncoding":
      return standard;
    case "SymbolEncoding":
      return symbol;
    default:
      return null;
  }
}

/* ---------- glyph names ---------- */

const NAMES = new Map<string, string>();
const add = (spec: string) => {
  for (const p of spec.split(" ")) {
    if (!p) continue;
    const [n, u] = p.split(":");
    NAMES.set(n!, u!.split("+").map((h) => String.fromCodePoint(parseInt(h, 16))).join(""));
  }
};
const run = (start: number, names: string) => {
  names.split(" ").forEach((n, i) => n && NAMES.set(n, String.fromCodePoint(start + i)));
};

run(
  32,
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash " +
    "zero one two three four five six seven eight nine colon semicolon less equal greater question at",
);
for (let c = 65; c <= 90; c++) {
  NAMES.set(String.fromCharCode(c), String.fromCharCode(c));
  NAMES.set(String.fromCharCode(c + 32), String.fromCharCode(c + 32));
}
run(91, "bracketleft backslash bracketright asciicircum underscore grave");
run(123, "braceleft bar braceright asciitilde");
run(
  0xa0,
  "nbspace exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot softhyphen registered macron " +
    "degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown " +
    "Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis " +
    "Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls " +
    "agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis " +
    "eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis",
);
add(
  "quoteleft:2018 quoteright:2019 quotedblleft:201C quotedblright:201D quotesinglbase:201A quotedblbase:201E guilsinglleft:2039 guilsinglright:203A " +
    "endash:2013 emdash:2014 bullet:2022 ellipsis:2026 dagger:2020 daggerdbl:2021 perthousand:2030 fraction:2044 florin:192 Euro:20AC euro:20AC trademark:2122 " +
    "fi:66+69 fl:66+6C ff:66+66 ffi:66+66+69 ffl:66+66+6C ft:66+74 st:73+74 minus:2212 nbhyphen:2011 figuredash:2012 horizontalbar:2015 " +
    "OE:152 oe:153 Scaron:160 scaron:161 Zcaron:17D zcaron:17E Ydieresis:178 dotlessi:131 dotlessj:237 Lslash:141 lslash:142 circumflex:2C6 tilde:2DC breve:2D8 " +
    "dotaccent:2D9 ring:2DA ogonek:2DB hungarumlaut:2DD caron:2C7 Dcroat:110 dcroat:111 Hbar:126 hbar:127 Eng:14A eng:14B Tbar:166 tbar:167 IJ:132 ij:133 kgreenlandic:138 longs:17F " +
    "Gcommaaccent:122 gcommaaccent:123 Idotaccent:130 napostrophe:149 Ldot:13F ldot:140 schwa:259 Schwa:18F " +
    "notequal:2260 lessequal:2264 greaterequal:2265 infinity:221E partialdiff:2202 summation:2211 product:220F pi:3C0 integral:222B Omega:2126 radical:221A approxequal:2248 Delta:2206 lozenge:25CA " +
    "arrowleft:2190 arrowup:2191 arrowright:2192 arrowdown:2193 arrowboth:2194 element:2208 notelement:2209 emptyset:2205 intersection:2229 union:222A propersubset:2282 propersuperset:2283 " +
    "logicaland:2227 logicalor:2228 equivalence:2261 gradient:2207 similar:223C proportional:221D angle:2220 therefore:2234 perpendicular:22A5 universal:2200 existential:2203 asteriskmath:2217 dotmath:22C5 circlemultiply:2297 circleplus:2295 " +
    "H18533:25CF H18543:25AA H18551:25AB H22073:25A1 filledbox:25A0 filledrect:25AC triagup:25B2 triagdn:25BC triagrt:25BA triaglf:25C4 circle:25CB openbullet:25E6 invbullet:25D8 smileface:263A " +
    "heart:2665 diamond:2666 club:2663 spade:2660 musicalnote:266A checkmark:2713 estimated:212E numero:2116 afii61289:2113 afii61352:2116 colonmonetary:20A1 franc:20A3 lira:20A4 peseta:20A7 dong:20AB sheqel:20AA rupee:20B9 " +
    "onethird:2153 twothirds:2154 oneeighth:215B threeeighths:215C fiveeighths:215D seveneighths:215E zerosuperior:2070 foursuperior:2074 zeroinferior:2080 oneinferior:2081 twoinferior:2082 threeinferior:2083",
);
// Greek
run(0x391, "Alpha Beta Gamma Deltagreek Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho");
run(0x3a3, "Sigma Tau Upsilon Phi Chi Psi Omegagreek Iotadieresis Upsilondieresis alphatonos epsilontonos etatonos iotatonos upsilondieresistonos");
run(0x3b1, "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mugreek nu xi omicron pigreek rho sigma1 sigma tau upsilon phi chi psi omega iotadieresis upsilondieresis omicrontonos upsilontonos omegatonos");
add("Alphatonos:386 Epsilontonos:388 Etatonos:389 Iotatonos:38A Omicrontonos:38C Upsilontonos:38E Omegatonos:38F iotadieresistonos:390 tonos:384 dieresistonos:385 anoteleia:387 theta1:3D1 Upsilon1:3D2 phi1:3D5 omega1:3D6 Omega:3A9");
// Cyrillic (afii names)
const cyr = (from: number, count: number, uni: number) => {
  for (let i = 0; i < count; i++) NAMES.set(`afii${from + i}`, String.fromCharCode(uni + i));
};
cyr(10017, 6, 0x410);
cyr(10024, 26, 0x416);
cyr(10065, 6, 0x430);
cyr(10072, 26, 0x436);
add("afii10023:401 afii10071:451 afii10050:490 afii10098:491");
cyr(10051, 12, 0x402);
add("afii10062:40E afii10145:40F");
cyr(10099, 12, 0x452);
add("afii10110:45E afii10193:45F");
// Hebrew and Arabic afii names
cyr(57664, 27, 0x5d0);
add(
  "afii57388:60C afii57403:61B afii57407:61F afii57409:621 afii57410:622 afii57411:623 afii57412:624 afii57413:625 afii57414:626 afii57415:627",
);
cyr(57416, 19, 0x628);
cyr(57440, 19, 0x640);
cyr(57392, 10, 0x660);

const ACCENTS: Record<string, string> = {
  acute: "\u0301",
  grave: "\u0300",
  circumflex: "\u0302",
  dieresis: "\u0308",
  tilde: "\u0303",
  ring: "\u030A",
  cedilla: "\u0327",
  caron: "\u030C",
  breve: "\u0306",
  ogonek: "\u0328",
  macron: "\u0304",
  dotaccent: "\u0307",
  hungarumlaut: "\u030B",
  commaaccent: "\u0326",
  dotbelow: "\u0323",
  hookabove: "\u0309",
  horn: "\u031B",
};

/** Unicode for a PDF glyph name, "" when unknown. */
export function glyphNameToUnicode(name: string): string {
  const direct = NAMES.get(name);
  if (direct !== undefined) return direct;
  const dot = name.indexOf(".");
  if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));
  if (name.includes("_")) {
    const parts = name.split("_").map(glyphNameToUnicode);
    return parts.every(Boolean) ? parts.join("") : "";
  }
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) {
    let s = "";
    for (let i = 0; i < m[1]!.length; i += 4) s += String.fromCharCode(parseInt(m[1]!.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const v = parseInt(m[1]!, 16);
    return v <= 0x10ffff ? String.fromCodePoint(v) : "";
  }
  m = /^([A-Za-z])([a-z]+)$/.exec(name);
  if (m) {
    let rest = m[2]!;
    let marks = "";
    outer: while (rest) {
      for (const [k, v] of Object.entries(ACCENTS)) {
        if (rest.startsWith(k)) {
          marks += v;
          rest = rest.slice(k.length);
          continue outer;
        }
      }
      return "";
    }
    return (m[1]! + marks).normalize("NFC");
  }
  return "";
}
