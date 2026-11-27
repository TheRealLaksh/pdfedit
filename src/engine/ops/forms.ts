/**
 * AcroForm fields. MuPDF draws appearances for plain western values; anything else (Indic, CJK, Arabic ...)
 * gets an appearance drawn here with the FONTS module.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext, ModuleChange } from "../context";
import { encodeLatin1 } from "../content/tokenizer";
import * as fonts from "../fonts";
import { num } from "../geom";
import type { FormField, RGB, Rect, TextStyle } from "../types";
import { subtypeOf } from "./annots";
import { arrayItems, fillColor, newArrayOf, numbers, objectNumber, strokeColor, withPage } from "./shared";
import { isRtl, layoutText, missingWarning, splitGraphemes } from "./textLayout";

const FLAG = { readOnly: 1, multiline: 1 << 12, password: 1 << 13, noToggleOff: 1 << 14, combo: 1 << 17, edit: 1 << 18, comb: 1 << 24, unison: 1 << 25 };

/** characters MuPDF can draw with the standard form fonts */
const WESTERN = /^[\t\n\r\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/;

type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;

interface Widget {
  page: number;
  object: Obj;
  id: string;
}

function widgetsOn(doc: Doc, page: number): Widget[] {
  return arrayItems(doc.findPage(page).get("Annots")).flatMap((object, i) =>
    object.isDictionary() && subtypeOf(object) === "Widget"
      ? [{ page, object, id: object.isIndirect() ? `w${object.asIndirect()}` : `p${page}a${i}` }]
      : [],
  );
}

/** the dictionary that holds the value: the widget itself, or its parent for multi-widget fields */
function fieldOf(widget: Obj): Obj {
  const parent = widget.get("Parent");
  return widget.get("T").isNull() && !parent.isNull() ? parent : widget;
}

function widgetsOfField(field: Obj): Obj[] {
  const kids = arrayItems(field.get("Kids")).filter((k) => k.get("T").isNull());
  return kids.length ? kids : [field];
}

const inherited = (obj: Obj, key: string) => obj.getInheritable(key);
const integer = (obj: Obj) => (obj.isNumber() ? obj.asNumber() : 0);
const textOf = (obj: Obj): string =>
  obj.isString() ? obj.asString() : obj.isName() ? obj.asName() : obj.isArray() ? arrayItems(obj).map(textOf).join("\n") : "";

type Type = FormField["type"];

function typeOf(widget: Obj): Type {
  const ft = inherited(widget, "FT");
  const flags = integer(inherited(widget, "Ff"));
  switch (ft.isName() ? ft.asName() : "") {
    case "Tx":
      return "text";
    case "Ch":
      return flags & FLAG.combo ? "combobox" : "listbox";
    case "Sig":
      return "signature";
    case "Btn":
      return flags & (1 << 16) ? "button" : flags & (1 << 15) ? "radio" : "checkbox";
    default:
      return "button";
  }
}

/** the appearance state that means "ticked" for this widget */
function onState(widget: Obj): string {
  for (const key of ["N", "D"]) {
    const states = widget.get("AP", key);
    if (!states.isDictionary() || states.isStream()) continue;
    let found: string | null = null;
    states.forEach((_, name) => {
      if (String(name) !== "Off") found ??= String(name);
    });
    if (found !== null) return found;
  }
  const current = widget.get("AS");
  return current.isName() && current.asName() !== "Off" ? current.asName() : "Yes";
}

function isOn(widget: Obj): boolean {
  const state = widget.get("AS");
  if (state.isName()) return state.asName() === onState(widget);
  return textOf(inherited(widget, "V")) === onState(widget);
}

function options(widget: Obj): { value: string; label: string }[] {
  return arrayItems(inherited(widget, "Opt")).map((o) =>
    o.isArray() ? { value: textOf(o.get(0)), label: textOf(o.get(1)) } : { value: textOf(o), label: textOf(o) },
  );
}

export function listFormFields(ctx: EngineContext): FormField[] {
  const { doc } = ctx;
  const out: FormField[] = [];
  for (let page = 0; page < doc.countPages(); page++) {
    const widgets = widgetsOn(doc, page).filter((w) => !(integer(w.object.get("F")) & (2 | 32)));
    if (!widgets.length) continue;
    const transform = withPage(doc, page, (p) => p.getTransform());
    for (const { object, id } of widgets) {
      const type = typeOf(object);
      const field = fieldOf(object);
      const flags = integer(inherited(object, "Ff"));
      const name = fieldName(object);
      const tooltip = textOf(inherited(object, "TU"));
      const entry: FormField = {
        id,
        page,
        name,
        label: tooltip || name,
        type,
        value: textOf(inherited(object, "V")),
        readOnly: !!(flags & FLAG.readOnly) || type === "signature" || type === "button",
        rect: ctx.mupdf.Rect.transform(numbers(object.get("Rect"), [0, 0, 0, 0]) as Rect, transform),
      };
      if (type === "text") entry.multiline = !!(flags & FLAG.multiline);
      if (type === "combobox" || type === "listbox") entry.options = options(object).map((o) => o.label);
      if (type === "combobox" || type === "listbox") {
        // show the visible label rather than the export value
        const match = options(object).find((o) => o.value === entry.value);
        if (match) entry.value = match.label;
      }
      if (type === "checkbox" || type === "radio") {
        entry.checked = isOn(object);
        entry.value = onState(object);
        entry.options = [...new Set(widgetsOfField(field).map(onState))];
      }
      out.push(entry);
    }
  }
  return out;
}

function fieldName(widget: Obj): string {
  const parts: string[] = [];
  for (let node = widget, i = 0; !node.isNull() && i < 32; node = node.get("Parent"), i++) {
    const t = node.get("T");
    if (t.isString()) parts.unshift(t.asString());
  }
  return parts.join(".");
}

export async function setFormField(
  ctx: EngineContext,
  page: number,
  id: string,
  value: string | boolean,
): Promise<ModuleChange> {
  const { doc } = ctx;
  const target = widgetsOn(doc, page).find((w) => w.id === id);
  if (!target) throw new Error("That form field no longer exists");
  const type = typeOf(target.object);
  const flags = integer(inherited(target.object, "Ff"));
  if (type === "signature" || type === "button") throw new Error("This field cannot be filled in");
  if (flags & FLAG.readOnly) throw new Error("This field is read only");

  const warnings: string[] = [];
  warnings.push(...(await ensureAppearances(ctx, doc)));
  const form = doc.getTrailer().get("Root", "AcroForm");
  if (!form.isNull() && !form.get("XFA").isNull()) {
    form.delete("XFA");
    warnings.push("This form also had a dynamic (XFA) version, which was removed so that your entries show everywhere.");
  }

  const field = fieldOf(target.object);
  const widgets = widgetsOfField(field);

  if (type === "checkbox" || type === "radio") {
    setButton(ctx, target.object, field, widgets, type, flags, value);
  } else {
    let text = typeof value === "string" ? value : value ? "Yes" : "";
    if (type === "text") {
      const max = integer(inherited(target.object, "MaxLen"));
      if (max > 0 && [...text].length > max) {
        text = [...text].slice(0, max).join("");
        warnings.push(`This field holds at most ${max} characters.`);
      }
      if (!(flags & FLAG.multiline)) text = text.replace(/[\r\n]+/g, " ");
      field.put("V", doc.newString(text));
    } else {
      const list = options(target.object);
      const choice = list.find((o) => o.label === text) ?? list.find((o) => o.value === text);
      if (!choice && text && !(flags & FLAG.edit)) throw new Error("That is not one of the choices for this field");
      field.put("V", doc.newString(choice ? choice.value : text));
      if (choice) field.put("I", newArrayOf(doc, [doc.newInteger(list.indexOf(choice))]));
      else field.delete("I");
    }
    field.delete("RV");
    for (const widget of widgets) warnings.push(...(await drawValue(ctx, doc, widget)));
  }

  const changed = new Set([page]);
  const numbersOfField = new Set(widgets.map(objectNumber));
  if (widgets.length > 1)
    for (let i = 0; i < doc.countPages(); i++)
      if (widgetsOn(doc, i).some((w) => numbersOfField.has(objectNumber(w.object)))) changed.add(i);
  return { changedPages: [...changed], warnings: [...new Set(warnings)] };
}

function setButton(
  ctx: EngineContext,
  clicked: Obj,
  field: Obj,
  widgets: Obj[],
  type: "checkbox" | "radio",
  flags: number,
  value: string | boolean,
) {
  const { doc } = ctx;
  const own = onState(clicked);
  const states = widgets.map(onState);
  let state: string;
  if (typeof value === "boolean") state = value ? own : "Off";
  else if (value === "" || /^(off|false)$/i.test(value)) state = "Off";
  else if (states.includes(value)) state = value;
  else {
    const byLabel = options(clicked).findIndex((o) => o.value === value || o.label === value);
    state = byLabel >= 0 && states[byLabel] !== undefined ? states[byLabel]! : own;
  }
  if (state === "Off" && type === "radio") {
    const current = textOf(inherited(clicked, "V")) || "Off";
    if (flags & FLAG.noToggleOff) state = current;
    else if (current !== own) state = current;
  }
  const clickedNumber = objectNumber(clicked);
  const exact = type === "radio" && !(flags & FLAG.unison) && state === own;
  field.put("V", doc.newName(state));
  widgets.forEach((widget, i) => {
    const on = state !== "Off" && states[i] === state && (!exact || objectNumber(widget) === clickedNumber);
    ensureButtonAppearance(ctx, doc, widget, states[i]!, type);
    widget.put("AS", doc.newName(on ? state : "Off"));
  });
}

/* ---------- appearances ---------- */

/**
 * "NeedAppearances" asks viewers to redraw every field themselves, which breaks non western values. Draw
 * what is missing once and clear the flag.
 */
export async function ensureAppearances(ctx: EngineContext, doc: Doc): Promise<string[]> {
  const form = doc.getTrailer().get("Root", "AcroForm");
  if (form.isNull()) return [];
  const flag = form.get("NeedAppearances");
  if (!flag.isBoolean() || !flag.asBoolean()) return [];
  const warnings: string[] = [];
  form.delete("NeedAppearances");
  for (let page = 0; page < doc.countPages(); page++)
    for (const { object } of widgetsOn(doc, page)) {
      const type = typeOf(object);
      if (type === "checkbox" || type === "radio") ensureButtonAppearance(ctx, doc, object, onState(object), type);
      else if (type !== "signature" && type !== "button") warnings.push(...(await drawValue(ctx, doc, object)));
    }
  return warnings;
}

/** draw a text or choice widget from the field's current value */
async function drawValue(ctx: EngineContext, doc: Doc, widget: Obj): Promise<string[]> {
  const type = typeOf(widget);
  const value = textOf(inherited(widget, "V"));
  const shown = options(widget);
  const display = type === "text" ? value : (shown.find((o) => o.value === value)?.label ?? value);
  const everything = type === "listbox" ? shown.map((o) => o.label).join("") + display : display;
  // MuPDF's list boxes come without the mark on the chosen entry, so those are always drawn here
  if (type !== "listbox" && WESTERN.test(everything) && drawNative(ctx, doc, widget, type, value)) return [];
  return drawCustom(ctx, doc, widget, type, display);
}

function drawNative(ctx: EngineContext, doc: Doc, widget: Obj, type: Type, value: string): boolean {
  const number = objectNumber(widget);
  if (!number) return false;
  for (let page = 0; page < doc.countPages(); page++) {
    if (!widgetsOn(doc, page).some((w) => objectNumber(w.object) === number)) continue;
    return withPage(doc, page, (p) => {
      const found = p.getWidgets().find((w) => objectNumber(w.getObject()) === number);
      if (!found) return false;
      widget.delete("AP");
      if (type === "text") found.setTextValue(value);
      else found.setChoiceValue(value);
      found.update();
      return !widget.get("AP", "N").isNull();
    });
  }
  return false;
}

interface Look {
  width: number;
  height: number;
  rotation: number;
  border: number;
  /** background and border operators */
  frame: string;
}

function look(widget: Obj): Look {
  const [x0, y0, x1, y1] = numbers(widget.get("Rect"), [0, 0, 0, 0]) as Rect;
  let width = Math.abs(x1 - x0);
  let height = Math.abs(y1 - y0);
  const rotation = (((integer(widget.get("MK", "R")) % 360) + 360) % 360) | 0;
  if (rotation % 180 === 90) [width, height] = [height, width];
  const color = (key: "BG" | "BC"): RGB | null => {
    const a = arrayItems(widget.get("MK", key)).map((v) => v.asNumber());
    if (a.length === 1) return [a[0]!, a[0]!, a[0]!];
    if (a.length === 3) return a as RGB;
    if (a.length === 4) return [0, 1, 2].map((i) => 1 - Math.min(1, a[i]! + a[3]!)) as RGB;
    return null;
  };
  const bg = color("BG");
  const bc = color("BC");
  const bw = widget.get("BS", "W");
  const border = bc ? (bw.isNumber() ? bw.asNumber() : 1) : 0;
  let frame = bg ? `${fillColor(bg)} 0 0 ${num(width)} ${num(height)} re f\n` : "";
  if (bc && border > 0)
    frame += `${strokeColor(bc)} ${num(border)} w ${num(border / 2)} ${num(border / 2)} ${num(width - border)} ${num(height - border)} re S\n`;
  return { width, height, rotation, border, frame };
}

function appearanceStream(doc: Doc, appearance: Look, content: string, resources: Obj): Obj {
  const rad = (appearance.rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Form"));
  dict.put("BBox", newArrayOf(doc, [0, 0, doc.newReal(appearance.width), doc.newReal(appearance.height)]));
  dict.put("Matrix", newArrayOf(doc, [cos, sin, -sin, cos, 0, 0]));
  dict.put("Resources", resources);
  return doc.addStream(encodeLatin1(content), dict);
}

function textStyle(doc: Doc, widget: Obj): { style: TextStyle; auto: boolean } {
  let da = textOf(inherited(widget, "DA"));
  if (!da) da = textOf(doc.getTrailer().get("Root", "AcroForm", "DA"));
  const font = /\/(\S+)\s+([\d.]+)\s+Tf/.exec(da);
  const name = font?.[1] ?? "Helv";
  const size = Number(font?.[2] ?? 0);
  let color: RGB = [0, 0, 0];
  const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const gray = /([\d.]+)\s+g(?![a-z])/.exec(da);
  const cmyk = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+k(?![a-z])/.exec(da);
  if (rgb) color = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  else if (gray) color = [Number(gray[1]), Number(gray[1]), Number(gray[1])];
  else if (cmyk) color = [1, 2, 3].map((i) => 1 - Math.min(1, Number(cmyk[i]) + Number(cmyk[4]))) as RGB;
  const serif = /^Ti|Times|Serif/i.test(name) && !/Sans/i.test(name);
  const mono = /^Co|Courier|Mono/i.test(name);
  return {
    style: {
      family: mono ? "Courier" : serif ? "Times" : "Helvetica",
      bold: /Bo|Bold|HeBo|TiBo/.test(name),
      italic: /It$|Italic|Oblique|Ob$/.test(name),
      serif,
      mono,
      size: size || 12,
      color,
    },
    auto: !size,
  };
}

async function drawCustom(ctx: EngineContext, doc: Doc, widget: Obj, type: Type, value: string): Promise<string[]> {
  const appearance = look(widget);
  const { width, height, border } = appearance;
  const { style, auto } = textStyle(doc, widget);
  const flags = integer(inherited(widget, "Ff"));
  const q = inherited(widget, "Q");
  const quadding = integer(q.isNull() ? doc.getTrailer().get("Root", "AcroForm", "Q") : q);
  const align = quadding === 1 ? "center" : quadding === 2 || (quadding === 0 && isRtl(value)) ? "right" : "left";
  const pad = 1 + Math.max(1, border * 2);
  const room = Math.max(1, width - 2 * pad);
  const resources = doc.newDictionary();
  const missing = new Set<string>();
  const ops: string[] = [];

  const write = async (text: string, x: number, y: number, charSpacing = 0, wordSpacing = 0) => {
    if (!text) return;
    const written = await fonts.writeText(ctx, {
      text, style, resources, matrix: [1, 0, 0, 1, x, y], charSpacing, wordSpacing,
    });
    for (const m of written.missing) missing.add(m);
    ops.push(written.ops);
  };
  const plan = (text: string) => fonts.planText(ctx, { text, style });

  if (type === "listbox") {
    if (auto) style.size = Math.min(12, Math.max(4, height / 4));
    const line = style.size * 1.3;
    const list = options(widget);
    // several entries may be chosen at once
    const held = inherited(widget, "V");
    const selected = new Set(held.isArray() ? arrayItems(held).map(textOf) : [textOf(held)]);
    const chosen = list.findIndex((o) => selected.has(o.value));
    // keep the selection in view
    const visible = Math.max(1, Math.floor((height - 2 * border) / line));
    const top = Math.max(0, Math.min(integer(widget.get("TI")), list.length - 1));
    const first = chosen >= 0 && (chosen < top || chosen >= top + visible) ? Math.max(0, chosen - visible + 1) : top;
    for (let i = first; i < list.length && (i - first) * line < height; i++) {
      const y = height - border - (i - first + 1) * line;
      if (selected.has(list[i]!.value)) ops.push(`q 0.6 0.76 0.85 rg ${num(border)} ${num(y)} ${num(width - 2 * border)} ${num(line)} re f Q`);
      const planned = await plan(list[i]!.label);
      await write(list[i]!.label, pad, y + (line - planned.ascent - planned.descent) / 2 + planned.descent);
    }
  } else if (type === "text" && flags & FLAG.multiline) {
    if (auto) style.size = 12;
    let layout = await layoutText(ctx, { text: value, style, width: room, align });
    while (auto && layout.height > height - 2 * border && style.size > 4) {
      style.size -= 1;
      layout = await layoutText(ctx, { text: value, style, width: room, align });
    }
    for (const [i, l] of layout.lines.entries())
      await write(l.text, pad + l.x, height - pad - layout.baseline(i), l.charSpacing, l.wordSpacing);
  } else {
    const shown = flags & FLAG.password ? "*".repeat([...value].length) : value;
    if (auto) style.size = Math.max(4, Math.min(24, (height - 2 * border) * 0.62));
    const cells = type === "text" && flags & FLAG.comb ? integer(inherited(widget, "MaxLen")) : 0;
    if (cells > 0) {
      const cell = width / cells;
      const divider = arrayItems(widget.get("MK", "BC")).map((v) => v.asNumber());
      if (divider.length && appearance.border > 0) {
        const color = (divider.length === 3 ? divider : [divider[0]!, divider[0]!, divider[0]!]) as RGB;
        for (let i = 1; i < cells; i++)
          ops.push(`q ${strokeColor(color)} ${num(appearance.border)} w ${num(i * cell)} 0 m ${num(i * cell)} ${num(height)} l S Q`);
      }
      const parts = splitGraphemes(shown).slice(0, cells);
      const offset = quadding === 2 ? cells - parts.length : quadding === 1 ? Math.floor((cells - parts.length) / 2) : 0;
      for (const [i, part] of parts.entries()) {
        const p = await plan(part);
        await write(part, (i + offset) * cell + (cell - p.width) / 2, (height - p.ascent - p.descent) / 2 + p.descent);
      }
    } else if (shown) {
      let planned = await plan(shown);
      if (auto && planned.width > room) {
        style.size = Math.max(4, (style.size * room) / planned.width);
        planned = await plan(shown);
      }
      // tall scripts must still fit the box vertically
      if (auto && planned.ascent + planned.descent > height) {
        style.size = Math.max(4, (style.size * height) / (planned.ascent + planned.descent));
        planned = await plan(shown);
      }
      const x = align === "center" ? (width - planned.width) / 2 : align === "right" ? width - pad - planned.width : pad;
      await write(shown, x, (height - planned.ascent - planned.descent) / 2 + planned.descent);
    }
  }

  const clip = `${num(border)} ${num(border)} ${num(Math.max(0, width - 2 * border))} ${num(Math.max(0, height - 2 * border))} re W n`;
  const content = `q\n${appearance.frame}Q\n/Tx BMC\nq\n${clip}\n${ops.join("\n")}\nQ\nEMC`;
  widget.put("AP", { N: appearanceStream(doc, appearance, content, resources) });
  return missingWarning(missing);
}

/** tick boxes and radio buttons that come without pictures get simple ones */
function ensureButtonAppearance(ctx: EngineContext, doc: Doc, widget: Obj, state: string, type: "checkbox" | "radio") {
  const normal = widget.get("AP", "N");
  const existing = normal.isDictionary() && !normal.isStream() && !normal.get(state).isNull() ? normal : null;
  if (existing && !existing.get("Off").isNull()) return;
  const appearance = look(widget);
  const { width: w, height: h } = appearance;
  const s = Math.min(w, h);
  const circle = (r: number) => {
    const k = r * 0.5523;
    const [x, y] = [w / 2, h / 2];
    const c = (...v: number[]) => `${v.map(num).join(" ")} c`;
    return [
      `${num(x + r)} ${num(y)} m`,
      c(x + r, y + k, x + k, y + r, x, y + r),
      c(x - k, y + r, x - r, y + k, x - r, y),
      c(x - r, y - k, x - k, y - r, x, y - r),
      c(x + k, y - r, x + r, y - k, x + r, y),
    ].join(" ");
  };
  const outline =
    appearance.frame || (type === "radio" ? `0 G 1 w ${circle(s / 2 - 0.5)} S\n` : `0 G 1 w 0.5 0.5 ${num(w - 1)} ${num(h - 1)} re S\n`);
  const mark =
    type === "radio"
      ? `0 g ${circle(s * 0.25)} f`
      : `0 G ${num(s * 0.12)} w 1 J 1 j ${num(w / 2 - s * 0.28)} ${num(h / 2)} m ${num(w / 2 - s * 0.08)} ${num(h / 2 - s * 0.22)} l ${num(w / 2 + s * 0.3)} ${num(h / 2 + s * 0.24)} l S`;
  const states = doc.newDictionary();
  // keep the document's own "ticked" picture when only the empty one is missing
  states.put(state, existing?.get(state) ?? appearanceStream(doc, appearance, `q ${outline} ${mark} Q`, doc.newDictionary()));
  states.put("Off", appearanceStream(doc, appearance, `q ${outline} Q`, doc.newDictionary()));
  widget.put("AP", { N: states });
}
