/** Stand-ins for the TEXT and OCR modules, so these tests only depend on OPS (and MuPDF). */
const missing = () => {
  throw new Error("not part of this test");
};
export const text = { analyzePage: missing, editLines: missing, findText: missing, replaceText: missing };
export const ocr = {
  mergePageText: <T>(_ctx: unknown, base: T) => base,
  setOcrResult: missing,
  editOcrLines: missing,
  makeSearchable: missing,
};
