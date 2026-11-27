/** Carrying links, annotations and form fields over when pages come from another PDF. */
import type * as MuPDF from "mupdf";
import { arrayItems, copyDict, newArrayOf, objectNumber } from "./shared";
import { subtypeOf } from "./annots";
import { destinationPage } from "./pages";

/** keys that point back into the source document's page or object structure */
const SKIP = new Set(["P", "Parent", "Popup", "IRT", "StructParent", "Dest", "A", "AA"]);

export function insertAnnotations(
  doc: MuPDF.PDFDocument,
  source: MuPDF.PDFDocument,
  map: MuPDF.PDFGraftMap,
  sourcePages: MuPDF.PDFObject[],
  added: MuPDF.PDFObject[],
): string[] {
  const pageByNumber = new Map(sourcePages.map((p, i) => [objectNumber(p), added[i]!]));
  const sourceForm = source.getTrailer().get("Root", "AcroForm");
  const fields = new Map<number, MuPDF.PDFObject>();
  const roots: MuPDF.PDFObject[] = [];
  let skippedWidgets = 0;

  const copyKeys = (from: MuPDF.PDFObject, to: MuPDF.PDFObject, skip: (key: string) => boolean) =>
    from.forEach((value, key) => {
      if (!skip(String(key))) to.put(key, map.graftObject(value));
    });

  /** the copy of a field dictionary above a widget, creating its own parents as needed */
  const field = (node: MuPDF.PDFObject, depth: number): MuPDF.PDFObject => {
    const number = objectNumber(node);
    const done = fields.get(number);
    if (done) return done;
    const copy = doc.addObject(doc.newDictionary());
    fields.set(number, copy);
    copyKeys(node, copy, (k) => k === "Kids" || SKIP.has(k));
    copy.put("Kids", doc.newArray());
    const parent = node.get("Parent");
    if (!parent.isNull() && depth < 32) {
      const above = field(parent, depth + 1);
      copy.put("Parent", above);
      above.get("Kids").push(copy);
    } else roots.push(copy);
    return copy;
  };

  sourcePages.forEach((sourcePage, index) => {
    const page = added[index]!;
    const annots: MuPDF.PDFObject[] = [];
    for (const annot of arrayItems(sourcePage.get("Annots"))) {
      const subtype = subtypeOf(annot);
      if (!annot.isDictionary() || subtype === "Popup") continue;
      const copy = doc.addObject(doc.newDictionary());
      copyKeys(annot, copy, (k) => SKIP.has(k));
      copy.put("P", page);
      if (subtype === "Link") {
        const target = pageByNumber.get(destinationPage(source, annot));
        const action = annot.get("A");
        const kind = action.isNull() ? "" : action.get("S").asName();
        if (target) copy.put("Dest", newArrayOf(doc, [target, doc.newName("Fit")]));
        else if (kind === "URI" || kind === "GoToR" || kind === "Launch") copy.put("A", map.graftObject(action));
        else continue;
      }
      if (subtype === "Widget") {
        if (sourceForm.isNull()) {
          skippedWidgets++;
          continue;
        }
        const parent = annot.get("Parent");
        if (!parent.isNull()) {
          const above = field(parent, 0);
          copy.put("Parent", above);
          above.get("Kids").push(copy);
        } else {
          // the widget is also the field; inherit what used to come from the source form dictionary
          const da = sourceForm.get("DA");
          if (copy.get("DA").isNull() && !da.isNull()) copy.put("DA", map.graftObject(da));
          roots.push(copy);
        }
      }
      annots.push(copy);
    }
    if (annots.length) page.put("Annots", newArrayOf(doc, annots));
  });

  if (roots.length) mergeForm(doc, sourceForm, map, roots);
  return skippedWidgets ? ["Some form fields in the inserted file could not be kept."] : [];
}

function mergeForm(doc: MuPDF.PDFDocument, source: MuPDF.PDFObject, map: MuPDF.PDFGraftMap, roots: MuPDF.PDFObject[]) {
  const catalog = doc.getTrailer().get("Root");
  let form = catalog.get("AcroForm");
  if (form.isNull()) {
    catalog.put("AcroForm", doc.addObject(doc.newDictionary()));
    form = catalog.get("AcroForm");
  }
  if (form.get("Fields").isNull()) form.put("Fields", doc.newArray());

  // two top level fields with one name would share a value: rename the newcomers
  const taken = new Set(
    arrayItems(form.get("Fields")).map((f) => (f.get("T").isString() ? f.get("T").asString() : "")),
  );
  for (const root of roots) {
    const name = root.get("T").isString() ? root.get("T").asString() : "";
    if (!name) continue;
    let next = name;
    for (let i = 2; taken.has(next); i++) next = `${name}_${i}`;
    if (next !== name) root.put("T", doc.newString(next));
    taken.add(next);
  }
  for (const root of roots) form.get("Fields").push(root);

  if (form.get("DA").isNull() && !source.get("DA").isNull()) form.put("DA", map.graftObject(source.get("DA")));
  if (source.get("NeedAppearances").isBoolean() && source.get("NeedAppearances").asBoolean())
    form.put("NeedAppearances", doc.newBoolean(true));

  const fonts = source.get("DR", "Font");
  if (fonts.isNull()) return;
  if (form.get("DR").isNull()) form.put("DR", doc.newDictionary());
  if (form.get("DR", "Font").isNull()) form.get("DR").put("Font", doc.newDictionary());
  const own = copyDict(doc, form.get("DR", "Font"));
  fonts.forEach((value, key) => {
    if (own.get(key).isNull()) own.put(key, map.graftObject(value));
  });
  form.get("DR").put("Font", own);
}
