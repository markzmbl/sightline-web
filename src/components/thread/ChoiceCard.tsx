import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Card, DecisionPoint } from "../../api/types";
import { WorkingCube } from "../working/WorkingCube";
import { formatConfidence } from "./format";

type Answers = Record<string, string | null>;

interface Props {
  card: Card;
  busy: boolean;
  /** Null for a point means "decide for me"; text instead of answers revises the question. */
  onSubmit(answers: Answers, text: string | null): void;
}

/**
 * The one place sightline asks: when the KPI is underspecified the run waits on
 * a blocking card, which asks the points nobody was sure of. Otherwise the card
 * lists the choices sightline made, under the chart, the unsure ones first, and
 * any of them can be changed.
 */
export function ChoiceCard({ card, busy, onSubmit }: Props) {
  // A new set of points starts the card afresh.
  const key = card.points.map((point) => point.id).join("|");
  return card.blocking ? (
    <AskCard key={key} points={asked(card.points)} busy={busy} onSubmit={onSubmit} />
  ) : (
    <ChoicesMade key={key} points={openFirst(card.points)} busy={busy} onSubmit={onSubmit} />
  );
}

interface PointsProps {
  points: DecisionPoint[];
  busy: boolean;
  onSubmit(answers: Answers, text: string | null): void;
}

const suggested = (point: DecisionPoint): string | null => point.chosen ?? point.default;

/** The points nobody was sure of first; the order is otherwise kept. */
const openFirst = (points: DecisionPoint[]): DecisionPoint[] => [
  ...points.filter((point) => point.open),
  ...points.filter((point) => !point.open),
];

/** What a blocking card asks: its open points, or every point when none is open. */
function asked(points: DecisionPoint[]): DecisionPoint[] {
  const open = points.filter((point) => point.open);
  return open.length > 0 ? open : points;
}

/**
 * Who settled the point: the user, or sightline (its rules or a model). The confidence is
 * the System 1 model's, so it goes with S1's own pick only, never with the pick S2 or the
 * rules made after S1 was unsure.
 */
function pickTag(point: DecisionPoint): string {
  if (point.by === "user") return "your choice";
  return point.by === "s1" && point.confidence !== null
    ? `sightline's pick · ${formatConfidence(point.confidence)}`
    : "sightline's pick";
}

function isTyping(target: EventTarget): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** Claude Code's AskUserQuestion, for sightline: one question per point, options as buttons. */
function AskCard({ points, busy, onSubmit }: PointsProps) {
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string | null>(null);
  const single = points.length === 1;
  const complete = points.every((point) => picked[point.id] !== undefined);

  // Take focus when nothing else holds it, so the digit keys work at once; not while it cannot be answered.
  useEffect(() => {
    if (busy) return;
    const active = document.activeElement;
    if (!active || active === document.body) root.current?.focus({ preventScroll: true });
  }, [busy]);

  const choose = (point: DecisionPoint, option: string) => {
    if (busy) return;
    if (single) onSubmit({ [point.id]: option }, null);
    else setPicked((current) => ({ ...current, [point.id]: option }));
  };

  const proceed = () => {
    if (busy || !complete) return;
    onSubmit(Object.fromEntries(points.map((point) => [point.id, picked[point.id] ?? null])), null);
  };

  const decide = () => {
    if (!busy) onSubmit(Object.fromEntries(points.map((point) => [point.id, null])), null);
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = other?.trim();
    if (!busy && text) onSubmit({}, text);
  };

  // Digits 1-9 pick the nth option of the first point not picked yet.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!/^[1-9]$/.test(event.key) || isTyping(event.target)) return;
    const point = points.find((candidate) => picked[candidate.id] === undefined);
    const option = point?.options[Number(event.key) - 1];
    if (!point || !option) return;
    event.preventDefault();
    choose(point, option.id);
  };

  return (
    <section
      ref={root}
      className="tx-choice tx-choice--blocking"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="tx-choice__head">
        <span className="tx-choice__cube" aria-hidden="true">
          <WorkingCube state="asking" size={14} />
        </span>
        <span id={titleId}>sightline needs a choice</span>
      </header>
      {points.map((point) => (
        <Point key={point.id} point={point} single={single} picked={picked[point.id]} busy={busy} onChoose={choose} />
      ))}
      <div className="tx-choice__foot">
        {!single && (
          <button type="button" className="tx-button tx-button--primary" disabled={busy || !complete} onClick={proceed}>
            Continue
          </button>
        )}
        <button type="button" className="tx-button" disabled={busy} onClick={decide}>
          Decide for me
        </button>
        {other === null && (
          <button type="button" className="tx-link" disabled={busy} aria-expanded="false" onClick={() => setOther("")}>
            Other…
          </button>
        )}
      </div>
      {other !== null && (
        <form className="tx-choice__other" onSubmit={send}>
          <input
            className="tx-input"
            aria-label="Say what you mean instead"
            placeholder="Say what you mean instead"
            value={other}
            disabled={busy}
            autoFocus
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOther(null);
                root.current?.focus();
              }
            }}
          />
          <button type="submit" className="tx-button tx-button--primary" disabled={busy || !other.trim()}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}

