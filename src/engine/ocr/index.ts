/** Engine side of OCR: turn recognised lines into editable lines and write edits back. Owner: OCR module. */
export { mergePageText, setOcrResult } from "./recognised";
export { editOcrLines } from "./edit";
export { makeSearchable } from "./searchable";
