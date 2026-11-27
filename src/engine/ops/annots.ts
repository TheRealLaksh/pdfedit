/** Removing annotations, form widgets and structure text together with everything that refers to them. */
import type * as MuPDF from "mupdf";
import { arrayItems, newArrayOf, objectNumber } from "./shared";

/**
 * Empty a dictionary, so stale references can reveal nothing. Key by key: MuPDF's journal does not undo
 * PDFObject.writeObject.
 */
export function blankObject(object: MuPDF.PDFObject): void {
  if (!object.isDictionary()) return;
  const keys: string[] = [];
  object.forEach((_, key) => keys.push(String(key)));
  for (const key of keys) object.delete(key);
}

function without(doc: MuPDF.PDFDocument, owner: MuPDF.PDFObject, key: string, target: number): number {
  const list = owner.get(key);
  if (!list.isArray()) return 0;
  const kept = arrayItems(list).filter((item) => objectNumber(item) !== target);
  if (kept.length !== list.length) owner.put(key, newArrayOf(doc, kept));
  return kept.length;
}

/** take a widget out of the form field tree; fields left without widgets disappear with their value */
export function detachWidget(doc: MuPDF.PDFDocument, widget: MuPDF.PDFObject): void {
  const form = doc.getTrailer().get("Root", "AcroForm");
  let node = widget;
  for (let depth = 0; depth < 32; depth++) {
    const number = objectNumber(node);
    const parent = node.get("Parent");
    if (!form.isNull()) without(doc, form, "CO", number);
    if (!parent.isNull()) {
      const left = without(doc, parent, "Kids", number);
      blankObject(node);
      if (left > 0) return;
      node = parent;
    } else {
      if (!form.isNull()) without(doc, form, "Fields", number);
      blankObject(node);
      return;
    }
  }
}

export const subtypeOf = (annot: MuPDF.PDFObject) => {
  const s = annot.get("Subtype");
  return s.isName() ? s.asName() : "";
};

/** delete the matching annotations of one page (and their popups); returns how many were removed */
export function removeAnnots(
  doc: MuPDF.PDFDocument,
  page: MuPDF.PDFObject,
  match: (annot: MuPDF.PDFObject, subtype: string) => boolean,
): number {
  const annots = page.get("Annots");
  if (!annots.isArray()) return 0;
  const all = arrayItems(annots);
  const doomed = new Set<number>();
  all.forEach((annot, i) => {
    if (annot.isDictionary() && match(annot, subtypeOf(annot))) doomed.add(i);
  });
  if (!doomed.size) return 0;
  const gone = new Set([...doomed].map((i) => objectNumber(all[i]!)).filter(Boolean));
  const popups = new Set(
    [...doomed].map((i) => objectNumber(all[i]!.get("Popup"))).filter(Boolean),
  );
  all.forEach((annot, i) => {
    if (popups.has(objectNumber(annot)) || gone.has(objectNumber(annot.get("Parent")))) {
      if (subtypeOf(annot) === "Popup") doomed.add(i);
    }
  });
  page.put("Annots", newArrayOf(doc, all.filter((_, i) => !doomed.has(i))));
  for (const i of doomed) {
    const annot = all[i]!;
    if (subtypeOf(annot) === "Widget") detachWidget(doc, annot);
    else blankObject(annot);
  }
  return doomed.size;
}

/** drop the text alternatives that the structure tree keeps for content on these pages */
export function scrubStructure(doc: MuPDF.PDFDocument, pages: Set<number>): void {
  const root = doc.getTrailer().get("Root", "StructTreeRoot");
  if (root.isNull()) return;
  const seen = new Set<number>();
  /** returns true when the subtree shows content of one of the pages */
  const visit = (node: MuPDF.PDFObject, inherited: number, depth: number): boolean => {
    if (node.isArray()) return arrayItems(node).map((k) => visit(k, inherited, depth)).includes(true);
    if (node.isNumber()) return pages.has(inherited);
    if (!node.isDictionary() || depth > 200) return false;
    const number = objectNumber(node);
    if (number) {
      if (seen.has(number)) return false;
      seen.add(number);
    }
    const own = objectNumber(node.get("Pg")) || inherited;
    const kids = node.get("K");
    const hit = kids.isNull() ? pages.has(own) : visit(kids, own, depth + 1);
    if (hit) for (const key of ["ActualText", "Alt", "E", "T"]) if (!node.get(key).isNull()) node.delete(key);
    return hit;
  };
  visit(root.get("K"), 0, 0);
}
