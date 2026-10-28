import {
  QueryClient,
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, toApiError, unwrap } from "./client";
import { applyEvent, useRunStream } from "./runEvents";
import {
  ENDED,
  isOpen,
  isWorking,
  type FollowRequest,
  type Me,
  type ProblemCode,
  type Rating,
  type Revise,
  type RunCreated,
  type RunStatus,
  type RunSummary,
  type RunView,
  type StepResult,
  type Thread,
  type ThreadSummary,
  type Turn,
} from "./types";

export const keys = {
  me: ["me"] as const,
  /** The sidebar's list; a prefix of every search's key too, so invalidating it refreshes those. */
  threads: (ws: string) => ["threads", ws] as const,
  threadSearch: (ws: string, q: string) => ["threads", ws, "search", q] as const,
  thread: (ws: string, threadId: string) => ["thread", ws, threadId] as const,
  run: (ws: string, runId: string) => ["run", ws, runId] as const,
  step: (ws: string, runId: string, stepId: string) => ["step", ws, runId, stepId] as const,
};

/** How long fetched data counts as fresh, unless a query says otherwise. */
const STALE_MS = 5_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        // A 4xx will not change on retry; a 5xx or a dropped connection (status 0) might.
        retry: (failures, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

export function useMe(): UseQueryResult<Me, Error> {
  return useQuery({
    queryKey: keys.me,
    queryFn: async ({ signal }) => unwrap(await api.GET("/api/v1/me", { signal })),
  });
}

export interface ThreadsOptions {
  /** A text search over the questions and prompts, done by the server; blank lists every thread. */
  q?: string;
}

/**
 * The sidebar's threads, most recently updated first; refetches every 10 s while any is
 * open. With `q`, the threads the server's search finds; while a new search is out, the
 * workspace's last list stays on as placeholder data.
 */
export function useThreads(ws: string, options: ThreadsOptions = {}): UseQueryResult<ThreadSummary[], Error> {
  const q = options.q?.trim() ?? "";
  return useQuery({
    queryKey: q ? keys.threadSearch(ws, q) : keys.threads(ws),
    queryFn: async ({ signal }) => {
      const page = unwrap(
        await api.GET("/api/v1/workspaces/{ws}/threads", {
          params: { path: { ws }, query: q ? { q, limit: 100 } : { limit: 100 } },
          signal,
        }),
      );
      return page.items;
    },
    enabled: ws !== "",
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === ws ? previous : undefined),
    refetchInterval: (query) => (query.state.data?.some((t) => isOpen(t.status)) ? 10_000 : false),
  });
}

/** A thread: every run in brief (runs, oldest first) and the latest in full (latest). */
export function useThread(ws: string, threadId: string): UseQueryResult<Thread, Error> {
  return useQuery({
    queryKey: keys.thread(ws, threadId),
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET("/api/v1/workspaces/{ws}/threads/{thread_id}", {
          params: { path: { ws, thread_id: threadId } },
          signal,
        }),
      ),
    enabled: ws !== "" && threadId !== "",
  });
}

/**
 * The one set of options every observer of `keys.run` uses: observers of a key
 * share one query, and each of them overwrites that query's options.
 */
export function runQueryOptions(ws: string, runId: string | null) {
  return queryOptions({
    queryKey: keys.run(ws, runId ?? ""),
    queryFn: async ({ client, queryKey, signal }): Promise<RunView> => {
      const fetched = unwrap(
        await api.GET("/api/v1/workspaces/{ws}/runs/{run_id}", {
          params: { path: { ws, run_id: runId ?? "" } },
          signal,
        }),
      );
      // The event stream may have folded newer events in while this request was out.
      const cached = client.getQueryData<RunView>(queryKey);
      return cached && cached.last_event_id > fetched.last_event_id ? cached : fetched;
    },
    enabled: runId !== null,
  });
}

export function useRun(ws: string, runId: string | null): UseQueryResult<RunView, Error> {
  return useQuery(runQueryOptions(ws, runId));
}

/** The step results fetched after their step had ended: a step id names one execution, so these are final. */
const finalSteps = new WeakSet<StepResult>();

