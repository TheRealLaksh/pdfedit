/**
 * Content stream interpreter: walks a page (and nested Form XObjects) tracking graphics and text state, and
 * records every glyph together with the exact operator that produced it, so editing can splice the bytes.
 */
import type * as MuPDF from "mupdf";
import { parseContent, type Operand, type Operation } from "../content/tokenizer";
import { readPageContent } from "../content/page";
import type { EngineContext } from "../context";
import { apply, intersects, multiply, rectFromPoints, transformRect, union } from "../geom";
import type { Matrix, Point, Rect, RGB } from "../types";
import { CMYK, GRAY, loadSpace, RGBSPACE, type Space } from "./color";
import { PdfFont, type Code } from "./pdffont";

export interface StreamNode {
  parent: StreamNode | null;
  /** index of the Do operator in the parent that produced this node */
  doOp: number;
  /** the form XObject; null for the page */
  form: MuPDF.PDFObject | null;
  resources: MuPDF.PDFObject;
  bytes: Uint8Array;
  ops: Operation[];
  /** CTM (to page user space) when the stream starts */
  ctm0: Matrix;
  depth: number;
  /** for forms: the BBox clip */
  bbox?: Rect;
}

export interface MarkedContent {
  node: StreamNode;
  begin: number;
  /** index of the EMC, -1 while open */
  end: number;
  tag: string;
  actualText?: string;
  /** property dictionary of BDC, already resolved */
  props: Record<string, Operand> | null;
}

export interface TextObject {
  node: StreamNode;
  bt: number;
  et: number;
}

export interface ClipRef {
  node: StreamNode;
  /** the `re` operator that built a rectangular clip, or null when it cannot be widened that way */
  reOp: number | null;
  /** page space bounding box */
  rect: Rect;
  /** user space -> page space at the time of the path */
  matrix: Matrix;
  /** this clip is a form's BBox */
  form?: boolean;
}

export interface ColorState {
  space: Space;
  comps: number[];
  /** raw operators that restore this colour exactly */
  spaceOp: string;
  colorOp: string;
}

export interface ShowOp {
  node: StreamNode;
  opIndex: number;
  textObject: TextObject | null;
  font: PdfFont;
  /** resource name in this stream, "" when the font came from an ExtGState */
  fontName: string;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  tr: number;
  ctm: Matrix;
  fill: ColorState;
  stroke: ColorState;
  alpha: number;
  /** line matrix in force while the string is shown (after the line advance of ' and ") */
  tlm: Matrix;
  /** text matrix after the whole operator */
  tmEnd: Matrix;
  elements: (number | Glyph)[];
  clips: ClipRef[];
  marked: MarkedContent[];
}

export interface Glyph {
  show: ShowOp;
  /** position in content order */
  seq: number;
  code: Code;
  /** width as a fraction of the font size (horizontal) or vertical displacement */
  w: number;
  /** full advance in text space units along the writing axis */
  adv: number;
  /** text matrix at the glyph */
  tm: Matrix;
  unicode: string;
  /** deliberately mapped to nothing: its text is carried by a neighbouring glyph */
  filler?: boolean;
  /** baseline origin, page space */
  origin: Point;
  /** unit vector of the writing direction, page space */
  dir: Point;
  /** advance of the glyph shape / of the pen, in page units along dir */
  width: number;
  advance: number;
  /** font size in page units, perpendicular to the baseline */
  size: number;
  /** page units per text space unit along the writing axis (always positive) */
  unit: number;
  invisible: boolean;
  /** the ActualText span this glyph belongs to, if any */
  actual: MarkedContent | null;
}

export interface Decoration {
  node: StreamNode;
  /** first path construction operator and the painting operator */
  first: number;
  paint: number;
  /** page space */
  rect: Rect;
  /** end points of the centre line, page space */
  a: Point;
  b: Point;
  thickness: number;
  stroked: boolean;
  matrix: Matrix;
}

