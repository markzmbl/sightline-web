import { useLayoutEffect, useRef, type FocusEvent, type Ref } from "react";
import { isOpen, isWorking, type Rating, type RunError, type RunStatus, type RunView } from "../../api/types";
import { ChartBlock } from "./ChartBlock";
import { ChartSwitcher } from "./ChartSwitcher";
import { AskedNote, ChoiceCard, MadeNote } from "./ChoiceCard";
import { ClarifyNote } from "./ClarifyNote";
import { Feedback } from "./Feedback";
import { Chevron } from "./icons";
import { Restatement } from "./Restatement";
import { StageTrace } from "./StageTrace";

interface Props {
  run: RunView;
  busy: boolean;
  expanded: boolean;
  /** Folds or unfolds the turn; absent for the latest run, which always shows in full. */
  onToggle?: () => void;
  /**
   * Answers the run's card; absent on an earlier run, as is onPickChart: only the
   * thread's latest run takes an answer or a chart switch, the server refuses any other.
   */
  onAnswer?: (answers: Record<string, string | null>, text: string | null) => void;
  onPickChart?: (chart: string) => void;
  onFeedback(rating: Rating): void;
  /** Sends a suggested question as a revision; absent, clarify's nearest questions show as text. */
  onRevise?: (text: string) => void;
}

const STATUS_WORDS: Partial<Record<RunStatus, string>> = {
  queued: "Queued",
  running: "Working",
  asking: "Waiting for you",
  clarify: "Needs a revision",
  failed: "Failed",
  cancelled: "Stopped",
  superseded: "Replaced",
};

/** sightline's side of one run: what it understood, what it did, and the chart. */
export function RunTurn({ run, busy, expanded, onToggle, onAnswer, onPickChart, onFeedback, onRevise }: Props) {
  // Folding swaps one toggle button for another; focus follows it rather than falling to the page.
  // So it does when a newer revision folds the run while focus was in it (a suggested question
  // or the card's free text sent that revision): the control pressed goes, the fold row takes over.
  const toggleButton = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  const focused = useRef(false);
  useLayoutEffect(() => {
    const byToggle = toggled.current;
    const dropped = !expanded && focused.current && focusIsNowhere();
    toggled.current = false;
    if (!expanded) focused.current = false;
    if (byToggle) toggleButton.current?.focus();
    // Not scrolled to: the thread is following its newest turn.
    else if (dropped) toggleButton.current?.focus({ preventScroll: true });
  }, [expanded]);
  const toggle = onToggle
    ? () => {
        toggled.current = true;
        onToggle();
      }
    : undefined;

  if (!expanded) return <FoldRow run={run} buttonRef={toggleButton} onToggle={toggle} />;

  const result = run.result;
  const chart = result?.chart ?? null;
  // A run a newer revision replaced offers nothing to answer or change: its card goes with it.
  const card = run.status === "superseded" ? null : run.card;
  // Only a run that has not ended, or a complete one with its card beside the chart, takes
  // answers. One that stopped, failed or ended in clarify keeps its card as a record only,
  // however it is flagged: the server refuses an answer to it. So it does for an earlier
  // run, whose complete choices stand as they were made.
  const answer = isOpen(run.status) || run.status === "complete" ? onAnswer : undefined;
  // A card cannot be answered twice: not while a mutation is out, nor while the run works on it.
  // A blocking card is answerable only while the run waits on it.
  const blockingBusy = busy || run.status !== "asking";
  const madeBusy = busy || isWorking(run.status);
  const restatement = <Restatement run={run} />;

  return (
    <div
      className={`tx-run tx-run--${run.status}`}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(event) => {
        focused.current = keepsFocus(event);
      }}
    >
      {toggle ? (
        <div className="tx-run__headline">
          <button
            ref={toggleButton}
            type="button"
            className="tx-run__collapse"
            aria-expanded="true"
            aria-label="Fold this answer"
            title="Fold this answer"
            onClick={toggle}
          >
            <Chevron />
          </button>
          {restatement}
        </div>
      ) : (
        restatement
      )}
      {run.clarify && <ClarifyNote clarify={run.clarify} busy={busy} onRevise={onRevise} />}
      <StageTrace run={run} />
      {/* Once the run has stopped or failed, a blocking card is only a record of what sightline asked. */}
      {card?.blocking &&
        (answer && isOpen(run.status) ? (
          <ChoiceCard card={card} busy={blockingBusy} onSubmit={answer} />
        ) : (
          <AskedNote card={card} />
        ))}
      {chart && <ChartBlock chart={chart} />}
      {result && result.findings.length > 0 && (
        <ul className="tx-findings">
          {result.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      )}
      {card &&
        !card.blocking &&
        (answer ? (
          <ChoiceCard card={card} busy={madeBusy} onSubmit={answer} />
        ) : run.status === "complete" ? (
          <MadeNote card={card} />
        ) : (
          <AskedNote card={card} />
        ))}
      {run.status === "failed" && <ErrorNote error={run.error} />}
      {run.status === "cancelled" && <p className="tx-stopped">Stopped.</p>}
      {run.status === "superseded" && <p className="tx-stopped">Replaced by the next revision.</p>}
      {run.status === "complete" && (
        <div className="tx-run__foot">
          <Feedback rating={run.feedback} onRate={onFeedback} />
          {chart && onPickChart && (
            <ChartSwitcher chart={chart} disabled={busy || isOpen(run.status)} onPick={onPickChart} />
          )}
        </div>
      )}
    </div>
  );
}

const focusIsNowhere = (): boolean => document.activeElement === null || document.activeElement === document.body;

/**
 * Whether focus leaving a control of the run still counts as in the run: it moved to
 * another of its controls, or it dropped to the page because its control went disabled
 * or away. Moving it anywhere else is the user's doing.
 */
function keepsFocus(event: FocusEvent<HTMLElement>): boolean {
  const to = event.relatedTarget;
  if (to) return event.currentTarget.contains(to);
  const from = event.target;
  return from instanceof Element && (!from.isConnected || from.matches(":disabled"));
}

interface FoldProps {
  run: RunView;
  buttonRef: Ref<HTMLButtonElement>;
  onToggle?: () => void;
}

/** A folded run: one row with what it understood, its chart and, unless complete, its status. */
function FoldRow({ run, buttonRef, onToggle }: FoldProps) {
  const label = run.result?.chart?.label;
  const status = STATUS_WORDS[run.status];
  return (
    <button ref={buttonRef} type="button" className="tx-fold" aria-expanded="false" onClick={onToggle}>
      <Chevron />
      <span className="tx-fold__text">{run.restatement ?? run.prompt}</span>
      {label && <span className="tx-chip">{label}</span>}
      {status && <span className={`tx-fold__status tx-fold__status--${run.status}`}>{status}</span>}
    </button>
  );
}

function ErrorNote({ error }: { error: RunError | null }) {
  return (
    <div className="tx-error">
      <p className="tx-error__title">
        The run failed
        {error?.stage ? (
          <>
            {" "}
            at <span className="mono">{error.stage}</span>
          </>
        ) : null}
        .
      </p>
      {error && <p className="tx-error__message">{error.message}</p>}
    </div>
  );
}
