/** Script knowledge: turning glyphs in visual order into logical Unicode, and recognising broken text. */
import bidiFactory from "bidi-js";

let bidiInstance: ReturnType<typeof bidiFactory> | null = null;
export const bidi = () => (bidiInstance ??= bidiFactory());

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|[\u{10800}-\u{10FFF}]|[\u{1E800}-\u{1EFFF}]/u;
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9\u066B\u066C]/;
const COMPLEX =
  /[\u0600-\u06FF\u0700-\u077F\u07C0-\u07FF\u08A0-\u08FF\u0900-\u0DFF\u0F00-\u109F\u1780-\u17FF\u1800-\u18AF\uA8C0-\uA8FF\uA920-\uAAFF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const CJK = /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF]|[\u{20000}-\u{3FFFF}]/u;
export const NOSPACE_SCRIPT = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF]/;

export const hasRtl = (s: string) => RTL.test(s);
/** words of these scripts change shape with their neighbours, so they are replaced whole */
export const isComplex = (s: string) => COMPLEX.test(s);
export const isMarkOnly = (s: string) => /^\p{M}+$/u.test(s);

export type Direction = "R" | "L" | "N" | "O";

export function directionOf(s: string): Direction {
  for (const ch of s) {
    if (ARABIC_DIGITS.test(ch)) return "N";
    if (/\p{L}/u.test(ch)) return RTL.test(ch) ? "R" : "L";
    if (/\p{Nd}/u.test(ch)) return "N";
    if (RTL.test(ch) && /\p{M}/u.test(ch)) return "R";
    if (ch === "\u05BE" || ch === "\u05C3") return "R";
  }
  return "O";
}

export function normalizeGlyphText(u: string): string {
  if (u === " " || u === "\u00A0") return " ";
  if (/[\uFB00-\uFDFF\uFE10-\uFE19\uFE30-\uFE4F\uFE70-\uFEFF\u2E80-\u2FDF\uF900-\uFAFF]/.test(u)) {
    const n = u.normalize("NFKC");
    return n.length > 1 ? n.replace(/^ (?=\p{M})/u, "") : n;
  }
  return u;
}

/* ---------- Indic and South East Asian reordering ---------- */

const PRE_BASE = new Set(
  [0x93f, 0x94e, 0x9bf, 0x9c7, 0x9c8, 0xa3f, 0xabf, 0xb47, 0xbc6, 0xbc7, 0xbc8, 0xd46, 0xd47, 0xd48, 0xdd9, 0xdda, 0xddb, 0x1031, 0x17c1, 0x17c2, 0x17c3, 0x103c].map(
    (c) => String.fromCharCode(c),
  ),
);
const POST_PARTS = new Set([0x9be, 0x9d7, 0xb3e, 0xb56, 0xb57, 0xbbe, 0xbd7, 0xd3e, 0xd57, 0xdcf, 0xddf, 0xdca].map((c) => String.fromCharCode(c)));
const REPH = new Set(["\u0930\u094D", "\u09B0\u09CD", "\u0AB0\u0ACD", "\u0B30\u0B4D", "\u0CB0\u0CCD"]);

function isConsonant(c: number): boolean {
  if (c >= 0x900 && c < 0xd80) {
    const o = c & 0x7f;
    return (o >= 0x15 && o <= 0x39) || (o >= 0x58 && o <= 0x5f) || c === 0x9f0 || c === 0x9f1 || c === 0xb71 || (c >= 0x978 && c <= 0x97f);
  }
  return (c >= 0xd9a && c <= 0xdc6) || (c >= 0x1000 && c <= 0x102a) || (c >= 0x1780 && c <= 0x17b3);
}

const isVirama = (c: number) =>
  (c >= 0x900 && c < 0xd80 && (c & 0x7f) === 0x4d) || c === 0xdca || c === 0x1039 || c === 0x17d2;
/** candrabindu, anusvara, visarga: they stay after the vowel sign */
const isFinalSign = (c: number) => c >= 0x900 && c < 0xd80 && (c & 0x7f) >= 1 && (c & 0x7f) <= 3;

export interface Piece {
  text: string;
  /** text came from ActualText and is already in logical order */
  actual: boolean;
}

