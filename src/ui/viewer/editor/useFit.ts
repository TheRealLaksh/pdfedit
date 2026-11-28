/** How the text being typed will fit, asked of the engine (it knows the fonts the page will be saved with). */
import { useEffect, useState } from "react";
import { engine } from "../../../engine/client";
import type { LineEdit, LineMeasure } from "../../../engine/types";

const PAUSE = 220;
/** while a font is still downloading the answer is a guess: ask again a few times */
const AGAIN = 900;
const TRIES = 6;

/** `edit` null = nothing to measure. Keeps the previous answer while the next is on its way */
export function useLineFit(page: number, edit: LineEdit | null): LineMeasure | null {
  const key = edit ? JSON.stringify(edit) : null;
  const [found, setFound] = useState<LineMeasure | null>(null);
  useEffect(() => {
    if (!edit) {
      setFound(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = (tries: number) =>
      engine.measureLine(page, edit).then(
        (measure) => {
          if (!live) return;
          setFound(measure);
          if (measure.estimated && tries < TRIES) timer = setTimeout(() => ask(tries + 1), AGAIN);
        },
        // the line is gone (the page changed) or cannot be measured: no warning
        () => live && setFound(null),
      );
    timer = setTimeout(() => ask(1), PAUSE);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [page, key]);
  return key ? found : null;
}