export interface Interpretation {
  root: StreamNode;
  glyphs: Glyph[];
  shows: ShowOp[];
  /** thin straight rules: underlines, strike-throughs, table borders */
  rules: Decoration[];
  images: Rect[];
  /** number of painted paths (text drawn as outlines shows up here) */
  paths: number;
  marked: MarkedContent[];
  pageMatrix: Matrix;
  pageRect: Rect;
  errors: string[];
}

interface GState {
  ctm: Matrix;
  font: PdfFont | null;
  fontName: string;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  tr: number;
  fill: ColorState;
  stroke: ColorState;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  clips: ClipRef[];
}

const MAX_DEPTH = 12;
const MAX_GLYPHS = 400_000;

const nums = (operands: Operand[]) => operands.map((o) => (o.type === "number" ? o.value : 0));

export function pdfString(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes.subarray(3));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function toOperand(o: MuPDF.PDFObject, depth = 0): Operand {
  if (o.isNumber()) return { type: "number", value: o.asNumber() };
  if (o.isName()) return { type: "name", value: o.asName() };
  if (o.isString()) return { type: "string", value: o.asByteString(), hex: true };
  if (o.isBoolean()) return { type: "bool", value: o.asBoolean() };
  if (depth < 3 && o.isArray()) {
    const value: Operand[] = [];
    for (let i = 0; i < o.length; i++) value.push(toOperand(o.get(i), depth + 1));
    return { type: "array", value };
  }
  if (depth < 3 && o.isDictionary()) {
    const value: Record<string, Operand> = {};
    o.forEach((v, k) => (value[String(k)] = toOperand(v, depth + 1)));
    return { type: "dict", value };
  }
  return { type: "null" };
}