/** Whether the run's copy shows the step ended: its record closed, the run ended (a step it cut off too), or the result's own step. */
function stepEnded(run: RunView | undefined, stepId: string | null): boolean {
  if (!run || stepId === null) return false;
  return (
    ENDED.includes(run.status) ||
    run.result?.step_id === stepId ||
    run.steps.some((s) => s.id === stepId && s.elapsed_ms !== null)
  );
}

/**
 * One step's SQL and rows (at most the first 200): a step of RunView.steps, or the one
 * Result.step_id names. Idle until both ids are set. A run without that step fails with
 * 404 no_step. Whether the step has ended is read from the run's cached copy
 * (keys.run): fetched after it ended, the rows are final and never go stale; fetched
 * while it ran (sql null, no rows yet), or with no copy to tell, they go stale like any
 * query's, and once the copy shows the step ended they are fetched again, once.
 */
export function useRunStep(ws: string, runId: string | null, stepId: string | null): UseQueryResult<StepResult, ApiError> {
  // Only reads the cache, so the hook re-renders when the run's copy shows the step ended.
  const { data: ended = false } = useQuery({
    ...runQueryOptions(ws, runId),
    enabled: false,
    select: (run) => stepEnded(run, stepId),
  });
  const query = useQuery<StepResult, ApiError>({
    queryKey: keys.step(ws, runId ?? "", stepId ?? ""),
    queryFn: async ({ client, signal }) => {
      // Ended before the request went out, so the server answers with the final rows.
      const final = stepEnded(client.getQueryData<RunView>(keys.run(ws, runId ?? "")), stepId);
      const step = unwrap(
        await api
          .GET("/api/v1/workspaces/{ws}/runs/{run_id}/steps/{step_id}", {
            params: { path: { ws, run_id: runId ?? "", step_id: stepId ?? "" } },
            signal,
          })
          .catch((error: unknown) => {
            throw toApiError(error);
          }),
      );
      if (final) finalSteps.add(step);
      return step;
    },
    enabled: ws !== "" && !!runId && !!stepId,
    staleTime: (query) => (query.state.data && finalSteps.has(query.state.data) ? Infinity : STALE_MS),
    // Each fetch keeps its own object, so finalSteps tells which fetch the data came from.
    structuralSharing: false,
  });

  const { data, refetch } = query;
  // Rows fetched before the step ended, which has ended now: fetched again, once per copy.
  const refetched = useRef<StepResult | null>(null);
  const behind = ended && data !== undefined && !finalSteps.has(data) ? data : null;
  useEffect(() => {
    if (!behind || refetched.current === behind) return;
    refetched.current = behind;
    void refetch();
  }, [behind, refetch]);
  return query;
}

/**
 * Tells the server the user opened the thread (sendSignal, thread_opened): once per
 * mount and thread, StrictMode's second mount sending nothing, and again when the hook
 * moves to another thread. Fire-and-forget: nothing waits on it, retries it or shows
 * its failure.
 */
export function useThreadOpened(ws: string, threadId: string): void {
  // Kept across StrictMode's simulated unmount, so its second mount sends nothing.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (ws === "" || threadId === "") return;
    const opened = `${ws}/${threadId}`;
    if (sent.current === opened) return;
    sent.current = opened;
    void api
      .POST("/api/v1/workspaces/{ws}/signals", {
        params: { path: { ws } },
        body: { kind: "thread_opened", thread_id: threadId },
      })
      .catch(() => undefined);
  }, [ws, threadId]);
}

