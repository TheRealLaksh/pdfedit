/** Every language tesseract.js can load (all verified on cdn.jsdelivr.net/npm/@tesseract.js-data). */
import type { OcrLanguage } from "../engine/types";

/** code | English name | native name | script; the most used languages come first */
const TABLE = `
eng|English|English|Latin
hin|Hindi|हिन्दी|Devanagari
spa|Spanish|Español|Latin
fra|French|Français|Latin
ara|Arabic|العربية|Arabic
ben|Bengali|বাংলা|Bengali
por|Portuguese|Português|Latin
rus|Russian|Русский|Cyrillic
urd|Urdu|اردو|Arabic
ind|Indonesian|Bahasa Indonesia|Latin
deu|German|Deutsch|Latin
jpn|Japanese|日本語|Japanese
chi_sim|Chinese (Simplified)|简体中文|Han
chi_tra|Chinese (Traditional)|繁體中文|Han
mar|Marathi|मराठी|Devanagari
tel|Telugu|తెలుగు|Telugu
tur|Turkish|Türkçe|Latin
tam|Tamil|தமிழ்|Tamil
vie|Vietnamese|Tiếng Việt|Latin
kor|Korean|한국어|Hangul
ita|Italian|Italiano|Latin
guj|Gujarati|ગુજરાતી|Gujarati
kan|Kannada|ಕನ್ನಡ|Kannada
mal|Malayalam|മലയാളം|Malayalam
pan|Punjabi|ਪੰਜਾਬੀ|Gurmukhi
ori|Odia|ଓଡ଼ିଆ|Oriya
asm|Assamese|অসমীয়া|Bengali
nep|Nepali|नेपाली|Devanagari
san|Sanskrit|संस्कृतम्|Devanagari
sin|Sinhala|සිංහල|Sinhala
snd|Sindhi|سنڌي|Arabic
fas|Persian|فارسی|Arabic
pus|Pashto|پښتو|Arabic
uig|Uyghur|ئۇيغۇرچە|Arabic
kmr|Kurdish (Kurmanji)|Kurmancî|Latin
heb|Hebrew|עברית|Hebrew
yid|Yiddish|ייִדיש|Hebrew
tha|Thai|ไทย|Thai
lao|Lao|ລາວ|Lao
khm|Khmer|ខ្មែរ|Khmer
mya|Burmese|မြန်မာ|Myanmar
bod|Tibetan|བོད་ཡིག|Tibetan
dzo|Dzongkha|རྫོང་ཁ|Tibetan
kat|Georgian|ქართული|Georgian
kat_old|Georgian (Old)|ძველი ქართული|Georgian
hye|Armenian|Հայերեն|Armenian
amh|Amharic|አማርኛ|Ethiopic
tir|Tigrinya|ትግርኛ|Ethiopic
ell|Greek|Ελληνικά|Greek
grc|Greek (Ancient)|Ἑλληνική|Greek
ukr|Ukrainian|Українська|Cyrillic
bel|Belarusian|Беларуская|Cyrillic
bul|Bulgarian|Български|Cyrillic
srp|Serbian (Cyrillic)|Српски|Cyrillic
srp_latn|Serbian (Latin)|Srpski|Latin
mkd|Macedonian|Македонски|Cyrillic
kaz|Kazakh|Қазақ тілі|Cyrillic
kir|Kyrgyz|Кыргызча|Cyrillic
tgk|Tajik|Тоҷикӣ|Cyrillic
mon|Mongolian|Монгол|Cyrillic
uzb|Uzbek (Latin)|Oʻzbekcha|Latin
uzb_cyrl|Uzbek (Cyrillic)|Ўзбекча|Cyrillic
aze|Azerbaijani (Latin)|Azərbaycanca|Latin
aze_cyrl|Azerbaijani (Cyrillic)|Азәрбајҹанҹа|Cyrillic
tat|Tatar|Татарча|Cyrillic
afr|Afrikaans|Afrikaans|Latin
sqi|Albanian|Shqip|Latin
eus|Basque|Euskara|Latin
bos|Bosnian|Bosanski|Latin
bre|Breton|Brezhoneg|Latin
cat|Catalan|Català|Latin
ceb|Cebuano|Cebuano|Latin
chr|Cherokee|ᏣᎳᎩ|Cherokee
cos|Corsican|Corsu|Latin
hrv|Croatian|Hrvatski|Latin
ces|Czech|Čeština|Latin
dan|Danish|Dansk|Latin
nld|Dutch|Nederlands|Latin
enm|English (Middle)|Middle English|Latin
epo|Esperanto|Esperanto|Latin
est|Estonian|Eesti|Latin
fao|Faroese|Føroyskt|Latin
fil|Filipino|Filipino|Latin
fin|Finnish|Suomi|Latin
frm|French (Middle)|Moyen français|Latin
frk|Fraktur|Fraktur|Latin
fry|Western Frisian|Frysk|Latin
glg|Galician|Galego|Latin
hat|Haitian Creole|Kreyòl ayisyen|Latin
hun|Hungarian|Magyar|Latin
isl|Icelandic|Íslenska|Latin
iku|Inuktitut|ᐃᓄᒃᑎᑐᑦ|Canadian Aboriginal
gle|Irish|Gaeilge|Latin
ita_old|Italian (Old)|Italiano antico|Latin
jav|Javanese|Basa Jawa|Latin
lat|Latin|Latina|Latin
lav|Latvian|Latviešu|Latin
lit|Lithuanian|Lietuvių|Latin
ltz|Luxembourgish|Lëtzebuergesch|Latin
msa|Malay|Bahasa Melayu|Latin
mlt|Maltese|Malti|Latin
mri|Maori|Te reo Māori|Latin
nor|Norwegian|Norsk|Latin
oci|Occitan|Occitan|Latin
pol|Polish|Polski|Latin
que|Quechua|Runa Simi|Latin
ron|Romanian|Română|Latin
gla|Scottish Gaelic|Gàidhlig|Latin
slk|Slovak|Slovenčina|Latin
slv|Slovenian|Slovenščina|Latin
spa_old|Spanish (Old)|Español antiguo|Latin
sun|Sundanese|Basa Sunda|Latin
swa|Swahili|Kiswahili|Latin
swe|Swedish|Svenska|Latin
syr|Syriac|ܣܘܪܝܝܐ|Syriac
ton|Tonga|Lea fakatonga|Latin
cym|Welsh|Cymraeg|Latin
yor|Yoruba|Yorùbá|Latin
jpn_vert|Japanese (vertical)|日本語（縦書き）|Japanese
chi_sim_vert|Chinese Simplified (vertical)|简体中文（竖排）|Han
chi_tra_vert|Chinese Traditional (vertical)|繁體中文（直排）|Han
kor_vert|Korean (vertical)|한국어 (세로쓰기)|Hangul
`;

