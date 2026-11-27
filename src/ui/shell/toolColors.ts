/**
 * The store has one drawing colour; people expect a yellow highlighter and a dark pen. This keeps a
 * colour per tool family and swaps it in when the tool changes.
 */
import { useEffect } from "react";
import type { RGB } from "../../engine/types";
import { useStore, type ToolId } from "../../store";
import { INK_SWATCHES, MARKER_SWATCHES } from "./controls";

type Family = "highlight" | "shape" | "ink";

const family = (tool: ToolId): Family | null =>
  tool === "highlight" ? "highlight"
  : tool === "ink" ? "ink"
  : tool === "rect" || tool === "ellipse" || tool === "line" || tool === "arrow" ? "shape"
  : null;

const memory: Record<Family, RGB> = {
  highlight: MARKER_SWATCHES[0]!.value,
  shape: INK_SWATCHES[2]!.value,
  ink: INK_SWATCHES[1]!.value,
};

export function useToolColors(): void {
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.tool === previous.tool) return;
        const from = family(previous.tool);
        const to = family(state.tool);
        if (from === to) return;
        if (from) memory[from] = previous.toolOptions.color;
        if (to) state.setToolOptions({ color: memory[to] });
      }),
    [],
  );
}