export interface Group {
  members: number[];
  text: string;
}

const startsWithConsonant = (s: string) => s.length > 0 && isConsonant(s.charCodeAt(0));
const endsWithVirama = (s: string) => {
  const t = s.replace(/[\u200C\u200D]+$/, "");
  return t.length > 0 && isVirama(t.charCodeAt(t.length - 1));
};

/** pieces are in visual (left to right) order; the result merges those that must be reordered */
export function reorderIndic(pieces: Piece[]): Group[] {
  const groups: Group[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    const first = p.text.charAt(0);
    if (!p.actual && PRE_BASE.has(first) && i + 1 < pieces.length && !pieces[i + 1]!.actual) {
      // one or two pre-base signs, then the consonant cluster they belong to
      let k = i;
      let matras = "";
      while (k < pieces.length && !pieces[k]!.actual && pieces[k]!.text && [...pieces[k]!.text].every((c) => PRE_BASE.has(c))) {
        matras += pieces[k]!.text;
        k++;
      }
      if (k < pieces.length && startsWithConsonant(pieces[k]!.text)) {
        let cluster = pieces[k]!.text;
        let end = k;
        while (end + 1 < pieces.length && !pieces[end + 1]!.actual) {
          const next = pieces[end + 1]!.text;
          if ((endsWithVirama(cluster) && startsWithConsonant(next)) || /^[\u093C\u0ABC\u0A3C\u0B3C\u0CBC]/.test(next) || (next.length && isVirama(next.charCodeAt(0)) && !REPH.has(next))) {
            cluster += next;
            end++;
          } else break;
        }
        let tail = "";
        while (cluster.length > 1 && isFinalSign(cluster.charCodeAt(cluster.length - 1))) {
          tail = cluster.slice(-1) + tail;
          cluster = cluster.slice(0, -1);
        }
        let post = "";
        const next = pieces[end + 1];
        if (next && !next.actual && POST_PARTS.has(next.text.charAt(0))) {
          const composed = (matras.slice(-1) + next.text.charAt(0)).normalize("NFC");
          if (composed.length === 1) {
            post = next.text;
            end++;
          }
        }
        const members: number[] = [];
        for (let m = i; m <= end; m++) members.push(m);
        groups.push({ members, text: (cluster + matras + post + tail).normalize("NFC") });
        i = end;
        continue;
      }
    }
    const reph = !p.actual && p.text.length >= 2 && REPH.has(p.text.slice(0, 2));
    if (reph && (p.text.length === 2 ? true : isFinalSign(p.text.charCodeAt(2)))) {
      // the reph is drawn after the syllable it logically precedes
      let at = groups.length - 1;
      while (at >= 0 && ![...groups[at]!.text].some((c) => isConsonant(c.charCodeAt(0)))) {
        if (/\s/.test(groups[at]!.text)) at = -1;
        else at--;
      }
      if (at >= 0) {
        while (at > 0 && endsWithVirama(groups[at - 1]!.text) && !REPH.has(groups[at - 1]!.text)) at--;
        const tail = groups.splice(at);
        groups.push({
          members: [...tail.flatMap((g) => g.members), i],
          text: (p.text.slice(0, 2) + tail.map((g) => g.text).join("") + p.text.slice(2)).normalize("NFC"),
        });
        continue;
      }
    }
    groups.push({ members: [i], text: p.text });
  }
  return groups;
}

/* ---------- visual order -> logical order ---------- */