/** The summary a thread lists for a run, made from the run in full. */
export function summaryOf(run: RunView): RunSummary {
  const chart = run.result?.chart;
  return {
    id: run.id,
    revision: run.revision,
    origin: run.origin,
    prompt: run.prompt,
    status: run.status,
    restatement: run.restatement,
    top: run.result?.storyline?.top ?? null,
    chart: chart ? { chart: chart.chart, label: chart.label } : null,
    follows: run.follows,
    takes_back: run.takes_back,
    feedback: run.feedback,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

export interface LiveThread {
  thread: Thread | undefined;
  /**
   * One turn per run, oldest first (Thread.runs). The latest turn carries the latest run
   * in full, live: while it is open its event stream folds in, and its summary is made
   * from it, so status, restatement, top and chart keep up. No event carries the
   * definitions: the stream fetches the run once more after each restatement and takes
   * them from it, so they are empty until that copy is back (see useRunStream). An
   * earlier turn carries its run in full once `expand` asked for it (null until then,
   * and while it loads). An earlier run the copy still shows open is on its way out (a
   * revision supersedes it, cooperatively), so its summary and its run show as
   * superseded, ended the way the stream ends a run: no step under way, and finished_at,
   * when the copy has none, the thread's updated_at (it moved when the newer run was
   * created, or later) standing in until the copy catches up.
   */
  turns: Turn[];
  /**
   * The thread's latest run while it is queued, running or asking; else null. Never
   * a superseded or otherwise ended run, nor an earlier run the copy still shows open.
   */
  activeRun: RunView | null;
  isLoading: boolean;
  error: Error | null;
  /** Why the active run's event stream is down while it reconnects (the run is refetched meanwhile); else null. */
  streamError: Error | null;
  /**
   * Unfolds an earlier turn: fetches its run in full (getRun), which the turn then
   * carries. Stable for the thread. Asking again does nothing; so does asking for the
   * latest run, for a run that is not the thread's, or before the thread has loaded:
   * nothing is remembered, so such a run stays folded when it later becomes an earlier turn.
   */
  expand(runId: string): void;
}

const NONE: readonly string[] = [];

/**
 * A thread kept live: it follows the latest run's event stream while that run works,
 * and refetches when it ends; the thread's copy of the ended latest then also moves a
 * cached run (keys.run) that is behind forward. Only the latest run can be active (an
 * answer or a chart pick on any other is refused as not_latest): when a refetch shows a
 * newer run (a revision, a follow-up), the old run's stream closes and its late frames
 * are dropped.
 */
export function useLiveThread(ws: string, threadId: string): LiveThread {
  const queryClient = useQueryClient();
  const threadQuery = useThread(ws, threadId);
  const thread = threadQuery.data;
  const threadAt = threadQuery.dataUpdatedAt;
  // The latest run while it is open; an ended one is the thread's copy as it stands.
  const seed = thread && isOpen(thread.latest.status) ? thread.latest : null;

  const live = useQuery({
    ...runQueryOptions(ws, seed?.id ?? null),
    initialData: () => seed ?? undefined,
    initialDataUpdatedAt: threadAt,
  });

  const merged = seed ? fresher(live.data, live.dataUpdatedAt, seed, threadAt) : null;

  // A thread refetch can be ahead of the cached run (the stream was closed while
  // the user was away); move the cache forward so the stream resumes from there.
  useEffect(() => {
    if (!seed || !live.data || live.data === seed || merged !== seed) return;
    queryClient.setQueryData(keys.run(ws, seed.id), seed, { updatedAt: threadAt });
  }, [queryClient, ws, seed, live.data, merged, threadAt]);

  // The ended latest as the thread has it is as full as getRun's copy (the follow-ups, a
  // cut-off step's time): a cached run that is behind moves forward to it. The run's own
  // refetch at the stream's end can be cut short, since nothing observes an ended latest.
  useEffect(() => {
    if (!thread || isOpen(thread.latest.status)) return;
    const key = keys.run(ws, thread.latest.id);
    const cached = queryClient.getQueryState<RunView>(key);
    if (!cached?.data || cached.data === thread.latest) return;
    if (fresher(cached.data, cached.dataUpdatedAt, thread.latest, threadAt) !== thread.latest) return;
    queryClient.setQueryData(key, thread.latest, { updatedAt: threadAt });
  }, [queryClient, ws, thread, threadAt]);

  const stream = useRunStream(ws, merged && isWorking(merged.status) ? merged.id : null);
  const latest = merged ?? thread?.latest ?? null;

  // The earlier turns unfolded, for this thread only.
  const scope = `${ws}/${threadId}`;
  const [unfolded, setUnfolded] = useState<{ scope: string; ids: readonly string[] }>({ scope, ids: NONE });
  const unfoldedIds = unfolded.scope === scope ? unfolded.ids : NONE;
  const expand = useCallback(
    (runId: string) => {
      // Only an earlier run of the thread unfolds; anything else is not remembered.
      const current = queryClient.getQueryData<Thread>(keys.thread(ws, threadId));
      if (!current || current.latest.id === runId || !current.runs.some((r) => r.id === runId)) return;
      setUnfolded((prev) => {
        const ids = prev.scope === scope ? prev.ids : NONE;
        return ids.includes(runId) ? prev : { scope, ids: [...ids, runId] };
      });
    },
    [queryClient, ws, threadId, scope],
  );
  // Should a newer copy no longer list an unfolded run, it is no longer fetched.
  const wanted = useMemo(
    () => (thread ? unfoldedIds.filter((id) => id !== thread.latest.id && thread.runs.some((r) => r.id === id)) : NONE),
    [thread, unfoldedIds],
  );
  const unfoldedRuns = useQueries({ queries: wanted.map((id) => runQueryOptions(ws, id)), combine: dataOf });

  const turns = useMemo((): Turn[] => {
    if (!thread || !latest) return [];
    const full = new Map(wanted.map((id, i) => [id, unfoldedRuns[i]]));
    const turns = thread.runs.map((summary): Turn => {
      if (summary.id === latest.id) return { summary: summaryOf(latest), run: latest };
      // Only the latest run can be open: an earlier one still open is being superseded.
      // It ends as the stream would end it, the thread's last move standing in for its end.
      const status: RunStatus = isOpen(summary.status) ? "superseded" : summary.status;
      const at = summary.finished_at ?? thread.updated_at;
      const run = full.get(summary.id) ?? null;
      return {
        summary: status === summary.status ? summary : { ...summary, status, finished_at: at },
        run: run && isOpen(run.status) ? applyEvent(run, { type: "run.status", run_id: run.id, status }, at) : run,
      };
    });
    // The latest is among the runs; should a copy lack it, it still gets its turn.
    if (!thread.runs.some((r) => r.id === latest.id)) turns.push({ summary: summaryOf(latest), run: latest });
    return turns;
  }, [thread, latest, wanted, unfoldedRuns]);

  return {
    thread,
    turns,
    activeRun: merged && isOpen(merged.status) ? merged : null,
    isLoading: threadQuery.isLoading,
    error: threadQuery.error,
    streamError: stream.error,
    expand,
  };
}

/** The runs useQueries fetched, in order. Module-level, so the combined array changes only when a result does. */
function dataOf(results: UseQueryResult<RunView, Error>[]): (RunView | undefined)[] {
  return results.map((result) => result.data);
}

/** The newer of two copies of a run: more events folded in, or else fetched later. */
function fresher(live: RunView | undefined, liveAt: number, seed: RunView, seedAt: number): RunView {
  if (!live) return seed;
  if (live.last_event_id !== seed.last_event_id) return live.last_event_id > seed.last_event_id ? live : seed;
  return seedAt > liveAt ? seed : live;
}

// Mutations. Each one refetches the sidebar and the thread it touched, and
// stays pending until they are back, so the new turn shows as it re-enables.

function useRefresh(ws: string) {
  const queryClient = useQueryClient();
  return (threadIds: readonly string[], runId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.threads(ws) }),
      ...[...new Set(threadIds)].map((id) => queryClient.invalidateQueries({ queryKey: keys.thread(ws, id) })),
      // The same run id can work again (a resume, a re-present), and its stream must reopen.
      runId !== undefined ? queryClient.invalidateQueries({ queryKey: keys.run(ws, runId) }) : null,
    ]);
}

