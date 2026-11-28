/**
 * The box sweep: for every box on every page, is it a sensible box, and can it be edited, again and
 * again, with the result looking right and reading back right?
 */
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { Engine } from "../../../src/engine/engine";
import type { MutationResult, Rect, RenderedPage, TextLine } from "../../../src/engine/types";
import { nodeAssets } from "../../fonts/nodeAssets";

export interface Segment {
  text: string;
  /** wraps over several lines: any run of whole boxes that spells it counts */
  flow?: boolean;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: number[];
  alpha?: number;
  rect?: number[] | null;
  /** may be one box or the listed pieces (columns made of spaces) */
  parts?: string[];
  /** one character per cell: one box or one per character */
  cells?: boolean;
}

export interface Failure {
  page: number;
  box: string;
  check: string;
  detail: string;
}

export interface DocResult {
  id: string;
  producer: string;
  boxes: number;
  /** [passed, tried] per check */
  checks: Record<string, [number, number]>;
  failures: Failure[];
  fallback: string[];
  ms: number;
}

const SCALE = 2;
export const norm = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[­​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const squash = (s: string) => norm(s).replace(/ /g, "");
const MARKER = /^([•◦▪‣·●○■\-–o]|\(?[0-9ivxa-zA-Z]{1,3}[.)])$/;

/* ---------- which boxes are what a reader sees ---------- */

export interface Grouping {
  /** box index -> the expected segment it carries */
  matched: Map<number, Segment>;
  wrong: { box: number; why: string }[];
  missing: Segment[];
}

export function group(expected: Segment[], lines: TextLine[]): Grouping {
  const matched = new Map<number, Segment>();
  const open = new Set(expected.map((_, i) => i));
  const texts = lines.map((l) => norm(l.text));
  const free = (j: number) => !matched.has(j);
  const variants = (t: string) => [t, t.replace(/^[•◦▪‣·●]\s*/, ""), t.replace(/^(\d{1,2}[.)]|[a-z][.)])\s+/, ""), t.replace(/-$/, "")];
  const same = (a: string, b: string) => variants(a).some((v) => v === b) || b.replace(/-$/, "") === a.replace(/-$/, "");
  // exact pieces first, nearest in place when the same text occurs twice
  const place = (s: Segment, j: number) =>
    s.rect ? Math.hypot((s.rect[0]! + s.rect[2]!) / 2 - (lines[j]!.rect[0] + lines[j]!.rect[2]) / 2, (s.rect[1]! + s.rect[3]!) / 2 - (lines[j]!.rect[1] + lines[j]!.rect[3]) / 2) : 0;
  for (const loose of [false, true]) {
    for (const i of [...open]) {
      const s = expected[i]!;
      const want = norm(s.text);
      let best = -1;
      for (let j = 0; j < lines.length; j++) {
        if (!free(j) || !(loose ? same(texts[j]!, want) : texts[j] === want)) continue;
        if (best < 0 || place(s, j) < place(s, best)) best = j;
      }
      if (best >= 0) {
        matched.set(best, s);
        open.delete(i);
      }
    }
  }
  // columns held apart by spaces or cells may be one box or several
  for (const i of [...open]) {
    const s = expected[i]!;
    const parts = s.parts ?? (s.cells ? [...s.text] : null);
    if (!parts) continue;
    const used: number[] = [];
    for (const part of parts) {
      const j = texts.findIndex((t, j) => free(j) && !used.includes(j) && t === norm(part));
      if (j >= 0) used.push(j);
    }
    if (used.length === parts.length) {
      for (const [k, j] of used.entries()) matched.set(j, { text: parts[k]! });
      open.delete(i);
    }
  }
  // paragraphs: whole boxes, one after another
  for (const i of [...open]) {
    const s = expected[i]!;
    if (!s.flow) continue;
    const want = squash(s.text);
    const used: number[] = [];
    let at = 0;
    while (at < want.length) {
      let found = -1;
      let length = 0;
      for (let j = 0; j < lines.length; j++) {
        if (!free(j) || used.includes(j)) continue;
        const t = squash(texts[j]!.replace(/^[•◦▪‣·●]\s*/, ""));
        const bare = t.replace(/-$/, "");
        const n = want.startsWith(t, at) ? t.length : bare && want.startsWith(bare, at) ? bare.length : 0;
        if (n > length) {
          found = j;
          length = n;
        }
      }
      if (found < 0) break;
      used.push(found);
      at += length;
    }
    if (at >= want.length) {
      for (const j of used) matched.set(j, { ...s, text: lines[j]!.text });
      open.delete(i);
    }
  }
  // a title and its page number joined by a leader of dots may be one box
  for (let j = 0; j < lines.length; j++) {
    if (!free(j)) continue;
    const m = /^(.*?)\s*(?:\.\s?){5,}\s*(\S*)$/.exec(texts[j]!);
    if (!m) continue;
    const found = [m[1]!, m[2]!].filter(Boolean).map((part) => [...open].find((i) => norm(expected[i]!.text) === part));
    if (!found.length || found.some((i) => i === undefined)) continue;
    for (const i of found) open.delete(i!);
    matched.set(j, { text: lines[j]!.text });
    // the leader itself, when the page sets it apart, is part of this box
    for (const i of [...open]) if (/^[.· ]{5,}$/.test(norm(expected[i]!.text))) {
      open.delete(i);
      break;
    }
  }
  const wrong: Grouping["wrong"] = [];
  for (let j = 0; j < lines.length; j++) {
    if (!free(j) || MARKER.test(texts[j]!)) continue;
    const t = squash(texts[j]!);
    const spacing = expected.find((s) => squash(s.text) === t);
    const part = expected.find((s) => squash(s.text).includes(t));
    const holds = expected.filter((s) => squash(s.text).length > 1 && t.includes(squash(s.text)));
    wrong.push({
      box: j,
      why: spacing ? `spacing differs from ${JSON.stringify(spacing.text)}` : holds.length > 1 ? `merges ${holds.slice(0, 3).map((s) => JSON.stringify(s.text)).join(" + ")}` : part ? `only part of ${JSON.stringify(part.text)}` : "no such text on the page",
    });
  }
  return { matched, wrong, missing: [...open].map((i) => expected[i]!) };
}

