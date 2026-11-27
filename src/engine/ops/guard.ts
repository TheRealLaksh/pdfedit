/**
 * Refuses pages that would hang or crash the PDF engine before it touches them: drawings (forms,
 * patterns) nested very deeply or inside themselves, millions of repeated drawings, and content streams
 * that unpack to hundreds of megabytes. Cheap for ordinary pages: they are only checked for size.
 */
import type * as MuPDF from "mupdf";
import { latin1 } from "./shared";

/** MuPDF's own stack gives out a little above 30 nested drawings */
const MAX_DEPTH = 28;
/** drawings painted by one page, counting repeats */
const MAX_DRAWS = 100_000;
/** redaction copies every drawing it passes through */
const MAX_REDACT_DRAWS = 2_000;
/** unpacked content of one page that can be taken apart for editing */
export const MAX_CONTENT = 24_000_000;

export interface PageRisk {
  /** set when the page must not even be drawn */
  render?: string;
  /** set when its content must not be read or changed */
  edit?: string;
  /** set when nothing under a redaction could be removed reliably */
  redact?: string;
}

type Obj = MuPDF.PDFObject;

const TOO_NESTED = "This page is built from drawings nested too deeply (or inside themselves) to be processed safely.";
const TOO_MANY = "This page repeats its drawings so many times that it cannot be processed.";
const TOO_BIG = "This page holds too much drawing data to be edited in the browser.";

const INVOKE = /\/([^\s/[\]<>(){}%]+)\s+(Do|scn|SCN)(?![A-Za-z0-9])/g;
const unescapeName = (name: string) => name.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function streamsOf(contents: Obj): Obj[] {
  if (contents.isArray()) {
    const out: Obj[] = [];
    for (let i = 0; i < contents.length; i++) if (contents.get(i).isStream()) out.push(contents.get(i));
    return out;
  }
  return contents.isStream() ? [contents] : [];
}

/** the unpacked bytes, or null when there are more than `limit` of them */
function read(streams: Obj[], limit: number): Uint8Array[] | null {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const stream of streams) {
    let buffer: MuPDF.Buffer;
    try {
      buffer = stream.readStream();
    } catch (e) {
      if (/bomb|memory|alloc/i.test(String((e as Error).message))) return null;
      continue; // a broken stream draws nothing
    }
    total += buffer.getLength();
    const part = total <= limit ? buffer.asUint8Array().slice() : null;
    buffer.destroy();
    if (!part) return null;
    parts.push(part);
  }
  return parts;
}

/** whether the resources can draw anything that draws further things */
function hasDrawings(resources: Obj): boolean {
  let found = false;
  const patterns = resources.get("Pattern");
  if (patterns.isDictionary())
    patterns.forEach((p) => {
      if (p.isStream()) found = true;
    });
  const objects = resources.get("XObject");
  if (objects.isDictionary())
    objects.forEach((x) => {
      const subtype = x.get("Subtype");
      if (subtype.isName() && subtype.asName() === "Form") found = true;
    });
  return found;
}

interface Tree {
  draws: number;
  depth: number;
  loop: boolean;
  patternLoop: boolean;
}

export function inspectPage(doc: MuPDF.PDFDocument, index: number): PageRisk {
  const page = doc.findPage(index);
  const streams = streamsOf(page.get("Contents"));
  let packed = 0;
  let filtered = false;
  for (const s of streams) {
    const length = s.get("Length");
    packed += length.isNumber() ? length.asNumber() : 0;
    if (!s.get("Filter").isNull()) filtered = true;
  }
  const resources = page.getInheritable("Resources");
  const nested = resources.isDictionary() && hasDrawings(resources);
  // deflate shrinks at most about a thousand times
  const mightBeBig = packed * (filtered ? 1000 : 1) > MAX_CONTENT;
  if (!nested && !mightBeBig) return {};
  const parts = read(streams, MAX_CONTENT);
  if (!parts) return { edit: TOO_BIG, redact: TOO_BIG };
  if (!nested) return {};

  const known = new Map<number, Tree>();
  const open = new Set<number>();
  let unpacked = 0;

  const visit = (content: Uint8Array[], res: Obj, level: number): Tree => {
    const tree: Tree = { draws: 0, depth: 0, loop: false, patternLoop: false };
    const repeats = new Map<string, number>();
    for (const part of content)
      for (const match of latin1(part).matchAll(INVOKE)) {
        const key = `${match[2] === "Do" ? "XObject" : "Pattern"} ${unescapeName(match[1]!)}`;
        repeats.set(key, (repeats.get(key) ?? 0) + 1);
      }
    for (const [key, times] of repeats) {
      const space = key.indexOf(" ");
      const category = key.slice(0, space);
      const child = res.get(category, key.slice(space + 1));
      if (!child.isStream()) continue;
      const subtype = child.get("Subtype");
      if (category === "XObject" && !(subtype.isName() && subtype.asName() === "Form")) continue;
      const number = child.isIndirect() ? child.asIndirect() : 0;
      if (open.has(number)) {
        tree.loop = true;
        if (category === "Pattern") tree.patternLoop = true;
        continue;
      }
      let sub = known.get(number);
      if (!sub) {
        if (level >= MAX_DEPTH) sub = { draws: 0, depth: 1, loop: false, patternLoop: false };
        else {
          const bytes = read([child], MAX_CONTENT - unpacked) ?? null;
          if (bytes) unpacked += bytes.reduce((sum, b) => sum + b.length, 0);
          const own = child.get("Resources");
          open.add(number);
          sub = bytes
            ? visit(bytes, own.isDictionary() ? own : res, level + 1)
            : { draws: MAX_DRAWS + 1, depth: 0, loop: false, patternLoop: false };
          open.delete(number);
        }
        known.set(number, sub);
      }
      tree.draws = Math.min(1e9, tree.draws + times * (1 + sub.draws));
      tree.depth = Math.max(tree.depth, 1 + sub.depth);
      // a pattern that leads back to itself through any route keeps painting itself
      if (sub.loop) tree.loop = true;
      if (sub.patternLoop || (sub.loop && category === "Pattern")) tree.patternLoop = true;
    }
    return tree;
  };

  const tree = visit(parts, resources, 0);
  const stop = tree.depth > MAX_DEPTH || tree.patternLoop ? TOO_NESTED : tree.draws > MAX_DRAWS ? TOO_MANY : null;
  if (stop) return { render: stop, edit: stop, redact: stop };
  if (tree.loop) return { redact: "This page has drawings that include themselves, so it cannot be redacted reliably." };
  if (tree.draws > MAX_REDACT_DRAWS) return { redact: "This page repeats its drawings too many times to be redacted reliably." };
  return {};
}
