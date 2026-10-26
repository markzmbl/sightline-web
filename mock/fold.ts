// The mock's RunView is never written directly: every change is an event, folded
// here, so GET /runs/{id} always equals what a client folding the stream holds.
// fold() mirrors the client's applyEvent (src/api/runEvents.ts), which cannot be
// imported under Node's type stripping; tests/mock.test.ts checks the two agree.
import type { Result, RunEvent, RunStatus, RunView, StageTiming } from "../src/api/types.ts";

/** Statuses of a run that has ended; superseded: a newer revision replaced it. */
export const ENDED: readonly RunStatus[] = ["complete", "clarify", "failed", "cancelled", "superseded"];
/** Statuses after which the event stream ends: the run ended or waits on the card. */
export const STOPS: readonly RunStatus[] = [...ENDED, "asking"];
/** Statuses of a run that has not ended. */
export const OPEN: readonly RunStatus[] = ["queued", "running", "asking"];
const WORKING: readonly RunStatus[] = ["queued", "running"];

export const isOpen = (status: RunStatus): boolean => OPEN.includes(status);

export function newRunView(id: string, threadId: string, revision: number, prompt: string): RunView {
  return {
    id,
    thread_id: threadId,
    revision,
    prompt,
    status: "queued",
    phase: null,
    stage: null,
    started_at: null,
    finished_at: null,
    restatement: null,
    card: null,
    clarify: null,
    result: null,
    timings: [],
    error: null,
    feedback: null,
    last_event_id: 0,
  };
}

/** A result that has only its chart yet: the chart arrives before the rows. */
const chartOnly = (chart: Result["chart"]): Result => ({
  sql: null,
  columns: [],
  rows: [],
  row_count: 0,
  truncated: false,
  chart,
  findings: [],
});

/**
 * Folds one event (frame `id`) into a run; `now` stamps what the event does not
 * carry. A stage that runs again (a re-presented run, a reconsider loop) is a
 * new timing, and stage.finished closes the stage's latest open one; a queued
 * after running (a worker restart) clears the trace.
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
      // Queued while running: a worker restarted the run, which starts its stages over.
      if (event.status === "queued" && run.status === "running") {
        next.timings = [];
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
    case "restatement":
      next.restatement = event.text;
      break;
    case "card":
      next.card = event.card;
      break;
    case "clarify":
      next.clarify = event.clarify;
      break;
    case "chart":
      next.result = run.result ? { ...run.result, chart: event.chart } : chartOnly(event.chart);
      break;
    case "result":
      next.result = event.result;
      break;
    case "error":
      next.error = { message: event.message, stage: event.stage };
      break;
  }
  return next;
}
