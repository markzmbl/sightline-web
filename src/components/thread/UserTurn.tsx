import type { RunView } from "../../api/types";

interface Props {
  run: RunView;
  busy: boolean;
  /** Offered on the latest revision only; absent hides the button. */
  onTakeBack?: () => void;
}

/** What the user typed for this run: the question, or a revision of it. */
export function UserTurn({ run, busy, onTakeBack }: Props) {
  return (
    <div className="tx-user">
      {run.revision > 0 && <span className="eyebrow">Revision {run.revision}</span>}
      <p className="tx-user__bubble">{run.prompt}</p>
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
