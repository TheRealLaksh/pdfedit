/** Download as PDF (with options), page images or plain text. */
import { DownloadSimple, FileImage, FileText, MagnifyingGlass, Warning } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { engine } from "../../../engine/client";
import { saveBytes, useStore } from "../../../store";
import { canShare, finishDocument } from "../actions";
import { Button, Check, PasswordField, Segmented } from "../controls";
import { FINISH } from "../strings";
import { ask } from "../uiStore";
import { baseName, errorText } from "../util";
import { PageScope, usePageScope } from "./PageScope";

export function ExportPanel() {
  const doc = useStore((s) => s.doc)!;
  const busy = useStore((s) => s.busy !== null);
  const run = useStore((s) => s.run);
  const openPanel = useStore((s) => s.openPanel);
  const recognised = useStore((s) => s.ocr.done);
  const scope = usePageScope();
  const [compress, setCompress] = useState(true);
  const [flatten, setFlatten] = useState(false);
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [dpi, setDpi] = useState(150);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void finishDocument({
      compress,
      flatten,
      password: protect && password ? password : undefined,
      pages: scope.optional,
    });
  };

  const images = async () => {
    const pages = scope.pages;
    if (pages.length > 10) {
      const choice = await ask({
        title: `Download ${pages.length} images?`,
        message: "Each page is saved as a separate file. Your browser may ask for permission to download several files.",
        choices: [
          { id: "cancel", label: "Cancel" },
          { id: "go", label: "Download", tone: "primary" },
        ],
      });
      if (choice !== "go") return;
    }
    try {
      const made: File[] = [];
      for (const [i, page] of pages.entries()) {
        useStore.setState({ busy: `Preparing image ${i + 1} of ${pages.length}` });
        const bytes = await engine.exportPageImage(page, dpi, format);
        const name = `${baseName(doc.fileName)} (page ${page + 1}).${format === "png" ? "png" : "jpg"}`;
        saveBytes(bytes, name, `image/${format}`);
        made.push(new File([bytes as Uint8Array<ArrayBuffer>], name, { type: `image/${format}` }));
        if (i < pages.length - 1) await new Promise((r) => setTimeout(r, 250));
      }
      // a button of its own: sharing needs a fresh tap
      if (canShare(made))
        useStore.getState().toast(made.length === 1 ? "Image saved" : `${made.length} images saved`, "success", {
          label: FINISH.share,
          run: () => void navigator.share({ files: made }).catch(() => {}),
        });
    } catch (e) {
      useStore.getState().toast(errorText(e), "error");
    } finally {
      useStore.setState({ busy: null });
    }
  };

  const text = async () => {
    useStore.setState({ busy: "Preparing text" });
    try {
      const out = await engine.exportText(scope.optional);
      if (!out.trim()) {
        useStore.getState().toast("No text found. Scanned pages need text recognition first.", "warning", {
          label: "Recognise text",
          run: () => openPanel("ocr"),
        });
        return;
      }
      saveBytes(new TextEncoder().encode(out), baseName(doc.fileName) + ".txt", "text/plain;charset=utf-8");
    } catch (e) {
      useStore.getState().toast(errorText(e), "error");
    } finally {
      useStore.setState({ busy: null });
    }
  };

  return (
    <div className="sh-scroll">
      <div className="sh-stack sh-pad">
        {doc.signed && (
          <p className="sh-notice">
            <Warning size={20} weight="fill" aria-hidden />
            <span>This PDF is digitally signed. A changed copy will no longer pass signature checks.</span>
          </p>
        )}
        <PageScope scope={scope} />

        <form className="sh-stack" onSubmit={submit}>
          <h3>PDF</h3>
          <Check label="Reduce file size" checked={compress} onChange={setCompress} />
          <Check
            label="Flatten"
            hint="Form fields and annotations become part of the page."
            checked={flatten}
            onChange={setFlatten}
          />
          <Check label="Protect with a password" checked={protect} onChange={setProtect} />
          {protect && (
            <PasswordField
              label="New password"
              name="new-pdf-password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              hint="Keep it safe: it cannot be recovered."
            />
          )}
          {doc.encrypted && !protect && (
            <p className="sh-hint">The original password is not kept. Set one above if the copy should stay protected.</p>
          )}
          <Button
            variant="primary"
            type="submit"
            icon={DownloadSimple}
            block
            disabled={busy || !scope.valid || (protect && !password)}
          >
            Download PDF
          </Button>
        </form>

        <hr />
        <h3>Page images</h3>
        <Segmented
          label="Format"
          value={format}
          onChange={setFormat}
          options={[
            { value: "png", label: "PNG" },
            { value: "jpeg", label: "JPEG" },
          ]}
        />
        <Segmented
          label="Resolution (dpi)"
          value={dpi}
          onChange={setDpi}
          options={[96, 150, 300].map((v) => ({ value: v, label: String(v) }))}
        />
        <Button icon={FileImage} block disabled={busy || !scope.valid} onClick={() => void images()}>
          Download images
        </Button>

        <hr />
        <h3>Text</h3>
        <Button icon={FileText} block disabled={busy || !scope.valid} onClick={() => void text()}>
          Download plain text
        </Button>

        <hr />
        <h3>Searchable scan</h3>
        {recognised.length ? (
          <>
            <p className="sh-hint">Adds invisible text over recognised pages, so they can be searched and copied.</p>
            <Button
              icon={MagnifyingGlass}
              block
              disabled={busy}
              onClick={() =>
                void run("Adding searchable text", () => engine.makeSearchable(recognised)).then(
                  (r) => r && useStore.getState().toast("Searchable text added. Download the PDF to keep it.", "success"),
                )
              }
            >
              Make searchable
            </Button>
          </>
        ) : (
          <>
            <p className="sh-hint">Recognise the text of scanned pages first.</p>
            <Button block onClick={() => openPanel("ocr")}>
              Recognise text
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
