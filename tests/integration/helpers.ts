/** Shared harness for the integration tests: corpus manifest, engine setup, text scoring and pixel checks. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { createAssetLoader, type AssetLoader } from "../../src/engine/context";
import { Engine } from "../../src/engine/engine";
import { quadToRect } from "../../src/engine/geom";
import type { DocInfo, PageText, Rect, RenderedPage, TextLine } from "../../src/engine/types";
import { createNodeAssets } from "../fonts/nodeAssets";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES = join(ROOT, "tests/fixtures/pdfs");
export const ASSETS = join(ROOT, "tests/fixtures/assets");
export const OUT = join(ROOT, ".tmp/integration");

/* ---------- manifest ---------- */

export interface ExpectedLine {
  text: string;
  rect: Rect;
  lang: string;
  script: string;
  dir: "ltr" | "rtl";
  size: number;
  bold?: boolean;
  italic?: boolean;
  color?: [number, number, number];
  angle?: number;
  align?: "left" | "center" | "right" | "justify";
  tags?: string[];
  /** broken-encoding fixtures: what a reader sees, as opposed to what the file encodes */
  intended?: string;
}
export interface ManifestPage {
  index: number;
  width: number;
  height: number;
  rotate: number;
  kind: "text" | "scanned" | "garbled" | "mixed" | "empty";
  lines: ExpectedLine[];
  images?: { rect: Rect | null; pixelWidth: number; pixelHeight: number; rotated?: boolean }[];
}
export interface ManifestEdit {
  page: number;
  line: number;
  newText?: string;
  replace?: [string, string];
  onlyThisPage?: boolean;
}
export interface ManifestField {
  name: string;
  type: string;
  value?: string;
  values?: string[];
  checked?: boolean;
  options?: string[];
  multiline?: boolean;
  readOnly?: boolean;
  rect: Rect;
}
export interface ManifestDoc {
  id: string;
  file: string;
  producer: string;
  language: string;
  script: string;
  tags: string[];
  password: string | null;
  pageCount: number;
  pages: ManifestPage[];
  edits: ManifestEdit[];
  repaired?: boolean;
  signed?: boolean;
  fields?: ManifestField[];
  tesseract?: string;
  skew?: number;
}

export const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as {
  documents: ManifestDoc[];
};
export const documents = manifest.documents;

export function doc(id: string): ManifestDoc {
  const found = documents.find((d) => d.id === id);
  if (!found) throw new Error(`No fixture called ${id}`);
  return found;
}
export const fixtureBytes = (id: string) => new Uint8Array(readFileSync(join(FIXTURES, doc(id).file)));
export const assetBytes = (name: string) => new Uint8Array(readFileSync(join(ASSETS, name)));

/* ---------- engine ---------- */

/** Fonts come from the CDN the app is allowed to use (see public/_headers), cached in .tmp/fonts-cache. */
const downloads = createNodeAssets();
export const nodeAssets: AssetLoader = createAssetLoader((url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "cdn.jsdelivr.net")
    throw new Error(`The engine asked for ${url}; the content security policy only allows cdn.jsdelivr.net`);
  return downloads.bytes(url);
});

export const newEngine = () => new Engine(nodeAssets);

export async function openBytes(bytes: Uint8Array, name: string, password?: string): Promise<{ engine: Engine; info: DocInfo }> {
  const engine = newEngine();
  const result = await engine.open(bytes.slice(), name, password);
  if (result.status !== "ok") throw new Error(`${name} asked for a password (wrong: ${result.wrong})`);
  return { engine, info: result.doc };
}

export async function openDoc(id: string) {
  const entry = doc(id);
  return openBytes(fixtureBytes(id), entry.file, entry.password ?? undefined);
}

/* ---------- text scoring ---------- */

const INVISIBLE = /[­​‎‏‪-‮⁦-⁩﻿]/g;