/* ---------- pixels ---------- */

function changes(a: RenderedPage, b: RenderedPage, allowed: Rect[]): { stray: number; bounds: Rect | null; strayBounds: Rect | null } {
  let stray = 0;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const far = [Infinity, Infinity, -Infinity, -Infinity];
  const boxes = allowed.map((r) => [Math.floor(r[0] * SCALE), Math.floor(r[1] * SCALE), Math.ceil(r[2] * SCALE), Math.ceil(r[3] * SCALE)]);
  const A = new Uint32Array(a.data.buffer, a.data.byteOffset, a.width * a.height);
  const B = new Uint32Array(b.data.buffer, b.data.byteOffset, b.width * b.height);
  const grow = (r: number[], x: number, y: number) => {
    if (x < r[0]!) r[0] = x;
    if (y < r[1]!) r[1] = y;
    if (x > r[2]!) r[2] = x;
    if (y > r[3]!) r[3] = y;
  };
  for (let i = 0; i < A.length; i++) {
    if (A[i] === B[i]) continue;
    const k = i * 4;
    if (Math.abs(a.data[k]! - b.data[k]!) <= 24 && Math.abs(a.data[k + 1]! - b.data[k + 1]!) <= 24 && Math.abs(a.data[k + 2]! - b.data[k + 2]!) <= 24) continue;
    const x = i % a.width;
    const y = (i / a.width) | 0;
    grow(box, x, y);
    if (!boxes.some((r) => x >= r[0]! && x < r[2]! && y >= r[1]! && y < r[3]!)) {
      stray++;
      grow(far, x, y);
    }
  }
  const rect = (r: number[]): Rect | null => (r[0] === Infinity ? null : [r[0]! / SCALE, r[1]! / SCALE, (r[2]! + 1) / SCALE, (r[3]! + 1) / SCALE]);
  return { stray, bounds: rect(box), strayBounds: rect(far) };
}