/** The refusals that mean this view of a run was behind. */
const BEHIND: readonly ProblemCode[] = ["not_latest", "not_answerable", "stale_run"];

/**
 * A refused answer, chart pick or follow-up (409: not_latest, not_answerable, stale_run)
 * means this view of the run was behind, a newer revision or another tab say: the run
 * and every thread of the workspace catch up, so what the refusal speaks of is on screen.
 * Any other failure changed nothing and refetches nothing.
 */
function useCatchUp(ws: string) {
  const queryClient = useQueryClient();
  return (error: Error, runId?: string) =>
    error instanceof ApiError && error.status === 409 && error.code !== null && BEHIND.includes(error.code)
      ? Promise.all([
          queryClient.invalidateQueries({ queryKey: keys.threads(ws) }),
          queryClient.invalidateQueries({ queryKey: ["thread", ws] }),
          runId !== undefined ? queryClient.invalidateQueries({ queryKey: keys.run(ws, runId) }) : null,
        ])
      : undefined;
}

export function useCreateThread(ws: string): UseMutationResult<RunCreated, Error, { question: string }> {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: async ({ question }) =>
      unwrap(await api.POST("/api/v1/workspaces/{ws}/threads", { params: { path: { ws } }, body: { question } })),
    onSuccess: (created) => refresh([created.thread_id]),
  });
}