const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "\u00AB": "\u00BB", "\u00BB": "\u00AB", "\u2039": "\u203A", "\u203A": "\u2039" };
const NUMBER_SEP = /^[.,:/+\-\u2212\u066B\u066C]$/;
const NUMBER_TERM = /^[%$\u20AC\u00A3\u00A5\u20B9#\u00B0\u066A\u2030]$/;

export interface LogicalOrder {
  /** visual indices in logical order */
  order: number[];
  rtl: boolean;
  /** visual index -> replacement text for mirrored brackets */
  mirrored: Map<number, string>;
}

/** \p{Nd} written left to right inside right to left text without ever joining a Latin run */
const nativeDigit = (s: string) => ARABIC_DIGITS.test(s);

/**
 * Which way the line reads, judged from glyphs in visual order: the strong characters at both ends, then
 * punctuation between the two directions (it hugs the word it follows), then the final stop, then the rest
 * of the page.
 */
function paragraphIsRtl(pieces: Piece[], types: Direction[], fallback: boolean): boolean {
  const strong = types.filter((t) => t === "R" || t === "L");
  const ends = (strong[0] ?? "") + (strong[strong.length - 1] ?? "");
  if (ends === "LL") return false;
  if (ends === "RR") return true;
  const blank = (i: number) => i >= 0 && i < pieces.length && !pieces[i]!.text.trim();
  const letter = (i: number, step: number) => {
    for (let k = i + step; k >= 0 && k < pieces.length; k += step) if (types[k] === "R" || types[k] === "L") return types[k];
    return null;
  };
  let vote = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (!/^[.,:;!?\u060C\u061B\u061F]$/.test(pieces[i]!.text)) continue;
    const left = letter(i, -1);
    const right = letter(i, 1);
    if (!left || !right || left === right) continue;
    // it must actually touch the right to left text, not merely separate two numbers on the way there
    const near = (step: number) => {
      let k = i + step;
      while (blank(k)) k += step;
      return types[k];
    };
    if (near(-1) !== "R" && near(1) !== "R") continue;
    if (blank(i + 1) && !blank(i - 1)) vote--;
    else if (blank(i - 1) && !blank(i + 1)) vote++;
  }
  if (vote) return vote > 0;
  const stop = /^[.!?:;\u061F\u06D4\u0964]$/;
  const solid = pieces.filter((p) => p.text.trim());
  const stopLeft = stop.test(solid[0]?.text ?? "");
  const stopRight = stop.test(solid[solid.length - 1]?.text ?? "");
  return stopLeft !== stopRight ? stopLeft : fallback;
}

/** @param prior the reading direction of the surrounding page, used when the line itself does not say */
export function visualToLogical(pieces: Piece[], prior?: boolean): LogicalOrder {
  const n = pieces.length;
  const identity = Array.from({ length: n }, (_, i) => i);
  const types = pieces.map((p) => directionOf(p.text));
  let r = 0;
  let l = 0;
  types.forEach((t) => {
    if (t === "R") r++;
    else if (t === "L") l++;
  });
  if (!r) return { order: identity, rtl: false, mirrored: new Map() };
  const rtl = paragraphIsRtl(pieces, types, prior ?? r >= l);
  // separators between digits and signs next to digits travel with the number
  for (let i = 0; i < n; i++) {
    if (types[i] !== "O") continue;
    const t = pieces[i]!.text;
    if (NUMBER_SEP.test(t) && types[i - 1] === "N" && types[i + 1] === "N") types[i] = "N";
    else if (NUMBER_TERM.test(t) && (types[i - 1] === "N" || types[i + 1] === "N")) types[i] = "N";
  }
  let order = identity.slice();
  const embedded = new Array<boolean>(n).fill(false);
  const reverseRange = (list: number[], from: number, to: number) => {
    while (from < to) {
      const t = list[from]!;
      list[from++] = list[to]!;
      list[to--] = t;
    }
  };
  if (rtl) {
    // Left to right stretches, in visual terms: from a Latin letter rightwards over everything up to the
    // next right to left letter, ending at its last letter or European number (UAX #9 W7 and N1). Numbers
    // not claimed that way stand on their own.
    const runs: [number, number][] = [];
    for (let i = 0; i < n; ) {
      const t = types[i];
      if (t !== "L" && t !== "N") {
        i++;
        continue;
      }
      let end = i;
      for (let j = i + 1; j < n; j++) {
        const u = types[j];
        if (u === "R") break;
        if (t === "L") {
          if (u === "N" && nativeDigit(pieces[j]!.text)) break;
          if (u === "L" || u === "N") end = j;
        } else {
          if (u !== "N") break;
          end = j;
        }
      }
      runs.push([i, end]);
      i = end + 1;
    }
    order.reverse();
    for (const [from, to] of runs) {
      for (let k = from; k <= to; k++) embedded[k] = true;
      reverseRange(order, n - 1 - to, n - 1 - from);
    }
  } else {
    for (let i = 0; i < n; i++) {
      if (types[i] !== "R") continue;
      let end = i;
      for (let j = i + 1; j < n; j++) {
        if (types[j] === "L") break;
        if (types[j] === "R") end = j;
      }
      for (let k = i; k <= end; k++) embedded[k] = true;
      reverseRange(order, i, end);
      // numbers inside the run keep their left to right order
      for (let k = i; k <= end; k++) {
        if (types[order[k]!] !== "N") continue;
        let m = k;
        while (m < end && types[order[m + 1]!] === "N") m++;
        reverseRange(order, k, m);
        k = m;
      }
      i = end;
    }
  }
  const mirrored = new Map<number, string>();
  for (let i = 0; i < n; i++) {
    const inRtl = rtl ? !embedded[i] : embedded[i];
    const m = MIRROR[pieces[i]!.text];
    if (inRtl && m && !pieces[i]!.actual) mirrored.set(i, m);
  }
  if (mirrored.size) {
    const balance = (use: boolean) => {
      let depth = 0;
      let bad = 0;
      for (const i of order) {
        const t = (use && mirrored.get(i)) || pieces[i]!.text;
        if (/^[([{\u00AB\u2039]$/.test(t)) depth++;
        else if (/^[)\]}\u00BB\u203A]$/.test(t)) depth > 0 ? depth-- : bad++;
      }
      return bad * 2 + depth;
    };
    if (balance(false) < balance(true)) mirrored.clear();
  }
  return { order, rtl, mirrored };
}

