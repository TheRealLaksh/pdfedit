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

  // Only objects reachable from the trailer are read: resolving an unused number (there are some after an
  // undo) makes MuPDF log errors.
  const queue: number[] = [];
  const found = new Set<number>();

  const convert = (value: MuPDF.PDFObject): unknown => {
    if (value.isIndirect()) {
      const number = value.asIndirect();
      if (number <= 0 || number >= count) return copy.newNull();
      if (!found.has(number)) {
        found.add(number);
        queue.push(number);
      }
      return copy.newIndirect(number);
    }
    if (value.isDictionary()) return dictionary(value);
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
  const dictionary = (value: MuPDF.PDFObject) => {
    const out = copy.newDictionary();
    value.forEach((v, k) => out.put(k, convert(v)));
    return out;
  };

  const trailer = source.getTrailer();
  const target = copy.getTrailer();
  for (const key of ["Root", "Info", "ID"]) {
    const value = trailer.get(key);
    if (!value.isNull()) target.put(key, convert(value));
  }

  // the queue grows while it is being worked through
  for (let i = 0; i < queue.length; i++) {
    const number = queue[i]!;
    const reference = source.newIndirect(number);
    const object = copy.newIndirect(number);
    try {
      const value = reference.resolve();
      if (reference.isStream()) {
        object.writeObject(dictionary(value));
        // the buffer itself is handed over: a large file must not be held a second and third time
        const data = reference.readRawStream();
        object.writeRawStream(data);
        data.destroy();
      } else object.writeObject(value.isDictionary() ? dictionary(value) : convert(value));
    } catch {
      // a broken object in a damaged file stays empty, as it already is for the viewer
      object.writeObject(copy.newNull());
    }
  }
  for (let number = 1; number < count; number++)
    if (!found.has(number)) copy.newIndirect(number).writeObject(copy.newNull());
  return copy;
}