/**
 * A revision of the thread: typed in the composer, a follow-up, or a clarify run's
 * nearest question. How a follow-up goes depends on the status of the run that offered
 * it, never on its kind: from a complete run with `follows` (message: the follow-up's
 * question verbatim), from a clarify run with via "nearest" and no follows.
 */
export interface ReviseVariables {
  message: string;
  /** Where a revision without follows came from; the server takes composer when it is left out. Never with follows. */
  via?: "composer" | "nearest";
  /** The follow-up this sends: the thread's latest run, which offered it, and the follow-up's id. */
  follows?: FollowRequest;
}

/**
 * Sends a revision as given, leaving out what is undefined. A follow-up refused as
 * behind (409 not_latest, not_answerable) catches the thread up, like a refused answer.
 */
export function useRevise(ws: string, threadId: string): UseMutationResult<RunCreated, Error, ReviseVariables> {
  const refresh = useRefresh(ws);
  const catchUp = useCatchUp(ws);
  return useMutation({
    mutationFn: async ({ message, via, follows }) => {
      const body: Revise = { message };
      if (via !== undefined) body.via = via;
      if (follows !== undefined) body.follows = follows;
      return unwrap(
        await api.POST("/api/v1/workspaces/{ws}/threads/{thread_id}/revisions", {
          params: { path: { ws, thread_id: threadId } },
          body,
        }),
      );
    },
    onSuccess: () => refresh([threadId]),
    onError: (error, { follows }) => catchUp(error, follows?.run_id),
  });
}

export function useTakeBack(ws: string, threadId: string): UseMutationResult<RunCreated, Error, { n: number }> {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: async ({ n }) =>
      unwrap(
        await api.DELETE("/api/v1/workspaces/{ws}/threads/{thread_id}/revisions/{n}", {
          params: { path: { ws, thread_id: threadId, n } },
        }),
      ),
    onSuccess: () => refresh([threadId]),
  });
}

export function useAnswer(
  ws: string,
): UseMutationResult<RunCreated, Error, { runId: string; answers: Record<string, string | null>; text?: string | null }> {
  const refresh = useRefresh(ws);
  const catchUp = useCatchUp(ws);
  return useMutation({
    mutationFn: async ({ runId, answers, text }) =>
      unwrap(
        await api.POST("/api/v1/workspaces/{ws}/runs/{run_id}/answers", {
          params: { path: { ws, run_id: runId } },
          body: { answers, text: text ?? null },
        }),
      ),
    onSuccess: (created, { runId }) => refresh([created.thread_id], runId),
    onError: (error, { runId }) => catchUp(error, runId),
  });
}

/** Stops a run. Idempotent: on a run that has already ended the server answers the same 202, and nothing changes. */
export function useCancel(ws: string): UseMutationResult<RunCreated, Error, { runId: string }> {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: async ({ runId }) =>
      unwrap(await api.POST("/api/v1/workspaces/{ws}/runs/{run_id}/cancel", { params: { path: { ws, run_id: runId } } })),
    onSuccess: (created, { runId }) => refresh([created.thread_id], runId),
  });
}

