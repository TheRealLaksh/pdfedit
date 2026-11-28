/**
 * Marks an exported picture as edited. The pixels come from a canvas, so nothing of the source file's
 * metadata (camera, place, time, author) is carried over; any such block found is removed all the same.
 * Only the plain note and the program's name are written.
 */
export const NOTE = "Edited with PDFEdit";
export const SOFTWARE = "PDFEdit";

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const text = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

let table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function be32(n: number) {
  return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}
function le32(n: number) {
  return Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);
}

function png(bytes: Uint8Array) {
  if (bytes.length < 33 || text(bytes, 1, 4) !== "PNG") throw new Error("Not a PNG file.");
  const chunk = (type: string, data: Uint8Array) => {
    const body = join([ascii(type), data]);
    return join([be32(data.length), body, be32(crc32(body))]);
  };
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = text(bytes, at + 4, at + 8);
    const end = at + 12 + length;
    if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) out.push(bytes.subarray(at, end));
    if (type === "IHDR") out.push(chunk("tEXt", ascii(`Software\0${SOFTWARE}`)), chunk("tEXt", ascii(`Comment\0${NOTE}`)));
    at = end;
  }
  return join(out);
}

function jpeg(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG file.");
  const note = ascii(NOTE);
  const comment = join([Uint8Array.of(0xff, 0xfe, 0, note.length + 2), note]);
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  let placed = false;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    // the picture data follows the scan header: copy the rest as it is
    if (marker === 0xda) break;
    const end = at + 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
    // EXIF / XMP (APP1), IPTC (APP13) and old comments stay behind
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) {
      if (!placed && marker !== 0xe0) {
        out.push(comment);
        placed = true;
      }
      out.push(bytes.subarray(at, end));
    }
    at = end;
  }
  if (!placed) out.push(comment);
  out.push(bytes.subarray(at));
  return join(out);
}

function webp(bytes: Uint8Array, width: number, height: number) {
  if (text(bytes, 0, 4) !== "RIFF" || text(bytes, 8, 12) !== "WEBP") throw new Error("Not a WebP file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  for (let at = 12; at + 8 <= bytes.length; ) {
    const type = text(bytes, at, at + 4);
    const length = view.getUint32(at + 4, true);
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 8 + length + (length & 1);
  }
  const chunk = (type: string, data: Uint8Array) => join([ascii(type), le32(data.length), data, new Uint8Array(data.length & 1)]);
  const kept = chunks.filter((c) => !["VP8X", "EXIF", "XMP "].includes(c.type));
  const old = chunks.find((c) => c.type === "VP8X");
  const lossless = kept.find((c) => c.type === "VP8L");
  const alpha = kept.some((c) => c.type === "ALPH") || (!!lossless && (lossless.data[4]! & 0x10) !== 0);
  const header = new Uint8Array(10);
  // keep what the old header said (colour profile, transparency, animation), without EXIF, with XMP
  header[0] = ((old?.data[0] ?? 0) & ~0x08) | 0x04 | (alpha ? 0x10 : 0) | (kept.some((c) => c.type === "ICCP") ? 0x20 : 0);
  header.set(le32(width - 1).subarray(0, 3), 4);
  header.set(le32(height - 1).subarray(0, 3), 7);
  const xmp = ascii(
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:CreatorTool="${SOFTWARE}"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${NOTE}</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
  );
  const body = join([ascii("WEBP"), chunk("VP8X", header), ...kept.map((c) => chunk(c.type, c.data)), chunk("XMP ", xmp)]);
  return join([ascii("RIFF"), le32(body.length), body]);
}

export function addNote(bytes: Uint8Array, type: ImageType, width: number, height: number): Uint8Array<ArrayBuffer> {
  if (type === "image/png") return png(bytes);
  if (type === "image/jpeg") return jpeg(bytes);
  return webp(bytes, width, height);
}
