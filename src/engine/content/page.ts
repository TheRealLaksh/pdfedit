/** Read and write a page's content and resources safely (shared objects are copied before writing). */
import type * as MuPDF from "mupdf";
import { concatBytes, encodeLatin1 } from "./tokenizer";

/** All content streams of the page joined into one byte array. */
export function readPageContent(page: MuPDF.PDFPage): Uint8Array {
  const contents = page.getObject().get("Contents");
  if (contents.isNull()) return new Uint8Array();
  if (contents.isArray()) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < contents.length; i++) {
      const s = contents.get(i);
      if (s.isStream()) parts.push(s.readStream().asUint8Array().slice(), encodeLatin1("\n"));
    }
    return concatBytes(parts);
  }
  return contents.isStream() ? contents.readStream().asUint8Array().slice() : new Uint8Array();
}

/** Replace the page content with a single new stream (never mutates a stream another page may share). */
export function writePageContent(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, bytes: Uint8Array): void {
  const stream = doc.addStream(bytes, doc.newDictionary());
  page.getObject().put("Contents", stream);
}

/** Wrap the existing content in q/Q and append new operators drawn in the page's default coordinates. */
export function appendPageContent(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, ops: string | Uint8Array): void {
  const extra = typeof ops === "string" ? encodeLatin1(ops) : ops;
  const old = readPageContent(page);
  writePageContent(
    doc,
    page,
    concatBytes([encodeLatin1("q\n"), old, encodeLatin1("\nQ\n"), extra, encodeLatin1("\n")]),
  );
}

/**
 * The page's own, direct Resources dictionary, safe to add fonts / XObjects to.
 * Copies inherited or shared resource dictionaries (and the named sub-dictionaries) first.
 */
export function ownResources(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage): MuPDF.PDFObject {
  const obj = page.getObject();
  const current = obj.getInheritable("Resources");
  const copy = doc.newDictionary();
  if (!current.isNull()) {
    current.forEach((val, key) => {
      if (val.isDictionary()) {
        const sub = doc.newDictionary();
        val.forEach((v, k) => sub.put(k, v));
        copy.put(key, sub);
      } else copy.put(key, val);
    });
  }
  obj.put("Resources", copy);
  return obj.get("Resources");
}

/** Register `value` under resources/<category> with an unused name starting with `prefix`; returns the name. */
export function addResource(
  doc: MuPDF.PDFDocument,
  resources: MuPDF.PDFObject,
  category: "Font" | "XObject" | "ExtGState" | "Properties",
  prefix: string,
  value: MuPDF.PDFObject,
): string {
  let dict = resources.get(category);
  if (dict.isNull()) {
    resources.put(category, doc.newDictionary());
    dict = resources.get(category);
  }
  // reuse the existing name when this exact object is already registered
  let existing: string | null = null;
  if (value.isIndirect()) {
    dict.forEach((v, k) => {
      if (v.isIndirect() && v.asIndirect() === value.asIndirect()) existing = String(k);
    });
  }
  if (existing) return existing;
  let i = 1;
  while (!dict.get(`${prefix}${i}`).isNull()) i++;
  dict.put(`${prefix}${i}`, value);
  return `${prefix}${i}`;
}
