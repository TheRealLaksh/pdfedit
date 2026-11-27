/** Areas marked for redaction, waiting for confirmation. */
import { XIcon } from "@phosphor-icons/react";
import { useViewer } from "../viewerStore";

export function RedactionLayer({ page, scale }: { page: number; scale: number }) {
  const rects = useViewer((s) => s.redactions[page]);
  if (!rects?.length) return null;
  const remove = (index: number) =>
    useViewer.setState((s) => {
      const rest = (s.redactions[page] ?? []).filter((_, i) => i !== index);
      const redactions = { ...s.redactions, [page]: rest };
      if (!rest.length) delete redactions[page];
      return { redactions };
    });
  return (
    <div className="pv-redactions">
      {rects.map(([x0, y0, x1, y1], i) => (
        <div
          key={i}
          className="pv-redaction"
          style={{ left: x0 * scale, top: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale }}
        >
          <button type="button" aria-label="Remove this mark" onClick={() => remove(i)}>
            <XIcon weight="bold" />
          </button>
        </div>
      ))}
    </div>
  );
}
