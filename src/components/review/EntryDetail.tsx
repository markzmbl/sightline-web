import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ApiError } from "../../api/client";
import { useRegistryEntry, useReview } from "../../api/registry";
import type { EntryChange, EntryRun, KindInfo, RegistryEntryDetail, Review, ReviewAction } from "../../api/types";
import { threadPath } from "../sidebar/paths";
import { ChoiceBars } from "./ChoiceBars";
import { collisionsOf, isDirty, placeOf, rebase, startDraft, wordsToSave, type Draft } from "./draft";
import { ago, capital, counted, fieldNames, kindWords, longDate, sentence, STATUS_LABEL } from "./format";
import { ThumbIcon } from "./icons";
import { useNow } from "./useNow";
import { WordsEditor } from "./WordsEditor";
import "./review.css";

interface Props {
  ws: string;
  entryId: string;
  /** The way back to the list, for a narrow page where the entry takes the list's place. */
  back: ReactNode;
  /** The list's URL with its filters, for the way back from an entry that is gone. */
  list: string;
  /** The server's kinds and their words; undefined until they are in. */
  kinds: readonly KindInfo[] | undefined;
}

const GONE = "This entry does not exist (any more).";

/** A 404 about the entry, not the workspace: no_entry, or a 404 that does not say. */
const isGone = (error: ApiError | null): boolean => error?.status === 404 && error.code !== "no_workspace";

