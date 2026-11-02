import { Fragment, useId } from "react";
import type { Clarify, FollowUp, Gap } from "../../api/types";
import { formatCount } from "./format";
import { FollowUps } from "./FollowUps";

interface Props {
  clarify: Clarify;
  /** The nearest questions the warehouse can answer instead: the run's follow-ups (kind nearest). */
  nearest: FollowUp[];
  busy: boolean;
  /** Sends a gap's suggested question as a revision; absent, the suggestions show as text only. */
  onRevise?: (text: string) => void;
  /** Sends one of the nearest questions; absent, they show as text only. */
  onFollowUp?: (followUp: FollowUp) => void;
}

/**
 * Why a run ended in clarify: the terms it could not match, or that the data
 * cannot answer the question yet, with what it lacks, what someone would have
 * to record, and the nearest questions it can answer. Not a question back and
 * never a proxy answer: the user answers by revising the question.
 */
export function ClarifyNote({ clarify: sent, nearest, busy, onRevise, onFollowUp }: Props) {
  const clarify = complete(sent);
  const nearestId = useId();
  const gaps = clarify.gaps.length > 0;
  const notYet = clarify.missing.length > 0 || clarify.record.length > 0;
  const more = clarify.warnings_total - clarify.warnings.length;
  return (
    <div className="tx-clarify">
      {gaps && <Gaps gaps={clarify.gaps} busy={busy} onRevise={onRevise} />}
      {notYet && <NotYet clarify={clarify} />}
      {nearest.length > 0 && (
        <div className="tx-clarify__part">
          <p id={nearestId}>Questions I can answer instead:</p>
          <FollowUps followUps={nearest} busy={busy} onFollowUp={onFollowUp} tagged={false} labelledBy={nearestId} />
        </div>
      )}
      {/* A report that names neither claims neither: it says only that a revision is due. */}
      {!gaps && !notYet && nearest.length === 0 && <p>This question needs a revision before sightline can answer it.</p>}
      {clarify.warnings.length > 0 && (
        <details className="tx-clarify__notes">
          <summary>Notes</summary>
          <ul className="tx-clarify__list">
            {clarify.warnings.map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
            {more > 0 && <li className="tx-clarify__more">and {formatCount(more)} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Every list the contract requires, even from a report written before it had them
 * (a replayed run from round 1 carries gaps only): a missing list reads as empty.
 */
function complete(clarify: Partial<Clarify>): Clarify {
  const warnings = clarify.warnings ?? [];
  return {
    gaps: clarify.gaps ?? [],
    missing: clarify.missing ?? [],
    record: clarify.record ?? [],
    warnings,
    warnings_total: Math.max(clarify.warnings_total ?? 0, warnings.length),
  };
}

interface GapsProps {
  gaps: Gap[];
  busy: boolean;
  onRevise?: (text: string) => void;
}

/** The terms that matched nothing in the data; only ever given some. */
function Gaps({ gaps, busy, onRevise }: GapsProps) {
  const suggested = gaps.some((gap) => gap.suggestions.length > 0);
  return (
    <>
      <p>I could not match every term in your question to the data.</p>
      <ul className="tx-clarify__gaps">
        {gaps.map((gap, index) => (
          <li key={`${index}:${gap.slot}`}>
            <strong>{gap.requested}</strong> <span className="tx-clarify__reason">{gap.reason}</span>
            {gap.suggestions.length > 0 && (
              <span className="tx-clarify__suggestions">
                {gap.suggestions.map((suggestion) =>
                  onRevise ? (
                    <button
                      key={suggestion.id}
                      type="button"
                      className="tx-chip tx-chip--ask"
                      title={suggestion.question}
                      disabled={busy}
                      onClick={() => onRevise(suggestion.question)}
                    >
                      {breakable(suggestion.label)}
                    </button>
                  ) : (
                    <span key={suggestion.id} className="tx-chip" title={suggestion.question}>
                      {breakable(suggestion.label)}
                    </span>
                  ),
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p>
        {!suggested
          ? "Revise the question to say it another way."
          : onRevise
            ? "Pick one of these to ask again with it, or revise the question to say it another way."
            : "Revise the question to name one of these, or something else."}
      </p>
    </>
  );
}

/** The data-gap ending: the question is fine, the warehouse cannot answer it yet. */
function NotYet({ clarify }: { clarify: Clarify }) {
  const lacksId = useId();
  const recordId = useId();
  return (
    <>
      <h3 className="tx-clarify__title">This is not possible with the data yet.</h3>
      {clarify.missing.length > 0 && (
        <div className="tx-clarify__part">
          <p id={lacksId}>The data lacks:</p>
          <ul className="tx-clarify__list" aria-labelledby={lacksId}>
            {clarify.missing.map((item, index) => (
              <li key={`${index}:${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {clarify.record.length > 0 && (
        <div className="tx-clarify__part">
          <p id={recordId}>To answer it, someone would have to record:</p>
          <ul className="tx-clarify__list" aria-labelledby={recordId}>
            {clarify.record.map((item, index) => (
              <li key={`${index}:${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** A dotted name that may wrap after each dot, table.column, before it must break mid-word. */
function breakable(name: string) {
  return name.split(".").map((part, index) => (
    <Fragment key={index}>
      {index > 0 && "."}
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}
