/** Things the shell can do, shared by the top bar, tool bars, menus and panels. */
import { clearDraft, engine } from "../../engine/client";
import type { ExportOptions, MutationResult } from "../../engine/types";
import { saveBytes, toEngineImage, useStore, type Prepared, type ToolId } from "../../store";
import { FINISH, SAMPLE } from "./strings";
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
    let cancelled: ReturnType<typeof setTimeout> | undefined;
    const done = (files: File[]) => {
      clearTimeout(cancelled);
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(Array.from(input.files ?? [])), { once: true });
    // wait a moment: some engines (automated Firefox) report "cancel" and then deliver the files anyway
    input.addEventListener("cancel", () => (cancelled = setTimeout(() => done([]), 1000)), { once: true });
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

/** a computer with a mouse saves in one click; elsewhere Share needs a tap of its own, after the file is ready */
const quickSave = () => window.matchMedia("(min-width: 900px) and (min-height: 480px) and (pointer: fine)").matches;

export const pdfFile = (copy: Prepared) =>
  new File([copy.bytes as Uint8Array<ArrayBuffer>], copy.name, { type: "application/pdf" });

export function canShare(files: File[]): boolean {
  try {
    return typeof navigator.share === "function" && !!navigator.canShare?.({ files });
  } catch {
    return false;
  }
}

export function saveCopy(copy: Prepared): void {
  saveBytes(copy.bytes, copy.name);
  useStore.getState().markSaved(copy);
}

/** call straight from a tap: the browser refuses to share once the tap is old */
export function shareCopy(copy: Prepared, done: () => void): void {
  navigator.share({ files: [pdfFile(copy)] }).then(
    () => {
      useStore.getState().markSaved(copy);
      useStore.getState().toast(FINISH.shared, "success");
      done();
    },
    (e: unknown) => {
      // closing the share sheet is a choice, not a failure
      if ((e as Error)?.name !== "AbortError") useStore.getState().toast(FINISH.shareFailed, "error");
    },
  );
}

function showFinish(copy: Prepared, saved: boolean): void {
  const state = useStore.getState();
  useShell.getState().setMenu(false);
  state.openPanel(null);
  useShell.getState().setFinish({ copy, saved });
}

let finishing = false;

/** make the finished PDF, then save it or offer to save and share it */
export async function finishDocument(options?: ExportOptions): Promise<void> {
  if (finishing) return;
  finishing = true;
  try {
    await whenIdle();
    const copy = await useStore.getState().prepare(options);
    if (!copy) return;
    if (!quickSave()) return showFinish(copy, false);
    saveCopy(copy);
    // a copy of only some pages has nothing more to offer
    if (!options?.pages)
      useStore.getState().toast(FINISH.savedNotice(copy.name), "success", {
        label: FINISH.options,
        run: () => showFinish(copy, true),
      });
  } finally {
    finishing = false;
  }
}

export const downloadWhenReady = () => finishDocument();

/** the sample document that ships with the app */
export async function openSample(): Promise<void> {
  try {
    useStore.setState({ busy: "Opening " + SAMPLE.name, openError: null });
    const response = await fetch(SAMPLE.url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || bytes[0] !== 0x25) throw new Error(String(response.status));
    await useStore.getState().openBytes(bytes, SAMPLE.name);
  } catch {
    useStore.setState({ busy: null, openError: "The sample could not be downloaded. Check your connection, then try again." });
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
  if (choice === "discard") {
    // thrown away on purpose: it must not come back as a draft
    void clearDraft();
    return true;
  }
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
