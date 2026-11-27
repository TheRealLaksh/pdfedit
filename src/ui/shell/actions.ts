/** Things the shell can do, shared by the top bar, tool bars, menus and panels. */
import { engine } from "../../engine/client";
import type { MutationResult } from "../../engine/types";
import { toEngineImage, useStore, type ToolId } from "../../store";
import { ask, promptFor, useShell } from "./uiStore";
import { errorText } from "./util";

export const PDF_ACCEPT = "application/pdf,.pdf";
export const IMAGE_ACCEPT = "image/*,.tif,.tiff";
export const OPEN_ACCEPT = `${PDF_ACCEPT},${IMAGE_ACCEPT}`;

/** open the system file picker; resolves with [] if nothing was chosen */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.className = "sh-hidden-file";
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => done([]), { once: true });
    // iOS needs the input in the document
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Resolves once no engine work is running. Tapping a control while a line is being edited makes the
 * viewer commit it first, so "download" and "close" have to wait for that change to land.
 */
export function whenIdle(): Promise<void> {
  // one tick, so a commit started by this same click has marked the store busy
  return new Promise((resolve) =>
    setTimeout(() => {
      if (!useStore.getState().busy) return resolve();
      const stop = useStore.subscribe((s) => {
        if (s.busy) return;
        stop();
        resolve();
      });
    }),
  );
}

let downloading = false;

export async function downloadWhenReady(): Promise<void> {
  if (downloading) return;
  downloading = true;
  try {
    await whenIdle();
    await useStore.getState().download();
  } finally {
    downloading = false;
  }
}

/** true when it is fine to throw the current document away */
export async function confirmDiscard(action: string): Promise<boolean> {
  await whenIdle();
  const { doc, dirty } = useStore.getState();
  if (!doc || !dirty) return true;
  const choice = await ask({
    title: "Unsaved changes",
    message: `Your changes to ${doc.fileName} have not been downloaded. ${action}`,
    choices: [
      { id: "cancel", label: "Keep editing", tone: "plain" },
      { id: "discard", label: "Discard changes", tone: "danger" },
      { id: "download", label: "Download first", tone: "primary" },
    ],
  });
  if (choice === "discard") return true;
  if (choice === "download") {
    await useStore.getState().download();
    return !useStore.getState().dirty;
  }
  return false;
}

export async function openAnother(files?: File[]): Promise<void> {
  const chosen = files ?? (await pickFiles(OPEN_ACCEPT, true));
  if (!chosen.length) return;
  if (!(await confirmDiscard("Opening another file will discard them."))) return;
  await useStore.getState().openFiles(chosen);
}

export async function closeDocument(): Promise<void> {
  useShell.getState().setMenu(false);
  if (await confirmDiscard("Closing the document will discard them.")) await useStore.getState().closeDoc();
}

/** insert a PDF, asking for its password when it has one */
export async function insertPdfFile(file: File, at: number): Promise<MutationResult | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password: string | undefined;
  for (;;) {
    useStore.setState({ busy: "Adding " + file.name });
    try {
      const result = await engine.insertPdf(bytes.slice(), at, password);
      useStore.getState().applyMutation(result);
      useStore.setState({ busy: null });
      return result;
    } catch (e) {
      useStore.setState({ busy: null });
      if (!/password|encrypt/i.test(errorText(e))) {
        useStore.getState().toast(errorText(e), "error");
        return null;
      }
      const typed = await promptFor({
        title: "Password needed",
        message:
          password === undefined
            ? `${file.name} is protected. Enter its password to add it.`
            : `That password did not work for ${file.name}. Try again.`,
        label: "Password",
        type: "password",
        submit: "Add file",
      });
      if (typed === null) return null;
      password = typed;
    }
  }
}

export async function insertImageFiles(files: File[], at: number): Promise<MutationResult | null> {
  try {
    useStore.setState({ busy: "Reading images" });
    const data = await Promise.all(files.map(toEngineImage));
    useStore.setState({ busy: null });
    return await useStore.getState().run("Adding pages", () => engine.insertImagesAsPages(data, at));
  } catch (e) {
    useStore.setState({ busy: null });
    useStore.getState().toast("Could not read that image: " + errorText(e), "error");
    return null;
  }
}

/** files dropped on an open document */
export async function dropOnDocument(files: File[]): Promise<void> {
  const state = useStore.getState();
  if (!state.doc) return;
  const first = files[0];
  if (!first) return;
  const onlyImage = files.length === 1 && first.type.startsWith("image/");
  const choice = await ask({
    title: files.length === 1 ? first.name : `${files.length} files`,
    message: onlyImage
      ? "Place the image on a page, add it as a new page, or open it on its own."
      : "Add to the end of this document, or open instead of it.",
    choices: [
      { id: "open", label: "Open instead", tone: "plain" },
      ...(onlyImage ? [{ id: "place", label: "Place on a page", tone: "plain" as const }] : []),
      { id: "append", label: "Add as pages", tone: "primary" },
    ],
  });
  if (choice === "open") await openAnother(files);
  else if (choice === "place") await placeImage(first);
  else if (choice === "append") {
    const images = files.filter((f) => f.type.startsWith("image/"));
    for (const file of files.filter((f) => !images.includes(f)))
      await insertPdfFile(file, useStore.getState().doc!.pageCount);
    if (images.length) await insertImageFiles(images, useStore.getState().doc!.pageCount);
  }
}

/** hold an image until the user taps the spot on a page */
export async function placeImage(file?: File): Promise<void> {
  const chosen = file ?? (await pickFiles(IMAGE_ACCEPT))[0];
  if (!chosen) return;
  try {
    const data = await toEngineImage(chosen);
    const bitmap = await createImageBitmap(chosen);
    const { width, height } = bitmap;
    bitmap.close();
    const state = useStore.getState();
    state.setTool("image");
    state.openPanel(null);
    state.setPlacement({ kind: "image", data, width, height, label: chosen.name });
  } catch (e) {
    useStore.getState().toast("Could not read that image: " + errorText(e), "error");
  }
}

/** choose a tool from any menu */
export function chooseTool(tool: ToolId): void {
  useShell.getState().setMenu(false);
  const state = useStore.getState();
  if (tool === "image") {
    void placeImage();
    return;
  }
  if (tool === "signature") {
    state.openPanel("signature");
    return;
  }
  state.openPanel(null);
  state.setTool(tool);
}
