/**
 * One line of text -> positioned glyphs. Itemised by script, bidi level and font (fallback per grapheme
 * cluster), shaped with HarfBuzz, reordered visually; glyphs are returned in LOGICAL order.
 */
import bidiFactory from "bidi-js";
import type { EngineContext } from "../context";
import type { Face } from "./face";
import { harfbuzz } from "./hb";
import { createResolver, type Resolver, type Source } from "./resolve";
import { clusterScript, scriptInfo } from "./scripts";
import type { MeasureTextRequest, PlannedText } from "./types";

export interface PlacedGlyph {
  source: Source;
  face: Face;
  gid: number;
  /** font size this glyph is drawn at (substitutes are sized to match the original) */
  size: number;
  /** glyph origin relative to the line's left baseline point, points, y up (before horizontal scale) */
  x: number;
  y: number;
  /** the logical text this glyph stands for ("" for the extra glyphs of a cluster) */
  text: string;
  /**
   * Advance to declare for this glyph instead of the font's, in thousandths of the font size. Used
   * when one glyph carries the text of a whole cluster (it then spans the cluster, the others are
   * zero wide), so that text extraction sees continuous characters.
   */
  declared?: number;
  /** starts a cluster of this many glyphs that is marked with the text as ActualText */
  actual?: { text: string; glyphs: number };
}

export interface Layout extends PlannedText {
  /** logical order, so that extracting the content stream gives the text back */
  glyphs: PlacedGlyph[];
  /** width before horizontal scaling */
  advance: number;
  /** the text as drawn (control characters replaced) */
  text: string;
  rtl: boolean;
  /** faces used, for metrics */
  primary: Face;
}

const bidi = bidiFactory();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// a class of invisible code points, some of them combining on purpose
// oxlint-disable-next-line no-misleading-character-class
const IGNORABLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E0FFF}]/u;
const SPACE = /\p{Zs}/u;

/** what the extra glyphs of a cluster map to: invisible, and ignored by text search */
export const FILLER = "\uFEFF";

/**
 * Joins neighbouring clusters when a mark of one sits inside the other (conjuncts, subscripts), so
 * that one marked span covers both and readers that sort glyphs by position cannot mix them up.
 */
function mergeOverlapping(groups: ShapedGroup[], size: number): ShapedGroup[] {
  const slack = size * 0.05;
  const strays = (g: ShapedGroup, side: -1 | 1) =>
    g.glyphs.length > 1 &&
    g.glyphs.some(
      (gl) => g.run.face.hbFont.glyphHAdvance(gl.gid) === 0 && (side < 0 ? gl.x < g.x - slack : gl.x > g.x + g.width + slack),
    );
  const out: ShapedGroup[] = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    const joins =
      last && last.run === g.run && last.end === g.start && !(g.run.level & 1) && (strays(g, -1) || strays(last, 1)) &&
      !/^\s/.test(g.run.text.slice(g.start, g.end)) && !/\s$/.test(g.run.text.slice(last.start, last.end));
    if (!joins) {
      out.push(g);
      continue;
    }
    const left = Math.min(last.x, g.x);
    out[out.length - 1] = {
      ...last,
      end: g.end,
      x: left,
      width: Math.max(last.x + last.width, g.x + g.width) - left,
      glyphs: [...last.glyphs, ...g.glyphs],
    };
  }
  return out;
}

export const cleanText = (text: string) =>
  // oxlint-disable-next-line no-control-regex
  text.replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, " ").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\p{Surrogate}/gu, "\uFFFD");

interface Cluster {
  start: number;
  end: number;
  text: string;
  own: string;
  script: string;
  level: number;
  source: Source;
  face: Face;
}

/** every character of the cluster (as written, composed or decomposed) is in the font */
function covers(face: Face, source: Source, text: string): boolean {
  const check = (s: string) => {
    for (const ch of s) {
      if (IGNORABLE.test(ch)) continue;
      let cp = ch.codePointAt(0)!;
      const space = SPACE.test(ch);
      let g = face.glyph(cp);
      if (!g && space) {
        cp = 32;
        g = face.glyph(cp);
      }
      if (!g) return false;
      if (source.needsOutlineCheck && !space && !face.hasOutline(g)) return false;
    }
    return true;
  };
  if (check(text)) return true;
  const nfc = text.normalize("NFC");
  if (nfc !== text && check(nfc)) return true;
  const nfd = text.normalize("NFD");
  return nfd !== text && check(nfd);
}

