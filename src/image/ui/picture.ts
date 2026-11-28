/** Browser side of the picture: decoding, drawing patches and exporting. */
import { addNote, type ImageType } from "../metadata";
import type { Patch, Picture } from "../types";

export interface Opened {
  bitmap: ImageBitmap;
  picture: Picture;
  /** the file was larger than can be edited */
  scaled: boolean;
}

/** the largest canvas that is dependable on this device */
function pixelLimit(): number {
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (apple) return 16_700_000;
  return matchMedia("(pointer: coarse)").matches ? 24_000_000 : 50_000_000;
}

export async function openPicture(file: Blob): Promise<Opened> {
  // turned the way the camera says; the instruction itself is not carried into the export
  let bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const limit = pixelLimit();
  let scaled = false;
  if (bitmap.width * bitmap.height > limit) {
    const f = Math.sqrt(limit / (bitmap.width * bitmap.height));
    const small = await createImageBitmap(bitmap, { resizeWidth: Math.floor(bitmap.width * f), resizeHeight: Math.floor(bitmap.height * f), resizeQuality: "high" });
    bitmap.close();
    bitmap = small;
    scaled = true;
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This picture is too large for this browser.");
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  canvas.width = canvas.height = 0;
  return { bitmap, picture: { width: bitmap.width, height: bitmap.height, data }, scaled };
}

export function drawPatch(context: CanvasRenderingContext2D, patch: Patch) {
  const area = context.getImageData(patch.x, patch.y, patch.width, patch.height);
  for (let i = 0; i < patch.mask.length; i++) {
    if (!patch.mask[i]) continue;
    const at = i * 4;
    area.data[at] = patch.data[at]!;
    area.data[at + 1] = patch.data[at + 1]!;
    area.data[at + 2] = patch.data[at + 2]!;
    area.data[at + 3] = patch.data[at + 3]!;
  }
  context.putImageData(area, patch.x, patch.y);
}

export const EXTENSION: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** the edited picture as a file of the original pixel size, carrying only the note that it was edited */
export async function exportPicture(bitmap: ImageBitmap, patches: Patch[], type: ImageType, quality: number, name: string): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  for (const patch of patches) drawPatch(context, patch);
  if (type === "image/jpeg") {
    // JPEG has no transparency
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  canvas.width = canvas.height = 0;
  if (!blob || blob.type !== type) throw new Error(`This browser cannot save ${EXTENSION[type].toUpperCase()} files. Choose another format.`);
  const bytes = addNote(new Uint8Array(await blob.arrayBuffer()), type, bitmap.width, bitmap.height);
  return new File([bytes], `${name}.${EXTENSION[type]}`, { type });
}
