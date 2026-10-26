import {
  QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api, ApiError, unwrap } from "./client";
import { useRunStream } from "./runEvents";
import { isOpen, isWorking, type Me, type Rating, type RunCreated, type RunView, type Thread, type ThreadSummary } from "./types";

export const keys = {
  me: ["me"] as const,
  threads: (ws: string) => ["threads", ws] as const,
  thread: (ws: string, threadId: string) => ["thread", ws, threadId] as const,
  run: (ws: string, runId: string) => ["run", ws, runId] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
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

/** The sidebar's threads, newest first; refetches every 10 s while any is open. */
export function useThreads(ws: string): UseQueryResult<ThreadSummary[], Error> {
  return useQuery({
    queryKey: keys.threads(ws),
    queryFn: async ({ signal }) => {
      const page = unwrap(
        await api.GET("/api/v1/workspaces/{ws}/threads", { params: { path: { ws }, query: { limit: 100 } }, signal }),
      );
      return page.items;
    },
    enabled: ws !== "",
    refetchInterval: (query) => (query.state.data?.some((t) => isOpen(t.status)) ? 10_000 : false),
  });
}

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

export interface LiveThread {
  thread: Thread | undefined;
  /**
   * The thread's runs, oldest first, with the active run's live state merged in.
   * A run before the latest that the copy still shows open is on its way out (a
   * revision supersedes it, cooperatively), so it shows as superseded.
   */
  runs: RunView[];
  /**
   * The thread's latest run while it is queued, running or asking; else null. Never
   * a superseded or otherwise ended run, nor an earlier run the copy still shows open.
   */
  activeRun: RunView | null;
  isLoading: boolean;
  error: Error | null;
  /** Why the active run's event stream is down while it reconnects (the run is refetched meanwhile); else null. */
  streamError: Error | null;
}

/**
 * A thread kept live: it follows the active run's event stream and refetches when it
 * ends. Only the active run is followed, and only the latest run can be active (an
 * answer or a chart pick on any other is refused as not_latest): when a refetch shows
 * a newer run (a revision), the old run's stream closes and its late frames are dropped.
 */
export function useLiveThread(ws: string, threadId: string): LiveThread {
  const queryClient = useQueryClient();
  const threadQuery = useThread(ws, threadId);
  const thread = threadQuery.data;
  const threadAt = threadQuery.dataUpdatedAt;
  const seed = useMemo(() => (thread ? latestOpenRun(thread.runs) : null), [thread]);

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

  const stream = useRunStream(ws, merged && isWorking(merged.status) ? merged.id : null);

  const runs = useMemo(() => {
    if (!thread) return [];
    const last = thread.runs.length - 1;
    return thread.runs.map((run, i): RunView => {
      if (i === last && merged) return merged;
      return i < last && isOpen(run.status) ? { ...run, status: "superseded" } : run;
    });
  }, [thread, merged]);

  return {
    thread,
    runs,
    activeRun: merged && isOpen(merged.status) ? merged : null,
    isLoading: threadQuery.isLoading,
    error: threadQuery.error,
    streamError: stream.error,
  };
}

/** The latest run while it is open. An earlier run still open in the copy is being superseded. */
function latestOpenRun(runs: RunView[]): RunView | null {
  const latest = runs.at(-1);
  return latest && isOpen(latest.status) ? latest : null;
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

/**
 * A refused answer or chart pick (409: not_latest, not_answerable, stale_run) means this
 * view of the run was behind, a newer revision or another tab say: the run and every
 * thread of the workspace catch up, so what the refusal speaks of is on screen.
 */
function useCatchUp(ws: string) {
  const queryClient = useQueryClient();
  return (error: Error, runId: string) =>
    error instanceof ApiError && error.status === 409
      ? Promise.all([
          queryClient.invalidateQueries({ queryKey: keys.threads(ws) }),
          queryClient.invalidateQueries({ queryKey: ["thread", ws] }),
          queryClient.invalidateQueries({ queryKey: keys.run(ws, runId) }),
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

export function useRevise(ws: string, threadId: string): UseMutationResult<RunCreated, Error, { message: string }> {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: async ({ message }) =>
      unwrap(
        await api.POST("/api/v1/workspaces/{ws}/threads/{thread_id}/revisions", {
          params: { path: { ws, thread_id: threadId } },
          body: { message },
        }),
      ),
    onSuccess: () => refresh([threadId]),
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
  // Every cached thread holding the run carries its own copy of the rating.
  const threadsHolding = (runId: string) =>
    queryClient
      .getQueriesData<Thread>({ queryKey: ["thread", ws] })
      .flatMap(([key, thread]) => {
        const run = thread?.runs.find((r) => r.id === runId);
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

function rated(run: RunView, next: Rerate): RunView {
  const feedback = next(run.feedback);
  return feedback === run.feedback ? run : { ...run, feedback };
}

function ratedIn(thread: Thread, runId: string, next: Rerate): Thread {
  const runs = thread.runs.map((run) => (run.id === runId ? rated(run, next) : run));
  return runs.every((run, i) => run === thread.runs[i]) ? thread : { ...thread, runs };
}
