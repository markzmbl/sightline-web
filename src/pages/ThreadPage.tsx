import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  useAnswer,
  useCancel,
  useFeedback,
  useLiveThread,
  usePickChart,
  useRevise,
  useTakeBack,
  useThreadOpened,
} from "../api/queries";
import { isOpen, isWorking, type RunView } from "../api/types";
import { useShell } from "../App";
import { Composer } from "../components/composer/Composer";
import { workspacePath } from "../components/sidebar/paths";
import { Transcript, type TranscriptActions } from "../components/thread/Transcript";
import { StatusLine } from "../components/working/StatusLine";
import "./ThreadPage.css";

/** One question and its revisions, each answered by a run, with the composer to revise it again. */
export function ThreadPage() {
  const { ws, sidebarButton } = useShell();
  const { threadId = "" } = useParams();
  // A fresh page per thread: scroll position, composer text and mutation errors do not carry over.
  return <ThreadView key={`${ws}/${threadId}`} ws={ws} threadId={threadId} sidebarButton={sidebarButton} />;
}

interface ViewProps {
  ws: string;
  threadId: string;
  sidebarButton: ReactNode;
}

function ThreadView({ ws, threadId, sidebarButton }: ViewProps) {
  const live = useLiveThread(ws, threadId);
  const revise = useRevise(ws, threadId);
  const takeBack = useTakeBack(ws, threadId);
  const answer = useAnswer(ws);
  const cancel = useCancel(ws);
  const pickChart = usePickChart(ws);
  const feedback = useFeedback(ws);
  const scroll = useFollowBottom(live.turns);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  useThreadOpened(ws, threadId);

  // Arriving with focus nowhere (the question was just asked, or the link followed went
  // away with the page it was on), the composer takes it, ready for a revision.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) composer.current?.focus();
  }, []);

  const question = live.thread?.question ?? live.turns[0]?.summary.prompt ?? "";
  useEffect(() => {
    document.title = question ? `${question} · sightline` : "sightline";
  }, [question]);
  useEffect(
    () => () => {
      document.title = "sightline";
    },
    [],
  );

  const busy = [revise, takeBack, answer, cancel, pickChart, feedback].some((m) => m.isPending);
  const failure = latestFailure([
    { mutation: revise, what: "send the revision" },
    { mutation: takeBack, what: "take the revision back" },
    { mutation: answer, what: "answer the card" },
    { mutation: cancel, what: "stop the run" },
    { mutation: pickChart, what: "switch the chart" },
    { mutation: feedback, what: "record the feedback" },
  ]);

  // Only an open run shows in the status line: a superseded or cancelled one has ended,
  // whatever a late frame of its stream said.
  const open = live.activeRun && isOpen(live.activeRun.status) ? live.activeRun : null;
  // A revision (typed, suggested, taken back, or free text on the card), an answer or a chart
  // switch sets a run working: a new one that supersedes the open run, or the same one again.
  // Its mutation stays pending until the thread has caught up, so meanwhile the status line
  // already shows that run starting, not the run it replaces. It has no id yet to stop.
  const starting = [revise, takeBack, answer, pickChart].some((m) => m.isPending);
  const status = starting ? STARTING : open && statusOf(open);
  const working = status?.state === "working";
  const activeId = starting ? null : (open?.id ?? null);
  const stop = useCallback(() => {
    if (activeId) cancel.mutate({ runId: activeId });
  }, [activeId, cancel.mutate]);
  const onStop = activeId ? stop : undefined;

  // Posted directly, never cancelled first: the server supersedes the open run itself.
  const send = (message: string) => {
    scroll.pin();
    return revise.mutateAsync({ message });
  };

  // A revision made in the transcript starts a new turn, and the control pressed folds away with
  // the turn it was on. Focus goes on to the composer, where the next revision is typed and the
  // run can be stopped, rather than falling to the page.
  const revised = () => {
    scroll.pin();
    composer.current?.focus();
  };

  const actions: TranscriptActions = {
    onAnswer: (runId, answers, text) => {
      if (text) revised(); // free text becomes a revision, a new turn at the bottom
      answer.mutate({ runId, answers, text });
    },
    onPickChart: (runId, chart) => pickChart.mutate({ runId, chart }),
    onFeedback: (runId, rating) => feedback.mutate({ runId, rating }),
    onTakeBack: (n) => {
      revised();
      takeBack.mutate({ n });
    },
    // The thread's next run, sent the way the offering run's status calls for (never its kind):
    // a clarify run has no answer to follow, so its nearest questions go as a revision via
    // "nearest"; a complete run's follow-ups name the run and the follow-up they came from.
    onFollowUp: (run, followUp) => {
      revised();
      revise.mutate(
        run.status === "clarify"
          ? { message: followUp.question, via: "nearest" }
          : { message: followUp.question, follows: { run_id: run.id, follow_up_id: followUp.id } },
      );
    },
    // A full revised question (a clarify gap's suggestion) goes in as if typed; a failure shows in the banner.
    onRevise: (text) => {
      revised();
      revise.mutate({ message: text });
    },
  };

  // Unfolding an earlier turn is reading back: the view stays on the turn opened, while its run
  // loads and its chart grows, instead of following the bottom away from it.
  const unfold = (runId: string) => {
    scroll.release();
    live.expand(runId);
  };

  const missing = live.error !== null && live.thread === undefined;

  return (
    <div className="thread">
      <header className="shell__bar">
        {sidebarButton}
        <h1 className="thread__title" title={question || undefined}>
          {question}
        </h1>
      </header>

      <div className="thread__scroll" ref={scroll.scroller} onScroll={scroll.onScroll}>
        <div className="thread__content" ref={scroll.content}>
          {missing ? (
            <ThreadMissing ws={ws} error={live.error} />
          ) : live.isLoading ? (
            <div className="thread__skeleton" aria-busy="true">
              <span className="sr-only">Loading the thread</span>
              {[46, 88, 72, 94, 60].map((width, i) => (
                <span
                  key={i}
                  className={i === 0 ? "thread__bone thread__bone--prompt" : "thread__bone"}
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          ) : (
            <Transcript turns={live.turns} busy={busy} actions={actions} onExpand={unfold} />
          )}
        </div>
      </div>

      {!missing && (
        <footer className="thread__foot">
          {failure && (
            <div className="thread__banner" role="alert">
              <span>{failureText(failure.what, failure.error)}</span>
              <button type="button" className="icon-button" aria-label="Dismiss" onClick={failure.dismiss}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="m3.5 3.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
          {status && (
            <div className="thread__status">
              <StatusLine
                state={status.state}
                stage={status.stage}
                phase={status.phase}
                step={status.step}
                since={status.since}
                onStop={onStop}
              />
            </div>
          )}
          <Composer
            ref={composer}
            placeholder="Revise the question…"
            label="Revise the question"
            working={working}
            onSubmit={send}
            onStop={onStop}
          />
        </footer>
      )}
    </div>
  );
}

/** What the status line shows. */
interface Status {
  state: "working" | "asking";
  stage: string | null;
  phase: string | null;
  /** The analysis step under way, in the asker's words (RunView.step.label). */
  step: string | null;
  /** When the run started (epoch ms), for the clock. */
  since: number | null;
}

/** A run on its way that the thread does not show yet: no stage, no clock, like a queued run. */
const STARTING: Status = { state: "working", stage: null, phase: null, step: null, since: null };

function statusOf(run: RunView): Status {
  return {
    state: isWorking(run.status) ? "working" : "asking",
    stage: run.stage,
    phase: run.phase,
    step: run.step?.label ?? null,
    since: run.started_at ? Date.parse(run.started_at) : null,
  };
}

function ThreadMissing({ ws, error }: { ws: string; error: Error | null }) {
  return (
    <div className="thread__missing" role="alert">
      {isNotFound(error) ? (
        <p>This thread does not exist in this workspace.</p>
      ) : (
        <>
          <p>Could not load this thread.</p>
          {error && <p className="muted">{error.message}</p>}
        </>
      )}
      <Link to={workspacePath(ws)} className="pill">
        Ask a new question
      </Link>
    </div>
  );
}

/** The thread's own 404: the workspace holds no thread by this id. */
function isNotFound(error: Error | null): boolean {
  return error instanceof ApiError && error.code === "no_thread";
}

/** The agreed sentence for a run made by an earlier version of sightline. */
const STALE_RUN =
  "This answer was made by an earlier version of sightline and can't be changed any more. Ask the question again for a fresh answer.";

/**
 * What the banner says: "Could not …: reason". The reason for stale_run is two whole
 * sentences that already say what to do, so it stands alone, without the prefix.
 */
function failureText(what: string, error: Error): string {
  const reason = reasonOf(error);
  return error instanceof ApiError && error.code === "stale_run" ? reason : `Could not ${what}: ${reason}`;
}

/**
 * Why the server refused, in the thread's words. The codes the client knows are put in
 * words (a refusal that says the view was behind has caught it up meanwhile); any other
 * failure is said by the server's own detail, a sentence fit to show.
 */
function reasonOf(error: Error): string {
  if (!(error instanceof ApiError)) return error.message;
  switch (error.code) {
    case "not_latest":
      return "a newer revision has replaced this answer.";
    case "not_answerable":
      return "that is no longer offered for this answer.";
    case "stale_run":
      return STALE_RUN;
    case "too_many_active":
      return error.retryAfter !== null
        ? `too many questions are running; try again in ${error.retryAfter} s.`
        : "too many questions are running; try again in a moment.";
  }
  if (error.status === 422 && error.errors.some((item) => item.type === "follow_up_mismatch")) {
    return "the follow-up changed; pick it again.";
  }
  return error.message;
}

interface Tracked {
  mutation: { isError: boolean; error: Error | null; submittedAt: number; reset(): void };
  what: string;
}

/** The most recently submitted mutation that failed, to show until dismissed. */
function latestFailure(tracked: Tracked[]): { what: string; error: Error; dismiss(): void } | null {
  let latest: Tracked | null = null;
  for (const t of tracked) {
    if (t.mutation.isError && (!latest || t.mutation.submittedAt > latest.mutation.submittedAt)) latest = t;
  }
  if (!latest) return null;
  const { mutation, what } = latest;
  return mutation.error ? { what, error: mutation.error, dismiss: () => mutation.reset() } : null;
}

const FOLLOW_PX = 120;

/**
 * Keeps the transcript scrolled to the bottom while new content arrives, as
 * long as the reader was within FOLLOW_PX of it; `pin` follows again (after a submit),
 * `release` stops following until the reader scrolls back down or `pin` is called.
 */
function useFollowBottom(content: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX;
  };

  useLayoutEffect(() => {
    if (follow.current) toBottom();
  }, [content, toBottom]);

  // Content also grows on its own, a chart rendering say, without new runs.
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current) toBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [toBottom]);

  const pin = () => {
    follow.current = true;
    toBottom();
  };

  const release = () => {
    follow.current = false;
  };

  return { scroller, content: inner, onScroll, pin, release };
}
