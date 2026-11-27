/** One mounted page: its picture and the layers of the active tool. */
import { memo } from "react";
import { useStore } from "../../store";
import { TextEditor } from "./editor/TextEditor";
import type { PageBox } from "./geometry";
import { DRAW_TOOLS, DrawLayer } from "./layers/DrawLayer";
import { EditTextLayer } from "./layers/EditTextLayer";
import { AddTextLayer, PlaceLayer } from "./layers/PlaceLayer";
import { RedactionLayer } from "./layers/RedactionLayer";
import { SelectLayer } from "./layers/SelectLayer";
import { PendingLayer, SearchLayer } from "./layers/StaticLayers";
import { PageCanvas } from "./PageCanvas";

export const PageView = memo(function PageView({ index, left, top, width, height, scale, settled }: {
  index: number;
  settled: number;
} & PageBox) {
  const info = useStore((s) => s.doc?.pages[index]);
  const session = useStore((s) => s.session);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => !!s.placement);
  const editing = useStore((s) => (s.editing?.page === index ? s.editing.lineId : null));
  const selected = useStore((s) => s.selection?.page === index);
  if (!info) return null;
  const size = { page: index, width: info.width, height: info.height, scale };

  return (
    <div
      className={editing ? "pv-page pv-page-editing" : "pv-page"}
      data-page={index}
      data-testid="page"
      style={{ left, top, width, height }}
    >
      <PageCanvas {...size} revision={info.revision} settled={settled} />
      <SearchLayer page={index} width={info.width} height={info.height} />
      <PendingLayer {...size} />
      <div className="pv-tool" key={session}>
        {placing ? (
          <PlaceLayer {...size} />
        ) : (
          <>
            {tool === "edit-text" && <EditTextLayer {...size} />}
            {tool === "add-text" && <AddTextLayer {...size} />}
            {DRAW_TOOLS.includes(tool) && <DrawLayer {...size} tool={tool} />}
            {(tool === "select" || selected) && <SelectLayer {...size} interactive={tool === "select"} />}
          </>
        )}
        <RedactionLayer page={index} scale={scale} />
        {editing && <TextEditor key={`${session}:${editing}`} page={index} lineId={editing} scale={scale} />}
      </div>
    </div>
  );
});
