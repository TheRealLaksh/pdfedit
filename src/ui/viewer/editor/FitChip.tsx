/** A line of warning above the editor's controls while the new text is being typed, with a one tap remedy. */
import { ArrowsInLineHorizontalIcon, WarningIcon } from "@phosphor-icons/react";
/** collides: into other text or off the page; long: there is room, but it is much longer than it was */
export type Overflow = "collides" | "long" | null;

const SAY: Record<NonNullable<Overflow>, string> = {
  collides: "Runs into other text or off the page",
  long: "Longer than before",
};

export function FitChip({ overflow, fitted, narrow, lacking, onFit }: {
  overflow: Overflow;
  /** "fit to the original width" is on */
  fitted: boolean;
  /** fitting squeezes the text a lot */
  narrow: boolean;
  /** letters the previewed font does not have */
  lacking: string[];
  onFit(on: boolean): void;
}) {
  const fit = overflow && !fitted;
  const squeezed = fitted && narrow;
  const message = fit
    ? SAY[overflow]
    : squeezed
      ? "Fitted, but very narrow"
      : lacking.length
        ? `Another font will draw ${lacking.slice(0, 6).join(" ")}`
        : null;
  if (!message) return null;
  return (
    <div className="pv-fitchip" role="status" data-testid="fit-chip">
      <WarningIcon aria-hidden />
      <span>{message}</span>
      {(fit || squeezed) && (
        <button
          type="button"
          className="pv-btn pv-btn-text pv-btn-outline"
          // the field keeps the focus, so the keyboard stays
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onFit(!squeezed)}
        >
          {fit && <ArrowsInLineHorizontalIcon aria-hidden />}
          {fit ? "Fit" : "Undo fit"}
        </button>
      )}
    </div>
  );
}
