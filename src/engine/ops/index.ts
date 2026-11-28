/** Added objects, existing images, forms, page tools, redaction, stamps and export. Owner: OPS module. */
export { addObject, listObjects, removeObject, updateObject } from "./objects";
export { deleteImage, listImages, moveImage, replaceImage } from "./images";
export { listFormFields, setFormField } from "./forms";
export {
  deletePages, duplicatePage, extractPages, insertBlankPage, insertImagesAsPages, insertPdf, reorderPages,
  rotatePages, splitDocument,
} from "./pages";
export { redactAreas } from "./redact";
export { addPageNumbers, addWatermark } from "./stamps";
export { exportPageImage, exportPdf, exportText, lastExportInfo } from "./export";
