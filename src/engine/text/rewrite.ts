/**
 * Surgical content rewriting. A glyph either stays exactly where its bytes put it, or is taken out of its
 * show operator (replaced by the equal advance, so nothing after it moves) and optionally drawn again at a
 * new place with the same state. Streams are only spliced at the operators concerned.
 */
import type * as MuPDF from "mupdf";
import { addResource, ownResources, writePageContent } from "../content/page";
import { hexString, spliceContent, type Operand } from "../content/tokenizer";
import type { EngineContext } from "../context";
import { apply, invert, multiply, num, transformRect, union } from "../geom";
import type { Matrix, Point, Rect, RGB } from "../types";
import type { Glyph, Interpretation, MarkedContent, ShowOp, StreamNode } from "./interpret";
import type { Code, PdfFont } from "./pdffont";

export interface Placement {
  font: PdfFont;
  code: Code;
  /** new baseline origin, page space */
  origin: Point;
  /** size factor relative to the show operator's Tf size */
  scale: number;
  /** extra horizontal squeeze */
  squeeze: number;
  /** extra letter spacing, page units */
  spacing: number;
  color?: RGB;
  /** consecutive placements sharing this object are wrapped in one ActualText span */
  actual?: { text: string };
  /** a newly typed glyph rather than a moved original one */
  fresh: boolean;
}

/** every byte becomes the code point of the same value, so splicing keeps it (TextDecoder's "latin1" does not) */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

interface Insert {
  ops: string;
}