export const OCR_LANGUAGES: OcrLanguage[] = TABLE.trim()
  .split("\n")
  .map((row) => {
    const [code, name, nativeName, script] = row.split("|") as [string, string, string, string];
    return { code, name, nativeName, script };
  });

const RTL_CODES = new Set(["ara", "urd", "fas", "pus", "uig", "snd", "heb", "yid", "syr"]);
export const isRtlLanguage = (code: string) => RTL_CODES.has(code);

/** the language to try first for a script reported by orientation and script detection */
export const SCRIPT_DEFAULTS: Record<string, string[]> = {
  Latin: ["eng"],
  Fraktur: ["frk"],
  Cyrillic: ["rus"],
  Greek: ["ell"],
  Arabic: ["ara"],
  Hebrew: ["heb"],
  Syriac: ["syr"],
  Devanagari: ["hin"],
  Bengali: ["ben"],
  Gurmukhi: ["pan"],
  Gujarati: ["guj"],
  Oriya: ["ori"],
  Tamil: ["tam"],
  Telugu: ["tel"],
  Kannada: ["kan"],
  Malayalam: ["mal"],
  Sinhala: ["sin"],
  Thai: ["tha"],
  Lao: ["lao"],
  Khmer: ["khm"],
  Myanmar: ["mya"],
  Tibetan: ["bod"],
  Georgian: ["kat"],
  Armenian: ["hye"],
  Ethiopic: ["amh"],
  Cherokee: ["chr"],
  Canadian_Aboriginal: ["iku"],
  Han: ["chi_sim"],
  Hiragana: ["jpn"],
  Katakana: ["jpn"],
  Japanese: ["jpn"],
  Hangul: ["kor"],
  Korean: ["kor"],
};