/** NFC, one kind of space, no bidi control characters. Deliberately NOT NFKC: presentation forms are errors. */
export function normalise(text: string): string {
  return text.normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

export function editDistance(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const current = [i];
    for (let j = 1; j <= t.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (s[i - 1] === t[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[t.length]!;
}

export function similarity(expected: string, actual: string): number {
  const a = normalise(expected);
  const b = normalise(actual);
  const length = Math.max([...a].length, [...b].length);
  return length === 0 ? 1 : 1 - editDistance(a, b) / length;
}

/* ---------- geometry ---------- */

export const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
export function intersection(a: Rect, b: Rect): number {
  return area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
}
/** share of the smaller box covered by both: tolerant of different ascent / descent conventions */
export function overlap(a: Rect, b: Rect): number {
  const smaller = Math.min(area(a), area(b));
  return smaller > 0 ? intersection(a, b) / smaller : 0;
}
/** intersection over union along the horizontal axis (for vertical text, along y) */
export function extentMatch(a: Rect, b: Rect, vertical = false): number {
  const [i0, i1] = vertical ? ([1, 3] as const) : ([0, 2] as const);
  const both = Math.max(0, Math.min(a[i1], b[i1]) - Math.max(a[i0], b[i0]));
  const either = Math.max(a[i1], b[i1]) - Math.min(a[i0], b[i0]);
  return either > 0 ? both / either : 0;
}
export const pad = (r: Rect, by: number): Rect => [r[0] - by, r[1] - by, r[2] + by, r[3] + by];
export const lineRect = (line: TextLine): Rect => line.rect;
export { quadToRect };

/* ---------- line matching ---------- */

export interface Match {
  expected: ExpectedLine;
  index: number;
  actual: TextLine | null;
  similarity: number;
  overlap: number;
}

/** One-to-one pairing of expected and extracted lines, preferring pairs that agree on place and text. */
export function matchLines(expected: ExpectedLine[], actual: TextLine[]): { matches: Match[]; extra: TextLine[] } {
  const pairs: { i: number; j: number; score: number; sim: number; over: number }[] = [];
  expected.forEach((line, i) => {
    actual.forEach((candidate, j) => {
      const over = overlap(line.rect, candidate.rect);
      const sim = similarity(line.text, candidate.text);
      if (over > 0.2 || sim > 0.9) pairs.push({ i, j, sim, over, score: sim + Math.min(over, 1) });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const usedExpected = new Set<number>();
  const usedActual = new Set<number>();
  const matches: Match[] = expected.map((line, index) => ({ expected: line, index, actual: null, similarity: 0, overlap: 0 }));
  for (const pair of pairs) {
    if (usedExpected.has(pair.i) || usedActual.has(pair.j)) continue;
    usedExpected.add(pair.i);
    usedActual.add(pair.j);
    Object.assign(matches[pair.i]!, { actual: actual[pair.j]!, similarity: pair.sim, overlap: pair.over });
  }
  return { matches, extra: actual.filter((line, j) => !usedActual.has(j) && normalise(line.text) !== "") };
}

export interface Accuracy {
  lines: number;
  exact: number;
  characters: number;
  accuracy: number;
  extra: number;
  failures: string[];
}

export function score(expected: ExpectedLine[], actual: TextLine[]): Accuracy {
  const { matches, extra } = matchLines(expected, actual);
  let errors = 0;
  let characters = 0;
  let exact = 0;
  const failures: string[] = [];
  for (const match of matches) {
    const want = normalise(match.expected.text);
    const got = normalise(match.actual?.text ?? "");
    const distance = editDistance(want, got);
    characters += [...want].length;
    errors += Math.min(distance, [...want].length);
    if (distance === 0) exact++;
    else failures.push(`expected ${JSON.stringify(want)}\n   got      ${match.actual ? JSON.stringify(got) : "(no line there)"}`);
  }
  for (const line of extra) failures.push(`unexpected extra line ${JSON.stringify(line.text)} at ${line.rect.map(Math.round)}`);
  return {
    lines: expected.length,
    exact,
    characters,
    accuracy: characters ? 1 - errors / characters : extra.length ? 0 : 1,
    extra: extra.length,
    failures,
  };
}

/** The extracted line that sits where the manifest says, with roughly the expected text. */
export function findLine(page: PageText, expected: ExpectedLine, minimum = 0.8): TextLine {
  const { matches } = matchLines([expected], page.lines);
  const match = matches[0]!;
  if (!match.actual || match.similarity < minimum)
    throw new Error(
      `Extraction did not produce the line ${JSON.stringify(expected.text)} (best: ${JSON.stringify(match.actual?.text)}, ` +
        `similarity ${match.similarity.toFixed(2)}; page kind ${page.kind}; lines: ${JSON.stringify(page.lines.map((l) => l.text))})`,
    );
  return match.actual;
}

/** best similarity of any line to `text`; optionally only lines overlapping `near` */
export function bestLine(lines: TextLine[], text: string, near?: Rect): { line: TextLine | null; similarity: number } {
  let best: TextLine | null = null;
  let value = 0;
  for (const line of lines) {
    if (near && overlap(near, line.rect) < 0.2) continue;
    const s = similarity(text, line.text);
    if (s > value || !best) {
      best = line;
      value = s;
    }
  }
  return { line: best, similarity: best ? value : 0 };
}

/* ---------- MuPDF as an independent reader ---------- */

export function mupdfDocument(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const opened = mupdf.Document.openDocument(bytes.slice(), "application/pdf");
  if (opened.needsPassword() && !opened.authenticatePassword(password ?? "")) throw new Error("wrong password");
  return opened.asPDF()!;
}

export function mupdfText(bytes: Uint8Array, page: number, password?: string): string {
  const pdf = mupdfDocument(bytes, password);
  const text = pdf.loadPage(page).toStructuredText("preserve-whitespace").asText();
  pdf.destroy();
  return text;
}

/** MuPDF's own lines in the same shape as the engine's, as a baseline in the accuracy report */
export function mupdfLines(bytes: Uint8Array, page: number, password?: string): TextLine[] {
  const pdf = mupdfDocument(bytes, password);
  const json = JSON.parse(pdf.loadPage(page).toStructuredText("preserve-whitespace").asJSON()) as {
    blocks: { type: string; lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
  };
  pdf.destroy();
  return json.blocks
    .flatMap((b) => b.lines ?? [])
    .map((l) => ({ text: l.text, rect: [l.bbox.x, l.bbox.y, l.bbox.x + l.bbox.w, l.bbox.y + l.bbox.h] }) as TextLine);
}

/* ---------- pixels ---------- */

export const SCALE = 2;

export async function render(engine: Engine, page: number, scale = SCALE): Promise<RenderedPage> {
  return engine.renderPage(page, scale);
}

export interface Difference {
  /** pixels that changed at all (beyond anti-aliasing noise) */
  changed: number;
  /** changed pixels outside every allowed rectangle */
  stray: number;
  /** bounding box of all changes, page space */
  bounds: Rect | null;
}

export function diffPixels(a: RenderedPage, b: RenderedPage, allowed: Rect[] = [], scale = SCALE, tolerance = 24): Difference {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`Page size changed: ${a.width}x${a.height} became ${b.width}x${b.height}`);
  let changed = 0;
  let stray = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const boxes = allowed.map((r) => [Math.floor(r[0] * scale), Math.floor(r[1] * scale), Math.ceil(r[2] * scale), Math.ceil(r[3] * scale)]);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (
        Math.abs(a.data[i]! - b.data[i]!) <= tolerance &&
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) <= tolerance &&
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) <= tolerance
      )
        continue;
      changed++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (!boxes.some((box) => x >= box[0]! && x < box[2]! && y >= box[1]! && y < box[3]!)) stray++;
    }
  }
  return { changed, stray, bounds: changed ? [x0 / scale, y0 / scale, (x1 + 1) / scale, (y1 + 1) / scale] : null };
}

/** number of pixels in `rect` that differ clearly from the paper colour around it */
export function inkPixels(page: RenderedPage, rect: Rect, scale = SCALE): number {
  const x0 = Math.max(0, Math.floor(rect[0] * scale));
  const y0 = Math.max(0, Math.floor(rect[1] * scale));
  const x1 = Math.min(page.width, Math.ceil(rect[2] * scale));
  const y1 = Math.min(page.height, Math.ceil(rect[3] * scale));
  let count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * page.width + x) * 4;
      if (page.data[i]! + page.data[i + 1]! + page.data[i + 2]! < 560) count++;
    }
  return count;
}

export function pixelAt(page: RenderedPage, x: number, y: number, scale = SCALE): [number, number, number] {
  const i = (Math.round(y * scale) * page.width + Math.round(x * scale)) * 4;
  return [page.data[i]!, page.data[i + 1]!, page.data[i + 2]!];
}

/** Write a rendering (with optional red boxes) to .tmp/integration so failures can be looked at. */
export function savePng(name: string, page: RenderedPage, boxes: Rect[] = [], scale = SCALE): string {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, page.width, page.height], true);
  const target = pixmap.getPixels();
  const stride = pixmap.getStride();
  for (let y = 0; y < page.height; y++)
    target.set(page.data.subarray(y * page.width * 4, (y + 1) * page.width * 4), y * stride);
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= page.width || y >= page.height) return;
    target.set([255, 0, 0, 255], y * stride + x * 4);
  };
  for (const r of boxes) {
    const [x0, y0, x1, y1] = r.map((v) => Math.round(v * scale)) as Rect;
    for (let x = x0; x <= x1; x++) {
      put(x, y0);
      put(x, y1);
    }
    for (let y = y0; y <= y1; y++) {
      put(x0, y);
      put(x1, y);
    }
  }
  const file = join(OUT, name.replace(/[^\w.-]+/g, "_") + ".png");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pixmap.asPNG());
  pixmap.destroy();
  return file;
}