export function usePickChart(ws: string): UseMutationResult<RunCreated, Error, { runId: string; chart: string }> {
  const refresh = useRefresh(ws);
  const catchUp = useCatchUp(ws);
  return useMutation({
    mutationFn: async ({ runId, chart }) =>
      unwrap(
        await api.POST("/api/v1/workspaces/{ws}/runs/{run_id}/chart", {
          params: { path: { ws, run_id: runId } },
          body: { chart },
        }),
      ),
    onSuccess: (created, { runId }) => refresh([created.thread_id], runId),
    onError: (error, { runId }) => catchUp(error, runId),
  });
}

/**
 * The ratings useFeedback replaced: in the run's own entry (undefined when it
 * was not cached) and in each cached thread holding the run.
 */
interface Replaced {
  run: Rating | null | undefined;
  threads: [QueryKey, Rating | null][];
}

export function useFeedback(ws: string): UseMutationResult<void, Error, { runId: string; rating: Rating }> {
  const queryClient = useQueryClient();
  const refresh = useRefresh(ws);
  // Every cached thread holding the run carries its own copy of the rating: in the run's
  // summary, and in the latest run when it is that one.
  const threadsHolding = (runId: string) =>
    queryClient
      .getQueriesData<Thread>({ queryKey: ["thread", ws] })
      .flatMap(([key, thread]) => {
        const run = thread?.runs.find((r) => r.id === runId) ?? (thread?.latest.id === runId ? thread.latest : undefined);
        return thread && run ? [{ key, threadId: thread.id, rating: run.feedback }] : [];
      });

  return useMutation<void, Error, { runId: string; rating: Rating }, Replaced>({
    mutationFn: async ({ runId, rating }) => {
      unwrap(
        await api.POST("/api/v1/workspaces/{ws}/runs/{run_id}/feedback", {
          params: { path: { ws, run_id: runId } },
          body: { rating },
        }),
      );
    },
    onMutate: async ({ runId, rating }) => {
      const runKey = keys.run(ws, runId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: runKey }),
        ...threadsHolding(runId).map(({ key }) => queryClient.cancelQueries({ queryKey: key, exact: true })),
      ]);
      const threads = threadsHolding(runId);
      const replaced: Replaced = {
        run: queryClient.getQueryData<RunView>(runKey)?.feedback,
        threads: threads.map(({ key, rating: before }) => [key, before]),
      };
      queryClient.setQueryData<RunView>(runKey, (old) => old && rated(old, () => rating));
      for (const { key } of threads) {
        queryClient.setQueryData<Thread>(key, (old) => old && ratedIn(old, runId, () => rating));
      }
      return replaced;
    },
    onError: (_error, { runId, rating }, replaced) => {
      // Undo the rating alone, and only where it still stands: stream frames, a new
      // revision's run, or a newer rating written meanwhile all stay.
      if (!replaced) return;
      const back = (before: Rating | null) => (current: Rating | null) => (current === rating ? before : current);
      const { run: runBefore } = replaced;
      if (runBefore !== undefined) {
        queryClient.setQueryData<RunView>(keys.run(ws, runId), (old) => old && rated(old, back(runBefore)));
      }
      for (const [key, before] of replaced.threads) {
        queryClient.setQueryData<Thread>(key, (old) => old && ratedIn(old, runId, back(before)));
      }
    },
    // Either way, the cache comes back to what the server holds.
    onSettled: (_data, _error, { runId }) => {
      const run = queryClient.getQueryData<RunView>(keys.run(ws, runId));
      const threadIds = threadsHolding(runId).map(({ threadId }) => threadId);
      return refresh(run ? [...threadIds, run.thread_id] : threadIds, runId);
    },
  });
}

type Rerate = (current: Rating | null) => Rating | null;

function rated<T extends { feedback: Rating | null }>(run: T, next: Rerate): T {
  const feedback = next(run.feedback);
  return feedback === run.feedback ? run : { ...run, feedback };
}

/** The thread with the run's rating changed in its summary and, when it is the latest, in the latest run. */
function ratedIn(thread: Thread, runId: string, next: Rerate): Thread {
  const runs = thread.runs.map((run) => (run.id === runId ? rated(run, next) : run));
  const latest = thread.latest.id === runId ? rated(thread.latest, next) : thread.latest;
  return latest === thread.latest && runs.every((run, i) => run === thread.runs[i]) ? thread : { ...thread, runs, latest };
}