interface PointProps {
  point: DecisionPoint;
  single: boolean;
  picked: string | undefined;
  busy: boolean;
  onChoose(point: DecisionPoint, option: string): void;
}

function Point({ point, single, picked, busy, onChoose }: PointProps) {
  const questionId = useId();
  const pick = suggested(point);
  return (
    <div className="tx-choice__point" role="group" aria-labelledby={questionId}>
      <h3 id={questionId} className="tx-choice__question">
        {point.question}
      </h3>
      <ol className="tx-choice__options">
        {point.options.map((option, index) => (
          <li key={option.id}>
            <button
              type="button"
              className="tx-choice__option"
              aria-pressed={single ? undefined : picked === option.id}
              disabled={busy}
              onClick={() => onChoose(point, option.id)}
            >
              <span className="tx-choice__key" aria-hidden="true">
                {index + 1}
              </span>
              <span className="tx-choice__text">
                <span className="tx-choice__label">
                  {option.label}
                  {pick === option.id && <span className="tx-choice__pick">{pickTag(point)}</span>}
                </span>
                {option.hint ? <span className="tx-choice__hint">{option.hint}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {point.why ? <p className="tx-choice__why">{point.why}</p> : null}
    </div>
  );
}

/**
 * A card whose run ended without taking an answer (stopped, failed, or sent back
 * for a revision): a record, not a question, since the run can no longer take one.
 * It keeps what sightline asked, the open points or, on a blocking card with none,
 * every point; a card that asked nothing keeps the choices sightline made.
 */
export function AskedNote({ card }: { card: Card }) {
  const titleId = useId();
  const points = asked(card.points);
  if (points.length === 0) return null;
  const askedSomething = card.blocking || points.some((point) => point.open);
  return (
    <section className="tx-choice tx-choice--asked" aria-labelledby={titleId}>
      <h3 id={titleId} className="tx-choice__title">
        {askedSomething ? "sightline asked" : "Choices sightline made"}
      </h3>
      <ul className="tx-made">
        {points.map((point) => {
          // An open point the user never answered stays unanswered, whatever sightline leaned to.
          const settled = point.by === "user" || !point.open;
          const option = settled ? point.options.find((candidate) => candidate.id === point.chosen) : undefined;
          return (
            <li key={point.id} className="tx-made__point">
              <div className="tx-made__line">
                <span className="tx-made__question">{point.question}</span>
                {option ? (
                  <>
                    <span className="tx-made__answer">{option.label}</span>
                    <span className="tx-made__by">{pickTag(point)}</span>
                  </>
                ) : (
                  <span className="tx-made__by">not answered</span>
                )}
              </div>
              {point.why ? <p className="tx-made__why">{point.why}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The choices behind an earlier run's chart, as they were made: a record with nothing to
 * change, since only the thread's latest run takes answers (the server refuses the others).
 */
export function MadeNote({ card }: { card: Card }) {
  return <ChoicesMade points={openFirst(card.points)} busy />;
}

interface MadeProps {
  points: DecisionPoint[];
  busy: boolean;
  /** Changes one choice; absent, the choices are a record only. */
  onSubmit?(answers: Answers, text: string | null): void;
}

/** The choices behind a finished chart, each one open to change. */
function ChoicesMade({ points, busy, onSubmit }: MadeProps) {
  const titleId = useId();
  const [changing, setChanging] = useState<string | null>(null);
  if (points.length === 0) return null;
  return (
    <section className="tx-choice tx-choice--made" aria-labelledby={titleId}>
      <h3 id={titleId} className="tx-choice__title">
        Choices sightline made
      </h3>
      <ul className="tx-made">
        {points.map((point) => {
          const current = suggested(point);
          const option = point.options.find((candidate) => candidate.id === current);
          const expanded = changing === point.id;
          return (
            <li key={point.id} className="tx-made__point">
              <div className="tx-made__line">
                <span className="tx-made__question">{point.question}</span>
                <span className="tx-made__answer">{option?.label ?? current ?? "–"}</span>
                <span className="tx-made__by">{pickTag(point)}</span>
                {onSubmit && (
                  <button
                    type="button"
                    className="tx-link"
                    aria-expanded={expanded}
                    disabled={busy}
                    onClick={() => setChanging(expanded ? null : point.id)}
                  >
                    Change
                  </button>
                )}
              </div>
              {point.why ? <p className="tx-made__why">{point.why}</p> : null}
              {expanded && onSubmit && (
                <div className="tx-made__options" role="group" aria-label={point.question}>
                  {point.options.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className="pill"
                      aria-pressed={candidate.id === current}
                      title={candidate.hint || undefined}
                      disabled={busy}
                      onClick={() => {
                        setChanging(null);
                        if (candidate.id !== current) onSubmit({ [point.id]: candidate.id }, null);
                      }}
                    >
                      {candidate.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
