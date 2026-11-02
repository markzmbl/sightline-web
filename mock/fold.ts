// The mock's RunView is written by events: every change but three is an event, folded
// here, so GET /runs/{id} always equals what a client folding the stream holds. The
// three the contract carries on no event are set beside the log (engine.ts): the
// definitions (with the restatement), the follow-ups (with the terminal status), and a
// step cut off by the run's end (its elapsed_ms). fold() follows the contract's rules,
// as the client's applyEvent (src/api/runEvents.ts) does; tests/mock.test.ts checks
// the two agree.
import type { Result, RunEvent, RunOrigin, RunStatus, RunView, StageTiming, StepRecord, FollowRef } from "../src/api/types.ts";

/** Statuses of a run that has ended; superseded: a newer revision replaced it. */
export const ENDED: readonly RunStatus[] = ["complete", "clarify", "failed", "cancelled", "superseded"];
/** Statuses after which the event stream ends: the run ended or waits on the card. */
export const STOPS: readonly RunStatus[] = [...ENDED, "asking"];
/** Statuses of a run that has not ended. */
export const OPEN: readonly RunStatus[] = ["queued", "running", "asking"];
const WORKING: readonly RunStatus[] = ["queued", "running"];

export const isOpen = (status: RunStatus): boolean => OPEN.includes(status);

export interface RunOrigins {
  origin: RunOrigin;
  takes_back: number | null;
  follows: FollowRef | null;
}

export function newRunView(id: string, threadId: string, revision: number, prompt: string, from: RunOrigins): RunView {
  return {
    id,
    thread_id: threadId,
    revision,
    prompt,
    origin: from.origin,
    takes_back: from.takes_back,
    follows: from.follows,
    status: "queued",
    locale: null,
    phase: null,
    stage: null,
    started_at: null,
    finished_at: null,
    restatement: null,
    definitions: [],
    card: null,
    clarify: null,
    result: null,
    follow_ups: [],
    step: null,
    steps: [],
    timings: [],
    error: null,
    feedback: null,
    last_event_id: 0,
  };
}

/** A result that has only its main chart yet: the chart arrives before the rows. */
const chartOnly = (chart: Result["chart"]): Result => ({
  sql: null,
  step_id: null,
  columns: [],
  rows: [],
  row_count: 0,
  truncated: false,
  chart,
  findings: [],
  notes: [],
  verdict: "pass",
  concerns: [],
  storyline: null,
  lead: null,
  supports: [],
});

/**
 * Folds one event (frame `id`) into a run; `now` stamps what the event does not carry.
 * A stage that runs again (a re-presented run, a reconsider loop) is a new timing, and
 * stage.finished closes the stage's latest open one; a queued after running (a worker
 * restart) clears the trace, its steps included. A step under way is RunView.step until
 * its step.finished, or until the run asks or ends.
 */
export function fold(run: RunView, event: RunEvent, id: number, now: string): RunView {
  const next: RunView = { ...run, last_event_id: id };
  switch (event.type) {
    case "run.status":
      next.status = event.status;
      if (ENDED.includes(event.status)) next.finished_at = run.finished_at ?? now;
      // Working again after an end (a re-present, a resume): the run is not finished,
      // and its trace stays, the stages it runs again appending to it.
      if (WORKING.includes(event.status)) next.finished_at = null;
      if (STOPS.includes(event.status)) next.step = null;
      // Queued while running: a worker restarted the run, which starts its stages over.
      if (event.status === "queued" && run.status === "running") {
        next.timings = [];
        next.steps = [];
        next.step = null;
        next.phase = null;
        next.stage = null;
      }
      if (event.status === "running" && run.status !== "running" && run.started_at === null) next.started_at = now;
      break;
    case "stage.started": {
      const timing: StageTiming = { phase: event.phase, stage: event.stage, started_at: event.at, elapsed_ms: null };
      next.timings = [...run.timings, timing];
      next.phase = event.phase;
      next.stage = event.stage;
      next.started_at = run.started_at ?? event.at;
      break;
    }
    case "stage.finished": {
      const open = run.timings.findLastIndex((t) => t.stage === event.stage && t.elapsed_ms === null);
      next.timings =
        open < 0
          ? [...run.timings, { phase: event.phase, stage: event.stage, started_at: event.at, elapsed_ms: event.elapsed_ms }]
          : run.timings.map((t, i) => (i === open ? { ...t, elapsed_ms: event.elapsed_ms } : t));
      break;
    }
    case "step.started": {
      const record: StepRecord = {
        id: event.step.id,
        stage: event.stage,
        label: event.step.label,
        role: event.role,
        started_at: event.at,
        elapsed_ms: null,
        verdict: null,
        cached: false,
        sql: null,
        row_count: null,
      };
      next.steps = [...run.steps, record];
      next.step = event.step;
      break;
    }
    case "step.finished": {
      const done = {
        label: event.step.label,
        role: event.role,
        elapsed_ms: event.elapsed_ms,
        verdict: event.verdict,
        cached: event.cached,
        sql: event.sql,
        row_count: event.row_count,
      };
      next.steps = run.steps.some((s) => s.id === event.step.id)
        ? run.steps.map((s) => (s.id === event.step.id ? { ...s, ...done } : s))
        : [...run.steps, { id: event.step.id, stage: event.stage, started_at: event.at, ...done }];
      if (run.step?.id === event.step.id) next.step = null;
      break;
    }
    case "restatement":
      next.restatement = event.text;
      break;
    case "card":
      next.card = event.card;
      break;
    case "clarify":
      next.clarify = event.clarify;
      break;
    case "chart": {
      // The main chart, or a support's small chart once the result names the support.
      if (event.support_id === null) {
        next.result = run.result ? { ...run.result, chart: event.chart } : chartOnly(event.chart);
      } else if (run.result) {
        const supports = run.result.supports.map((s) => (s.id === event.support_id ? { ...s, chart: event.chart } : s));
        next.result = { ...run.result, supports };
      }
      break;
    }
    case "result":
      next.result = event.result;
      break;
    case "error":
      next.error = {
        code: event.code,
        message: event.message,
        detail: event.detail,
        stage: event.stage,
        retryable: event.retryable,
      };
      break;
  }
  return next;
}
