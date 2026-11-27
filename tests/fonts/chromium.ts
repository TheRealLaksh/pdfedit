/**
 * Renders the same lines in Chromium (its own HarfBuzz, same font files) and compares them with the
 * MuPDF rendering of the PDF we wrote: widths, ink mismatch per line, and an overlay image.
 */
import { writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { chromium } from "playwright";
import { layoutText } from "../../src/engine/fonts/layout";
import { draw, makeContext, OUT, style } from "./helpers";

export interface Comparison {
  name: string;
  width: number;
  chromiumWidth: number;
  /** share of inked pixels of either rendering that have no ink within 1px in the other */
  mismatch: number;
}

const SIZE = 36;
const ROW = 80;
const WIDTH = 1200;

export async function compareWithChromium(
  samples: [string, string][],
  imageName: string,
  // asked for by its own name, so Arimo is shaped with its default features, as Chromium does
  family = "Arimo",
): Promise<Comparison[]> {
  const ctx = makeContext(WIDTH, ROW * samples.length);
  const lines: { name: string; text: string; fonts: string[]; rtl: boolean; width: number; y: number }[] = [];
  const fontData = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const [i, [name, text]] of samples.entries()) {
    const y = i * ROW + 52;
    const request = { text, style: style({ size: SIZE, family }) };
    const layout = await layoutText(ctx, request);
    const written = await draw(ctx, text, 10, y, request);
    const fonts: string[] = [];
    // the base font first, as in a CSS font list
    const sources = [...new Map(layout.glyphs.map((g) => [g.source.key, g.source])).values()];
    sources.sort((a, b) => Number(b.family === "Arimo") - Number(a.family === "Arimo"));
    for (const source of sources) {
      let id = ids.get(source.key);
      if (!id) {
        id = `f${ids.size}`;
        ids.set(source.key, id);
        fontData.set(id, Buffer.from(await ctx.assets.bytes(source.key)).toString("base64"));
      }
      fonts.push(id);
    }
    lines.push({ name, text, fonts, rtl: layout.rtl, width: written.width, y });
  }
  const page = ctx.doc.loadPage(0);
  const ours = Buffer.from(page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false).asPNG()).toString("base64");

  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    await tab.setContent("<!doctype html><meta charset=utf-8><body></body>");
    const result = await tab.evaluate(
      async ({ lines, fonts, ours, SIZE, ROW, WIDTH }) => {
        for (const [id, data] of fonts) {
          const face = new FontFace(id, `url(data:font/ttf;base64,${data})`);
          await face.load();
          (document as any).fonts.add(face);
        }
        const height = ROW * lines.length;
        const canvas = () => {
          const c = document.createElement("canvas");
          c.width = WIDTH;
          c.height = height;
          const g = c.getContext("2d", { willReadFrequently: true })!;
          g.fillStyle = "#fff";
          g.fillRect(0, 0, WIDTH, height);
          return [c, g] as const;
        };
        const [, theirs] = canvas();
        theirs.canvas.setAttribute("lang", "und");
        theirs.fillStyle = "#000";
        theirs.textBaseline = "alphabetic";
        theirs.textRendering = "geometricPrecision";
        const widths: number[] = [];
        for (const line of lines) {
          theirs.font = `${SIZE}px ${line.fonts.map((f: string) => `"${f}"`).join(",")}`;
          theirs.direction = line.rtl ? "rtl" : "ltr";
          theirs.textAlign = "left";
          theirs.fillText(line.text, 10, line.y);
          widths.push(theirs.measureText(line.text).width);
        }
        const image = new Image();
        image.src = `data:image/png;base64,${ours}`;
        await image.decode();
        const [, mine] = canvas();
        mine.drawImage(image, 0, 0);
        const a = mine.getImageData(0, 0, WIDTH, height).data;
        const b = theirs.getImageData(0, 0, WIDTH, height).data;
        const [overlay, o] = canvas();
        const out = o.createImageData(WIDTH, height);
        for (let i = 0; i < a.length; i += 4) {
          // ours in red, Chromium in cyan: agreement is black
          out.data[i] = b[i]!;
          out.data[i + 1] = a[i]!;
          out.data[i + 2] = a[i]!;
          out.data[i + 3] = 255;
        }
        o.putImageData(out, 0, 0);
        const ink = (d: Uint8ClampedArray, x: number, y: number) => d[(y * WIDTH + x) * 4]! < 140;
        const near = (d: Uint8ClampedArray, x: number, y: number) => {
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              if (x + dx >= 0 && x + dx < WIDTH && y + dy >= 0 && y + dy < height && d[((y + dy) * WIDTH + x + dx) * 4]! < 200) return true;
          return false;
        };
        const mismatch = lines.map((_: unknown, row: number) => {
          let total = 0;
          let bad = 0;
          for (let y = row * ROW; y < (row + 1) * ROW; y++)
            for (let x = 0; x < WIDTH; x++) {
              if (ink(a, x, y)) {
                total++;
                if (!near(b, x, y)) bad++;
              }
              if (ink(b, x, y)) {
                total++;
                if (!near(a, x, y)) bad++;
              }
            }
          return total ? bad / total : 0;
        });
        return { widths, mismatch, overlay: overlay.toDataURL(), theirs: theirs.canvas.toDataURL() };
      },
      { lines, fonts: [...fontData], ours, SIZE, ROW, WIDTH },
    );
    writeFileSync(`${OUT}${imageName}-overlay.png`, Buffer.from(result.overlay.split(",")[1]!, "base64"));
    writeFileSync(`${OUT}${imageName}-chromium.png`, Buffer.from(result.theirs.split(",")[1]!, "base64"));
    writeFileSync(`${OUT}${imageName}-ours.png`, Buffer.from(ours, "base64"));
    return lines.map((l, i) => ({ name: l.name, width: l.width, chromiumWidth: result.widths[i]!, mismatch: result.mismatch[i]! }));
  } finally {
    await browser.close();
  }
}