/* ---------- report ---------- */

export function report(file: string, line: string) {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(join(OUT, file), line + "\n");
}

export function table(headers: string[], rows: (string | number)[][]): string {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const format = (r: string[]) => "| " + r.map((c, i) => c.padEnd(widths[i]!)).join(" | ") + " |";
  return [format(headers), format(widths.map((w) => "-".repeat(w))), ...all.slice(1).map(format)].join("\n");
}

/* ---------- generated big file ---------- */

/** A 300 page document made on demand (too repetitive to commit). */
export function largePdf(pages = 300, linesPerPage = 40): Uint8Array {
  const dense = linesPerPage > 44;
  const [size, step, perColumn] = dense ? [5, 7.8, 100] : [10, 18, 44];
  const pdf = new mupdf.PDFDocument();
  const font = pdf.newDictionary();
  font.put("Type", pdf.newName("Font"));
  font.put("Subtype", pdf.newName("Type1"));
  font.put("BaseFont", pdf.newName("Helvetica"));
  font.put("Encoding", pdf.newName("WinAnsiEncoding"));
  const resources = pdf.newDictionary();
  const fonts = pdf.newDictionary();
  fonts.put("F1", pdf.addObject(font));
  resources.put("Font", fonts);
  const shared = pdf.addObject(resources);
  for (let p = 0; p < pages; p++) {
    let ops = "";
    for (let l = 0; l < linesPerPage; l++) {
      const x = 30 + Math.floor(l / perColumn) * 140;
      const y = (dense ? 810 : 800) - (l % perColumn) * step;
      ops += `BT /F1 ${size} Tf ${x} ${y.toFixed(1)} Td (Ledger page ${p + 1} row ${l + 1}: stock counted and signed off) Tj ET
`;
    }
    pdf.insertPage(-1, pdf.addPage([0, 0, 595, 842], 0, shared, ops));
  }
  const bytes = pdf.saveToBuffer("compress").asUint8Array().slice();
  pdf.destroy();
  return bytes;
}