/** One entry beside the list: what it is, how often it was asked, its words, and the review. */
export function EntryDetail({ ws, entryId, back, list, kinds }: Props) {
  const entry = useRegistryEntry(ws, entryId);

  // Gone is gone, even with an earlier version still at hand.
  if (entry.isError && isGone(entry.error)) return <Gone back={back} list={list} />;

  if (entry.data) return <EntryReview ws={ws} entry={entry.data} back={back} list={list} kinds={kinds} />;

  if (entry.isError) {
    return (
      <div className="rv-detail">
        {back}
        <div className="rv-detail__missing" role="alert">
          <p>Could not load the entry.</p>
          <p className="muted">{entry.error.message}</p>
          <button type="button" className="pill" onClick={() => void entry.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-detail" aria-busy="true">
      {back}
      <span className="sr-only">Loading the entry</span>
      {[40, 64, 88, 72, 56].map((width, i) => (
        <span key={i} className="rv-detail__bone" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

/** Focus is nowhere a keyboard user can go on from: on the page itself, or on something hidden or taken away. */
function focusLost(): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    (active instanceof HTMLElement && typeof active.checkVisibility === "function" && !active.checkVisibility())
  );
}

/** An entry that does not exist (any more), on opening it or on a review of it: nothing to do but go back. */
function Gone({ back, list }: { back: ReactNode; list: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  // The review's button went with the form, or the list gave way to the entry: the way back takes focus.
  useEffect(() => {
    if (focusLost()) link.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="rv-detail">
      {back}
      <div className="rv-detail__missing" role="alert">
        <p>{GONE}</p>
        <Link ref={link} to={list} className="pill">
          Back to all entries
        </Link>
      </div>
    </div>
  );
}

/** What a done review says, read out and shown beside the actions. */
const DONE: Record<ReviewAction, string> = {
  approve: "Approved.",
  reject: "Rejected.",
  reopen: "Reopened: it is proposed again.",
  edit: "Saved.",
};

/** The same, when the edits were saved first. */
const SAVED_AND: Record<ReviewAction, string> = {
  approve: "Saved and approved.",
  reject: "Saved and rejected.",
  reopen: "Saved and reopened: it is proposed again.",
  edit: "Saved.",
};

interface ReviewProps {
  ws: string;
  entry: RegistryEntryDetail;
  back: ReactNode;
  list: string;
  kinds: readonly KindInfo[] | undefined;
}

function EntryReview({ ws, entry, back, list, kinds }: ReviewProps) {
  const review = useReview(ws, entry.id);
  const now = useNow();
  const [draft, setDraft] = useState<Draft>(() => startDraft(entry));
  // The fields whose edits a newer version overruled ("label", or a locale), until the key user acts or discards.
  const [dropped, setDropped] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [said, setSaid] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  // The action last sent, until focus has been put back after it.
  const refocus = useRef<ReviewAction | null>(null);
  const labelId = useId();
  const noteId = useId();

  // A newer version came in (someone else's review, a refetch): the edits carry over where they still apply.
  // Not while a review from here is pending: the version it brings in is the key user's own (the draft starts
  // afresh from it when the review succeeds) or, when someone was first, the one the conflict is about (carried
  // over once the review has failed). An older version landing late, from a fetch that crossed a review, is no news.
  let current = draft;
  if (!review.isPending && entry.version > draft.version) {
    const next = rebase(draft, entry);
    current = next.draft;
    setDraft(next.draft);
    if (next.dropped.length > 0) setDropped((previous) => [...new Set([...previous, ...next.dropped])]);
  }

  // Opened with focus nowhere (on a narrow page the list it was in gave way to the entry), the heading takes it.
  useEffect(() => {
    if (focusLost()) heading.current?.focus({ preventScroll: true });
  }, []);

  // The button pressed is disabled while its review is pending, which drops focus, and it may be
  // gone after (Approve becomes Reopen): focus goes back to it, or else to the first action left.
  useEffect(() => {
    const action = refocus.current;
    if (action === null || review.isPending) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const actions = bar.current;
    const again = actions?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]:not(:disabled)`);
    (again ?? actions?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
  }, [review.isPending, entry.status, entry.version]);

  const pending = review.isPending;
  const dirty = isDirty(current);
  const label = current.fields.label.trim();
  const error = review.error;
  // The entry was not as the key user saw it; the hook has loaded it as it stands.
  const moved = error?.status === 409 ? movedBy(error.code) : null;
  const collisions =
    error?.status === 422 ? collisionsOf(error.errors, review.variables?.changes?.words ?? {}) : [];
  const failure = error && !moved && collisions.length === 0 ? error.message : null;
  // A colliding word removed (or changed) since has nothing left to fix.
  const clashing = collisions.filter(
    (collision) => placeOf(collision, current.fields.words[collision.locale] ?? []) >= 0,
  );
  const notice = noticeOf(moved, dropped, dirty);

  const edit = (change: (fields: Draft["fields"]) => Draft["fields"]) => {
    setSaid("");
    setDraft((previous) => ({ ...previous, fields: change(previous.fields) }));
  };

  // A review with unsaved edits saves them first (an edit is the only review that changes them), then does
  // what was asked on the version the save made; the note goes with what was asked.
  const send = (action: ReviewAction) => {
    const text = note.trim();
    setDropped([]);
    setSaid("");
    refocus.current = action;
    // What a review sent is what the entry is now: the draft starts afresh from the answer, the
    // server's own wording of the label and the words included, so nothing reads as overruled.
    const done = (detail: RegistryEntryDetail, message: string) => {
      setDraft(startDraft(detail));
      setSaid(message);
    };
    const act = (version: number, saved: boolean) => {
      const body: Review = { action, version };
      if (text) body.note = text;
      review.mutate(body, {
        onSuccess: (detail) => {
          setNote("");
          done(detail, saved ? SAVED_AND[action] : DONE[action]);
        },
      });
    };
    if (action !== "edit" && !dirty) {
      act(current.version, false);
      return;
    }
    const body: Review = { action: "edit", version: current.version, changes: { label, words: wordsToSave(current) } };
    if (action === "edit" && text) body.note = text;
    review.mutate(body, {
      onSuccess: (detail) => {
        if (action === "edit") setNote("");
        done(detail, DONE.edit);
        if (action !== "edit") act(detail.version, true);
      },
    });
  };

  const discard = () => {
    setDraft((previous) => ({ ...previous, fields: previous.base }));
    setDropped([]);
    setSaid("");
    review.reset();
  };

  // With edits to save first, a review needs a label to save.
  const blocked = pending || (dirty && label === "");

  // The review found the entry gone: as on opening it, there is nothing left to review or save.
  if (isGone(error)) return <Gone back={back} list={list} />;

  // Every review's note sits in the history with the review it came with; the entry's own shows
  // here only when the history does not carry it.
  const entryNote = entry.note?.trim();
  const headNote = entryNote && !entry.history.some((change) => change.note?.trim() === entryNote) ? entryNote : null;

  return (
    <article className="rv-detail" aria-labelledby={`${labelId}-term`}>
      {back}
      <header className="rv-detail__head">
        <div className="rv-detail__titles">
          <h2 id={`${labelId}-term`} ref={heading} tabIndex={-1} className="rv-detail__term">
            {entry.term}
          </h2>
          <span className="rv-chip">{capital(kindWords(kinds, entry.kind).label)}</span>
          <span className={`rv-status rv-status--${entry.status}`}>
            <span className={`rv-dot rv-dot--${entry.status}`} aria-hidden="true" />
            {STATUS_LABEL[entry.status]}
          </span>
        </div>
        <p className="rv-detail__label">{entry.label}</p>
        <p className="rv-detail__meta">
          <span className="mono" title={`Version ${entry.version}`}>
            v{entry.version}
          </span>
          {entry.reviewed_by && (
            <>
              {" · "}reviewed by {entry.reviewed_by}
              {ago(entry.reviewed_at, now) && ` · ${ago(entry.reviewed_at, now)}`}
            </>
          )}
        </p>
        {headNote && <p className="rv-detail__said-note">“{headNote}”</p>}
      </header>

      <section className="rv-detail__about" aria-label="What it is">
        {entry.source.text && <p>{sentence(entry.source.text)}</p>}
        <Definition entry={entry} />
        <p className="muted">{demandLong(entry, now)}</p>
      </section>

      {entry.kind === "gap" && entry.gap && (entry.gap.missing.length > 0 || entry.gap.record.length > 0) && (
        <section className="rv-section" aria-label="The data gap">
          <Listed title="The data lacks:" items={entry.gap.missing} />
          <Listed title="Would need recorded:" items={entry.gap.record} />
        </section>
      )}

      {entry.kind === "default" && entry.choices && entry.choices.length > 0 && (
        <Section title="What users picked">
          <ChoiceBars choices={entry.choices} chosen={entry.chosen_option} />
        </Section>
      )}

      <Section title="Label and words">
        <p className="rv-section__hint">The words people use for it, per language; sightline knows the term by them.</p>
        <label className="rv-field">
          <span className="rv-field__name">Label</span>
          <input
            className="rv-input"
            value={current.fields.label}
            disabled={pending}
            aria-invalid={label === "" || undefined}
            onChange={(event) => {
              const value = event.target.value;
              edit((fields) => ({ ...fields, label: value }));
            }}
          />
        </label>
        {label === "" && <p className="rv-field__error">The label cannot be empty.</p>}
        <WordsEditor
          words={current.fields.words}
          collisions={collisions}
          disabled={pending}
          onChange={(locale, list) => edit((fields) => ({ ...fields, words: { ...fields.words, [locale]: list } }))}
        />
        {clashing.length > 0 && (
          <p className="rv-field__error" role="alert">
            {clashing.length === 1
              ? "A word already names another term. Change or remove it, then save again."
              : "Some words already name other terms. Change or remove them, then save again."}
          </p>
        )}
      </Section>

      <Section title="Your review">
        <label className="rv-field" htmlFor={noteId}>
          <span className="rv-field__name">
            Note <span className="muted">(optional, kept with what you do)</span>
          </span>
        </label>
        <textarea
          id={noteId}
          className="rv-input rv-input--note"
          rows={2}
          value={note}
          placeholder="Why, for whoever looks at it next"
          disabled={pending}
          onChange={(event) => setNote(event.target.value)}
        />
        {/* Live regions are in place before what they say: one put in with its text is often not read out. */}
        <div className="rv-live" role="status">
          {notice && <p className="rv-notice">{notice}</p>}
        </div>
        {failure && (
          <p className="rv-banner" role="alert">
            {failure}
          </p>
        )}
        <div ref={bar} className="rv-detail__bar" aria-busy={pending || undefined}>
          {entry.status === "proposed" ? (
            <>
              <button
                type="button"
                className="rv-button rv-button--primary"
                data-action="approve"
                disabled={blocked}
                onClick={() => send("approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="rv-button"
                data-action="reject"
                disabled={blocked}
                onClick={() => send("reject")}
              >
                Reject
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rv-button"
              data-action="reopen"
              disabled={blocked}
              onClick={() => send("reopen")}
            >
              Reopen
            </button>
          )}
          {dirty && (
            <span className="rv-detail__edits">
              <button type="button" className="rv-button rv-button--quiet" disabled={pending} onClick={discard}>
                Discard
              </button>
              <button
                type="button"
                className="rv-button rv-button--primary"
                data-action="edit"
                disabled={pending || label === ""}
                onClick={() => send("edit")}
              >
                Save changes
              </button>
            </span>
          )}
        </div>
        {dirty && (
          <p className="rv-section__hint">
            {entry.status === "proposed" ? "Approving or rejecting" : "Reopening"} saves your edits first.
          </p>
        )}
        <p className="rv-detail__said rv-live" role="status">
          {said || null}
        </p>
      </Section>

      <Section title="Used in">
        <UsedIn ws={ws} entry={entry} now={now} />
      </Section>

      {entry.history.length > 0 && (
        <Section title="History">
          <History changes={entry.history} now={now} />
        </Section>
      )}
    </article>
  );
}

/** Why a review found the entry other than the key user saw it: someone reviewed it first, or it moved on. */
type Moved = "version_conflict" | "not_allowed";

const movedBy = (code: ApiError["code"]): Moved | null =>
  code === "version_conflict" || code === "not_allowed" ? code : null;

const MOVED: Record<Moved, string> = {
  version_conflict: "Someone reviewed this entry first. You are now looking at the latest version.",
  not_allowed: "This entry was moved since you opened it; here it is as it stands.",
};

/** What the key user is told when a newer version came in: who moved it, and what became of their edits. */
function noticeOf(moved: Moved | null, dropped: readonly string[], dirty: boolean): string | null {
  if (moved === null && dropped.length === 0) return null;
  const parts = [moved ? MOVED[moved] : "This entry changed while you were editing it."];
  if (dropped.length > 0 && dirty) {
    parts.push(
      `Some of your edits no longer applied and were discarded: ${fieldNames(dropped)}.`,
      "The others still apply and are not saved yet.",
    );
  } else if (dropped.length > 0) {
    parts.push("Your edits no longer applied and were discarded.");
  } else if (dirty) {
    parts.push("Your edits still apply and are not saved yet.");
  }
  return parts.join(" ");
}

/** "Defined as …" for a measure, "Means: …" for a default; a gap's definition as it comes. */
function Definition({ entry }: { entry: RegistryEntryDetail }) {
  const definition = entry.definition?.trim();
  if (!definition) return null;
  if (entry.kind === "measure") {
    return (
      <p>
        Defined as <span className="rv-detail__definition">{definition}</span>
      </p>
    );
  }
  if (entry.kind === "default") {
    return (
      <p>
        Means: <strong>{definition}</strong>
      </p>
    );
  }
  return <p>{sentence(definition)}</p>;
}

/** "Asked in 12 runs, first 3 Oct 2026, last 3 h ago." */
function demandLong({ demand }: RegistryEntryDetail, now: number): string {
  if (demand.runs === 0) return "Not asked in a run yet.";
  const parts = [`Asked in ${counted(demand.runs, "run")}`];
  const first = longDate(demand.first_asked);
  const last = ago(demand.last_asked, now);
  if (first) parts.push(`first ${first}`);
  if (last) parts.push(`last ${last}`);
  return `${parts.join(", ")}.`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="rv-section" aria-labelledby={id}>
      <h3 id={id} className="rv-section__title">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A titled list of what a gap lacks or would need; nothing when it is empty. */
function Listed({ title, items }: { title: string; items: string[] }) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <div className="rv-listed">
      <p id={id} className="rv-listed__title">
        {title}
      </p>
      <ul className="rv-listed__items" aria-labelledby={id}>
        {items.map((item, index) => (
          <li key={`${index}:${item}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** The newest runs that used the entry, and how many more did. */
function UsedIn({ ws, entry, now }: { ws: string; entry: RegistryEntryDetail; now: number }) {
  const more = entry.runs_total - entry.runs.length;
  if (entry.runs.length === 0) {
    return (
      <p className="muted">
        {entry.runs_total > 0 ? `Used in ${counted(entry.runs_total, "run")}.` : "Not used in a run yet."}
      </p>
    );
  }
  return (
    <>
      <ul className="rv-runs">
        {entry.runs.map((run) => (
          <RunRow key={run.run_id} ws={ws} run={run} now={now} />
        ))}
      </ul>
      {more > 0 && <p className="rv-runs__more">and {more} more</p>}
    </>
  );
}

/**
 * A run that used the entry: the thread's question and, for a later run of it, which revision
 * and what was sent (both to the thread), how it was rated, and when.
 */
function RunRow({ ws, run, now }: { ws: string; run: EntryRun; now: number }) {
  // Revision 0 is the question itself: what was sent is the question.
  const revision = run.revision > 0 ? `Revision ${run.revision} · ${run.prompt}` : null;
  return (
    <li className="rv-runs__row">
      <Link
        to={threadPath(ws, run.thread_id)}
        className="rv-runs__link"
        title={revision ? `${run.question}\n${revision}` : run.question}
      >
        <span className="rv-runs__question">{run.question}</span>
        {revision && <span className="rv-runs__revision">{revision}</span>}
      </Link>
      {run.rating && (
        <span
          className={`rv-runs__rating rv-runs__rating--${run.rating}`}
          role="img"
          aria-label={run.rating === "up" ? "Rated good" : "Rated bad"}
          title={run.rating === "up" ? "Rated good" : "Rated bad"}
        >
          <ThumbIcon down={run.rating === "down"} />
        </span>
      )}
      <span className="rv-runs__time">{ago(run.at, now)}</span>
    </li>
  );
}

/** A change in words: a key user's review, or sightline's own (worded as what happened, by no one). */
const CHANGE: Record<EntryChange["action"], string> = {
  proposed: "Proposed by sightline",
  demand: "Demand updated",
  approve: "Approved",
  reject: "Rejected",
  reopen: "Reopened",
  edit: "Edited",
};

/** The newest changes shown before "Show all". */
const HISTORY_SHOWN = 5;

/** The entry's changes, newest first: what happened, who did it, its version after, when, and the note. */
function History({ changes, now }: { changes: EntryChange[]; now: number }) {
  const [all, setAll] = useState(false);
  const newest = [...changes].reverse();
  const shown = all ? newest : newest.slice(0, HISTORY_SHOWN);
  return (
    <>
      <ul className="rv-history">
        {shown.map((change, index) => (
          <ChangeRow key={`${change.at}:${change.action}:${index}`} change={change} now={now} />
        ))}
      </ul>
      {newest.length > HISTORY_SHOWN && (
        <button
          type="button"
          className="rv-button rv-button--quiet rv-history__all"
          aria-expanded={all}
          onClick={() => setAll((previous) => !previous)}
        >
          {all ? "Show fewer" : `Show all ${counted(newest.length, "change")}`}
        </button>
      )}
    </>
  );
}

/** One change: "Approved by Ada · v4 · 2 h ago", and its note. */
function ChangeRow({ change, now }: { change: EntryChange; now: number }) {
  // An action a later contract adds goes by its own name.
  const what = CHANGE[change.action] ?? capital(change.action);
  const note = change.note?.trim();
  const when = ago(change.at, now);
  return (
    <li className="rv-history__row">
      <span className="rv-history__line">
        <span className="rv-history__what">
          {what}
          {change.by && ` by ${change.by}`}
        </span>
        <span className="mono rv-history__version" title={`Version ${change.version}`}>
          v{change.version}
        </span>
        {when && (
          <time className="rv-history__when" dateTime={change.at} title={longDate(change.at)}>
            {when}
          </time>
        )}
      </span>
      {/* A key user's note is theirs, quoted; sightline's own is a plain line. */}
      {note && <span className="rv-history__note">{change.by ? `“${note}”` : sentence(note)}</span>}
    </li>
  );
}