function canShape(face: Face, source: Source, script: string): boolean {
  if (!source.needsShapingCheck) return true;
  const tags = scriptInfo(script)?.ot;
  return !tags || tags.some((t) => face.gsubScripts.has(t));
}

function bidiLevels(text: string): { levels: Uint8Array; base: number } {
  const result = bidi.getEmbeddingLevels(text);
  const levels = result.levels.slice();
  const base = result.paragraphs[0]?.level ?? 0;
  // rule L1: trailing whitespace takes the paragraph direction
  for (let i = text.length - 1; i >= 0 && /\s/.test(text[i]!); i--) levels[i] = base;
  return { levels, base };
}

/** substitutes drawn so much like the original that single letters of theirs do not show inside a word */
export const LOOKALIKE: Record<string, RegExp> = { Arimo: /arial|helvetica/i, Tinos: /times/i };

/**
 * Ranges of words the document's own subset can only draw in part. When the substitute looks different,
 * such a word is drawn in the substitute as a whole: odd letters inside a word stand out far more.
 */
async function patchworkRanges(resolver: Resolver, text: string): Promise<{ start: number; end: number; key: string }[]> {
  const out: { start: number; end: number; key: string }[] = [];
  const [own, next] = resolver.base;
  if (!own?.key.startsWith("doc:")) return out;
  if (next && (!next.substituted || LOOKALIKE[next.family]?.test(own.family))) return out;
  const face = await own.load();
  if (!face) return out;
  for (const word of text.matchAll(/[^ ]+/g)) {
    // only alphabets: each syllable or ideograph of other scripts stands on its own
    if (!/^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{M}]+$/u.test(word[0])) continue;
    const parts = [...segmenter.segment(word[0])].map((s) => covers(face, own, s.segment));
    if (parts.includes(true) && parts.includes(false)) out.push({ start: word.index, end: word.index + word[0].length, key: own.key });
  }
  return out;
}

/** every font may hold these, or the fonts of other scripts would be asked for plain letters */
const EVERYWHERE = new Set(["Latin", "Greek", "Cyrillic", "Common", "Inherited"]);
const EAST_ASIAN = new Set(["Han", "Hiragana", "Katakana", "Hangul", "Bopomofo"]);
/** punctuation shared by Indic scripts that only their fonts have */
const DANDA = /[।॥]/;

/** false when a downloadable font cannot hold this script, so it need not be fetched to find out */
function mayHold(source: Source, script: string): boolean {
  const held = source.scripts;
  if (!held || EVERYWHERE.has(script) || held.includes(script)) return true;
  if (held.includes("Symbols") || held.includes("Math")) return true;
  if (EAST_ASIAN.has(script) && held.some((s) => EAST_ASIAN.has(s))) return true;
  const info = scriptInfo(script);
  return !info || [info.sans, info.serif, info.mono].some((key) => !!key && source.choice === `web:${key}`);
}

/**
 * Fonts of different scripts are fetched at the same time, not one after the other as the line is read:
 * for every script the document and user fonts cannot draw, the first likely download is started.
 */
async function prefetch(resolver: Resolver, clusters: { text: string; own: string }[]): Promise<void> {
  const texts = new Map<string, string>();
  for (const c of clusters) if (c.own !== "Common") texts.set(c.own, (texts.get(c.own) ?? "") + c.text);
  // a single script is fetched by the choosing itself
  if (texts.size < 2) return;
  const local = resolver.base.filter((s) => !s.scripts);
  const faces = await Promise.all(local.map(async (source) => ({ source, face: await source.load() })));
  for (const [script, text] of texts) {
    if (faces.some(({ source, face }) => face && covers(face, source, text) && canShape(face, source, script))) continue;
    const first = [...resolver.base.filter((s) => s.scripts), ...resolver.forScript(script)].find((s) => mayHold(s, script));
    if (first) void (first.expand ? first.expand(text).then((list) => list[0]?.load()) : first.load()).catch(() => undefined);
  }
}