export function interpretPage(ctx: EngineContext, pageIndex: number, page: MuPDF.PDFPage): Interpretation {
  const pageMatrix = page.getTransform() as Matrix;
  const pageRect = page.getBounds() as Rect;
  const resources = page.getObject().getInheritable("Resources");
  const root: StreamNode = {
    parent: null,
    doOp: -1,
    form: null,
    resources,
    bytes: readPageContent(page),
    ops: [],
    ctm0: [1, 0, 0, 1, 0, 0],
    depth: 0,
  };
  const out: Interpretation = {
    root,
    glyphs: [],
    shows: [],
    rules: [],
    images: [],
    paths: 0,
    marked: [],
    pageMatrix,
    pageRect,
    errors: [],
  };

  // font objects are shared by all pages until the next change, so that probing a font happens once
  let shared = ctx.cache.get("text:fonts") as Map<string, PdfFont | null> | undefined;
  if (!shared) ctx.cache.set("text:fonts", (shared = new Map()));
  const direct = new Map<string, PdfFont | null>();
  let directFonts = 0;
  const loadFont = (ref: MuPDF.PDFObject, hint: string): PdfFont | null => {
    if (ref.isNull() || !ref.isDictionary()) return null;
    const key = ref.isIndirect() ? `f${ref.asIndirect()}` : `d${pageIndex}:${hint}:${directFonts++}`;
    const fonts = ref.isIndirect() ? shared : direct;
    let font = fonts.get(key);
    if (font === undefined) {
      try {
        font = new PdfFont(ctx.mupdf, ref, key);
      } catch (e) {
        out.errors.push(`font ${hint}: ${String(e)}`);
        font = null;
      }
      fonts.set(key, font);
    }
    return font;
  };

  const spaces = new Map<string, Space>();
  const active = new Set<number>();
  let fallbackFont: PdfFont | null = null;

  const initial: GState = {
    ctm: root.ctm0,
    font: null,
    fontName: "",
    size: 1,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    rise: 0,
    tr: 0,
    fill: { space: GRAY, comps: [0], spaceOp: "", colorOp: "0 g" },
    stroke: { space: GRAY, comps: [0], spaceOp: "", colorOp: "0 G" },
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    clips: [],
  };

  function run(node: StreamNode, start: GState, markedBase: MarkedContent[]) {
    try {
      node.ops = parseContent(node.bytes);
    } catch (e) {
      out.errors.push(String(e));
      return;
    }
    const raw = (i: number) => {
      const op = node.ops[i]!;
      let s = "";
      for (let k = op.start; k < op.end; k++) s += String.fromCharCode(node.bytes[k]!);
      return s;
    };
    let gs: GState = { ...start };
    const stack: GState[] = [];
    const marked = [...markedBase];
    let tm: Matrix = [1, 0, 0, 1, 0, 0];
    let tlm: Matrix = [1, 0, 0, 1, 0, 0];
    let textObject: TextObject | null = null;

    // current path
    let subpaths: Point[][] = [];
    let pathFirst = -1;
    let reOps: number[] = [];
    let pathOther = false;
    let pendingClip = false;

    const nextLine = (tx: number, ty: number) => {
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tx * tlm[0] + ty * tlm[2] + tlm[4], tx * tlm[1] + ty * tlm[3] + tlm[5]];
      tm = [...tlm];
    };

    const spaceFor = (name: Operand | undefined): Space => {
      if (name?.type !== "name") return GRAY;
      const n = name.value;
      if (n === "DeviceGray") return GRAY;
      if (n === "DeviceRGB") return RGBSPACE;
      if (n === "DeviceCMYK") return CMYK;
      const res = node.resources.isNull() ? null : node.resources.get("ColorSpace", n);
      const key = res && !res.isNull() && res.isIndirect() ? `i${res.asIndirect()}` : `${node.depth}:${n}`;
      let s = spaces.get(key);
      if (!s) {
        try {
          s = res && !res.isNull() ? loadSpace(res, node.resources) : loadSpace(ctx.doc.newName(n), node.resources);
        } catch {
          s = GRAY;
        }
        spaces.set(key, s);
      }
      return s;
    };

    const setColor = (target: "fill" | "stroke", space: Space, operands: Operand[], i: number) => {
      const comps = operands.filter((o) => o.type === "number").map((o) => (o as { value: number }).value);
      const previous = gs[target];
      const isGeneric = node.ops[i]!.op.toLowerCase().startsWith("sc");
      gs[target] = {
        space,
        comps,
        spaceOp: isGeneric ? previous.spaceOp : "",
        colorOp: raw(i),
      };
    };

    const finishPath = (i: number, op: string) => {
      const painted = op !== "n";
      if (painted) out.paths++;
      const toPage = multiply(gs.ctm, pageMatrix);
      const points = subpaths.flat();
      if (points.length) {
        const pagePoints = points.map((p) => apply(toPage, p));
        const box = rectFromPoints(pagePoints);
        if (painted && !pendingClip && subpaths.length === 1) {
          const rule = ruleFrom(node, pathFirst, i, op, subpaths[0]!, toPage, gs.lineWidth);
          if (rule) out.rules.push(rule);
        }
        if (pendingClip) {
          const isRect = reOps.length === 1 && !pathOther;
          const axisAligned = Math.abs(toPage[1]) < 1e-6 && Math.abs(toPage[2]) < 1e-6;
          const quarter = Math.abs(toPage[0]) < 1e-6 && Math.abs(toPage[3]) < 1e-6;
          gs.clips = [
            ...gs.clips,
            { node, reOp: isRect && (axisAligned || quarter) ? reOps[0]! : null, rect: box, matrix: toPage },
          ];
        }
      }
      subpaths = [];
      reOps = [];
      pathOther = false;
      pathFirst = -1;
      pendingClip = false;
    };

    const addPoint = (i: number, p: Point, move = false) => {
      if (pathFirst < 0) pathFirst = i;
      if (move || !subpaths.length) subpaths.push([]);
      subpaths[subpaths.length - 1]!.push(p);
    };

    const show = (i: number, items: Operand[]) => {
      const font =
        gs.font ??
        (fallbackFont ??= loadFont(
          (() => {
            const d = ctx.doc.newDictionary();
            d.put("Type", ctx.doc.newName("Font"));
            d.put("Subtype", ctx.doc.newName("Type1"));
            d.put("BaseFont", ctx.doc.newName("Helvetica"));
            return d;
          })(),
          "fallback",
        ));
      if (!font) return;
      let actual: MarkedContent | null = null;
      for (const m of marked)
        if (m.actualText !== undefined) {
          actual = m;
          break;
        }
      const op: ShowOp = {
        node,
        opIndex: i,
        textObject,
        font,
        fontName: gs.fontName,
        size: gs.size,
        tc: gs.tc,
        tw: gs.tw,
        th: gs.th,
        tl: gs.tl,
        rise: gs.rise,
        tr: gs.tr,
        ctm: gs.ctm,
        fill: gs.fill,
        stroke: gs.stroke,
        alpha: gs.tr === 1 || gs.tr === 5 ? gs.strokeAlpha : gs.fillAlpha,
        tlm: [...tlm],
        tmEnd: tm,
        elements: [],
        clips: gs.clips,
        marked: [...marked],
      };
      const { size, tc, tw, th, rise } = gs;
      const mode = gs.tr % 4;
      const invisible =
        gs.tr === 3 ||
        size === 0 ||
        th === 0 ||
        (mode === 0 && gs.fillAlpha <= 0.004) ||
        (mode === 1 && gs.strokeAlpha <= 0.004) ||
        (mode === 2 && gs.fillAlpha <= 0.004 && gs.strokeAlpha <= 0.004);
      const vertical = font.vertical;
      const ctmPage = multiply(gs.ctm, pageMatrix);
      for (const item of items) {
        if (item.type === "number") {
          op.elements.push(item.value);
          const shift = (-item.value / 1000) * size;
          if (vertical) tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + shift * tm[2], tm[5] + shift * tm[3]];
          else tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + shift * th * tm[0], tm[5] + shift * th * tm[1]];
          continue;
        }
        if (item.type !== "string") continue;
        const codes = font.decode(item.value);
        font.prepare(codes);
        for (const code of codes) {
          if (out.glyphs.length >= MAX_GLYPHS) return;
          const w = vertical ? font.verticalAdvance(code) : font.width(code);
          const space = code.length === 1 && code.code === 32;
          const adv = vertical ? w * size + tc + (space ? tw : 0) : (w * size + tc + (space ? tw : 0)) * th;
          const m = multiply(tm, ctmPage);
          const ax = vertical ? 0 : 1;
          const sign = Math.sign(vertical ? w * size || -1 : size * th || 1);
          const lx = ax ? m[0] : m[2];
          const ly = ax ? m[1] : m[3];
          const unit = Math.hypot(lx, ly) || 1e-9;
          const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
          const glyph: Glyph = {
            show: op,
            seq: out.glyphs.length,
            code,
            w,
            adv,
            tm,
            unicode: "",
            origin: vertical ? [m[4], m[5]] : [rise * m[2] + m[4], rise * m[3] + m[5]],
            dir: [(sign * lx) / unit, (sign * ly) / unit],
            width: Math.abs(w * size * (vertical ? 1 : th)) * unit,
            advance: adv * sign * unit,
            size: (Math.abs(size) * font.emScale * det) / unit,
            unit,
            invisible,
            actual,
          };
          out.glyphs.push(glyph);
          op.elements.push(glyph);
          if (vertical) tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + adv * tm[2], tm[5] + adv * tm[3]];
          else tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + adv * tm[0], tm[5] + adv * tm[1]];
        }
      }
      op.tmEnd = tm;
      out.shows.push(op);
    };

    for (let i = 0; i < node.ops.length; i++) {
      const { op, operands } = node.ops[i]!;
      switch (op) {
        case "q":
          stack.push({ ...gs });
          break;
        case "Q":
          gs = stack.pop() ?? gs;
          break;
        case "cm": {
          const m = nums(operands.slice(-6)) as Matrix;
          if (m.length === 6) gs.ctm = multiply(m, gs.ctm);
          break;
        }
        case "w":
          gs.lineWidth = nums(operands)[0] ?? 1;
          break;
        case "gs": {
          const name = operands[0];
          if (name?.type !== "name" || node.resources.isNull()) break;
          const dict = node.resources.get("ExtGState", name.value);
          if (dict.isNull()) break;
          const ca = dict.get("ca");
          const CA = dict.get("CA");
          if (ca.isNumber()) gs.fillAlpha = ca.asNumber();
          if (CA.isNumber()) gs.strokeAlpha = CA.asNumber();
          const lw = dict.get("LW");
          if (lw.isNumber()) gs.lineWidth = lw.asNumber();
          const f = dict.get("Font");
          if (f.isArray() && f.length === 2) {
            gs.font = loadFont(f.get(0), name.value);
            gs.fontName = "";
            gs.size = f.get(1).asNumber();
          }
          break;
        }
        case "BT":
          tm = [1, 0, 0, 1, 0, 0];
          tlm = [1, 0, 0, 1, 0, 0];
          textObject = { node, bt: i, et: -1 };
          break;
        case "ET":
          if (textObject) textObject.et = i;
          textObject = null;
          break;
        case "Tf": {
          const name = operands[0];
          if (name?.type === "name") {
            gs.fontName = name.value;
            const ref = node.resources.isNull() ? null : node.resources.get("Font", name.value);
            gs.font = ref ? loadFont(ref, name.value) : null;
          }
          const s = operands[1];
          if (s?.type === "number") gs.size = s.value;
          break;
        }
        case "Tc":
          gs.tc = nums(operands)[0] ?? 0;
          break;
        case "Tw":
          gs.tw = nums(operands)[0] ?? 0;
          break;
        case "Tz":
          gs.th = (nums(operands)[0] ?? 100) / 100;
          break;
        case "TL":
          gs.tl = nums(operands)[0] ?? 0;
          break;
        case "Tr":
          gs.tr = nums(operands)[0] ?? 0;
          break;
        case "Ts":
          gs.rise = nums(operands)[0] ?? 0;
          break;
        case "Td":
        case "TD": {
          const [x = 0, y = 0] = nums(operands);
          if (op === "TD") gs.tl = -y;
          nextLine(x, y);
          break;
        }
        case "Tm": {
          const m = nums(operands.slice(-6)) as Matrix;
          if (m.length === 6) {
            tlm = [...m];
            tm = [...m];
          }
          break;
        }
        case "T*":
          nextLine(0, -gs.tl);
          break;
        case "Tj": {
          const s = operands[operands.length - 1];
          if (s) show(i, [s]);
          break;
        }
        case "TJ": {
          const a = operands[operands.length - 1];
          if (a?.type === "array") show(i, a.value);
          break;
        }
        case "'":
          nextLine(0, -gs.tl);
          if (operands[0]) show(i, [operands[operands.length - 1]!]);
          break;
        case '"': {
          const [aw, ac] = operands;
          if (aw?.type === "number") gs.tw = aw.value;
          if (ac?.type === "number") gs.tc = ac.value;
          nextLine(0, -gs.tl);
          if (operands[2]) show(i, [operands[2]]);
          break;
        }
        case "g":
          setColor("fill", GRAY, operands, i);
          break;
        case "G":
          setColor("stroke", GRAY, operands, i);
          break;
        case "rg":
          setColor("fill", RGBSPACE, operands, i);
          break;
        case "RG":
          setColor("stroke", RGBSPACE, operands, i);
          break;
        case "k":
          setColor("fill", CMYK, operands, i);
          break;
        case "K":
          setColor("stroke", CMYK, operands, i);
          break;
        case "cs":
        case "CS": {
          const space = spaceFor(operands[0]);
          gs[op === "cs" ? "fill" : "stroke"] = { space, comps: space.initial, spaceOp: raw(i), colorOp: "" };
          break;
        }
        case "sc":
        case "scn":
          setColor("fill", gs.fill.space, operands, i);
          break;
        case "SC":
        case "SCN":
          setColor("stroke", gs.stroke.space, operands, i);
          break;
        case "m": {
          const [x = 0, y = 0] = nums(operands);
          pathOther = true;
          addPoint(i, [x, y], true);
          break;
        }
        case "l": {
          const [x = 0, y = 0] = nums(operands);
          pathOther = true;
          addPoint(i, [x, y]);
          break;
        }
        case "c":
        case "v":
        case "y": {
          const v = nums(operands);
          pathOther = true;
          for (let k = 0; k + 1 < v.length; k += 2) addPoint(i, [v[k]!, v[k + 1]!]);
          break;
        }
        case "h":
          pathOther ||= !reOps.length;
          break;
        case "re": {
          const [x = 0, y = 0, w = 0, h = 0] = nums(operands);
          reOps.push(i);
          addPoint(i, [x, y], true);
          addPoint(i, [x + w, y]);
          addPoint(i, [x + w, y + h]);
          addPoint(i, [x, y + h]);
          break;
        }
        case "W":
        case "W*":
          pendingClip = true;
          break;
        case "n":
        case "S":
        case "s":
        case "f":
        case "F":
        case "f*":
        case "B":
        case "B*":
        case "b":
        case "b*":
          finishPath(i, op);
          break;
        case "BI":
          out.images.push(transformRect(multiply(gs.ctm, pageMatrix), [0, 0, 1, 1]));
          break;
        case "Do": {
          const name = operands[0];
          if (name?.type !== "name" || node.resources.isNull()) break;
          const xobj = node.resources.get("XObject", name.value);
          if (xobj.isNull()) break;
          const subtype = xobj.get("Subtype");
          const kind = subtype.isName() ? subtype.asName() : "";
          if (kind === "Image") {
            out.images.push(transformRect(multiply(gs.ctm, pageMatrix), [0, 0, 1, 1]));
          } else if (kind === "Form" && xobj.isStream() && node.depth < MAX_DEPTH) {
            const num = xobj.isIndirect() ? xobj.asIndirect() : -1;
            if (num >= 0 && active.has(num)) break;
            let bytes: Uint8Array;
            try {
              bytes = xobj.readStream().asUint8Array().slice();
            } catch (e) {
              out.errors.push(String(e));
              break;
            }
            const matrixObj = xobj.get("Matrix");
            const matrix: Matrix = matrixObj.isArray()
              ? ([0, 1, 2, 3, 4, 5].map((k) => matrixObj.get(k).asNumber()) as Matrix)
              : [1, 0, 0, 1, 0, 0];
            const ctm = multiply(matrix, gs.ctm);
            const own = xobj.get("Resources");
            const child: StreamNode = {
              parent: node,
              doOp: i,
              form: xobj,
              resources: own.isNull() ? node.resources : own,
              bytes,
              ops: [],
              ctm0: ctm,
              depth: node.depth + 1,
            };
            const state: GState = { ...gs, ctm };
            const b = xobj.get("BBox");
            if (b.isArray() && b.length === 4) {
              const box = [0, 1, 2, 3].map((k) => b.get(k).asNumber()) as Rect;
              child.bbox = box;
              const toPage = multiply(ctm, pageMatrix);
              state.clips = [...state.clips, { node: child, reOp: null, rect: transformRect(toPage, box), matrix: toPage, form: true }];
            }
            if (num >= 0) active.add(num);
            run(child, state, marked);
            if (num >= 0) active.delete(num);
          }
          break;
        }
        case "BMC":
        case "BDC": {
          const tag = operands[0]?.type === "name" ? operands[0].value : "";
          let props: Record<string, Operand> | null = null;
          const p = operands[1];
          if (p?.type === "dict") props = p.value;
          else if (p?.type === "name" && !node.resources.isNull()) {
            const dict = node.resources.get("Properties", p.value);
            if (dict.isDictionary()) {
              const o = toOperand(dict);
              if (o.type === "dict") props = o.value;
            }
          }
          const at = props?.ActualText;
          const m: MarkedContent = {
            node,
            begin: i,
            end: -1,
            tag,
            props,
            actualText: at?.type === "string" ? pdfString(at.value).replace(/[\0\uFEFF]/g, "") : undefined,
          };
          marked.push(m);
          out.marked.push(m);
          break;
        }
        case "EMC": {
          if (marked.length > markedBase.length) marked.pop()!.end = i;
          break;
        }
      }
    }
  }

  run(root, initial, []);
  decodeUnicode(out);

  // glyphs entirely outside their clip cannot be seen
  for (const g of out.glyphs) {
    if (g.invisible || !g.show.clips.length) continue;
    const x = g.origin[0] + g.dir[0] * g.width * 0.5 + g.dir[1] * g.size * 0.3;
    const y = g.origin[1] + g.dir[1] * g.width * 0.5 - g.dir[0] * g.size * 0.3;
    const r: Rect = [x - g.size, y - g.size, x + g.size, y + g.size];
    for (const c of g.show.clips) if (!intersects(r, c.rect)) g.invisible = true;
  }
  return out;
}

