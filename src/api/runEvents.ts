import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, authHeaders, unwrap } from "./client";
import { keys, runQueryOptions } from "./queries";
import { ENDED, isWorking, type Result, type RunEvent, type RunView, type StageTiming, type StepRecord } from "./types";

/**
 * Folds one event into a run. Pure: returns a new RunView and never mutates `run`.
 * `now` (ISO time) stamps fields the event does not carry, such as finished_at.
 * Folding a run's whole stream gives what getRun gives, except for what no event
 * carries: the definitions (the run has them from bind, when the restatement is told),
 * the follow-ups (after the terminal run.status), and the time of a step cut off by
 * the run's end (no step.finished comes for it, so its record stays open, elapsed_ms
 * null). useRunStream fetches the definitions after each restatement; the rest comes
 * with getRun's or the thread's copy once the run has ended.
 */
export function applyEvent(run: RunView, event: RunEvent, now: string = new Date().toISOString()): RunView {
  switch (event.type) {
    case "run.status": {
      const { status } = event;
      const next: RunView = { ...run, status };
      // Ended, superseded included: a newer revision replaced the run.
      if (ENDED.includes(status)) next.finished_at = run.finished_at ?? now;
      // Working again after an end (a re-present, a resume): the run is not finished,
      // and its trace stays, the stages it runs again appending to it.
      if (isWorking(status)) next.finished_at = null;
      // Asking or ended: no step is under way any more.
      if (!isWorking(status)) next.step = null;
      // Queued while running: a worker restarted the run, which starts its stages and
      // steps over. What it already said (restatement, card, result) stands until it
      // says otherwise.
      if (status === "queued" && run.status === "running") {
        next.timings = [];
        next.steps = [];
        next.step = null;
        next.phase = null;
        next.stage = null;
      }
      if (status === "running" && run.status !== "running" && run.started_at === null) next.started_at = now;
      return next;
    }
    case "stage.started": {
      const timing: StageTiming = { phase: event.phase, stage: event.stage, started_at: event.at, elapsed_ms: null };
      return {
        ...run,
        phase: event.phase,
        stage: event.stage,
        started_at: run.started_at ?? event.at,
        timings: [...run.timings, timing],
      };
    }
    case "stage.finished": {
      // A stage can run more than once (reconsider loops): close its latest open timing.
      const open = run.timings.findLastIndex((t) => t.stage === event.stage && t.elapsed_ms === null);
      const timings =
        open === -1
          ? [...run.timings, { phase: event.phase, stage: event.stage, started_at: event.at, elapsed_ms: event.elapsed_ms }]
          : run.timings.map((t, i) => (i === open ? { ...t, elapsed_ms: event.elapsed_ms } : t));
      return { ...run, timings };
    }
    case "step.started": {
      const record: StepRecord = {
        id: event.step.id,
        label: event.step.label,
        role: event.role,
        stage: event.stage,
        started_at: event.at,
        elapsed_ms: null,
        verdict: null,
        cached: false,
        sql: null,
        row_count: null,
      };
      return { ...run, step: event.step, steps: [...run.steps, record] };
    }
    case "step.finished": {
      const { step } = event;
      const closed = {
        role: event.role,
        elapsed_ms: event.elapsed_ms,
        verdict: event.verdict,
        cached: event.cached,
        sql: event.sql,
        row_count: event.row_count,
      };
      // Step ids are unique per execution: close the step's open record. A finish
      // whose start was never seen is recorded whole, its start counted back from its end.
      let at = run.steps.findLastIndex((s) => s.id === step.id && s.elapsed_ms === null);
      if (at === -1) at = run.steps.findLastIndex((s) => s.id === step.id);
      const steps =
        at === -1
          ? [
              ...run.steps,
              { id: step.id, label: step.label, stage: event.stage, started_at: startOf(event.at, event.elapsed_ms), ...closed },
            ]
          : run.steps.map((s, i) => (i === at ? { ...s, ...closed } : s));
      return { ...run, steps, step: run.step?.id === step.id ? null : run.step };
    }
    case "restatement":
      // Told after bind, and again whenever the text changes: the latest stands.
      return { ...run, restatement: event.text };
    case "card":
      return { ...run, card: event.card };
    case "clarify":
      return { ...run, clarify: event.clarify };
    case "error": {
      const { code, retryable, message, detail, stage } = event;
      return { ...run, error: { code, retryable, message, detail, stage } };
    }
    case "chart": {
      // The main chart. It comes before the result, so it may need the result's shell.
      if (event.support_id == null) {
        const result: Result = run.result ?? emptyResult();
        return { ...run, result: { ...result, chart: event.chart } };
      }
      // A support's small chart. A support not in the result yet (the result event
      // has not come) is left to that event, which carries every support with its chart.
      const at = run.result?.supports.findIndex((s) => s.id === event.support_id) ?? -1;
      if (!run.result || at === -1) return run;
      const supports = run.result.supports.map((s, i) => (i === at ? { ...s, chart: event.chart } : s));
      return { ...run, result: { ...run.result, supports } };
    }
    case "result":
      return { ...run, result: event.result };
    default:
      // A type this client does not know yet: newer servers stay readable.
      return run;
  }
}