async function chooseFonts(resolver: Resolver, text: string, levels: Uint8Array, missing: Set<string>): Promise<Cluster[]> {
  const raw = [...segmenter.segment(text)].map((s) => ({ start: s.index, text: s.segment, own: clusterScript(s.segment) }));
  // characters without a script of their own join the one before them (or after, at the start)
  let previous = raw.find((c) => c.own !== "Common")?.own ?? "Latin";
  const out: Cluster[] = [];
  let last: Cluster | undefined;

  const load = async (source: Source) => {
    const face = await source.load();
    return face ? { source, face } : null;
  };
  const pieces = new Map<Source, Promise<Source[]>>();
  const piecesOf = (source: Source): Source[] | Promise<Source[]> => {
    if (!source.expand) return [source];
    let list = pieces.get(source);
    if (!list) pieces.set(source, (list = source.expand(text)));
    return list;
  };
  await prefetch(resolver, raw);
  const skipped = await patchworkRanges(resolver, text);

  for (const c of raw) {
    const script = c.own === "Common" ? previous : c.own;
    previous = script;
    // the script that decides which downloads are worth making
    const needed = c.own !== "Common" || DANDA.test(c.text) ? script : null;

    const usable = async (sources: Source[], part: string) => {
      for (const listed of sources) {
        if (needed && !mayHold(listed, needed)) continue;
        for (const source of await piecesOf(listed)) {
          const found = await load(source);
          if (found && covers(found.face, source, part) && (c.own === "Common" || canShape(found.face, source, script))) return found;
        }
      }
      return null;
    };

    const visible = [...c.text].filter((ch) => !IGNORABLE.test(ch));
    let picked: { source: Source; face: Face } | null = null;
    if (!visible.length && last) picked = last;
    // joiners and marks typed on their own stay with the font before them
    const skip = skipped.find((r) => c.start >= r.start && c.start < r.end)?.key;
    const base = skip ? resolver.base.filter((s) => s.key !== skip) : resolver.base;
    // a space the document's own fonts lack comes from the font next to it: nothing is fetched for it
    if (!picked && last && !c.text.trim() && base.some((s) => s.key.startsWith("doc:")))
      picked = (await usable(base.filter((s) => !s.scripts), c.text)) ?? (await usable([last.source], c.text));
    picked ??= await usable(base, c.text);
    if (!picked && c.own === "Common" && last) picked = await usable([last.source], c.text);
    picked ??= await usable(resolver.forScript(script), c.text);
    picked ??= await usable(resolver.fallbacks(visible[0]?.codePointAt(0) ?? 32), c.text);
    if (!picked) {
      // draw what can be drawn: the font of the first character, and report the rest
      const first = visible[0] ?? c.text;
      picked =
        (await usable(resolver.base, first)) ??
        (await usable(resolver.forScript(script), first)) ??
        (await usable(resolver.fallbacks(first.codePointAt(0)!), first));
      if (!picked) {
        for (const source of [...resolver.base, ...resolver.forScript("Latin")]) {
          picked = await load(source);
          if (picked) break;
        }
      }
      if (!picked)
        throw new Error(`Could not load a font to draw this text. ${resolver.errors[0] ?? "Check your connection and try again."}`);
      for (const ch of visible) if (!covers(picked.face, picked.source, ch)) missing.add(ch);
    }
    last = { ...c, end: c.start + c.text.length, script, level: levels[c.start] ?? 0, source: picked.source, face: picked.face };
    out.push(last);
  }
  return out;
}

interface Run {
  start: number;
  end: number;
  level: number;
  script: string;
  source: Source;
  face: Face;
  /** the whole line */
  text: string;
}

/** rule L2: reverse every sequence of runs at or above each level, highest first */
function visualOrder<T extends { level: number }>(runs: T[]): T[] {
  const out = [...runs];
  const max = Math.max(0, ...out.map((r) => r.level));
  for (let level = max; level >= 1; level--) {
    let i = 0;
    while (i < out.length) {
      if (out[i]!.level < level) {
        i++;
        continue;
      }
      let j = i;
      while (j < out.length && out[j]!.level >= level) j++;
      out.splice(i, j - i, ...out.slice(i, j).reverse());
      i = j;
    }
  }
  return out;
}

