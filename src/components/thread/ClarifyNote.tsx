import { Fragment, useId } from "react";
import type { Clarify, Gap } from "../../api/types";

interface Props {
  clarify: Clarify;
  busy: boolean;
  /** Sends one of the nearest questions as a revision; absent, they show as text only. */
  onRevise?: (text: string) => void;
}

/**
 * Why a run ended in clarify: the terms it could not match, or that the data
 * cannot answer the question yet, with what it lacks, what someone would have
 * to record, and the nearest questions it can answer. Not a question back and
 * never a proxy answer: the user answers by revising the question.
 */
export function ClarifyNote({ clarify: sent, busy, onRevise }: Props) {
  const clarify = complete(sent);
  const gaps = clarify.gaps.length > 0;
  const notYet = clarify.missing.length > 0 || clarify.record.length > 0 || clarify.nearest.length > 0;
  return (
    <div className="tx-clarify">
      {gaps && <Gaps gaps={clarify.gaps} />}
      {notYet && <NotYet clarify={clarify} busy={busy} onRevise={onRevise} />}
      {/* A report that names neither claims neither: it says only that a revision is due. */}
      {!gaps && !notYet && <p>This question needs a revision before sightline can answer it.</p>}
      {clarify.warnings.length > 0 && (
        <details className="tx-clarify__notes">
          <summary>Notes</summary>
          <ul className="tx-clarify__list">
            {clarify.warnings.map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
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
  return {
    gaps: clarify.gaps ?? [],
    missing: clarify.missing ?? [],
    record: clarify.record ?? [],
    nearest: clarify.nearest ?? [],
    warnings: clarify.warnings ?? [],
  };
}

/** The terms that matched nothing in the data; only ever given some. */
function Gaps({ gaps }: { gaps: Gap[] }) {
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
                {gap.suggestions.map((suggestion) => (
                  <code key={suggestion} className="tx-chip tx-chip--mono">
                    {breakable(suggestion)}
                  </code>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p>
        {suggested
          ? "Revise the question to name one of these, or something else."
          : "Revise the question to say it another way."}
      </p>
    </>
  );
}

/** The data-gap ending: the question is fine, the warehouse cannot answer it yet. */
function NotYet({ clarify, busy, onRevise }: Props) {
  const lacksId = useId();
  const recordId = useId();
  const nearestId = useId();
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
      {clarify.nearest.length > 0 && (
        <div className="tx-clarify__part">
          <p id={nearestId}>Questions I can answer instead:</p>
          {onRevise ? (
            <ul className="tx-clarify__nearest" aria-labelledby={nearestId}>
              {clarify.nearest.map((question, index) => (
                <li key={`${index}:${question}`}>
                  <button
                    type="button"
                    className="tx-clarify__ask"
                    title="Ask this instead"
                    disabled={busy}
                    onClick={() => onRevise(question)}
                  >
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="tx-clarify__list" aria-labelledby={nearestId}>
              {clarify.nearest.map((question, index) => (
                <li key={`${index}:${question}`}>{question}</li>
              ))}
            </ul>
          )}
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
