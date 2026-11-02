import { useId, useLayoutEffect, useRef, type FocusEvent, type ReactNode, type Ref } from "react";
import {
  isOpen,
  isWorking,
  type FollowUp,
  type Rating,
  type RunError,
  type RunSummary,
  type RunView,
} from "../../api/types";
import { Answer, Concerns, Notes } from "./Answer";
import { ChartSwitcher } from "./ChartSwitcher";
import { AskedNote, ChoiceCard, MadeNote } from "./ChoiceCard";
import { ClarifyNote } from "./ClarifyNote";
import { Definitions } from "./Definitions";
import { Feedback } from "./Feedback";
import { FollowUps } from "./FollowUps";
import { Chevron } from "./icons";
import { Restatement } from "./Restatement";
import { StageTrace } from "./StageTrace";
import { STATUS_WORDS } from "./words";

interface Props {
  /** The run in brief, which a folded turn shows. */
  summary: RunSummary;
  /** The run in full; null for an earlier turn until it has been fetched. */
  run: RunView | null;
  busy: boolean;
  expanded: boolean;
  /** Folds or unfolds the turn; absent for the latest run, which always shows in full. */
  onToggle?: () => void;
  /**
   * Answers the run's card; absent on an earlier run, as are onPickChart, onRevise and
   * onFollowUp: only the thread's latest run takes an answer, a chart switch or a
   * follow-up, the server refuses any other.
   */
  onAnswer?: (answers: Record<string, string | null>, text: string | null) => void;
  onPickChart?: (chart: string) => void;
  onFeedback(rating: Rating): void;
  /** Sends a clarify gap's suggested question as a revision; absent, the suggestions show as text. */
  onRevise?: (text: string) => void;
  /** Sends one of the run's follow-ups; absent, they show as text. */
  onFollowUp?: (run: RunView, followUp: FollowUp) => void;
}

/** sightline's side of one run: what it understood, what it did, and the answer. */
export function RunTurn({ summary, run, busy, expanded, onToggle, ...actions }: Props) {
  // Folding swaps one toggle button for another; focus follows it rather than falling to the page.
  // So it does when a newer revision folds the run while focus was in it (a suggested question
  // or the card's free text sent that revision): the control pressed goes, the fold row takes over.
  // While an unfolded run loads, its row keeps the same toggle button, so focus stays on it.
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

  if (!expanded) return <FoldRow summary={summary} buttonRef={toggleButton} onToggle={toggle} />;

  const headline = run ? <Restatement run={run} /> : <p className="tx-restatement">{foldText(summary)}</p>;
  return (
    <div
      className={`tx-run tx-run--${run?.status ?? "loading"}`}
      aria-busy={run ? undefined : true}
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
          {headline}
        </div>
      ) : (
        headline
      )}
      {run ? <RunBody run={run} busy={busy} {...actions} /> : <p className="tx-run__loading">Loading this answer…</p>}
    </div>
  );
}

type BodyProps = Pick<Props, "busy" | "onAnswer" | "onPickChart" | "onFeedback" | "onRevise" | "onFollowUp"> & {
  run: RunView;
};

function RunBody({ run, busy, onAnswer, onPickChart, onFeedback, onRevise, onFollowUp }: BodyProps) {
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
  // Follow-ups go from the latest run once it has ended complete or in clarify. While it
  // presents again (a chart switch, a side-card answer) they stay, held, until it is back.
  const followable =
    onFollowUp && (run.status === "complete" || run.status === "clarify" || isWorking(run.status))
      ? (followUp: FollowUp) => onFollowUp(run, followUp)
      : undefined;
  const followBusy = busy || isWorking(run.status);

  return (
    <>
      <Definitions definitions={run.definitions} />
      {run.clarify && (
        <ClarifyNote
          clarify={run.clarify}
          nearest={run.follow_ups}
          busy={followBusy}
          onRevise={onRevise}
          onFollowUp={followable}
        />
      )}
      <StageTrace run={run} />
      {/* Once the run has stopped or failed, a blocking card is only a record of what sightline asked. */}
      {card?.blocking &&
        (answer && isOpen(run.status) ? (
          <ChoiceCard card={card} busy={blockingBusy} onSubmit={answer} />
        ) : (
          <AskedNote card={card} />
        ))}
      {result && <Answer result={result} />}
      {result && <Notes notes={result.notes} />}
      {result && <Concerns result={result} />}
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
      {/* A clarify run's follow-ups are its nearest questions, inside its note. */}
      {!run.clarify && run.follow_ups.length > 0 && (
        <NextQuestions>
          <FollowUps followUps={run.follow_ups} busy={followBusy} onFollowUp={followable} label="Follow-ups" />
        </NextQuestions>
      )}
    </>
  );
}

function NextQuestions({ children }: { children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="tx-next" aria-labelledby={titleId}>
      <h4 id={titleId} className="tx-next__title">
        Ask next
      </h4>
      {children}
    </section>
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

/** What a folded turn says it was: the answer's top, else what sightline understood, else the prompt. */
const foldText = (summary: RunSummary): string => summary.top ?? summary.restatement ?? summary.prompt;

interface FoldProps {
  summary: RunSummary;
  buttonRef: Ref<HTMLButtonElement>;
  onToggle?: () => void;
}

/** A folded run: one row with its answer or what it understood, its chart and, unless complete, its status. */
function FoldRow({ summary, buttonRef, onToggle }: FoldProps) {
  const label = summary.chart?.label;
  const status = STATUS_WORDS[summary.status];
  return (
    <button ref={buttonRef} type="button" className="tx-fold" aria-expanded="false" onClick={onToggle}>
      <Chevron />
      <span className="tx-fold__text">{foldText(summary)}</span>
      {label && <span className="tx-chip">{label}</span>}
      {status && <span className={`tx-fold__status tx-fold__status--${summary.status}`}>{status}</span>}
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
      {error?.retryable && <p className="tx-error__retry">Asking again may work.</p>}
      {error?.detail && (
        <details className="tx-error__detail">
          <summary>Details</summary>
          <pre>{error.detail}</pre>
        </details>
      )}
    </div>
  );
}