/**
 * Fonts of the same nominal size differ in how large their letters look and where they stand. A
 * substitute next to the original is fitted to the letters both can draw (medians of their heights and
 * of the offset of their lower edges).
 */
function fit(request: MeasureTextRequest, run: Run): { scale: number; rise: number } {
  const none = { scale: 1, rise: 0 };
  if (!request.reference || !run.source.substituted || request.style.fontChoice) return none;
  const pairs: { height: number; bottom: number; own: number; ownBottom: number }[] = [];
  const upem = run.face.info.unitsPerEm;
  for (const { char, top, bottom } of request.reference) {
    if (clusterScript(char) !== run.script) continue;
    const gid = run.face.glyph(char.codePointAt(0)!);
    const e = gid ? run.face.hbFont.glyphExtents(gid) : undefined;
    const own = e ? -e.height / upem : 0;
    if (own > 0.15 && top - bottom > 0.15) pairs.push({ height: top - bottom, bottom, own, ownBottom: (e!.yBearing + e!.height) / upem });
  }
  if (pairs.length < 3) return none;
  const median = (list: number[]) => list.sort((a, b) => a - b)[list.length >> 1]!;
  let scale = median(pairs.map((p) => p.height / p.own));
  scale = Math.abs(scale - 1) < 0.035 ? 1 : Math.min(1.35, Math.max(0.62, scale));
  const rise = median(pairs.map((p) => p.bottom - p.ownBottom * scale));
  // a larger shift would make readers take the substitute for another line
  const limit = 0.12 * Math.min(1, scale);
  return { scale, rise: Math.abs(rise) < 0.045 || Math.abs(rise) > 0.25 ? 0 : Math.max(-limit, Math.min(limit, rise)) };
}

interface ShapedGroup {
  start: number;
  end: number;
  /** left edge and advance of the cluster */
  x: number;
  width: number;
  glyphs: { gid: number; x: number; y: number }[];
  run: Run;
}

