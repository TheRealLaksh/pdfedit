import type { EngineContext } from "../context";

export interface OpsState {
  /** object number of the image XObject made from each blob, so it is embedded only once */
  images: Record<string, number>;
}

/** this module's slot in the undoable document state */
export function opsState(ctx: EngineContext): OpsState {
  return (ctx.state.extra.ops ??= { images: {} }) as OpsState;
}