/**
 * The result a main chart folds into when it comes before the result event: no rows,
 * no storyline, verdict pass. The result event replaces it whole.
 */
function emptyResult(): Result {
  return {
    sql: null,
    step_id: null,
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    chart: null,
    verdict: "pass",
    concerns: [],
    notes: [],
    findings: [],
    storyline: null,
    lead: null,
    supports: [],
  };
}

/** When a step that ended at `at` after `elapsedMs` started; `at` itself when it is no time. */
function startOf(at: string, elapsedMs: number): string {
  const end = Date.parse(at);
  return Number.isNaN(end) ? at : new Date(end - elapsedMs).toISOString();
}

/** Stops the library's own reconnecting: retrying the same request cannot help. */
class FatalStreamError extends Error {}

// Reconnects inside the library, after a 5xx or a dropped connection.
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 10_000;
// Reopens after the server refused the stream while the run still works.
const REOPEN_MS = 1_000;
const REOPEN_MAX_MS = 30_000;

export interface RunStream {
  /** Why the stream is down while it reconnects; null while it follows, or has nothing to follow. */
  error: Error | null;
}

/**
 * Follows a run's event stream while it works (queued or running), folding events
 * into the TanStack Query cache entry `keys.run(ws, runId)`. A stream the server
 * refuses is opened again later, with the run refetched meanwhile, until the run
 * stops working. Pass null to follow nothing; passing another run closes this
 * run's stream first, so its late frames are dropped. After each restatement it
 * fetches the run once (getRun) and takes only its definitions, which no event
 * carries, so they show with the restatement rather than at the end.
 */
export function useRunEvents(ws: string, runId: string | null): void {
  useRunStream(ws, runId);
}

