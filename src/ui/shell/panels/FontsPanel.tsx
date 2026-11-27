/** Fonts available for editing, and uploading your own. */
import { UploadSimple } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { engine } from "../../../engine/client";
import type { FontChoice } from "../../../engine/types";
import { useStore } from "../../../store";
import { pickFiles } from "../actions";
import { Button } from "../controls";
import { errorText } from "../util";

const GROUPS: [FontChoice["source"], string][] = [
  ["user", "Your fonts"],
  ["document", "In this document"],
  ["builtin", "Built in"],
  ["web", "Free fonts, downloaded when used"],
];

export function FontsPanel() {
  const [fonts, setFonts] = useState<FontChoice[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    engine.listFonts().then(
      (list) => {
        if (!live) return;
        setFonts(list);
        setError("");
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [version]);

  const upload = async () => {
    const files = await pickFiles(".ttf,.otf,.ttc,font/ttf,font/otf,font/collection", true);
    const { toast } = useStore.getState();
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const font = await engine.addUserFont(file.name.replace(/\.(ttf|otf|ttc)$/i, ""), bytes);
        toast(`Added ${font.family}`, "success");
      } catch (e) {
        toast(`${file.name} could not be used: ${errorText(e)}`, "error");
      }
    }
    if (files.length) setVersion((v) => v + 1);
  };

  const needle = filter.trim().toLocaleLowerCase();
  const matching = (fonts ?? []).filter(
    (f) => !needle || [f.family, f.category, ...f.scripts].some((v) => v.toLocaleLowerCase().includes(needle)),
  );

  return (
    <div className="sh-scroll">
      <div className="sh-stack sh-pad">
        <p className="sh-hint">
          Upload the document’s own font for the closest result. A font with a matching name is used automatically.
          Uploaded fonts stay on this device until you close the tab.
        </p>
        <Button variant="primary" icon={UploadSimple} block onClick={() => void upload()}>
          Upload TTF or OTF
        </Button>
        <input
          className="sh-input"
          type="search"
          name="font-search"
          aria-label="Search fonts"
          placeholder="Search by name or script…"
          autoComplete="off"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {error ? (
          <p className="sh-error" role="alert">
            The font list could not be loaded: {error}
          </p>
        ) : !fonts ? (
          <p className="sh-status" role="status">
            Loading fonts…
          </p>
        ) : !matching.length ? (
          <p className="sh-status">No fonts to show.</p>
        ) : (
          GROUPS.map(([source, title]) => {
            const items = matching.filter((f) => f.source === source);
            if (!items.length) return null;
            return (
              <section key={source}>
                <h3>{title}</h3>
                <ul className="sh-fonts">
                  {items.map((f) => (
                    <li key={f.id}>
                      <span translate="no">{f.family}</span>
                      <small>
                        {f.scripts.slice(0, 4).join(", ")}
                        {f.scripts.length > 4 ? ` +${f.scripts.length - 4}` : ""}
                      </small>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