/** before and after, cut around the change, one above the other */
function savePair(file: string, a: RenderedPage, b: RenderedPage, around: Rect) {
  const x0 = Math.max(0, Math.floor((around[0] - 20) * SCALE));
  const y0 = Math.max(0, Math.floor((around[1] - 10) * SCALE));
  const x1 = Math.min(a.width, Math.ceil((around[2] + 20) * SCALE));
  const y1 = Math.min(a.height, Math.ceil((around[3] + 10) * SCALE));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h * 2 + 3], true);
  const target = pix.getPixels();
  const stride = pix.getStride();
  target.fill(255);
  for (const [image, top] of [
    [a, 0],
    [b, h + 3],
  ] as const)
    for (let y = 0; y < h; y++) target.set(image.data.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x1) * 4), (top + y) * stride);
  for (let y = h; y < h + 3; y++)
    for (let x = 0; x < w; x++) target.set([255, 0, 255, 255], y * stride + x * 4);
  fs.writeFileSync(file, pix.asPNG());
  pix.destroy();
}

/* ---------- what a person might type ---------- */

const WORDS: [RegExp, string, string][] = [
  [/[ऀ-ॿ]/, "नमस्ते", "भारत"],
  [/[ঀ-৿]/, "বাংলা", "নতুন"],
  [/[஀-௿]/, "தமிழ்", "நாள்"],
];

