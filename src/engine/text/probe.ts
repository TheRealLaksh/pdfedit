/**
 * Ask MuPDF itself what a font does with a character code: the glyph it picks, its advance, the Unicode it
 * assumes and whether anything is actually painted. The font is grafted into a throwaway document, so
 * this works for every font type MuPDF can render and never touches the open document.
 */
import type * as MuPDF from "mupdf";
import { concatBytes, encodeLatin1, hexString } from "../content/tokenizer";

export interface Probe {
  gid: number;
  /** MuPDF's idea of the character, "" when it has none */
  unicode: string;
  /** advance along the writing direction as a fraction of the font size (negative downwards for vertical) */
  advance: number;
  /** something visible is painted */
  ink: boolean;
}

const COLS = 8;
const CELL_W = 400;
const CELL_H = 400;
const SIZE = 100;
const SCALE = 0.2;
const BATCH = 160;

export function probeCodes(
  mupdf: typeof MuPDF,
  fontObj: MuPDF.PDFObject,
  codes: Uint8Array[],
  vertical: boolean,
): (Probe | null)[] {
  const results: (Probe | null)[] = new Array(codes.length).fill(null);
  if (!codes.length) return results;
  let scratch: MuPDF.PDFDocument | null = null;
  try {
    scratch = new mupdf.PDFDocument();
    const grafted = scratch.graftObject(fontObj);
    const font = grafted.isIndirect() ? grafted : scratch.addObject(grafted);
    for (let from = 0; from < codes.length; from += BATCH) {
      const batch = codes.slice(from, from + BATCH);
      const rows = Math.ceil(batch.length / COLS);
      const height = rows * CELL_H;
      const parts: Uint8Array[] = [];
      for (let i = 0; i < batch.length; i++) {
        const x = (i % COLS) * CELL_W + 120;
        const y = height - Math.floor(i / COLS) * CELL_H - (vertical ? 60 : 250);
        const hex = hexString(batch[i]!).slice(1, -1);
        parts.push(encodeLatin1(`BT /F ${SIZE} Tf 1 0 0 1 ${x} ${y} Tm <${hex}${hex}> Tj ET\n`));
      }
      const resources = scratch.newDictionary();
      const fonts = scratch.newDictionary();
      fonts.put("F", font);
      resources.put("Font", fonts);
      const pageObj = scratch.addPage([0, 0, COLS * CELL_W, height], 0, resources, concatBytes(parts));
      scratch.insertPage(-1, pageObj);
      const page = scratch.loadPage(scratch.countPages() - 1);

      const seen: { gid: number; unicode: number; e: number; f: number }[] = [];
      const device = new mupdf.Device({
        fillText(text: MuPDF.Text) {
          text.walk({
            showGlyph(_font, trm, gid, unicode) {
              seen.push({ gid, unicode, e: trm[4], f: trm[5] });
            },
          });
        },
      } as never);
      page.run(device, mupdf.Matrix.identity);
      device.close();

      const pixmap = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceGray, false);
      const pixels = pixmap.getPixels();
      const width = pixmap.getWidth();
      const rowsPx = pixmap.getHeight();
      const stride = pixmap.getStride();
      const cw = CELL_W * SCALE;
      const ch = CELL_H * SCALE;
      const inked = (i: number) => {
        const x0 = Math.floor((i % COLS) * cw);
        const y0 = Math.floor(Math.floor(i / COLS) * ch);
        for (let y = y0 + 1; y < Math.min(rowsPx, y0 + ch - 1); y++)
          for (let x = x0 + 1; x < Math.min(width, x0 + cw - 1); x++) if (pixels[y * stride + x]! < 200) return true;
        return false;
      };
      // match device glyphs back to cells by position (codes MuPDF cannot show produce nothing)
      const byCell = new Map<number, typeof seen>();
      for (const g of seen) {
        const col = Math.round((g.e - 120) / CELL_W - 0.15);
        const startY = vertical ? 60 : 250;
        // page device space: the glyph matrix is given in PDF user space of the scratch page
        const row = Math.round((height - g.f - startY) / CELL_H);
        const idx = Math.max(0, row) * COLS + Math.max(0, Math.min(COLS - 1, col));
        let list = byCell.get(idx);
        if (!list) byCell.set(idx, (list = []));
        list.push(g);
      }
      // sequential matching is exact when every code produced two glyphs
      const sequential = seen.length === batch.length * 2;
      for (let i = 0; i < batch.length; i++) {
        const pair = sequential ? [seen[2 * i]!, seen[2 * i + 1]!] : byCell.get(i);
        if (!pair || !pair.length) continue;
        const a = pair[0]!;
        const b = pair[1];
        const advance = b ? (vertical ? b.f - a.f : b.e - a.e) / SIZE : 0;
        results[from + i] = {
          gid: a.gid,
          unicode: a.unicode > 0 && a.unicode !== 0xfffd ? String.fromCodePoint(a.unicode) : "",
          advance,
          ink: inked(i),
        };
      }
      device.destroy();
      pixmap.destroy();
      page.destroy();
    }
  } catch {
    // a font MuPDF cannot even load probes as unknown
  } finally {
    scratch?.destroy();
  }
  return results;
}
