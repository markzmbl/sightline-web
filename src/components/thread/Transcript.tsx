import { useState } from "react";
import type { Rating, RunView } from "../../api/types";
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
  /** Send a suggested question as a revision, e.g. one of clarify's nearest answerable questions. */
  onRevise?(text: string): void;
}

export interface TranscriptProps {
  /** Oldest first; one user turn and one run turn per run. */
  runs: RunView[];
  /** True while a mutation is in flight; disables the card and switcher buttons. */
  busy: boolean;
  actions: TranscriptActions;
}

/**
 * The thread as turns, oldest first: what the user typed, then what sightline
 * made of it. Earlier runs fold to one row each; the latest shows in full.
 * Suggested revisions are offered on the latest run only, where they answer the
 * question as it now stands. So are a card's answers and the chart switcher: the
 * server takes them for the thread's latest run only (409 not_latest otherwise).
 */
export function Transcript({ runs, busy, actions }: TranscriptProps): React.JSX.Element {
  // Only the folds the user changed; every other earlier run stays folded.
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const last = runs.length - 1;
  const takeBack = actions.onTakeBack;

  return (
    <div className="tx">
      {runs.map((run, index) => {
        const latest = index === last;
        const expanded = latest || (unfolded[run.id] ?? false);
        return (
          <section
            key={run.id}
            className="tx-pair"
            aria-label={run.revision === 0 ? "The question" : `Revision ${run.revision}`}
          >
            <UserTurn
              run={run}
              busy={busy}
              onTakeBack={latest && run.revision > 0 && takeBack ? () => takeBack(run.revision) : undefined}
            />
            <RunTurn
              run={run}
              busy={busy}
              expanded={expanded}
              onToggle={latest ? undefined : () => setUnfolded((current) => ({ ...current, [run.id]: !expanded }))}
              onAnswer={latest ? (answers, text) => actions.onAnswer(run.id, answers, text) : undefined}
              onPickChart={latest ? (chart) => actions.onPickChart(run.id, chart) : undefined}
              onFeedback={(rating) => actions.onFeedback(run.id, rating)}
              onRevise={latest ? actions.onRevise : undefined}
            />
          </section>
        );
      })}
    </div>
  );
}
