/** Watermarks and page numbers, marked as pagination artifacts. */
import type * as MuPDF from "mupdf";
import type { EngineContext, ModuleChange } from "../context";
import * as fonts from "../fonts";
import { invert, multiply } from "../geom";
import type { Matrix, PageNumberOptions, TextStyle, WatermarkOptions } from "../types";
import { rotationMatrix } from "./objects";
import { appendToPage, drawFormOps, makeForm, ownResources, pageSelection, withPage } from "./shared";
import { layoutText, missingWarning } from "./textLayout";

const MARGIN_SHARE = 0.94;

function stamp(
  ctx: EngineContext,
  index: number,
  form: MuPDF.PDFObject,
  matrix: Matrix,
  opacity: number,
  subtype: string,
) {
  withPage(ctx.doc, index, (page) => {
    const resources = ownResources(ctx.doc, page);
    const toUser = multiply(matrix, invert(page.getTransform() as Matrix));
    const draw = drawFormOps(ctx, page, resources, { form, opacity, blend: "Normal" }, toUser);
    appendToPage(ctx.doc, page, `/Artifact <</Type /Pagination${subtype}>> BDC\n${draw}\nEMC`);
  });
}

export async function addWatermark(ctx: EngineContext, options: WatermarkOptions): Promise<ModuleChange> {
  const pages = pageSelection(ctx.doc, options.pages);
  const text = options.text.trim();
  if (!text) throw new Error("Enter the watermark text");
  if (!pages.length) throw new Error("No pages selected");
  const opacity = Math.min(1, Math.max(0.02, options.opacity));
  const radians = (options.angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));

  const measure = (style: TextStyle) =>
    layoutText(ctx, { text, style, width: Number.POSITIVE_INFINITY, align: "left" });
  const full = await measure(options.style);
  const fullWidth = Math.max(...full.lines.map((l) => l.width), 1);
  const missing = new Set(full.missing);
  /** one form per size, shared by all pages that need it */
  const forms = new Map<string, MuPDF.PDFObject>();

  for (const index of pages) {
    const [x0, y0, x1, y1] = withPage(ctx.doc, index, (p) => p.getBounds());
    // shrink so that the rotated block stays on the page
    const scale = Math.min(
      1,
      (MARGIN_SHARE * (x1 - x0)) / (fullWidth * cos + full.height * sin),
      (MARGIN_SHARE * (y1 - y0)) / (fullWidth * sin + full.height * cos),
    );
    const size = Math.round(options.style.size * scale * 100) / 100;
    let form = forms.get(String(size));
    if (!form) {
      const style = { ...options.style, size };
      const layout = size === options.style.size ? full : await measure(style);
      const width = Math.max(...layout.lines.map((l) => l.width), 1);
      const resources = ctx.doc.newDictionary();
      const parts: string[] = [];
      for (const [i, line] of layout.lines.entries()) {
        if (!line.text) continue;
        const written = await fonts.writeText(ctx, {
          text: line.text,
          style,
          resources,
          matrix: [1, 0, 0, -1, -line.width / 2, layout.baseline(i) - layout.height / 2],
          charSpacing: line.charSpacing,
        });
        for (const m of written.missing) missing.add(m);
        parts.push(written.ops);
      }
      const pad = size * 2;
      form = makeForm(ctx.doc, {
        bbox: [-width / 2 - pad, -layout.height / 2 - pad, width / 2 + pad, layout.height / 2 + pad],
        content: parts.join("\n"),
        resources,
        group: opacity < 1,
      });
      forms.set(String(size), form);
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // counter clockwise on screen
    const matrix = multiply([1, 0, 0, 1, cx, cy], rotationMatrix([cx, cy, cx, cy], -options.angle));
    stamp(ctx, index, form, matrix, opacity, " /Subtype /Watermark");
  }
  return { changedPages: pages, warnings: missingWarning(missing) };
}

export async function addPageNumbers(ctx: EngineContext, options: PageNumberOptions): Promise<ModuleChange> {
  const pages = pageSelection(ctx.doc, options.pages);
  if (!pages.length) throw new Error("No pages selected");
  const format = options.format || "{n}";
  const total = options.startAt + pages.length - 1;
  const [vertical, horizontal] = options.position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  const missing = new Set<string>();

  for (const [i, index] of pages.entries()) {
    const text = format.replaceAll("{n}", String(options.startAt + i)).replaceAll("{total}", String(total));
    const style = options.style;
    const planned = await fonts.planText(ctx, { text, style });
    const [x0, y0, x1, y1] = withPage(ctx.doc, index, (p) => p.getBounds());
    const x =
      horizontal === "left"
        ? x0 + options.margin
        : horizontal === "right"
          ? x1 - options.margin - planned.width
          : (x0 + x1 - planned.width) / 2;
    const y = vertical === "top" ? y0 + options.margin + planned.ascent : y1 - options.margin - planned.descent;
    const resources = ctx.doc.newDictionary();
    const written = await fonts.writeText(ctx, { text, style, resources, matrix: [1, 0, 0, -1, x, y] });
    for (const m of written.missing) missing.add(m);
    const pad = style.size * 2;
    const form = makeForm(ctx.doc, {
      bbox: [x - pad, y - planned.ascent - pad, x + planned.width + pad, y + planned.descent + pad],
      content: written.ops,
      resources,
    });
    stamp(ctx, index, form, [1, 0, 0, 1, 0, 0], 1, "");
  }
  return { changedPages: pages, warnings: missingWarning(missing) };
}
