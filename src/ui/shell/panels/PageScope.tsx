/** "All pages / This page / Range" chooser used by several panels. */
import { useState } from "react";
import { useStore } from "../../../store";
import { Field, Segmented } from "../controls";
import { parsePageRange, range } from "../util";

type Mode = "all" | "current" | "range";

export function usePageScope(initial: Mode = "all") {
  const count = useStore((s) => s.doc?.pageCount ?? 0);
  const current = useStore((s) => s.currentPage);
  const [mode, setMode] = useState<Mode>(initial);
  const [text, setText] = useState("");
  const parsed = mode === "range" ? parsePageRange(text, count) : null;
  return {
    mode,
    setMode,
    text,
    setText,
    count,
    /** false while a range is being typed or is wrong */
    valid: mode !== "range" || parsed !== null,
    /** the chosen pages, spelled out */
    pages: mode === "all" ? range(count) : mode === "current" ? [current] : (parsed ?? []),
    /** for engine options where "all" means leaving the field out */
    optional: mode === "all" ? undefined : mode === "current" ? [current] : (parsed ?? undefined),
  };
}

export function PageScope({ scope, label = "Pages" }: { scope: ReturnType<typeof usePageScope>; label?: string }) {
  if (scope.count < 2) return null;
  return (
    <>
      <Segmented
        label={label}
        value={scope.mode}
        onChange={scope.setMode}
        options={[
          { value: "all", label: "All" },
          { value: "current", label: "This page" },
          { value: "range", label: "Range" },
        ]}
      />
      {scope.mode === "range" && (
        <Field
          label="Page range"
          name="page-range"
          autoComplete="off"
          inputMode="text"
          placeholder="e.g. 1-3, 6…"
          value={scope.text}
          onChange={(e) => scope.setText(e.target.value)}
          error={scope.text && !scope.valid ? `Use page numbers from 1 to ${scope.count}, like 1-3, 6.` : undefined}
        />
      )}
    </>
  );
}
