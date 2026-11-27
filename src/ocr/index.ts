/** Main-thread OCR (tesseract.js, runs fully in the browser). Owner: OCR module. */
import { multiply } from "../engine/geom";
import type { Matrix, OcrPageResult, OcrProgress, RenderedPage } from "../engine/types";
import { convertBlocks, weightedConfidence, type RawBlock } from "./convert";
import { alternatives, PROBES } from "./detect";
import { OCR_LANGUAGES, SCRIPT_DEFAULTS } from "./languages";
import { cleanImage, densestBand, encodePGM, removeRules, shrink, straighten, toGray, turn, type Gray, type Prepared } from "./preprocess";
import { abortError, detectScript, recognizer, runJob, terminateWorkers } from "./tess";

export { OCR_LANGUAGES };
export { configureOcr, type OcrConfig } from "./tess";

export interface RecognizeOptions {
  /** tesseract codes; empty = detect automatically */
  languages: string[];
  /** pixels per point used to render `image` (to convert boxes to page space) */
  scale: number;
  onProgress?: (p: OcrProgress) => void;
  signal?: AbortSignal;
}

/** recommended render scale for recognition */
export const OCR_SCALE = 300 / 72;

const NAMES = new Map(OCR_LANGUAGES.map((l) => [l.code, l.name]));

/** one recognition at a time: the workers are shared */
let queue: Promise<unknown> = Promise.resolve();
/** bumped by terminateOcr: jobs queued or running before it must not restart a worker */
let epoch = 0;
const running = new Set<() => void>();

