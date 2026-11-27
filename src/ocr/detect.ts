/**
 * Language refinement for automatic mode: script detection only says "Latin" or "Devanagari", so the
 * first result is inspected for tell-tale words and, when unsure, other models of the same script are
 * tried and the most confident one wins.
 */

const STOPWORDS: Record<string, string> = {
  eng: "the and of to in is that for with was are this be on by as from or not have at which you it",
  fra: "le la les des et est une un du que pour dans sur pas au avec qui ce nous vous sont cette aux",
  deu: "der die das und ist nicht ein eine mit den von zu für auf dem sich auch wird werden oder im des",
  spa: "el la los las de que y en un una es por con para del se su al como más pero sus este esta",
  por: "o os as de que e em um uma é por com para do da não se na no mais ao dos das são",
  ita: "il lo gli di che e è un una per con non del della sono nel alla più come anche dei delle",
  nld: "de het een en van is dat niet op te zijn voor met aan ook bij worden wordt deze",
  pol: "i w na się nie jest do z że to jak od przez oraz dla są po które który",
  tur: "ve bir bu için ile de da olan olarak daha çok gibi en ne değil sonra",
  vie: "và của là có không được cho các một những trong người đã với này khi",
  ind: "yang dan di ini itu dengan untuk dari pada adalah dalam tidak akan atau juga sebagai",
  swe: "och att det som är på av för med den inte till ett har om eller kan",
  nor: "og det som er på av for med den ikke til et har om eller kan jeg",
  dan: "og det som er på af for med den ikke til et har om eller kan jeg",
  fin: "ja on ei että se oli hän mutta ovat myös kuin tai sekä joka",
  ron: "și de la în a cu pe pentru este un o din care sau mai sunt",
  ces: "a v na je se že s z do i pro jako to by jsou které při",
  hun: "a az és hogy nem is egy meg van volt de ez vagy mint csak",
};

const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(" "))]));

/** the Latin-script language the words most likely belong to, or null when English (or unclear) */
export function guessLatin(text: string): string | null {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 6) return null;
  const score: Record<string, number> = {};
  for (const [lang, set] of Object.entries(SETS)) {
    let n = 0;
    for (const w of words) if (set.has(w)) n++;
    score[lang] = n / words.length;
  }
  const [best, value] = Object.entries(score).sort((a, b) => b[1] - a[1])[0]!;
  const english = score.eng ?? 0;
  return best !== "eng" && value >= 0.1 && value > english * 1.6 ? best : null;
}

export interface Alternative {
  lang: string;
  /** the text itself points at this language: a slightly less sure reading still wins */
  evidence: boolean;
}

/** other models worth trying after a first pass with `lang`, judged by the text it produced */
export function alternatives(lang: string, raw: string, confidence: number): Alternative[] {
  // the Arabic model writes Persian letters in their Arabic forms
  const text = lang === "ara" ? raw.replace(/\u0643/g, "\u06A9").replace(/[\u064A\u0649](?=\p{L})/gu, "\u06CC") : raw;
  const has = (re: RegExp) => (text.match(re)?.length ?? 0) >= 2;
  const told = (...langs: string[]) => langs.map((l) => ({ lang: l, evidence: true }));
  const unsure = (below: number, ...langs: string[]) => (confidence < below ? langs.map((l) => ({ lang: l, evidence: false })) : []);
  switch (lang) {
    case "eng": {
      const other = guessLatin(text);
      return other ? told(other) : [];
    }
    case "hin": {
      if (has(/आहे|आणि|नाही|च्या|साठी|होते/g)) return told("mar");
      if (has(/ छ[ ।]|गरेको|भएको|लागि|हुन्छ|छन्/g)) return told("nep");
      return [];
    }
    case "ben":
      return has(/[ৰৱ]/g) ? told("asm") : [];
    case "ara": {
      if (has(/[ٹڈڑںھہۓے]/g) || has(/(?<= |^)(ہے|کے|میں|اور|کی|سے|ھے|ہیں)(?= |$)/g)) return told("urd");
      if (has(/(?<= |^)(است|که|از|را|برای|این|باز|هر)(?= |$|\.)/g) || has(/[پچژگ]/g)) return told("fas", "urd");
      return unsure(78, "urd", "fas");
    }
    case "rus": {
      if (has(/[іїєґ]/gi) || has(/(?<= |^)(що|та|це|як|від|є)(?= |$)/gi)) return told("ukr");
      return unsure(82, "ukr", "bul");
    }
    case "heb":
      return unsure(75, "yid");
    case "chi_sim":
      return unsure(86, "chi_tra", "jpn");
    case "jpn":
      return unsure(75, "chi_sim");
    default:
      return [];
  }
}

/** tried one by one, on a small piece of the page, when script detection fails */
export const PROBES = [
  "eng", "hin", "ara", "chi_sim", "rus", "ben", "tam", "tel", "guj", "kan", "mal", "pan", "jpn", "kor", "tha", "heb", "ell",
];