function decodeUnicode(out: Interpretation) {
  const unknown = new Map<PdfFont, Glyph[]>();
  for (const g of out.glyphs) {
    const u = g.show.font.unicode(g.code);
    if (u) {
      // producers map the extra glyphs of a cluster to a zero width no-break space
      g.unicode = u.replace(/\uFEFF/g, "");
      if (!g.unicode) g.filler = true;
    } else if (!g.actual) {
      let list = unknown.get(g.show.font);
      if (!list) unknown.set(g.show.font, (list = []));
      list.push(g);
    }
  }
  for (const [font, glyphs] of unknown) {
    font.probeMany(glyphs.map((g) => g.code));
    for (const g of glyphs) {
      const p = font.probe(g.code);
      // MuPDF falls back to the raw code when it knows nothing; that is not a real mapping
      if (p?.unicode && p.unicode.codePointAt(0)! >= 32) {
        const cp = p.unicode.codePointAt(0)!;
        const guessed = cp === g.code.code && (font.composite || font.subtype === "Type3");
        if (!guessed) g.unicode = p.unicode;
      }
    }
  }
}

function ruleFrom(
  node: StreamNode,
  first: number,
  paint: number,
  op: string,
  path: Point[],
  toPage: Matrix,
  lineWidth: number,
): Decoration | null {
  if (path.length < 2 || path.length > 5) return null;
  const pts = path.map((p) => apply(toPage, p));
  const stroked = /^[sSbB]/.test(op);
  const filled = /^[fFbB]/.test(op);
  const box = rectFromPoints(pts);
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const scale = Math.sqrt(Math.abs(toPage[0] * toPage[3] - toPage[1] * toPage[2]));
  if (path.length === 2 && stroked) {
    const t = lineWidth * scale || 0.5;
    if (t > 6 || Math.hypot(w, h) < 2) return null;
    return {
      node,
      first,
      paint,
      a: pts[0]!,
      b: pts[1]!,
      thickness: t,
      stroked: true,
      matrix: toPage,
      rect: union(box, [box[0] - t / 2, box[1] - t / 2, box[2] + t / 2, box[3] + t / 2]),
    };
  }
  if (filled && path.length >= 4 && Math.min(w, h) <= 4 && Math.max(w, h) >= 2) {
    const horizontal = w >= h;
    return {
      node,
      first,
      paint,
      a: horizontal ? [box[0], (box[1] + box[3]) / 2] : [(box[0] + box[2]) / 2, box[1]],
      b: horizontal ? [box[2], (box[1] + box[3]) / 2] : [(box[0] + box[2]) / 2, box[3]],
      thickness: Math.min(w, h),
      stroked: false,
      matrix: toPage,
      rect: box,
    };
  }
  return null;
}

/** RGB shown for a glyph (stroke colour for outline-only text) */
export function glyphColor(g: Glyph): RGB {
  const c = g.show.tr % 4 === 1 ? g.show.stroke : g.show.fill;
  return c.space.toRGB(c.comps);
}