const utf16Hex = (s: string) => {
  let out = "FEFF";
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${out}>`;
};

const colorOps = (c: RGB) => `${c.map(num).join(" ")} rg ${c.map(num).join(" ")} RG`;
const restoreColor = (s: ShowOp) =>
  [s.fill.spaceOp, s.fill.colorOp, s.stroke.spaceOp, s.stroke.colorOp].filter(Boolean).join("\n");

function serialize(o: Operand): string {
  switch (o.type) {
    case "number":
      return num(o.value);
    case "name":
      return "/" + o.value.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => "#" + c.charCodeAt(0).toString(16).padStart(2, "0"));
    case "string":
      return hexString(o.value);
    case "array":
      return `[${o.value.map(serialize).join(" ")}]`;
    case "dict":
      return `<<${Object.entries(o.value)
        .map(([k, v]) => `${serialize({ type: "name", value: k })} ${serialize(v)}`)
        .join(" ")}>>`;
    case "bool":
      return String(o.value);
    default:
      return "null";
  }
}

/** operators that change what a later insertion would look like */
const STATE_OPS = new Set(["q", "Q", "cm", "cs", "CS", "sc", "SC", "scn", "SCN", "g", "G", "rg", "RG", "k", "K", "gs", "Do", "W", "W*", "BI", "sh"]);

export class Rewriter {
  private deleted = new Set<Glyph>();
  private moved = new Set<Glyph>();
  /** what is drawn again or anew at each show operator, in reading order */
  private placements = new Map<ShowOp, (Placement | Insert)[]>();
  private drawings = new Map<ShowOp, string[]>();
  private replaced = new Map<StreamNode, Map<number, string>>();
  private before = new Map<StreamNode, Map<number, string[]>>();
  private after = new Map<StreamNode, Map<number, string[]>>();
  private resources = new Map<StreamNode, MuPDF.PDFObject>();
  private boxes = new Map<StreamNode, Rect>();
  private touched = new Set<StreamNode>();
  /** logical text carried by a glyph, for rebuilding ActualText of spans that are only partly removed */
  readonly labels = new Map<Glyph, string>();

  constructor(
    private ctx: EngineContext,
    private page: MuPDF.PDFPage,
    readonly interp: Interpretation,
  ) {}

  /** a resource dictionary of the stream that is safe to add to */
  resourcesFor(node: StreamNode): MuPDF.PDFObject {
    let r = this.resources.get(node);
    if (r) return r;
    const doc = this.ctx.doc;
    if (!node.form) r = ownResources(doc, this.page);
    else {
      r = doc.newDictionary();
      const copy = r;
      if (!node.resources.isNull())
        node.resources.forEach((value, key) => {
          if (value.isDictionary()) {
            const sub = doc.newDictionary();
            value.forEach((v, k) => sub.put(k, v));
            copy.put(key, sub);
          } else copy.put(key, value);
        });
    }
    this.resources.set(node, r);
    this.touched.add(node);
    return r;
  }

  private fontName(show: ShowOp, font: PdfFont): string {
    if (font === show.font && show.fontName) return show.fontName;
    return addResource(this.ctx.doc, this.resourcesFor(show.node), "Font", "PEt", font.obj);
  }

  delete(g: Glyph): void {
    this.deleted.add(g);
  }

  move(g: Glyph, placement: Omit<Placement, "font" | "code" | "fresh">): void {
    this.moved.add(g);
    this.queue(g.show, { ...placement, font: g.show.font, code: g.code, fresh: false });
  }

  place(show: ShowOp, placement: Omit<Placement, "fresh">): void {
    this.queue(show, { ...placement, fresh: true });
  }

  private queue(show: ShowOp, p: Placement | Insert) {
    let list = this.placements.get(show);
    if (!list) this.placements.set(show, (list = []));
    list.push(p);
  }

  /** self contained operators ("q BT ... ET Q") painted at the z position of `show` */
  substitute(show: ShowOp, ops: string): void {
    this.queue(show, { ops });
  }

  /** path painting operators, in the user space of `show`, drawn right after its text object */
  draw(show: ShowOp, ops: string): void {
    let list = this.drawings.get(show);
    if (!list) this.drawings.set(show, (list = []));
    list.push(ops);
  }

  replaceOp(node: StreamNode, index: number, text: string): void {
    let m = this.replaced.get(node);
    if (!m) this.replaced.set(node, (m = new Map()));
    m.set(index, text);
    this.touched.add(node);
  }

  private extra(map: Map<StreamNode, Map<number, string[]>>, node: StreamNode, index: number, text: string) {
    let m = map.get(node);
    if (!m) map.set(node, (m = new Map()));
    let list = m.get(index);
    if (!list) m.set(index, (list = []));
    list.push(text);
    this.touched.add(node);
  }

  insertBefore(node: StreamNode, index: number, text: string): void {
    this.extra(this.before, node, index, text);
  }

  insertAfter(node: StreamNode, index: number, text: string): void {
    this.extra(this.after, node, index, text);
  }

  /** make sure clips and form boxes do not cut off content now covering `box` (page space) */
  reveal(show: ShowOp, previous: Rect, box: Rect): boolean {
    const contains = (outer: Rect, inner: Rect, slack: number) =>
      inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack && inner[2] <= outer[2] + slack && inner[3] <= outer[3] + slack;
    let ok = true;
    for (const clip of show.clips) {
      // only clips that were not cutting the line before
      if (contains(clip.rect, box, 0.5)) continue;
      const slack = 0.25 * (previous[3] - previous[1]);
      if (!contains(clip.rect, previous, Math.max(1, slack))) {
        const grewSideways = box[0] < previous[0] - 0.5 || box[2] > previous[2] + 0.5;
        if (!grewSideways) continue;
      }
      const wanted = union(clip.rect, [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
      if (clip.form) {
        const user = transformRect(invert(clip.matrix), wanted);
        this.boxes.set(clip.node, union(this.boxes.get(clip.node) ?? clip.node.bbox!, user));
        this.touched.add(clip.node);
      } else if (clip.reOp !== null) {
        clip.rect = wanted;
        const u = transformRect(invert(clip.matrix), wanted);
        this.replaceOp(clip.node, clip.reOp, `${num(u[0])} ${num(u[1])} ${num(u[2] - u[0])} ${num(u[3] - u[1])} re`);
      } else ok = false;
    }
    return ok;
  }

  /* ---------- writing ---------- */

  private placed(show: ShowOp, list: Placement[]): string {
    const ctmPage = multiply(show.ctm, this.interp.pageMatrix);
    const inverse = invert(ctmPage);
    const base = show.elements.find((e): e is Glyph => typeof e !== "number")?.tm ?? show.tlm;
    const m = multiply(base, ctmPage);
    const out: string[] = [];

    interface Run {
      key: string;
      actual?: object;
      prefix: string[];
      suffix: string[];
      tm: Matrix;
      items: string[];
      hex: string;
      next: Point;
    }
    let run: Run | null = null;
    // one ActualText span covers every run of the same cluster
    let open: object | undefined;
    const close = () => {
      if (open) out.push("EMC");
      open = undefined;
    };
    const flush = () => {
      if (!run) return;
      if (run.hex) run.items.push(`<${run.hex}>`);
      if (run.actual !== open) {
        close();
        if (run.actual) out.push(`/Span <</ActualText ${utf16Hex((run.actual as { text: string }).text)}>> BDC`);
        open = run.actual;
      }
      out.push(...run.prefix, `${run.tm.map(num).join(" ")} Tm`, `[${run.items.join(" ")}] TJ`, ...run.suffix);
      run = null;
    };

    for (const p of list) {
      const vertical = p.font.vertical;
      const size = show.size * p.scale;
      const th = show.th * p.squeeze;
      const ax = vertical ? m[2] : m[0];
      const ay = vertical ? m[3] : m[1];
      const unit = Math.hypot(ax, ay) || 1;
      // extra spacing is given in page units; Tc is in unscaled text space
      const tc = show.tc * p.scale + p.spacing / (unit * (vertical ? 1 : Math.abs(th) || 1));
      const tw = show.tw * p.scale;
      const name = this.fontName(show, p.font);
      const prefix: string[] = [];
      const suffix: string[] = [];
      if (name !== show.fontName || p.scale !== 1) {
        prefix.push(`/${name} ${num(size)} Tf`);
        if (show.fontName) suffix.push(`/${show.fontName} ${num(show.size)} Tf`);
        else suffix.push(`/${this.fontName(show, show.font)} ${num(show.size)} Tf`);
      }
      if (p.squeeze !== 1) {
        prefix.push(`${num(th * 100)} Tz`);
        suffix.push(`${num(show.th * 100)} Tz`);
      }
      if (Math.abs(tc - show.tc) > 1e-6) {
        prefix.push(`${num(tc)} Tc`);
        suffix.push(`${num(show.tc)} Tc`);
      }
      if (Math.abs(tw - show.tw) > 1e-6) {
        prefix.push(`${num(tw)} Tw`);
        suffix.push(`${num(show.tw)} Tw`);
      }
      if (p.scale !== 1 && show.rise) {
        prefix.push(`${num(show.rise * p.scale)} Ts`);
        suffix.push(`${num(show.rise)} Ts`);
      }
      if (p.color) {
        prefix.push(colorOps(p.color));
        suffix.push(restoreColor(show));
      }
      const key = prefix.join("|");

      const w = vertical ? p.font.verticalAdvance(p.code) : p.font.width(p.code);
      const space = p.code.length === 1 && p.code.code === 32;
      const adv = (w * size + tc + (space ? tw : 0)) * (vertical ? 1 : th);
      const hex = hexString(p.font.codeBytes(p.code)).slice(1, -1);

      let merged = false;
      if (run && run.key === key && run.actual === p.actual && size && (vertical || th)) {
        const dx = p.origin[0] - run.next[0];
        const dy = p.origin[1] - run.next[1];
        const along = (dx * ax + dy * ay) / (unit * unit);
        const off = Math.abs(dx * ay - dy * ax) / unit;
        if (off < 0.004 && Math.abs(along) < 1.5 * Math.abs(size)) {
          const adjust = (-along * 1000) / (size * (vertical ? 1 : th));
          if (Math.abs(adjust) > 0.02) {
            if (run.hex) run.items.push(`<${run.hex}>`);
            run.hex = "";
            run.items.push(num(Math.round(adjust * 1000) / 1000));
          }
          run.hex += hex;
          merged = true;
        }
      }
      if (!merged) {
        flush();
        const user = apply(inverse, p.origin);
        const rise = vertical ? 0 : show.rise * p.scale;
        const tm: Matrix = [base[0], base[1], base[2], base[3], user[0] - rise * base[2], user[1] - rise * base[3]];
        run = { key, actual: p.actual, prefix, suffix, tm, items: [], hex, next: p.origin };
      }
      run!.next = [p.origin[0] + adv * ax, p.origin[1] + adv * ay];
    }
    flush();
    close();
    return out.join("\n");
  }

  private showReplacement(show: ShowOp, stripped: Set<MarkedContent>): string {
    const op = show.node.ops[show.opIndex]!;
    const out: string[] = [];
    if (op.op === "'") out.push("T*");
    if (op.op === '"') {
      const [aw, ac] = op.operands;
      out.push(`${num(aw?.type === "number" ? aw.value : 0)} Tw`, `${num(ac?.type === "number" ? ac.value : 0)} Tc`, "T*");
    }
    const vertical = show.font.vertical;
    const factor = show.size * (vertical ? 1 : show.th);
    const gone = show.elements.some((e) => typeof e !== "number" && (this.deleted.has(e) || this.moved.has(e)));
    if (gone) {
      const items: string[] = [];
      let hex = "";
      let adjust = 0;
      const flushAdjust = () => {
        if (Math.abs(adjust) > 1e-6) {
          if (hex) items.push(`<${hex}>`);
          hex = "";
          items.push(num(adjust));
        }
        adjust = 0;
      };
      for (const e of show.elements) {
        if (typeof e === "number") adjust += e;
        else if (this.deleted.has(e) || this.moved.has(e)) adjust += factor ? (-e.adv * 1000) / factor : 0;
        else {
          flushAdjust();
          hex += hexString(show.font.codeBytes(e.code)).slice(1, -1);
        }
      }
      flushAdjust();
      if (hex) items.push(`<${hex}>`);
      if (items.length) out.push(`[${items.join(" ")}] TJ`);
    } else {
      // untouched string: keep the original bytes of the operator
      const raw = latin1(show.node.bytes.subarray(op.start, op.end));
      if (op.op === "Tj" || op.op === "TJ") out.push(raw);
      else {
        const items = show.elements.map((e) => (typeof e === "number" ? num(e) : hexString(show.font.codeBytes(e.code))));
        out.push(`[${items.join(" ")}] TJ`);
      }
    }

    const queued = this.placements.get(show) ?? [];
    let changedMatrix = false;
    const isNew = (e: Placement | Insert) => "ops" in e || e.fresh;
    const render = (list: (Placement | Insert)[], target: string[], inside = false) => {
      let batch: Placement[] = [];
      const flush = () => {
        if (!batch.length) return;
        target.push(this.placed(show, batch));
        batch = [];
        changedMatrix = true;
      };
      list.forEach((entry, i) => {
        if (!("ops" in entry)) return void batch.push(entry);
        flush();
        // the last item may follow the text object; earlier ones stay in reading order inside it
        if (!inside && i === list.length - 1) target.push(this.escape(show, entry.ops, () => (changedMatrix = true)));
        else {
          target.push(this.inline(show, entry.ops));
          changedMatrix = true;
        }
      });
      flush();
    };

    // new content must not sit inside an ActualText span that survives: it would not be extracted
    const span = show.marked.find((m) => m.actualText !== undefined);
    if (!span || stripped.has(span) || !queued.some(isNew)) render(queued, out);
    else this.splitSpan(show, span, queued, out, render);
    if (changedMatrix) out.push(this.restoreMatrix(show));
    return out.join("\n");
  }

  /**
   * Close the surviving span around each stretch of new content. Its replacement text stays with the first
   * part that holds original glyphs; the parts reopened afterwards carry an empty one.
   */
  private splitSpan(
    show: ShowOp,
    span: MarkedContent,
    queued: (Placement | Insert)[],
    out: string[],
    render: (list: (Placement | Insert)[], target: string[], inside: boolean) => void,
  ) {
    const isNew = (e: Placement | Insert) => "ops" in e || e.fresh;
    // glyphs of the span that come earlier in the content, or stay put in this operator, already carry it
    let carried =
      this.interp.glyphs.some(
        (g) => g.show.node === show.node && g.show.opIndex < show.opIndex && !this.deleted.has(g) && g.show.marked.includes(span),
      ) || show.elements.some((e) => typeof e !== "number" && !this.deleted.has(e) && !this.moved.has(e));
    for (let i = 0; i < queued.length; ) {
      let j = i + 1;
      const fresh = isNew(queued[i]!);
      while (j < queued.length && isNew(queued[j]!) === fresh) j++;
      const part = queued.slice(i, j);
      if (!fresh) {
        render(part, out, true);
        carried = true;
      } else {
        out.push("EMC");
        render(part, out, true);
        let text = "";
        if (!carried) {
          text = span.actualText!;
          carried = true;
          const props = { ...span.props };
          delete props.ActualText;
          const tag = serialize({ type: "name", value: span.tag || "Span" });
          const open = Object.keys(props).length ? `${tag} ${serialize({ type: "dict", value: props })} BDC` : `${tag} BMC`;
          this.replaceOp(span.node, span.begin, open);
        }
        out.push(`/Span <</ActualText ${utf16Hex(text)}>> BDC`);
      }
      i = j;
    }
  }

  private wrap(ops: string): string {
    return `q 0 Tc 0 Tw 100 Tz 0 Ts\n${ops}\nQ`;
  }

  /** self contained operators inside the text object, which is closed and reopened around them */
  private inline(show: ShowOp, ops: string): string {
    if (show.textObject && show.tr >= 4) {
      // text used as a clipping path: do not split the object that builds it
      this.insertBefore(show.node, show.textObject.bt, this.wrap(ops));
      return "";
    }
    return show.textObject ? `ET\n${this.wrap(ops)}\nBT` : this.wrap(ops);
  }

  /**
   * Place self contained text operators. They go after the enclosing text object when nothing in between
   * changes the graphics state; otherwise the text object is closed and reopened around them.
   */
  private escape(show: ShowOp, ops: string, reopened: () => void): string {
    const wrapped = this.wrap(ops);
    const to = show.textObject;
    const node = show.node;
    if (to && show.tr >= 4) {
      // text used as a clipping path: do not split the object that builds it
      this.insertBefore(node, to.bt, wrapped);
      return "";
    }
    if (to && to.et >= 0) {
      let safe = true;
      for (let i = show.opIndex + 1; i < to.et && safe; i++) if (STATE_OPS.has(node.ops[i]!.op) || node.ops[i]!.op === "Tr") safe = false;
      if (show.marked.some((m) => m.node === node && m.begin > to.bt && m.tag === "OC")) safe = false;
      // marked content opened inside this text object has to be closed inside it too
      if (safe) {
        this.insertAfter(node, to.et, wrapped);
        return "";
      }
    }
    if (!to) return wrapped;
    reopened();
    return `ET\n${wrapped}\nBT`;
  }

  private restoreMatrix(show: ShowOp): string {
    const { tlm, tmEnd } = show;
    const vertical = show.font.vertical;
    const ax = vertical ? tlm[2] : tlm[0];
    const ay = vertical ? tlm[3] : tlm[1];
    const length = ax * ax + ay * ay;
    const delta = length ? ((tmEnd[4] - tlm[4]) * ax + (tmEnd[5] - tlm[5]) * ay) / length : 0;
    const factor = show.size * (vertical ? 1 : show.th);
    const line = `${tlm.map(num).join(" ")} Tm`;
    if (Math.abs(delta) < 1e-6) return line;
    if (!factor) return `${tmEnd.map(num).join(" ")} Tm`;
    return `${line}\n[${num((-delta * 1000) / factor)}] TJ`;
  }

  /**
   * ActualText spans that lost glyphs no longer describe what is on the page. When the glyphs left over
   * read correctly on their own the replacement text goes; otherwise it is cut down to them, and the span
   * keeps treating new content as foreign. Returns the spans that lost their replacement text.
   */
  private rewriteSpans(): Set<MarkedContent> {
    const damaged = new Set<MarkedContent>();
    const retained = new Map<MarkedContent, Glyph[]>();
    for (const g of this.deleted) {
      for (const m of g.show.marked) if (m.actualText !== undefined) damaged.add(m);
    }
    if (!damaged.size) return damaged;
    for (const g of this.interp.glyphs) {
      if (this.deleted.has(g)) continue;
      for (const m of g.show.marked)
        if (damaged.has(m)) {
          let list = retained.get(m);
          if (!list) retained.set(m, (list = []));
          list.push(g);
        }
    }
    const stripped = new Set<MarkedContent>();
    const plain = (t: string) => t.normalize("NFKC");
    for (const m of damaged) {
      const props: Record<string, Operand> = { ...m.props };
      delete props.ActualText;
      const left = retained.get(m) ?? [];
      const needed = left.some((g) => !g.unicode || plain(this.labels.get(g) ?? g.unicode) !== plain(g.unicode));
      const text = needed ? left.map((g) => this.labels.get(g) ?? g.unicode).join("") : "";
      if (text) {
        const bytes = [0xfe, 0xff];
        for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) >> 8, text.charCodeAt(i) & 255);
        props.ActualText = { type: "string", value: Uint8Array.from(bytes), hex: true };
        m.actualText = text;
      } else stripped.add(m);
      const tag = serialize({ type: "name", value: m.tag || "Span" });
      this.replaceOp(m.node, m.begin, Object.keys(props).length ? `${tag} ${serialize({ type: "dict", value: props })} BDC` : `${tag} BMC`);
    }
    return stripped;
  }

  apply(): void {
    const doc = this.ctx.doc;
    const stripped = this.rewriteSpans();
    const shows = new Set<ShowOp>(this.placements.keys());
    for (const g of this.deleted) shows.add(g.show);

    for (const show of [...shows].sort((a, b) => a.opIndex - b.opIndex)) {
      this.replaceOp(show.node, show.opIndex, this.showReplacement(show, stripped));
    }
    for (const [show, list] of this.drawings) {
      const to = show.textObject;
      const index = to && to.et >= 0 ? to.et : show.opIndex;
      this.insertAfter(show.node, index, list.join("\n"));
    }

    // rewrite streams from the innermost forms outwards
    const nodes = new Set<StreamNode>();
    for (const n of this.touched) for (let k: StreamNode | null = n; k; k = k.parent) nodes.add(k);
    for (const node of [...nodes].sort((a, b) => b.depth - a.depth)) {
      const replaced = this.replaced.get(node) ?? new Map<number, string>();
      const before = this.before.get(node) ?? new Map<number, string[]>();
      const after = this.after.get(node) ?? new Map<number, string[]>();
      const indices = new Set([...replaced.keys(), ...before.keys(), ...after.keys()]);
      const edits = [...indices].map((i) => {
        const op = node.ops[i]!;
        const original = latin1(node.bytes.subarray(op.start, op.end));
        const body = replaced.get(i) ?? original;
        const replacement = [...(before.get(i) ?? []), body, ...(after.get(i) ?? [])].filter(Boolean).join("\n");
        // inline images contain raw bytes that must not pass through a text decoder
        return { start: op.start, end: op.end, replacement };
      });
      const bytes = spliceContent(node.bytes, edits);
      if (!node.form) {
        if (edits.length) writePageContent(doc, this.page, bytes);
        continue;
      }
      // copy on write: other uses of the form keep the original
      const resources = this.resourcesFor(node);
      const dict = doc.newDictionary();
      node.form.forEach((value, key) => {
        if (!["Length", "Filter", "DecodeParms", "DL"].includes(String(key))) dict.put(key, value);
      });
      dict.put("Resources", resources);
      const box = this.boxes.get(node);
      if (box) {
        const array = doc.newArray();
        for (const v of box) array.push(doc.newReal(v));
        dict.put("BBox", array);
      }
      const form = doc.addStream(bytes, dict);
      const parent = node.parent!;
      const name = addResource(doc, this.resourcesFor(parent), "XObject", "PEfm", form);
      this.replaceOp(parent, node.doOp, `/${name} Do`);
    }
  }
}
