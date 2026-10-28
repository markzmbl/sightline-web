import { useState } from "react";
import type { FollowUp, Rating, RunView, Turn } from "../../api/types";
import { RunTurn } from "./RunTurn";
import { UserTurn } from "./UserTurn";
import "./thread.css";

export interface TranscriptActions {
  /** Answer a run's choice card; null means "decide for me", text becomes a revision. */
  onAnswer(runId: string, answers: Record<string, string | null>, text: string | null): void;
  onPickChart(runId: string, chart: string): void;
  onFeedback(runId: string, rating: Rating): void;
  /** Take back revision n (1-based); absent when taking back is not offered. */
  onTakeBack?(revision: number): void;
  /**
   * Send one of a run's follow_ups. The page decides how: a clarify run's nearest
   * questions go as a revision with via "nearest"; a complete run's follow-ups go
   * with follows {run_id, follow_up_id}.
   */
  onFollowUp?(run: RunView, followUp: FollowUp): void;
  /** Send a full revised question as a plain revision, e.g. a clarify gap's suggestion. */
  onRevise?(text: string): void;
}

export interface TranscriptProps {
  /** Oldest first; one user turn and one run turn per run. The latest turn's run is always set. */
  turns: Turn[];
  /** True while a mutation is in flight; disables the card and switcher buttons. */
  busy: boolean;
  actions: TranscriptActions;
  /** An earlier turn was unfolded: load its full run (its Turn.run is null until then). */
  onExpand(runId: string): void;
}

/**
 * The thread as turns, oldest first: what the user sent, then what sightline made of
 * it. Earlier turns fold to one row each, made from their summary; unfolding one asks
 * for its run in full (onExpand), and the turn shows a quiet loading row until it is
 * there. The latest shows in full. Follow-ups and suggested questions are offered on
 * the latest run only, where they answer the question as it now stands. So are a
 * card's answers and the chart switcher: the server takes them for the thread's
 * latest run only (409 not_latest otherwise).
 */
export function Transcript({ turns, busy, actions, onExpand }: TranscriptProps): React.JSX.Element {
  // Only the folds the user changed; every other earlier turn stays folded.
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const last = turns.length - 1;
  const { onTakeBack, onFollowUp, onRevise } = actions;

  return (
    <div className="tx">
      {turns.map(({ summary, run }, index) => {
        const latest = index === last;
        const expanded = latest || (unfolded[summary.id] ?? false);
        const toggle = () => {
          if (!expanded) onExpand(summary.id);
          setUnfolded((current) => ({ ...current, [summary.id]: !expanded }));
        };
        return (
          <section
            key={summary.id}
            className="tx-pair"
            aria-label={summary.revision === 0 ? "The question" : `Revision ${summary.revision}`}
          >
            <UserTurn
              summary={summary}
              busy={busy}
              onTakeBack={
                latest && summary.revision > 0 && onTakeBack ? () => onTakeBack(summary.revision) : undefined
              }
            />
            <RunTurn
              summary={summary}
              run={run}
              busy={busy}
              expanded={expanded}
              onToggle={latest ? undefined : toggle}
              onAnswer={latest ? (answers, text) => actions.onAnswer(summary.id, answers, text) : undefined}
              onPickChart={latest ? (chart) => actions.onPickChart(summary.id, chart) : undefined}
              onFeedback={(rating) => actions.onFeedback(summary.id, rating)}
              onRevise={latest ? onRevise : undefined}
              onFollowUp={latest ? onFollowUp : undefined}
            />
          </section>
        );
      })}
    </div>
  );
}