export function changeWord(text: string): string {
  const words = [...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  if (!words.length) return `${text}1`;
  const target = words.reduce((a, b) => (b[0].length > a[0].length ? b : a));
  const w = target[0];
  const indic = WORDS.find(([r]) => r.test(w));
  let next: string;
  if (indic) next = w === indic[1] ? indic[2] : indic[1];
  else if (/^\p{N}+$/u.test(w)) next = [...w].map((c) => (/[0-9]/.test(c) ? String((Number(c) + 3) % 10) : c)).join("");
  else {
    const source = w === "Quartz" ? "Violet" : "Quartz";
    next = w === w.toUpperCase() && w !== w.toLowerCase() ? source.toUpperCase() : /^\p{Ll}/u.test(w) ? source.toLowerCase() : source;
  }
  return text.slice(0, target.index) + next + text.slice(target.index + w.length);
}

export function append(text: string): string {
  const indic = WORDS.find(([r]) => r.test(text));
  return indic ? `${text} ${indic[2]}` : text === text.toUpperCase() && text !== text.toLowerCase() ? `${text} XQ7` : `${text} xq7`;
}

export function shorten(text: string): string {
  const cut = text.replace(/\s*\S+\s*$/u, "");
  if (cut.trim() && cut !== text) return cut.trimEnd();
  const g = [...new Intl.Segmenter().segment(text)].map((s) => s.segment);
  return g.length > 1 ? g.slice(0, -1).join("").trimEnd() : `${text}2`;
}

/* ---------- checks on an edited line ---------- */

const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const overlaps = (a: Rect, b: Rect) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
export const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const grow = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
// slanted and script lettering reaches further past its advance
const margin = (l: TextLine) => Math.max(1.6, (l.style.italic ? 0.32 : 0.22) * l.style.size);
const along = (l: TextLine, p: [number, number]) => p[0] * Math.cos(l.angle) + p[1] * Math.sin(l.angle);
const across = (l: TextLine, p: [number, number]) => -p[0] * Math.sin(l.angle) + p[1] * Math.cos(l.angle);
const extent = (l: TextLine): [number, number] => {
  const us = [0, 2, 4, 6].map((i) => along(l, [l.quad[i]!, l.quad[i + 1]!]));
  return [Math.min(...us), Math.max(...us)];
};

/** the line that now carries the edited text, where the edited line was */
function findEdited(lines: TextLine[], old: TextLine, text: string): TextLine | null {
  const want = norm(text);
  let best: TextLine | null = null;
  let score = Infinity;
  for (const l of lines) {
    if (norm(l.text) !== want) continue;
    const d = Math.hypot(l.origin[0] - old.origin[0], l.origin[1] - old.origin[1]);
    if (d < score) {
      score = d;
      best = l;
    }
  }
  return best;
}

interface Verdict {
  failed: [check: string, detail: string][];
  line: TextLine | null;
  /** where changes were allowed */
  box: Rect;
}

function verify(old: TextLine, text: string, before: TextLine[], after: TextLine[], a: RenderedPage, b: RenderedPage, result: MutationResult): Verdict {
  // the style and baseline of a recognised line are estimates, which the first edit refines
  const scanned = old.source === "ocr";
  const failed: Verdict["failed"] = [];
  if (!result.changedPages.length) failed.push(["applied", result.warnings.join("; ") || "no page changed"]);
  const found = findEdited(after, old, text);
  // longer text can leave the page or a clipping shape: the user is told, and what is hidden is not read
  const hidden = !found && result.warnings.some((w) => /runs off the page|hidden by a shape/.test(w));
  const others = before.filter((l) => l !== old);
  // longer text may run into what sits beside it: the app does not reflow
  const [u0, u1] = extent(old);
  const newEnd = found ? extent(found) : [u0, u1];
  const collides = !!found && others.some((o) => overlaps(found.rect, o.rect) > 0.5 && overlaps(old.rect, o.rect) < overlaps(found.rect, o.rect) - 0.5);
  if (!found && !hidden) {
    const near = after
      .slice()
      .sort((p, q) => overlaps(q.rect, old.rect) - overlaps(p.rect, old.rect))
      .slice(0, 2)
      .map((l) => l.text);
    failed.push(["reread", `wanted ${JSON.stringify(text)} got ${JSON.stringify(near)}`]);
  }
  const lost = others.filter((o) => !after.some((x) => norm(x.text) === norm(o.text) && Math.hypot(x.origin[0] - o.origin[0], x.origin[1] - o.origin[1]) < 0.25));
  if (lost.length && !collides) failed.push(["neighbours", `changed: ${JSON.stringify(lost.slice(0, 3).map((l) => l.text))}`]);
  if (found) {
    const s = old.style;
    const t = found.style;
    // a word in another style than the rest of the line may have been the one replaced
    const styles = old.spans.map((p) => p.style);
    const near = (p: typeof s) =>
      Math.abs(p.size - t.size) < Math.max(0.25, 0.02 * p.size) && p.bold === t.bold && p.italic === t.italic && p.color.every((c, i) => Math.abs(c - t.color[i]!) < 0.05);
    // a substitute typeface is scaled so that its letters look the same size
    const substituted = result.fallbackFonts.length > 0 && Math.abs(s.size - t.size) < 0.2 * s.size && s.bold === t.bold && s.italic === t.italic;
    const estimated = scanned && Math.abs(s.size - t.size) < 0.3 * s.size;
    if (!near(s) && !styles.some(near) && !substituted && !estimated)
      failed.push(["style", `${s.size}/${s.bold ? "b" : ""}${s.italic ? "i" : ""}/${s.color.map((c) => c.toFixed(2))} became ${t.size}/${t.bold ? "b" : ""}${t.italic ? "i" : ""}/${t.color.map((c) => c.toFixed(2))}`]);
    const drop = Math.abs(across(old, found.origin) - across(old, old.origin));
    if (drop > Math.max(0.35, (scanned ? 0.16 : 0.02) * s.size) || Math.abs(found.angle - old.angle) > 0.02) failed.push(["baseline", `moved ${drop.toFixed(2)}pt, angle ${old.angle.toFixed(3)} -> ${found.angle.toFixed(3)}`]);
    const [n0, n1] = newEnd as [number, number];
    const anchor = old.align === "right" ? Math.abs(n1 - u1) : old.align === "center" ? Math.abs(n0 + n1 - u0 - u1) / 2 : Math.abs(n0 - u0);
    if (anchor > Math.max(1.2, (scanned ? 0.35 : 0.15) * s.size)) failed.push(["anchor", `${old.align} line moved ${anchor.toFixed(1)}pt`]);
  }
  const box = found ? union(old.rect, found.rect) : grow(old.rect, old.style.size * 4);
  const d = changes(a, b, [grow(box, margin(old))]);
  if (d.stray > 6) failed.push(["pixels", `${d.stray}px outside, at ${d.strayBounds!.map(Math.round)} (box ${box.map(Math.round)})`]);
  return { failed, line: found, box };
}

/* ---------- the sweep ---------- */

export interface SweepOptions {
  out: string;
  /** every n-th box gets the edit operations (all boxes are always checked for sense) */
  every?: number;
  pictures?: number;
}

/** what a recogniser would report for a scanned page whose layout is known */
function recognised(page: number, segments: Segment[]) {
  const lines = segments.map((s) => {
    const rect = s.rect as Rect;
    const per = (rect[2] - rect[0]) / Math.max(1, s.text.length);
    let at = 0;
    const words = s.text.split(" ").map((text) => {
      const x = rect[0] + at * per;
      at += text.length + 1;
      return { text, rect: [x, rect[1], x + text.length * per, rect[3]] as Rect, confidence: 96 };
    });
    return { text: s.text, rect, confidence: 96, words };
  });
  return { page, languages: ["eng"], lines };
}

export interface Truth {
  producer: string;
  password?: string;
  /** a scanned document: the segments are handed to the engine as its OCR result */
  ocr?: boolean;
  pages: { segments: Segment[] }[];
}

export async function sweepDocument(id: string, bytes: Uint8Array, truth: Truth, options: SweepOptions): Promise<DocResult> {
  const started = Date.now();
  const engine = new Engine(nodeAssets);
  const opened = await engine.open(bytes.slice(), `${id}.pdf`, truth.password);
  if (opened.status !== "ok") throw new Error(`${id} did not open`);
  const result: DocResult = { id, producer: truth.producer, boxes: 0, checks: {}, failures: [], fallback: [], ms: 0 };
  const fallback = new Set<string>();
  let pictures = options.pictures ?? 25;
  const tally = (check: string, ok: boolean) => {
    const c = (result.checks[check] ??= [0, 0]);
    c[1]++;
    if (ok) c[0]++;
  };
  const fail = (page: number, box: string, check: string, detail: string) => result.failures.push({ page, box, check, detail });
  const dir = path.join(options.out, "fail");
  fs.mkdirSync(dir, { recursive: true });
  const picture = (name: string, a: RenderedPage, b: RenderedPage, around: Rect) => {
    if (pictures-- > 0) savePair(path.join(dir, `${id}-${name}.png`.replace(/[^\w.-]+/g, "_")), a, b, around);
  };

  if (truth.ocr) for (const [p, page] of truth.pages.entries()) await engine.setOcrResult(recognised(p, page.segments));
  for (let p = 0; p < opened.doc.pageCount; p++) {
    const text = await engine.getPageText(p);
    const lines = text.lines;
    result.boxes += lines.length;
    const base = await engine.renderPage(p, SCALE);
    const expected = truth.pages[p]?.segments ?? [];
    const grouping = group(expected, lines);
    const wrong = new Map(grouping.wrong.map((w) => [w.box, w.why]));
    for (let j = 0; j < lines.length; j++) {
      const l = lines[j]!;
      tally("sensible", !wrong.has(j));
      if (wrong.has(j)) fail(p, l.text, "sensible", wrong.get(j)!);
      tally("editable", l.editable && !l.note);
      if (!l.editable || l.note) fail(p, l.text, "editable", l.note ?? "read only");
      const s = grouping.matched.get(j);
      if (s?.size && !truth.ocr) {
        const colour = (s.alpha ?? 1) < 1 || !s.color || l.spans.some((span) => s.color!.every((c, i) => Math.abs(c - span.style.color[i]!) < 0.1));
        const ok = Math.abs(l.style.size - s.size) < 0.12 * s.size && l.style.bold === s.bold && l.style.italic === s.italic && colour;
        tally("style-read", ok);
        if (!ok) fail(p, l.text, "style-read", `expected ${s.size}/${s.bold}/${s.italic}/${s.color?.map((c) => c.toFixed(2))} got ${l.style.size}/${l.style.bold}/${l.style.italic}/${l.style.color.map((c) => c.toFixed(2))}`);
      }
    }
    for (const s of grouping.missing) fail(p, s.text, "missing", "no box carries this text");
    if (expected.length) {
      result.checks.found ??= [0, 0];
      result.checks.found[0] += expected.length - grouping.missing.length;
      result.checks.found[1] += expected.length;
    }

    const editable = lines.filter((l) => l.editable);
    const every = options.every ?? 1;
    for (let k = 0; k < editable.length; k += every) {
      const target = editable[k]!;
      const label = target.text;

      // deleting the line shows where its ink really is
      try {
        const r = await engine.editLines(p, [{ lineId: target.id, text: "" }]);
        const after = await engine.getPageText(p);
        const image = await engine.renderPage(p, SCALE);
        const d = changes(base, image, [grow(target.rect, margin(target))]);
        const ink = d.bounds;
        const [w, h] = [target.rect[2] - target.rect[0], target.rect[3] - target.rect[1]];
        const slack = Math.max(4, 1.1 * target.style.size);
        const tight = !ink || (d.stray <= 6 && (Math.abs(target.angle) > 0.02 || (w - (ink[2] - ink[0]) < slack && h - (ink[3] - ink[1]) < 1.2 * target.style.size + 2)));
        tally("bounds", !!ink && tight);
        if (!ink) fail(p, label, "bounds", "deleting changed nothing visible");
        else if (!tight) fail(p, label, "bounds", `box ${target.rect.map(Math.round)} ink ${ink.map(Math.round)} stray ${d.stray}`);
        const left = lines.filter((o) => o !== target && !after.lines.some((x) => norm(x.text) === norm(o.text) && Math.hypot(x.origin[0] - o.origin[0], x.origin[1] - o.origin[1]) < 0.25));
        const gone = !after.lines.some((x) => norm(x.text) === norm(label) && Math.hypot(x.origin[0] - target.origin[0], x.origin[1] - target.origin[1]) < 0.5);
        tally("delete", !!r.changedPages.length && !left.length && gone);
        if (left.length || !gone) fail(p, label, "delete", gone ? `neighbours changed: ${JSON.stringify(left.slice(0, 3).map((l) => l.text))}` : "still there");
        if (!tight || left.length) picture(`p${p}-${k}-delete`, base, image, target.rect);
        await engine.undo();
      } catch (e) {
        tally("delete", false);
        fail(p, label, "delete", `threw ${(e as Error).message}`);
        continue;
      }

      const operations: [string, ((t: string) => string)[]][] = [
        ["word", [changeWord]],
        ["append", [append]],
        ["shorten", [shorten]],
        ["twice", [changeWord, append]],
      ];
      for (const [name, steps] of operations) {
        let done = 0;
        let ok = true;
        try {
          let current = target;
          let before = lines;
          let image = base;
          for (const step of steps) {
            const next = step(current.text);
            const r = await engine.editLines(p, [{ lineId: current.id, text: next }]);
            done++;
            for (const f of r.fallbackFonts) fallback.add(`${current.style.family} -> ${f}`);
            const after = (await engine.getPageText(p)).lines;
            const rendered = await engine.renderPage(p, SCALE);
            const verdict = verify(current, next, before, after, image, rendered, r);
            for (const [check, detail] of verdict.failed) {
              ok = false;
              fail(p, label, `${name}:${check}`, detail);
            }
            if (verdict.failed.length) picture(`p${p}-${k}-${name}${done}`, image, rendered, verdict.box);
            if (!verdict.line) {
              if (!verdict.failed.length) tally("hidden-warned", true);
              break;
            }
            current = verdict.line;
            before = after;
            image = rendered;
          }
        } catch (e) {
          ok = false;
          fail(p, label, `${name}:threw`, (e as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? String(e));
        }
        tally(name, ok);
        while (done--) await engine.undo();
      }
    }

    /* every box of the page again: new colour and size, then moved */
    for (let k = 0; k < editable.length; k += every) {
      const target = editable[k]!;
      const red: [number, number, number] = [0.8, 0.05, 0.1];
      const size = Math.round(target.style.size * 85) / 100;
      for (const [name, edit] of [
        ["restyle", { style: { color: red, size } }],
        ["move", { offset: [3, 2] as [number, number] }],
      ] as const) {
        let applied = false;
        try {
          const r = await engine.editLines(p, [{ lineId: target.id, text: target.text, ...edit }]);
          applied = true;
          const after = (await engine.getPageText(p)).lines;
          const rendered = await engine.renderPage(p, SCALE);
          const found = findEdited(after, target, target.text);
          const problems: string[] = [];
          if (!found) problems.push(`not read back; near ${JSON.stringify(after.filter((l) => overlaps(l.rect, target.rect) > 1).map((l) => l.text))}`);
          else if (name === "restyle") {
            const slack = target.source === "ocr" ? 0.3 : 0.06;
            if (Math.abs(found.style.size - size) > slack * size) problems.push(`size ${found.style.size} wanted ${size}`);
            if (!found.style.color.every((c, i) => Math.abs(c - red[i]!) < 0.05)) problems.push(`colour ${found.style.color}`);
          } else if (Math.hypot(found.origin[0] - target.origin[0] - 3, found.origin[1] - target.origin[1] - 2) > (target.source === "ocr" ? 0.35 * target.style.size : 0.5))
            problems.push(`moved to ${found.origin} from ${target.origin}`);
          const box = grow(found ? union(target.rect, found.rect) : grow(target.rect, target.style.size), margin(target));
          const d = changes(base, rendered, [box]);
          if (d.stray > 6) problems.push(`${d.stray}px outside at ${d.strayBounds!.map(Math.round)}`);
          if (!r.changedPages.length) problems.push("nothing changed");
          tally(name, !problems.length);
          if (problems.length) {
            fail(p, target.text, name, problems.join("; "));
            picture(`p${p}-${k}-${name}`, base, rendered, box);
          }
        } catch (e) {
          tally(name, false);
          fail(p, target.text, `${name}:threw`, (e as Error).message);
        }
        if (applied) await engine.undo();
      }
    }

    /* every box of the page, one after another, without undoing */
    let applied = 0;
    const planned: { old: TextLine; text: string; step: number; clash: boolean }[] = [];
    let current = lines;
    for (let k = 0; k < editable.length; k++) {
      const original = editable[k]!;
      const now = current.find((l) => l.text === original.text && Math.hypot(l.origin[0] - original.origin[0], l.origin[1] - original.origin[1]) < 0.4);
      if (!now) {
        tally("sequence", false);
        fail(p, original.text, "sequence", "box disappeared after earlier edits on the page");
        continue;
      }
      // same length or shorter, so that boxes do not run into each other
      const next = k % 3 === 2 ? shorten(now.text) : changeWord(now.text);
      try {
        await engine.editLines(p, [{ lineId: now.id, text: next }]);
        applied++;
        planned.push({ old: original, text: next, step: k, clash: false });
        current = (await engine.getPageText(p)).lines;
      } catch (e) {
        tally("sequence", false);
        fail(p, original.text, "sequence", `threw ${(e as Error).message}`);
      }
    }
    if (applied) {
      const final = await engine.renderPage(p, SCALE);
      const allowed: Rect[] = [];
      for (const plan of planned) {
        const found = findEdited(current, plan.old, plan.text);
        tally("sequence", !!found);
        if (!found) fail(p, plan.old.text, "sequence", `at the end ${JSON.stringify(plan.text)} is not read back; near: ${JSON.stringify(current.filter((l) => overlaps(l.rect, plan.old.rect) > 1).map((l) => l.text))}`);
        allowed.push(grow(found ? union(plan.old.rect, found.rect) : grow(plan.old.rect, plan.old.style.size * 4), margin(plan.old)));
      }
      const d = changes(base, final, allowed);
      tally("sequence-pixels", d.stray <= 10);
      if (d.stray > 10) fail(p, `page ${p + 1}`, "sequence-pixels", `${d.stray}px outside at ${d.strayBounds!.map(Math.round)}`);
      const png = engine.context.doc.loadPage(p).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
      fs.mkdirSync(path.join(options.out, "pages"), { recursive: true });
      fs.writeFileSync(path.join(options.out, "pages", `${id}-p${p}-edited.png`), png.asPNG());
      png.destroy();
      while (applied--) await engine.undo();
      const original = engine.context.doc.loadPage(p).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
      fs.writeFileSync(path.join(options.out, "pages", `${id}-p${p}.png`), original.asPNG());
      original.destroy();
    }
  }
  await engine.close();
  result.fallback = [...fallback];
  result.ms = Date.now() - started;
  return result;
}

export const COLUMNS = ["found", "sensible", "editable", "style-read", "bounds", "delete", "word", "append", "shorten", "twice", "restyle", "move", "sequence", "sequence-pixels"];

export function summary(results: DocResult[]): string {
  const cell = (c: [number, number] | undefined) => (c?.[1] ? (c[0] === c[1] ? "100" : ((100 * c[0]) / c[1]).toFixed(1)) : "-");
  const total: Record<string, [number, number]> = {};
  for (const r of results)
    for (const [k, [a, b]] of Object.entries(r.checks)) {
      const t = (total[k] ??= [0, 0]);
      t[0] += a;
      t[1] += b;
    }
  const rows = results.map((r) => [r.id, String(r.boxes), ...COLUMNS.map((c) => cell(r.checks[c]))]);
  rows.push(["ALL", String(results.reduce((n, r) => n + r.boxes, 0)), ...COLUMNS.map((c) => cell(total[c]))]);
  const head = ["document", "boxes", ...COLUMNS];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}