/** useRunEvents, also telling why the stream is down while it is. */
export function useRunStream(ws: string, runId: string | null): RunStream {
  const queryClient = useQueryClient();
  // Only reads the cache, so the hook re-renders when the run's status changes.
  const { data: run } = useQuery({ ...runQueryOptions(ws, runId), enabled: false });
  const follow = runId !== null && run !== undefined && isWorking(run.status);
  const [down, setDown] = useState<{ runId: string; error: Error } | null>(null);
  // Bumped to open the stream again after the server refused it.
  const [reopen, setReopen] = useState(0);
  const refusals = useRef({ runId, count: 0 });

  useEffect(() => {
    if (!follow || runId === null) return;
    if (refusals.current.runId !== runId) refusals.current = { runId, count: 0 };
    const key = keys.run(ws, runId);
    const controller = new AbortController();
    const lastId = queryClient.getQueryData<RunView>(key)?.last_event_id ?? 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Asking or ended: the thread and the sidebar catch up, and so does the run unless
    // it was just fetched: the follow-ups and a cut-off step's elapsed_ms come only with
    // getRun or the thread's latest. The run's refetch is cancelled should nothing observe
    // the run any more by the time it would land (useLiveThread lets go of an ended
    // latest); useLiveThread then caches the thread's copy of it instead.
    const settle = (threadId: string, fetched = false) => {
      void queryClient.invalidateQueries({ queryKey: keys.thread(ws, threadId) });
      void queryClient.invalidateQueries({ queryKey: keys.threads(ws) });
      if (!fetched) void queryClient.invalidateQueries({ queryKey: key });
    };

    // The id of the latest restatement folded in; only a copy that has it folded in has its definitions.
    let restatedAt = 0;
    const takeDefinitions = async (id: number) => {
      restatedAt = id;
      const fetched = await api
        .GET("/api/v1/workspaces/{ws}/runs/{run_id}", { params: { path: { ws, run_id: runId } }, signal: controller.signal })
        .then((result) => unwrap(result))
        .catch(() => undefined);
      // Let go of, or behind: the end of the run brings them (or newer ones) anyway.
      if (!fetched || controller.signal.aborted || fetched.last_event_id < restatedAt) return;
      queryClient.setQueryData<RunView>(key, (old) => old && { ...old, definitions: fetched.definitions });
    };

    const url = `/api/v1/workspaces/${encodeURIComponent(ws)}/runs/${encodeURIComponent(runId)}/events`;
    fetchEventSource(url, {
      // Lower-case names on purpose: the library sets `accept` and, on reconnect,
      // `last-event-id` itself, and a second spelling would send both values.
      headers: {
        ...authHeaders(),
        accept: "text/event-stream",
        ...(lastId > 0 ? { "last-event-id": String(lastId) } : {}),
      },
      signal: controller.signal,
      openWhenHidden: true,
      async onopen(response) {
        const type = response.headers.get("content-type") ?? "";
        if (response.ok && type.startsWith("text/event-stream")) {
          failures = 0;
          refusals.current.count = 0;
          setDown(null);
          return;
        }
        const { status } = response;
        if (response.ok || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
          throw new FatalStreamError(`event stream: HTTP ${status} ${type}`.trim());
        }
        throw new ApiError(`event stream: HTTP ${status}`, status);
      },
      onmessage(message) {
        // Let go of (another run followed now, or unmounted): a superseded or cancelled
        // run may still send a few late frames, which belong to nothing on screen.
        if (controller.signal.aborted || !message.event) return;
        const id = Number(message.id);
        const current = queryClient.getQueryData<RunView>(key);
        // Already folded (a replay after reconnecting), or nothing to fold into.
        if (!current || !(id > current.last_event_id)) return;
        let event: RunEvent;
        try {
          event = JSON.parse(message.data) as RunEvent;
        } catch {
          return;
        }
        // Only this run's frames fold into this run's entry, never another run's.
        if (event.run_id !== undefined && event.run_id !== runId) return;
        queryClient.setQueryData<RunView>(key, (old) => old && { ...applyEvent(old, event), last_event_id: id });
        if (event.type === "restatement") void takeDefinitions(id);
        // A queued after running (a worker restart) keeps working, and the stream stays.
        if (event.type === "run.status" && !isWorking(event.status)) {
          // Asking or ended (superseded too): the server closes the stream here.
          controller.abort();
          settle(current.thread_id);
        }
      },
      onclose() {
        // Closed before the run left the working set (a proxy timeout, a restart): reconnect.
        if (!controller.signal.aborted) throw new Error("event stream closed early");
      },
      onerror(error) {
        if (error instanceof FatalStreamError) throw error;
        setDown({ runId, error: asError(error) });
        failures += 1;
        return Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      },
    }).catch(async (refusal: unknown) => {
      // Refused (a lost event log, a proxy's 4xx): catch up from the run itself, and
      // while it still works open the stream again later, since the refusal may pass.
      if (controller.signal.aborted) return;
      setDown({ runId, error: asError(refusal) });
      const fresh = await queryClient
        .fetchQuery({ ...runQueryOptions(ws, runId), staleTime: 0 })
        .catch(() => undefined);
      if (controller.signal.aborted) return;
      if (fresh && !isWorking(fresh.status)) return settle(fresh.thread_id, true);
      refusals.current.count += 1;
      const delay = Math.min(REOPEN_MS * 2 ** (refusals.current.count - 1), REOPEN_MAX_MS);
      timer = setTimeout(() => setReopen((n) => n + 1), delay);
    });

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [queryClient, ws, runId, follow, reopen]);

  return { error: follow && down?.runId === runId ? down.error : null };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