export async function layoutText(ctx: EngineContext, request: MeasureTextRequest): Promise<Layout> {
  const text = cleanText(request.text);
  const resolver = createResolver(ctx, { ...request, text });
  const { levels, base } = bidiLevels(text);
  const missing = new Set<string>();
  const clusters = await chooseFonts(resolver, text, levels, missing);

  const runs: Run[] = [];
  for (const c of clusters) {
    const run = runs[runs.length - 1];
    if (run && run.source.key === c.source.key && run.level === c.level && run.script === c.script) run.end = c.end;
    else runs.push({ start: c.start, end: c.end, level: c.level, script: c.script, source: c.source, face: c.face, text });
  }

  const size = request.style.size;
  const spacing = (request.charSpacing ?? 0) + (request.style.letterSpacing ?? 0);
  const wordSpacing = request.wordSpacing ?? 0;
  const hb = await harfbuzz();
  const groups: ShapedGroup[] = [];
  let pen = 0;

  const sizes = new Map<Run, number>();
  const rises = new Map<Run, number>();
  for (const run of visualOrder(runs)) {
    const adapt = fit(request, run);
    const runSize = size * adapt.scale;
    rises.set(run, size * adapt.rise);
    sizes.set(run, runSize);
    const scale = runSize / run.face.info.unitsPerEm;
    const cursive = !!scriptInfo(run.script)?.cursive;
    const buffer = new hb.Buffer();
    // the whole line is given as context so joining works across run boundaries
    buffer.addText(text, run.start, run.end - run.start);
    buffer.setDirection(run.level & 1 ? hb.Direction.RTL : hb.Direction.LTR);
    buffer.setLanguage(resolver.language(run.script));
    buffer.guessSegmentProperties();
    // letter spaced text must not use optional ligatures
    // (office programs leave them off too: Carlito and Caladea stand in for office fonts)
    const standIn = run.source.substituted && /^(Arimo|Tinos|Cousine|Carlito|Caladea)$/.test(run.source.family);
    const features: InstanceType<typeof hb.Feature>[] = [];
    if ((spacing && !cursive) || (standIn && /^(Carlito|Caladea)$/.test(run.source.family)))
      features.push(new hb.Feature("liga", 0), new hb.Feature("clig", 0));
    // a metric compatible stand in must measure like the original, which office programs do not kern
    if (standIn && !cursive && (run.script === "Latin" || run.script === "Common")) features.push(new hb.Feature("kern", 0));
    hb.shape(run.face.hbFont, buffer, features);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();

    const starts = [...new Set(infos.map((g) => g.cluster))].sort((a, b) => a - b);
    const endOf = new Map(starts.map((s, i) => [s, starts[i + 1] ?? run.end]));
    let i = 0;
    while (i < infos.length) {
      const cluster = infos[i]!.cluster;
      const group: ShapedGroup = { start: cluster, end: endOf.get(cluster)!, x: pen, width: 0, glyphs: [], run };
      for (; i < infos.length && infos[i]!.cluster === cluster; i++) {
        const p = positions[i]!;
        group.glyphs.push({ gid: infos[i]!.codepoint, x: pen + p.xOffset * scale, y: p.yOffset * scale });
        pen += p.xAdvance * scale;
      }
      group.width = pen - group.x;
      if (!cursive) pen += spacing;
      if (wordSpacing && text.slice(group.start, group.end) === " ") pen += wordSpacing;
      groups.push(group);
    }
  }

  groups.sort((a, b) => a.start - b.start);
  const glyphs: PlacedGlyph[] = [];
  for (const g of mergeOverlapping(groups, size)) {
    const part = text.slice(g.start, g.end);
    const { face, source } = g.run;
    const own = sizes.get(g.run)!;
    const place = (glyph: ShapedGroup["glyphs"][number], t: string, declared?: number) =>
      // the baseline offset is added last: choosing the main glyph below works on the font's own baseline
      glyphs.push({ source, face, size: own, ...glyph, y: glyph.y + rises.get(g.run)!, text: t, declared });
    if (g.glyphs.length === 1) {
      place(g.glyphs[0]!, part);
      continue;
    }
    // Several glyphs (reordering, split vowels, stacked marks): their positions say nothing reliable
    // about reading order, so the leftmost glyph on the baseline stands for the whole text.
    const main = g.glyphs.reduce((best, gl) =>
      Math.abs(gl.y) < Math.abs(best.y) || (Math.abs(gl.y) === Math.abs(best.y) && gl.x < best.x) ? gl : best,
    );
    const first = glyphs.length;
    place(main, part, (g.width * 1000) / own);
    // rightmost last, reaching the cluster's edge: some extractors end a marked span at its last glyph
    const rest = g.glyphs.filter((gl) => gl !== main).sort((x, y) => x.x - y.x);
    rest.forEach((gl, k) => place(gl, FILLER, k === rest.length - 1 ? (Math.max(0, g.x + g.width - gl.x) * 1000) / own : 0));
    glyphs[first]!.actual = { text: part, glyphs: g.glyphs.length };
  }

  const faces = new Set(glyphs.map((g) => g.face));
  let primary: Face | undefined = glyphs[0]?.face;
  if (!primary) {
    for (const source of resolver.base) {
      primary = (await source.load()) ?? undefined;
      if (primary) break;
    }
    if (!primary) throw new Error(`Could not load a font. ${resolver.errors[0] ?? ""}`);
    faces.add(primary);
  }
  const metric = (f: (face: Face) => number) => Math.max(...[...faces].map((face) => (f(face) * size) / face.info.unitsPerEm));
  const sources = [...new Map(glyphs.map((g) => [g.source.key, g.source])).values()];
  return {
    glyphs,
    advance: pen,
    width: (pen * (request.horizontalScale ?? 100)) / 100,
    ascent: metric((f) => f.info.ascent),
    descent: metric((f) => -f.info.descent),
    fontsUsed: [...new Set(sources.map((s) => s.family))],
    substituted: sources.some((s) => s.substituted),
    missing: [...missing],
    text,
    rtl: (base & 1) === 1,
    primary,
  };
}
