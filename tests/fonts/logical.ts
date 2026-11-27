/**
 * Reads the text of our own operators the way a PDF consumer that honours ActualText does: content
 * order, ToUnicode of each code, marked spans replaced by their ActualText.
 */
import type * as MuPDF from "mupdf";
import { encodeLatin1, parseContent } from "../../src/engine/content/tokenizer";

function toUnicode(font: MuPDF.PDFObject): Map<number, string> {
  const cmap = font.get("ToUnicode").readStream().asString();
  const out = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const [, code, hex] of block[1]!.matchAll(/<([0-9A-F]{4})> <([0-9A-F]*)>/g))
      out.set(parseInt(code!, 16), (hex!.match(/.{4}/g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join(""));
  return out;
}

export function logicalText(ops: string, resources: MuPDF.PDFObject, useActualText = true): string {
  const maps = new Map<string, Map<number, string>>();
  let map: Map<number, string> | undefined;
  let out = "";
  let skipping = false;
  for (const op of parseContent(encodeLatin1(ops))) {
    if (op.op === "Tf") {
      const name = (op.operands[0] as { value: string }).value;
      if (!maps.has(name)) maps.set(name, toUnicode(resources.get("Font", name)));
      map = maps.get(name);
    } else if (op.op === "BDC" && useActualText) {
      const dict = op.operands[1];
      const actual = dict?.type === "dict" ? dict.value.ActualText : undefined;
      if (actual?.type === "string") {
        for (let i = 2; i + 1 < actual.value.length; i += 2)
          out += String.fromCharCode((actual.value[i]! << 8) | actual.value[i + 1]!);
        skipping = true;
      }
    } else if (op.op === "EMC") skipping = false;
    else if (op.op === "TJ" && !skipping) {
      const array = op.operands[0] as { value: { type: string; value: Uint8Array }[] };
      for (const item of array.value)
        if (item.type === "string")
          for (let i = 0; i + 1 < item.value.length; i += 2) out += map!.get((item.value[i]! << 8) | item.value[i + 1]!) ?? "�";
    }
  }
  return out.replaceAll("﻿", "");
}
