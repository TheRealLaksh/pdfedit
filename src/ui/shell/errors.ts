/** Turns what the engine or the browser said into a plain sentence with a way forward. */

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key|txt|csv|zip)$/i;
const HEIC = /\.(heic|heif)$/i;

/** a reason a file can be turned away before it is even read */
export function refusal(file: { name: string; type: string }): string | null {
  if (OFFICE.test(file.name)) return "PDFEdit opens PDFs and pictures. Save this document as a PDF first.";
  if ((HEIC.test(file.name) || /image\/hei[cf]/.test(file.type)) && !heicWorks())
    return "This browser can't read HEIC photos. Save it as JPEG and try again.";
  return null;
}

/** Safari decodes HEIC, so only turn it away elsewhere */
function heicWorks(): boolean {
  return typeof navigator !== "undefined" && /^((?!chrome|android|firefox).)*safari/i.test(navigator.userAgent);
}

/** the sentence to show for a failed open; the raw message goes to the console only */
export function openProblem(name: string, raw: string): string {
  if (/certificate/i.test(raw)) return "PDFEdit can't open certificate-locked files.";
  if (/file is empty/i.test(raw)) return `${name} is empty. Download it again, or choose another file.`;
  if (/could not be read as a PDF|not a PDF/i.test(raw))
    return `Couldn't open ${name}. It may be incomplete or not a PDF. Download it again, or choose another file.`;
  return plain(raw);
}

/** known technical messages in plain words; anything else is passed on as it is */
export function plain(raw: string): string {
  if (/language|traineddata|tesseract|recognition/i.test(raw) && /fetch|network|download|load/i.test(raw))
    return "Couldn't download the language files. Check your connection, then try again.";
  if (/font/i.test(raw) && /could not (load|download)|network|failed to fetch|connection/i.test(raw))
    return "Couldn't download a font for this text. Check your connection, then try again.";
  if (/^Could not download https?:/i.test(raw) || /^(TypeError: )?Failed to fetch$/i.test(raw))
    return "A download failed. Check your connection, then try again.";
  if (/out of memory|allocation failed|memory access/i.test(raw))
    return "This file is too large for the memory on this device. Close other tabs and try again.";
  return raw;
}
