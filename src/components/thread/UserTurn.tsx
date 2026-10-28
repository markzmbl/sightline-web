import type { RunSummary } from "../../api/types";
import { originLabel } from "./words";

interface Props {
  summary: RunSummary;
  busy: boolean;
  /** Offered on the latest revision only; absent hides the button. */
  onTakeBack?: () => void;
}

/**
 * What the user sent for this run: the question, a revision typed, a follow-up or a
 * nearest question sent from the transcript, or a take-back, whose prompt is the text
 * it took back and so shows muted.
 */
export function UserTurn({ summary, busy, onTakeBack }: Props) {
  const label = originLabel(summary);
  const takenBack = summary.origin === "take_back";
  return (
    <div className="tx-user">
      {label && <span className="eyebrow">{label}</span>}
      <p className={takenBack ? "tx-user__bubble tx-user__bubble--taken" : "tx-user__bubble"}>{summary.prompt}</p>
      {onTakeBack && (
        <button
          type="button"
          className="tx-link"
          title="Answer again without this revision"
          disabled={busy}
          onClick={onTakeBack}
        >
          Take back
        </button>
      )}
    </div>
  );
}
