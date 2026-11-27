/**
 * An independent, decrypted copy of the open document, made without saving it: any save of a journaled
 * MuPDF document (even to a buffer) corrupts its undo history. Objects are copied one by one under their
 * own numbers, so deeply linked structures (long bookmark chains) cannot overflow the stack.
 */
import type * as MuPDF from "mupdf";
import type { EngineContext } from "../context";

export function cloneDocument(ctx: EngineContext): MuPDF.PDFDocument {
  const source = ctx.doc;
  const copy = new ctx.mupdf.PDFDocument();
  const count = source.countObjects();
  while (copy.countObjects() < count) copy.createObject();

  const convert = (value: MuPDF.PDFObject): unknown => {
    if (value.isIndirect()) return copy.newIndirect(value.asIndirect());
    if (value.isDictionary()) {
      const out = copy.newDictionary();
      value.forEach((v, k) => out.put(k, convert(v)));
      return out;
    }
    if (value.isArray()) {
      const out = copy.newArray();
      value.forEach((v) => out.push(convert(v)));
      return out;
    }
    if (value.isName()) return copy.newName(value.asName());
    if (value.isInteger()) return copy.newInteger(value.asNumber());
    if (value.isReal()) return copy.newReal(value.asNumber());
    if (value.isString()) return copy.newByteString(value.asByteString());
    if (value.isBoolean()) return copy.newBoolean(value.asBoolean());
    return copy.newNull();
  };

  for (let number = 1; number < count; number++) {
    const reference = source.newIndirect(number);
    const target = copy.newIndirect(number);
    try {
      const value = reference.resolve();
      if (reference.isStream()) {
        const dict = copy.newDictionary();
        value.forEach((v, k) => dict.put(k, convert(v)));
        target.writeObject(dict);
        target.writeRawStream(reference.readRawStream().asUint8Array().slice());
      } else if (value.isDictionary()) {
        const dict = copy.newDictionary();
        value.forEach((v, k) => dict.put(k, convert(v)));
        target.writeObject(dict);
      } else target.writeObject(convert(value));
    } catch {
      // a broken object in a damaged file stays empty, as it already is for the viewer
      target.writeObject(copy.newNull());
    }
  }

  const trailer = source.getTrailer();
  const target = copy.getTrailer();
  for (const key of ["Root", "Info", "ID"]) {
    const value = trailer.get(key);
    if (!value.isNull()) target.put(key, convert(value));
  }
  return copy;
}