export async function recognizePage(image: RenderedPage, options: RecognizeOptions): Promise<OcrPageResult> {
  const { signal } = options;
  if (signal?.aborted) throw abortError();
  const born = epoch;
  const cancelled = () => born !== epoch || !!signal?.aborted;
  let stop!: (e: Error) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => {});
  const job = queue.then(() => run(image, options, cancelled));
  // an abandoned job may never settle (its worker is gone), so the queue also moves on when stopped
  queue = Promise.race([job, stopped]).catch(() => {});
  const onStop = () => stop(abortError());
  const onAbort = () => {
    // tesseract cannot be interrupted: throw the worker away
    void terminateWorkers();
    onStop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  running.add(onStop);
  try {
    return await Promise.race([job, stopped]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    running.delete(onStop);
  }
}

export async function terminateOcr(): Promise<void> {
  epoch++;
  for (const stop of [...running]) stop();
  queue = Promise.resolve();
  await terminateWorkers();
}

interface Pass {
  languages: string[];
  blocks: RawBlock[];
  text: string;
  confidence: number;
  /** characters weighted by certainty: compares passes that found different amounts of text */
  score: number;
}

type Report = (status: string, progress: number) => void;

async function run(image: RenderedPage, options: RecognizeOptions, cancelled: () => boolean): Promise<OcrPageResult> {
  const { scale } = options;
  const check = () => {
    if (cancelled()) throw abortError();
  };
  let shown = 0;
  const report: Report = (status, progress) => {
    if (cancelled()) return;
    shown = Math.max(shown, Math.min(1, progress));
    options.onProgress?.({ page: image.page, status, progress: shown });
  };
  check();
  report("Preparing page", 0.01);
  const gray = toGray(image.data, image.width, image.height);
  if (isBlank(gray)) {
    report("Done", 1);
    return { page: image.page, languages: options.languages, lines: [] };
  }
  await breathe();
  let prepared = cleanImage(gray);
  await breathe();
  check();

  const dpi = Math.round(scale * 72);
  const chosen = [...new Set(options.languages.filter(Boolean))];
  let result: Pass;

  if (chosen.length) {
    prepared = withoutRules(straighten(prepared), dpi);
    await breathe();
    check();
    result = await pass(prepared.image, chosen, dpi, check, report, 0.1, 0.9);
    result = await asOneBlock(result, prepared.image, dpi, check, report);
  } else {
    report("Detecting language", 0.05);
    const longest = Math.max(prepared.image.width, prepared.image.height);
    const small = shrink(prepared.image, Math.max(1, Math.round(longest / 1800)));
    const guess = await detectScript(encodePGM(small), (s) => report(describe(s, []), 0.08));
    check();
    // a sideways or upside-down scan is turned upright before recognition
    const asScanned = prepared;
    const turnedBy = guess && guess.turnConfidence >= 2 ? guess.turn : 0;
    if (guess && turnedBy !== 0) {
      const turned = turn(prepared.image, guess.turn);
      prepared = { image: turned.image, toSource: multiply(turned.toSource, prepared.toSource) };
    }
    prepared = withoutRules(straighten(prepared), dpi);
    await breathe();
    const sure = guess?.script && guess.scriptConfidence >= 1 ? SCRIPT_DEFAULTS[guess.script] : undefined;
    let first = sure?.[0] ?? (await probe(prepared.image, guess?.script ?? null, dpi, check, report));
    check();
    result = await pass(prepared.image, withEnglish(first), dpi, check, report, 0.2, 0.75);
    // script detection can be wrong on short or noisy pages
    if (sure && result.confidence < 55) {
      check();
      const other = await probe(prepared.image, null, dpi, check, report);
      if (other !== first) {
        check();
        const retry = await pass(prepared.image, withEnglish(other), dpi, check, report, 0.75, 0.85);
        if (retry.score > result.score) {
          result = retry;
          first = other;
        }
      }
    }
    const base = result.score;
    let best = result.score;
    for (const alt of alternatives(first, result.text, result.confidence)) {
      check();
      const retry = await pass(prepared.image, withEnglish(alt.lang), dpi, check, report, 0.85, 0.9);
      if (retry.score > (alt.evidence ? Math.max(base * 0.93, best === base ? 0 : best) : best * 1.005)) {
        result = retry;
        best = retry.score;
      }
    }
    result = await asOneBlock(result, prepared.image, dpi, check, report);
    // the guess that the page lay on its side may have been wrong
    if (turnedBy !== 0 && result.confidence < 60) {
      const upright = straighten(asScanned);
      const cleaned = withoutRules(upright, dpi);
      const retry = await pass(cleaned.image, result.languages, dpi, check, report, 0.95, 0.99);
      if (retry.score > result.score) {
        result = retry;
        prepared = cleaned;
      }
    }
  }
  check();

  // processed pixel -> render pixel -> page points
  const toPage: Matrix = multiply(prepared.toSource, [1 / scale, 0, 0, 1 / scale, 0, 0]);
  const lines = convertBlocks(result.blocks, toPage);
  report("Done", 1);
  return { page: image.page, languages: result.languages, lines };
}

const withoutRules = (p: Prepared, dpi: number): Prepared => ({ ...p, image: removeRules(p.image, dpi) });

/** English is read alongside other scripts: numbers, names and addresses are often Latin.
 * The Chinese, Japanese and Korean models already know Latin and lose lines when mixed with it. */
function withEnglish(lang: string): string[] {
  const script = OCR_LANGUAGES.find((l) => l.code === lang)?.script ?? "";
  return ["Latin", "Han", "Japanese", "Hangul"].includes(script) ? [lang] : [lang, "eng"];
}

async function pass(
  image: Gray,
  languages: string[],
  dpi: number,
  check: () => void,
  report: Report,
  from: number,
  to: number,
  /** page segmentation: "3" finds columns and blocks, "6" takes the page as one block */
  layout = "3",
): Promise<Pass> {
  check();
  const mid = from + (to - from) * 0.25;
  let reading = false;
  const worker = await recognizer(languages, (status, progress) => {
    if (status === "recognizing text") report(describe(status, languages), mid + (to - mid) * progress);
    else if (!reading) report(describe(status, languages), from + (mid - from) * progress);
  });
  reading = true;
  report(describe("recognizing text", languages), mid);
  // a message to a worker that has been thrown away is an unhandled error inside tesseract.js
  check();
  const { data } = await runJob(
    worker.recognize(
      encodePGM(image) as unknown as Parameters<typeof worker.recognize>[0],
      // handed to tesseract for this image only
      { user_defined_dpi: String(dpi), tessedit_pageseg_mode: layout } as unknown as Parameters<typeof worker.recognize>[1],
      { text: false, blocks: true },
    ),
  );
  const blocks = (data.blocks ?? []) as unknown as RawBlock[];
  const words = blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
  const real = words.filter((w) => w.text.trim());
  return {
    languages,
    blocks,
    text: real.map((w) => w.text).join(" "),
    confidence: weightedConfidence(real),
    score: real.reduce((s, w) => s + w.text.length * Math.max(0, w.confidence - 40), 0),
  };
}

/**
 * Layout analysis sometimes drops lines (often with Korean, and on poor scans): read the page again as
 * a single block of text and keep whichever reading is more complete and sure.
 */
async function asOneBlock(first: Pass, image: Gray, dpi: number, check: () => void, report: Report): Promise<Pass> {
  // with nothing found at all, forcing a block only invents letters from paper grain
  if (!first.text || (first.confidence >= 75 && !first.languages[0]!.startsWith("kor"))) return first;
  const retry = await pass(image, first.languages, dpi, check, report, 0.9, 0.95, "6");
  return retry.confidence >= 65 && retry.score > first.score * 1.03 ? retry : first;
}

/** read a strip of the page with several models and keep the most believable one */
async function probe(
  image: Gray,
  script: string | null,
  dpi: number,
  check: () => void,
  report: Report,
): Promise<string> {
  const band = densestBand(image, Math.min(image.height, Math.round(dpi * 1.6)));
  const preferred = script ? (SCRIPT_DEFAULTS[script] ?? []) : [];
  const order = [...new Set([...preferred, ...PROBES])];
  let best = "eng";
  let bestScore = 0;
  for (let i = 0; i < order.length; i++) {
    const lang = order[i]!;
    const at = 0.08 + (0.12 * i) / order.length;
    const r = await pass(band, [lang], dpi, check, (s) => report(s, at), at, at);
    // sureness matters more than the amount: a wrong model happily produces a lot of nonsense
    const believable = Math.max(0, r.confidence - 40) * Math.min(1, r.text.length / 15);
    if (believable > bestScore) {
      bestScore = believable;
      best = lang;
    }
    if (r.confidence >= 80 && r.text.length > 20) return lang;
  }
  return best;
}

function describe(status: string, languages: string[]): string {
  const names = languages.map((l) => NAMES.get(l) ?? l).join(", ");
  if (status === "recognizing text") return `Reading text${names ? ` (${names})` : ""}`;
  if (status === "loading language traineddata") return `Downloading language data${names ? ` (${names})` : ""}`;
  return "Starting text recognition";
}

function isBlank(image: Gray): boolean {
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < image.data.length; i += 3) {
    const v = image.data[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo < 24;
}

/** let the page paint between heavy steps */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