/** UAX #9 rule L2 over whole items: returns item indices in visual (left to right) order */
export function reorderByLevels(levels: number[]): number[] {
  const order = levels.map((_, i) => i);
  const max = Math.max(0, ...levels);
  const lowestOdd = Math.min(...levels.filter((l) => l % 2 === 1), max + 1);
  for (let level = max; level >= lowestOdd; level--) {
    for (let i = 0; i < order.length; i++) {
      if (levels[order[i]!]! < level) continue;
      let j = i;
      while (j + 1 < order.length && levels[order[j + 1]!]! >= level) j++;
      for (let a = i, b = j; a < b; a++, b--) {
        const t = order[a]!;
        order[a] = order[b]!;
        order[b] = t;
      }
      i = j;
    }
  }
  return order;
}

/* ---------- broken text ---------- */

const LEGACY_FONTS =
  /kruti|devlys|chanakya|shusha|walkman.?chanakya|shivaji(?!.*unicode)|aps.?dv|dvtt|shree.?(lipi|dev|ban|tam|guj|tel|kan|mal|ori)|bamini|tscii|^tam.?ttf|nudi\b|baraha|preeti|kantipur|sagarmatha|sutonny(?!omj)|bijoy|anmol.?lipi|gurbani|asees|satluj|terafont|ml.?tt|fml.?tt|akruti|krishna.?wide|agra.?thin|kundli|yogesh|ismoffice|winkey/i;

export const isLegacyFont = (name: string) => LEGACY_FONTS.test(name);

export function countBadChars(s: string): number {
  return (s.match(/[\uFFFD\uE000-\uF8FF\u{F0000}-\u{10FFFD}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu) ?? []).length;
}

/** dependent signs that cannot legally appear where they are */
export function invalidIndicSequences(s: string): number {
  let bad = 0;
  const t = s.normalize("NFC");
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x900 || c >= 0xd80) continue;
    const o = c & 0x7f;
    const vowelSign = (o >= 0x3e && o <= 0x4c) || (o >= 0x62 && o <= 0x63);
    const dependent = vowelSign || o === 0x4d;
    if (!dependent) continue;
    const prev = i ? t.charCodeAt(i - 1) : 0;
    if (prev < 0x900 || prev >= 0xd80) {
      bad++;
      continue;
    }
    const po = prev & 0x7f;
    const prevVowel = (po >= 0x3e && po <= 0x4c) || po === 0x4d;
    const independentVowel = po >= 0x05 && po <= 0x14;
    if ((prevVowel && vowelSign) || (independentVowel && o === 0x4d)) bad++;
  }
  return bad;
}
