/** Saving the document, page images and plain text. */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";
import { encodeLatin1 } from "../content/tokenizer";
import * as ocr from "../ocr";
import { rectToQuad } from "../geom";
import * as text from "../text";
import type { ExportOptions, ExportReport, PageText, Rect } from "../types";
import { ensureAppearances } from "./forms";
import { cloneDocument } from "./clone";
import { inspectPage } from "./guard";
import { discardPages, pageRefs } from "./pages";
import { orderByDirection, type Directed } from "./readingOrder";
import { assertPage, latin1, pageSelection, streamBytes, withPage } from "./shared";
import { shrinkToSize } from "./shrink";

const MAX_PIXELS = 48_000_000;

const reports = new WeakMap<object, ExportReport>();

/** what the last export of this document came to */
export const lastExportInfo = (ctx: EngineContext): ExportReport | null => reports.get(ctx.doc) ?? null;

export async function exportPdf(ctx: EngineContext, options: ExportOptions = {}): Promise<Uint8Array> {
  const password = options.password;
  const limit = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : 0;
  const compress = options.compress || !!limit;
  if (password !== undefined && password !== "" && new TextEncoder().encode(password).length > 127)
    throw new Error("The password is too long (127 bytes at most)");
  if (options.pages) {
    if (!options.pages.length) throw new Error("No pages selected");
    options.pages.forEach((p) => assertPage(ctx.doc, p));
  }

  // all work happens on a copy: the open document is never touched by exporting
  const clone = cloneDocument(ctx);
  try {
    if (options.pages) {
      const refs = pageRefs(clone);
      discardPages(clone, [...new Set(options.pages)].map((p) => refs[p]!));
    }
    if (options.flatten) {
      await ensureAppearances({ ...ctx, doc: clone, cache: new Map(), state: structuredClone(ctx.state) }, clone);
      clone.bake(true, true);
    }
    // subsetting follows what every page draws: drawings inside themselves crash it
    if (compress && subsettable(clone)) {
      try {
        clone.subsetFonts();
      } catch {
        /* an unusual font stays complete */
      }
    }
    stampModified(clone, new Date());
    // garbage collection is not optional: removed and redacted content must not stay in the file.
    // ("deduplicate" is not used: MuPDF can merge streams that differ, which blanks content.)
    const settings: Record<string, string> = {
      garbage: "compact",
      compress: "yes",
      "compress-images": "yes",
      "compress-fonts": "yes",
      encrypt: password ? "aes-256" : "none",
    };
    if (compress) settings.objstms = "yes";
    if (password) {
      settings["user-password"] = password;
      settings["owner-password"] = password;
    }
    // decoded pictures left from showing the pages are not needed while saving
    ctx.mupdf.emptyStore();
    const write = (doc: MuPDF.PDFDocument, how: Record<string, string>) => {
      const buffer = doc.saveToBuffer(how);
      try {
        return buffer.asUint8Array().slice();
      } finally {
        buffer.destroy();
      }
    };
    const save = (doc: MuPDF.PDFDocument) => write(doc, settings);
    if (!limit) {
      const bytes = save(clone);
      reports.set(ctx.doc, { bytes: bytes.length, reached: true, images: 0 });
      return bytes;
    }
    const base = write(clone, { ...settings, encrypt: "none" });
    const result = shrinkToSize(ctx, base, limit, save);
    reports.set(ctx.doc, {
      bytes: result.bytes.length,
      maxBytes: limit,
      reached: result.reached,
      images: result.images,
      dpi: result.step?.dpi,
      quality: result.step?.quality,
    });
    return result.bytes;
  } finally {
    clone.destroy();
  }
}

const subsettable = (doc: MuPDF.PDFDocument) =>
  Array.from({ length: doc.countPages() }, (_, i) => i).every((i) => !inspectPage(doc, i).redact);

/** say truthfully when the file was last changed, in both metadata places */
function stampModified(doc: MuPDF.PDFDocument, now: Date) {
  const two = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
  const zone = `${sign}${two(offset / 60)}`;
  const minutes = two(offset % 60);
  doc.setMetaData("info:ModDate", `D:${date.replaceAll("-", "")}${time.replaceAll(":", "")}${zone}'${minutes}'`);

  const xmp = doc.getTrailer().get("Root", "Metadata");
  if (!xmp.isStream()) return;
  const iso = `${date}T${time}${zone}:${minutes}`;
  // the stream is UTF-8; working on its bytes keeps everything else exactly as it is
  const before = latin1(streamBytes(xmp));
  const after = before.replace(
    /(<(xmp|xap):(ModifyDate|MetadataDate)>)[^<]*(<\/)|(\b(?:xmp|xap):(?:ModifyDate|MetadataDate)=(["']))[^"']*(\6)/g,
    (match, open, _p, _k, close, attribute, _q, end) => (open ? `${open}${iso}${close}` : `${attribute}${iso}${end}`),
  );
  if (after !== before) xmp.writeStream(encodeLatin1(after));
}

export function exportPageImage(ctx: EngineContext, page: number, dpi: number, format: "png" | "jpeg"): Uint8Array {
  return withPage(ctx.doc, page, (p) => {
    const [x0, y0, x1, y1] = p.getBounds() as Rect;
    let scale = Math.max(8, Math.min(1200, dpi || 150)) / 72;
    scale = Math.min(scale, Math.sqrt(MAX_PIXELS / Math.max(1, (x1 - x0) * (y1 - y0))));
    const pixmap = p.toPixmap([scale, 0, 0, scale, 0, 0], ctx.mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      pixmap.setResolution(Math.round(scale * 72), Math.round(scale * 72));
      return (format === "jpeg" ? pixmap.asJPEG(92, false) : pixmap.asPNG()).slice();
    } finally {
      pixmap.destroy();
    }
  });
}

/** lines from the text engine (with OCR results), or MuPDF's own reading when that is unavailable */
function pageLines(ctx: EngineContext, page: number): Directed[] {
  let analysed: PageText | null = null;
  try {
    analysed = ocr.mergePageText(ctx, text.analyzePage(ctx, page));
  } catch {
    analysed = null;
  }
  if (analysed) return analysed.lines.map((l) => ({ text: l.text, dir: l.dir, quad: l.quad, angle: l.angle }));
  return withPage(ctx.doc, page, (p) => {
    const lines: Directed[] = [];
    const stext = p.toStructuredText("preserve-whitespace");
    let current: Directed | null = null;
    stext.walk({
      beginLine(bbox, _wmode, direction) {
        const angle = Math.atan2(direction[1], direction[0]);
        current = { text: "", quad: rectToQuad(bbox), angle, dir: "ltr" };
      },
      onChar(c) {
        if (current) current.text += c;
      },
      endLine() {
        if (current?.text.trim()) {
          if (/^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(current.text)) current.dir = "rtl";
          lines.push(current);
        }
        current = null;
      },
    });
    stext.destroy();
    return lines;
  });
}

export function exportText(ctx: EngineContext, pages?: number[]): string {
  return pageSelection(ctx.doc, pages)
    .map((page) => orderByDirection(pageLines(ctx, page).filter((l) => l.text.trim())).join("\n"))
    .join("\n\n");
}
