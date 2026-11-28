/** One picture being edited: analyses boxes (once each) and renders their edits. Runs in the worker. */
import type { AssetLoader } from "../engine/context";
import { matchLine, observe } from "./analyze/match";
import { segment, tighten } from "./analyze/segment";
import { renderEdit, type Prepared } from "./compose";
import { doubtful } from "./words";
import { familyByKey, familiesFor, nearestWeight, scriptOfText } from "./fonts/catalog";
import { Fonts, outlines, type FaceRef } from "./fonts/shape";
import { homography, project, quadSize } from "./geometry";
import { Coverage } from "./outline";
import { clamp, sample } from "./raster";
import type { Align, Analysis, BoxEdit, LineStyle, Picture, Quad4, RenderResult, TextBox } from "./types";

export interface AnalyzeOptions {
  align?: Align;
}

export class ImageSession {
  readonly fonts: Fonts;
  private prepared = new Map<string, Promise<Prepared>>();
  private hints: FaceRef[] = [];

  constructor(
    readonly picture: Picture,
    assets: AssetLoader,
  ) {
    this.fonts = new Fonts(assets);
  }

  prepare(box: TextBox, options: AnalyzeOptions = {}): Promise<Prepared> {
    const key = `${box.id}|${box.source}|${box.quad.flat().map((v) => v.toFixed(2)).join(",")}|${box.text}|${box.checked ? 1 : 0}`;
    let job = this.prepared.get(key);
    if (!job) {
      job = this.build(box, options);
      this.prepared.set(key, job);
      job.catch(() => this.prepared.delete(key));
    }
    return job;
  }

  private async build(box: TextBox, options: AnalyzeOptions): Promise<Prepared> {
    let seg = segment(this.picture, box.quad);
    if (box.source === "ocr") {
      // tighten the recogniser's box to the letters, then once more with the better ground around it
      for (const straighten of [true, false]) {
        const quad = tighten(seg, straighten);
        if (!quad) break;
        const next = segment(this.picture, quad);
        if (next.blank) break;
        seg = next;
      }
    }
    const text = box.text.replace(/\s+/g, " ").trim();
    const obs = seg.blank ? null : observe(seg);
    // small grids to compare many faces quickly, then the best few at full detail
    const rough = obs && seg.height > 34 ? observe(seg, 32) : obs;
    const match = obs && rough && text ? await matchLine(this.fonts, text, obs, { hints: this.hints }, rough) : null;
    if (match && match.score > 0.6) {
      const { font, weight, italic } = match.ref;
      this.hints = [{ font, weight, italic }, ...this.hints.filter((h) => h.font !== font || h.weight !== weight)].slice(0, 6);
    }
    const script = scriptOfText(text);
    const fallback = familiesFor(script)[0]!;
    const grain = (seg.noise[0] + seg.noise[1] + seg.noise[2]) / 3;
    const style: LineStyle = {
      font: match?.ref.font ?? fallback.key,
      weight: match?.ref.weight ?? nearestWeight(fallback.weights, 400),
      italic: match ? match.ref.italic || match.placement.shear > 0.08 : false,
      size: match?.placement.size ?? Math.max(6, seg.height * 0.82),
      stretch: match?.placement.stretch ?? 1,
      spacing: match?.placement.spacing ?? 0,
      color: seg.color,
      thickness: match?.thickness ?? 0,
      gamma: match?.gamma ?? 1,
      blur: match?.blur ?? 0,
      grain: grain > 0.9 ? Math.min(40, grain) : 0,
      subpixel: seg.subpixel,
      shadow: !!seg.shadow,
      dx: 0,
      dy: 0,
      rotate: 0,
    };
    return { text, seg, obs, match, style, align: options.align ?? "left", unsure: !!text && doubtful(box, match?.score) };
  }

  async analyze(box: TextBox, options: AnalyzeOptions = {}): Promise<Analysis> {
    const p = await this.prepare(box, options);
    return {
      boxId: box.id,
      text: p.text,
      quad: p.seg.quad,
      style: p.style,
      align: p.align,
      candidates: p.match?.candidates ?? [],
      paper: p.seg.paper,
      blank: p.seg.blank,
      busy: p.seg.busy,
    };
  }

  async render(box: TextBox, edit: BoxEdit, options: AnalyzeOptions = {}): Promise<RenderResult> {
    const p = await this.prepare(box, options);
    return renderEdit(this.picture, this.fonts, p, edit);
  }

  /** coverage picture of a text in a face, for the font list */
  async sample(ref: FaceRef, text: string, height: number): Promise<{ width: number; height: number; alpha: Uint8Array<ArrayBuffer> }> {
    const shaped = await this.fonts.shape(ref, text);
    const size = height * 0.72;
    const width = clamp(Math.ceil(((shaped.ink[2] - shaped.ink[0]) * size) / 100) + 4, 8, height * 14);
    const coverage = new Coverage(width, height);
    const placement = { ox: 2 - (shaped.ink[0] * size) / 100, oy: height * 0.74, size, stretch: 1, spacing: 0, shear: ref.italic && !shaped.realItalic ? 0.21 : 0 };
    for (const glyph of outlines(shaped, placement, 0, (u, v) => [u, v])) coverage.add(glyph);
    const out = coverage.finish();
    const alpha = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) alpha[i] = Math.round(out[i]! * 255);
    return { width, height, alpha };
  }

  /** the inside of a quad as an upright picture, for reading a box the user drew */
  crop(quad: Quad4, minHeight = 64): Picture {
    const { width, height } = quadSize(quad);
    const scale = clamp(minHeight / height, 1, 4);
    const pad = Math.round(height * scale * 0.35);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const m = homography(w, h, quad);
    const data = new Uint8ClampedArray((w + pad * 2) * (h + pad * 2) * 4);
    const src = this.picture;
    for (let y = -pad; y < h + pad; y++) {
      for (let x = -pad; x < w + pad; x++) {
        // outside the box the edge colour carries on, so that nothing there is read
        const [px, py] = project(m, clamp(x + 0.5, 0.5, w - 0.5), clamp(y + 0.5, 0.5, h - 0.5));
        const at = ((y + pad) * (w + pad * 2) + x + pad) * 4;
        for (let c = 0; c < 3; c++) data[at + c] = sample(src.data, src.width, src.height, px, py, 4, c);
        data[at + 3] = 255;
      }
    }
    return { width: w + pad * 2, height: h + pad * 2, data };
  }

  addFont(name: string, bytes: Uint8Array) {
    const face = this.fonts.addUserFont(name, bytes);
    // boxes analysed from now on try the new font as well
    this.prepared.clear();
    return face;
  }

  familyName(key: string): string {
    return familyByKey(key)?.name ?? this.fonts.users.get(key)?.name ?? key;
  }
}
