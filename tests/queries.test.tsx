import type { EventSourceMessage, FetchEventSourceInit } from "@microsoft/fetch-event-source";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setToken } from "../src/api/client";
import {
  createQueryClient,
  keys,
  summaryOf,
  useAnswer,
  useCreateThread,
  useFeedback,
  useLiveThread,
  usePickChart,
  useRevise,
  useRun,
  useRunStep,
  useThread,
  useThreadOpened,
  useThreads,
} from "../src/api/queries";
import type {
  ChartView,
  Definition,
  Result,
  RunEvent,
  RunView,
  StepRecord,
  StepResult,
  Thread,
  ThreadSummary,
} from "../src/api/types";

// openapi-fetch builds same-origin, relative URLs, which a browser resolves
// against the page and Node's Request refuses. Resolve them against jsdom's page,
// before the client module captures Request.
vi.hoisted(() => {
  const NodeRequest = globalThis.Request;
  globalThis.Request = class extends NodeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, location.href) : input, init);
    }
  };
});

// The event stream, replaced by a stand-in the tests drive by hand. Like the
// library, it resolves when aborted and rejects when onerror throws (`reject`).
interface Stream {
  url: string;
  init: FetchEventSourceInit;
  reject: (error: unknown) => void;
}
const streams = vi.hoisted(() => [] as Stream[]);
vi.mock("@microsoft/fetch-event-source", () => ({
  fetchEventSource: (url: string, init: FetchEventSourceInit) =>
    new Promise<void>((resolve, reject) => {
      streams.push({ url, init, reject });
      init.signal?.addEventListener("abort", () => resolve());
    }),
}));

// The API, as a table of routes over a stubbed fetch.
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
type Handler = (request: Request) => Reply | Promise<Reply>;
let routes: Record<string, Handler> = {};
const requests: Request[] = [];

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  requests.push(request);
  const { pathname } = new URL(request.url);
  const handler = routes[`${request.method} ${pathname}`];
  const { status = 200, body, headers = {} } = handler
    ? await handler(request)
    : { status: 404, body: { detail: `no route ${pathname}` } };
  if (status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
});

const callsTo = (method: string, pathname: string) =>
  requests.filter((r) => r.method === method && new URL(r.url).pathname === pathname).length;
const bodiesTo = (method: string, pathname: string) =>
  Promise.all(
    requests.filter((r) => r.method === method && new URL(r.url).pathname === pathname).map((r) => r.clone().json()),
  );

function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    thread_id: "t1",
    revision: 1,
    origin: "revision",
    prompt: "only the north",
    status: "running",
    phase: "understand",
    stage: "ground",
    step: null,
    started_at: "2026-10-24T12:00:00.000Z",
    finished_at: null,
    restatement: null,
    definitions: [],
    card: null,
    clarify: null,
    result: null,
    follow_ups: [],
    follows: null,
    takes_back: null,
    locale: null,
    timings: [],
    steps: [],
    error: null,
    feedback: null,
    last_event_id: 3,
    ...overrides,
  };
}

const done = makeRun({
  id: "r0",
  revision: 0,
  origin: "question",
  prompt: "Revenue by region",
  status: "complete",
  finished_at: "2026-10-24T11:59:00.000Z",
  last_event_id: 12,
});

/** A thread as getThread sends it: every run in brief, the last one in full. */
function makeThread(runs: RunView[]): Thread {
  const latest = runs.at(-1);
  if (!latest) throw new Error("a thread has at least its question's run");
  return {
    id: "t1",
    question: "Revenue by region",
    created_at: "2026-10-24T11:58:00.000Z",
    updated_at: "2026-10-24T12:00:00.000Z",
    locale: null,
    latest,
    runs: runs.map(summaryOf),
  };
}

const chart: ChartView = {
  chart: "horizontal_bar",
  label: "Horizontal bars",
  hint: null,
  spec: { mark: "bar", title: { text: "North leads the regions" } },
  png_url: null,
  title: "North leads the regions",
  subtitle: [],
  score: 0.9,
  min_width: null,
  options: [],
};

const answer: Result = {
  sql: "select region, sum(amount) from sales group by 1",
  step_id: "s0",
  columns: [],
  rows: [],
  row_count: 0,
  truncated: false,
  chart,
  verdict: "pass",
  concerns: [],
  notes: [],
  findings: [],
  storyline: { top: "North leads the regions", key_line: [] },
  lead: "u1",
  supports: [],
};

let client: QueryClient;

function wrapperFor() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Sends one frame down a stream, by default the latest one opened. */
function send(id: number, event: RunEvent, stream: Stream | undefined = streams.at(-1)) {
  if (!stream) throw new Error("no stream is open");
  const message: EventSourceMessage = { id: String(id), event: event.type, data: JSON.stringify(event) };
  act(() => stream.init.onmessage?.(message));
}

/**
 * Answers a stream's request the way the library handles it: onopen, and when
 * that throws, onerror; an error thrown from onerror ends the stream for good.
 * Returns the delay before the library would retry, or null when it stopped.
 */
async function respond(stream: Stream, response: Response): Promise<number | null | undefined> {
  let retryIn: number | null | undefined;
  await act(async () => {
    try {
      await stream.init.onopen?.(response);
    } catch (error) {
      try {
        retryIn = stream.init.onerror?.(error) as number | undefined;
      } catch (fatal) {
        retryIn = null;
        stream.reject(fatal);
      }
    }
  });
  return retryIn;
}

const eventStream = () => new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });

const THREAD_PATH = "/api/v1/workspaces/ws1/threads/t1";
const RUNS = "/api/v1/workspaces/ws1/runs";

beforeEach(() => {
  client = createQueryClient();
  routes = {};
  requests.length = 0;
  streams.length = 0;
  // v1 has no auth: no token unless a test sets one.
  setToken(null);
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  cleanup();
  client.clear();
  setToken(null);
  vi.unstubAllGlobals();
  fetchStub.mockClear();
});

describe("useThreads", () => {
  const items: ThreadSummary[] = [
    {
      id: "t1",
      question: "Revenue by region",
      restatement: "Net revenue by region",
      status: "running",
      active_run_id: "r1",
      revisions: 1,
      updated_at: "2026-10-24T12:00:00.000Z",
    },
    {
      id: "t2",
      question: "Claims per adjuster",
      restatement: null,
      status: "complete",
      active_run_id: null,
      revisions: 0,
      updated_at: "2026-10-23T09:00:00.000Z",
    },
  ];
  const THREADS = "/api/v1/workspaces/ws1/threads";
  const searchOf = (request: Request | undefined) => Object.fromEntries(new URL(request?.url ?? "").searchParams);

  it("lists the first page's items, sending no Authorization header (v1 has no auth)", async () => {
    routes[`GET ${THREADS}`] = () => ({ body: { items, next_cursor: "c2" } });
    const { result } = renderHook(() => useThreads("ws1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.data).toEqual(items));
    const request = requests[0];
    expect(searchOf(request)).toEqual({ limit: "100" });
    expect(request?.headers.has("Authorization")).toBe(false);
  });

  it("polls only while a thread is open", async () => {
    routes[`GET ${THREADS}`] = () => ({ body: { items, next_cursor: null } });
    const { result } = renderHook(() => useThreads("ws1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = client.getQueryCache().find({ queryKey: keys.threads("ws1") });
    const interval = query?.observers[0]?.options.refetchInterval;
    if (typeof interval !== "function" || !query) throw new Error("expected a refetchInterval function");
    expect(interval(query as never)).toBe(10_000);
    client.setQueryData(keys.threads("ws1"), items.slice(1));
    expect(interval(query as never)).toBe(false);
  });

  it("asks the server to search when q is set, keeping the last list meanwhile, and sends no blank q", async () => {
    let release: (() => void) | null = null;
    routes[`GET ${THREADS}`] = (request) => {
      const q = new URL(request.url).searchParams.get("q");
      if (q === null) return { body: { items, next_cursor: null } };
      return new Promise<Reply>((resolve) => {
        release = () => resolve({ body: { items: items.slice(1), next_cursor: null } });
      });
    };
    const { result, rerender } = renderHook(({ q }: { q?: string }) => useThreads("ws1", { q }), {
      wrapper: wrapperFor(),
      initialProps: { q: "  " },
    });
    await waitFor(() => expect(result.current.data).toEqual(items));
    expect(searchOf(requests[0])).toEqual({ limit: "100" });

    rerender({ q: " claims " });
    await waitFor(() => expect(release).not.toBeNull());
    expect(searchOf(requests[1])).toEqual({ q: "claims", limit: "100" });
    // The workspace's last list stays on while the search is out.
    expect(result.current.data).toEqual(items);
    expect(result.current.isPlaceholderData).toBe(true);

    act(() => release?.());
    await waitFor(() => expect(result.current.data).toEqual(items.slice(1)));
    expect(client.getQueryData(keys.threadSearch("ws1", "claims"))).toEqual(items.slice(1));
    expect(client.getQueryData(keys.threads("ws1"))).toEqual(items);
  });
});

describe("useThread", () => {
  it("fails with the server's detail and does not retry a 4xx", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ status: 404, body: { detail: "no such thread", code: "no_thread" } });
    const { result } = renderHook(() => useThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error).toMatchObject({ message: "no such thread", status: 404, code: "no_thread", retryAfter: null });
    expect(callsTo("GET", THREAD_PATH)).toBe(1);
  });
});

describe("ApiError", () => {
  it("reads a 429's Retry-After in seconds, whether seconds or a date", async () => {
    let retryAfter = "30";
    routes["POST /api/v1/workspaces/ws1/threads"] = () => ({
      status: 429,
      body: { detail: "Too many questions are on their way.", code: "too_many_active" },
      headers: { "Retry-After": retryAfter },
    });
    const { result } = renderHook(() => useCreateThread("ws1"), { wrapper: wrapperFor() });
    const failure = async () => {
      let error: unknown = null;
      await act(async () => {
        await result.current.mutateAsync({ question: "Revenue by region" }).catch((e: unknown) => (error = e));
      });
      return error;
    };

    expect(await failure()).toMatchObject({ status: 429, code: "too_many_active", retryAfter: 30 });
    retryAfter = new Date(Date.now() + 90_000).toUTCString();
    const dated = (await failure()) as ApiError;
    expect(dated.retryAfter).toBeGreaterThanOrEqual(88);
    expect(dated.retryAfter).toBeLessThanOrEqual(90);
    retryAfter = "soon";
    expect(await failure()).toMatchObject({ retryAfter: null });
  });

  it("has no retryAfter outside a 429", async () => {
    routes["POST /api/v1/workspaces/ws1/threads"] = () => ({
      status: 503,
      body: { detail: "down" },
      headers: { "Retry-After": "30" },
    });
    const { result } = renderHook(() => useCreateThread("ws1"), { wrapper: wrapperFor() });
    let error: unknown = null;
    await act(async () => {
      await result.current.mutateAsync({ question: "Revenue by region" }).catch((e: unknown) => (error = e));
    });
    expect(error).toMatchObject({ status: 503, code: null, retryAfter: null });
  });
});

describe("a token", () => {
  it("signs the requests and the event stream once set, and nothing once cleared", async () => {
    setToken("test-token");
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer test-token");
    expect(streams[0]?.init.headers).toEqual({
      Authorization: "Bearer test-token",
      accept: "text/event-stream",
      "last-event-id": "3",
    });

    setToken(null);
    await act(() => client.refetchQueries({ queryKey: keys.thread("ws1", "t1") }));
    expect(requests.at(-1)?.headers.has("Authorization")).toBe(false);
  });
});

describe("useLiveThread", () => {
  it("follows the latest run while it is open, from where the view stands", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });

    await waitFor(() => expect(result.current.activeRun?.id).toBe("r1"));
    expect(result.current.turns.map((t) => t.summary.id)).toEqual(["r0", "r1"]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();

    expect(streams).toHaveLength(1);
    const { url, init } = streams[0] as Stream;
    expect(url).toBe("/api/v1/workspaces/ws1/runs/r1/events");
    expect(init.headers).toEqual({ accept: "text/event-stream", "last-event-id": "3" });
    expect(init.openWhenHidden).toBe(true);
  });

  it("folds new frames, skips replayed ones, and lets go when the run ends", async () => {
    let thread = makeThread([done, makeRun()]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    // A replay of a frame the view already holds changes nothing.
    const cached = () => client.getQueryData<RunView>(keys.run("ws1", "r1"));
    send(3, { type: "stage.started", run_id: "r1", phase: "analyse", stage: "query", at: "2026-10-24T12:00:04.000Z" });
    expect(cached()?.stage).toBe("ground");
    expect(cached()?.last_event_id).toBe(3);

    send(4, { type: "stage.started", run_id: "r1", phase: "analyse", stage: "query", at: "2026-10-24T12:00:04.000Z" });
    await waitFor(() => expect(result.current.activeRun?.stage).toBe("query"));
    expect(result.current.turns[1]?.run?.phase).toBe("analyse");
    expect(cached()?.last_event_id).toBe(4);

    // The same id twice (a reconnect overlapping the last frame) folds once.
    send(4, { type: "restatement", run_id: "r1", text: "duplicate" });
    expect(cached()?.restatement).toBeNull();
    send(5, { type: "restatement", run_id: "r1", text: "Net revenue, north only" });
    await waitFor(() => expect(result.current.activeRun?.restatement).toBe("Net revenue, north only"));

    thread = makeThread([done, makeRun({ status: "complete", last_event_id: 6, finished_at: "2026-10-24T12:00:09.000Z" })]);
    routes[`GET ${RUNS}/r1`] = () => ({ body: thread.latest });
    const before = callsTo("GET", THREAD_PATH);
    send(6, { type: "run.status", run_id: "r1", status: "complete" });

    expect(streams[0]?.init.signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.activeRun).toBeNull());
    expect(result.current.turns[1]?.summary.status).toBe("complete");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.thread("ws1", "t1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.threads("ws1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.run("ws1", "r1") });
    await waitFor(() => expect(callsTo("GET", THREAD_PATH)).toBe(before + 1));
    await waitFor(() => expect(result.current.thread?.runs[1]?.status).toBe("complete"));
    expect(streams).toHaveLength(1);
  });

  it("shows the follow-ups and a cut-off step's time after the end, which only getRun's copy has", async () => {
    let thread = makeThread([done, makeRun({ phase: "analyse", stage: "analyse" })]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    send(4, {
      type: "step.started",
      run_id: "r1",
      step: { id: "s1", label: "the prior period" },
      role: "comparison",
      stage: "analyse",
      at: "2026-10-24T12:00:04.000Z",
    });
    await waitFor(() => expect(result.current.activeRun?.step?.label).toBe("the prior period"));

    // Cancelled while the step ran: no step.finished comes; getRun has its time.
    const step = { ...result.current.activeRun!.steps[0]!, elapsed_ms: 1200 };
    const ended = makeRun({
      status: "cancelled",
      phase: "analyse",
      stage: "analyse",
      finished_at: "2026-10-24T12:00:05.200Z",
      steps: [step],
      follow_ups: [{ id: "f1", kind: "breakdown", question: "Revenue by plant in the north" }],
      last_event_id: 5,
    });
    thread = makeThread([done, ended]);
    routes[`GET ${RUNS}/r1`] = () => ({ body: ended });
    const runCalls = callsTo("GET", `${RUNS}/r1`);
    send(5, { type: "run.status", run_id: "r1", status: "cancelled" });

    // Folded from the stream: no step under way, the cut-off one still open.
    const folded = client.getQueryData<RunView>(keys.run("ws1", "r1"));
    expect(folded?.status).toBe("cancelled");
    expect(folded?.step).toBeNull();
    expect(folded?.steps[0]?.elapsed_ms).toBeNull();
    await waitFor(() => expect(result.current.activeRun).toBeNull());
    await waitFor(() => expect(callsTo("GET", `${RUNS}/r1`)).toBe(runCalls + 1));
    await waitFor(() => expect(result.current.turns[1]?.run?.steps[0]?.elapsed_ms).toBe(1200));
    expect(result.current.turns[1]?.run?.follow_ups.map((f) => f.id)).toEqual(["f1"]);
    await waitFor(() => expect(client.getQueryData<RunView>(keys.run("ws1", "r1"))?.follow_ups).toHaveLength(1));
  });

  it("caches the thread's copy of the ended latest run when the run's own refetch is cut short", async () => {
    let thread = makeThread([done, makeRun()]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    const ended = makeRun({
      status: "complete",
      finished_at: "2026-10-24T12:00:09.000Z",
      follow_ups: [{ id: "f1", kind: "breakdown", question: "Revenue by plant in the north" }],
      last_event_id: 4,
    });
    thread = makeThread([done, ended]);
    // getRun is held until the thread is back: by then nothing observes the run, and
    // its refetch is cancelled, the stream's copy (no follow-ups) reverted to.
    const held: (() => void)[] = [];
    routes[`GET ${RUNS}/r1`] = () => new Promise<Reply>((resolve) => held.push(() => resolve({ body: ended })));
    send(4, { type: "run.status", run_id: "r1", status: "complete" });

    await waitFor(() => expect(result.current.turns[1]?.summary.status).toBe("complete"));
    await waitFor(() => expect(client.getQueryData<RunView>(keys.run("ws1", "r1"))?.follow_ups).toHaveLength(1));
    expect(client.getQueryData<RunView>(keys.run("ws1", "r1"))).toEqual(ended);
    expect(callsTo("GET", `${RUNS}/r1`)).toBe(1);
    for (const release of held) act(release);
  });

  it("fetches the definitions a restatement comes with, which no event carries", async () => {
    const oee: Definition = {
      name: "oee",
      label: "OEE",
      definition: "availability × performance × quality",
      entry_id: "e1",
      source: { kind: "library", text: "from sightline's KPI library (ISO 22400-2)" },
      status: "proposed",
    };
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    // First a copy from before the restatement, which tells nothing about it.
    let copy = makeRun({ last_event_id: 3 });
    routes[`GET ${RUNS}/r1`] = () => ({ body: copy });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    send(4, { type: "restatement", run_id: "r1", text: "OEE by line" });
    await waitFor(() => expect(callsTo("GET", `${RUNS}/r1`)).toBe(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(result.current.activeRun?.definitions).toEqual([]);

    copy = makeRun({ phase: "analyse", stage: "query", definitions: [oee], last_event_id: 6 });
    send(5, { type: "restatement", run_id: "r1", text: "OEE by production line" });
    await waitFor(() => expect(result.current.activeRun?.definitions).toEqual([oee]));
    // Only the definitions are taken: the rest stands as the stream folded it.
    expect(result.current.activeRun).toMatchObject({ stage: "ground", restatement: "OEE by production line", last_event_id: 5 });
    expect(callsTo("GET", `${RUNS}/r1`)).toBe(2);
  });

  it("makes the latest turn's summary from the live run", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(result.current.turns[1]?.summary).toMatchObject({ status: "running", restatement: null, top: null, chart: null });

    send(4, { type: "restatement", run_id: "r1", text: "Net revenue, north only" });
    send(5, { type: "chart", run_id: "r1", chart, support_id: null });
    await waitFor(() => expect(result.current.turns[1]?.summary.chart).toEqual({ chart: "horizontal_bar", label: "Horizontal bars" }));
    expect(result.current.turns[1]?.summary.restatement).toBe("Net revenue, north only");
    send(6, { type: "result", run_id: "r1", result: answer });
    await waitFor(() => expect(result.current.turns[1]?.summary.top).toBe("North leads the regions"));

    // The thread's own copy of the summary is behind; the turn is not.
    expect(result.current.thread?.runs[1]?.restatement).toBeNull();
    expect(result.current.turns[1]?.run).toBe(result.current.activeRun);
    expect(result.current.turns[0]).toEqual({ summary: summaryOf(done), run: null });
  });

  it("shows an asking run as active without opening a stream", async () => {
    const asking = makeRun({ status: "asking", stage: "ask" });
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, asking]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.activeRun?.status).toBe("asking"));
    expect(streams).toHaveLength(0);
  });

  it("has no active run when every run has ended, the latest turn its full run", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.thread).toBeDefined());
    expect(result.current.activeRun).toBeNull();
    expect(result.current.turns).toEqual([{ summary: summaryOf(done), run: done }]);
    expect(streams).toHaveLength(0);
  });

  it("keeps a cached run that has folded more events than the thread's copy", async () => {
    client.setQueryData(keys.run("ws1", "r1"), makeRun({ stage: "render", phase: "present", last_event_id: 9 }));
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    routes[`GET ${RUNS}/r1`] = () => ({ body: makeRun() });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.activeRun?.stage).toBe("render"));
    expect(streams[0]?.init.headers?.["last-event-id"]).toBe("9");
  });

  it("moves a cached run forward to a fresher thread copy", async () => {
    client.setQueryData(keys.run("ws1", "r1"), makeRun({ stage: "ground", last_event_id: 2 }));
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun({ stage: "query", last_event_id: 7 })]) });
    routes[`GET ${RUNS}/r1`] = () => ({ body: makeRun({ stage: "query", last_event_id: 7 }) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.activeRun?.stage).toBe("query"));
    await waitFor(() => expect(client.getQueryData<RunView>(keys.run("ws1", "r1"))?.last_event_id).toBe(7));
  });

  it("leaves one live stream under StrictMode's double mount", async () => {
    // StrictMode at the root, and the run cached before mount, so the stream opens
    // in the mount effect that StrictMode runs, cleans up and runs again.
    const thread = makeThread([done, makeRun()]);
    client.setQueryData(keys.thread("ws1", "t1"), thread);
    client.setQueryData(keys.run("ws1", "r1"), makeRun());
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor(), reactStrictMode: true });
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[0]?.init.signal?.aborted).toBe(true);
    expect(streams.filter((s) => !s.init.signal?.aborted)).toHaveLength(1);
  });

  it("opens the stream again after the server refused it while the run still works", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    routes[`GET ${RUNS}/r1`] = () => ({
      body: makeRun({ phase: "analyse", stage: "query", last_event_id: 4 }),
    });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(result.current.streamError).toBeNull();

    // A 404 (the backend lost the run's event log): the library stops for good.
    expect(await respond(streams[0] as Stream, new Response("", { status: 404 }))).toBeNull();
    await waitFor(() => expect(result.current.streamError?.message).toMatch(/404/));
    // Meanwhile the run itself is refetched, so the view does not freeze.
    await waitFor(() => expect(result.current.activeRun?.stage).toBe("query"));

    await waitFor(() => expect(streams).toHaveLength(2), { timeout: 3_000 });
    const reopened = streams[1] as Stream;
    expect(reopened.init.headers?.["last-event-id"]).toBe("4");
    await respond(reopened, eventStream());
    expect(result.current.streamError).toBeNull();
    send(5, { type: "stage.started", run_id: "r1", phase: "present", stage: "render", at: "2026-10-24T12:00:08.000Z" });
    await waitFor(() => expect(result.current.activeRun?.stage).toBe("render"));
  });

  it("lets go after a refused stream when the refetched run has ended", async () => {
    let thread = makeThread([done, makeRun()]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    const ended = makeRun({ status: "complete", finished_at: "2026-10-24T12:00:09.000Z", last_event_id: 6 });
    routes[`GET ${RUNS}/r1`] = () => ({ body: ended });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    thread = makeThread([done, ended]);
    const before = callsTo("GET", THREAD_PATH);
    await respond(streams[0] as Stream, new Response("", { status: 401 }));
    await waitFor(() => expect(result.current.activeRun).toBeNull());
    expect(result.current.turns[1]?.summary.status).toBe("complete");
    expect(result.current.streamError).toBeNull();
    await waitFor(() => expect(callsTo("GET", THREAD_PATH)).toBe(before + 1));
    expect(streams).toHaveLength(1);
    // The run it just fetched is not fetched again.
    expect(callsTo("GET", `${RUNS}/r1`)).toBe(1);
  });

  it("closes the old run's stream when a revision's run appears, and drops the old run's late frames", async () => {
    const r2 = makeRun({
      id: "r2",
      revision: 2,
      prompt: "and the south",
      status: "queued",
      phase: null,
      stage: null,
      started_at: null,
      last_event_id: 1,
    });
    let thread = makeThread([done, makeRun()]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    routes[`GET ${RUNS}/r2`] = () => ({ body: r2 });
    routes[`POST ${THREAD_PATH}/revisions`] = () => {
      // Superseding is cooperative: the copy can still show the old run running.
      thread = makeThread([done, makeRun(), r2]);
      return { status: 202, body: { thread_id: "t1", run_id: "r2" } };
    };
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), revise: useRevise("ws1", "t1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    const old = streams[0] as Stream;

    act(() => result.current.revise.mutate({ message: "and the south" }));
    await waitFor(() => expect(result.current.live.activeRun?.id).toBe("r2"));
    expect(old.init.signal?.aborted).toBe(true);
    expect(streams).toHaveLength(2);
    const fresh = streams[1] as Stream;
    expect(fresh.url).toBe("/api/v1/workspaces/ws1/runs/r2/events");
    expect(fresh.init.headers?.["last-event-id"]).toBe("1");
    expect(result.current.live.turns.map((t) => [t.summary.id, t.summary.status])).toEqual([
      ["r0", "complete"],
      ["r1", "superseded"],
      ["r2", "queued"],
    ]);

    // The old run keeps talking for a while; none of it lands anywhere.
    const oldRun = client.getQueryData<RunView>(keys.run("ws1", "r1"));
    send(4, { type: "restatement", run_id: "r1", text: "late" }, old);
    send(5, { type: "run.status", run_id: "r1", status: "superseded" }, old);
    expect(client.getQueryData<RunView>(keys.run("ws1", "r1"))).toBe(oldRun);
    // Nor does an old run's frame on the new run's stream.
    send(2, { type: "restatement", run_id: "r1", text: "late" }, fresh);
    const active = client.getQueryData<RunView>(keys.run("ws1", "r2"));
    expect(active?.restatement).toBeNull();
    expect(active?.last_event_id).toBe(1);
    expect(fresh.init.signal?.aborted).toBe(false);

    send(2, { type: "restatement", run_id: "r2", text: "Net revenue, north and south" }, fresh);
    await waitFor(() => expect(result.current.live.activeRun?.restatement).toBe("Net revenue, north and south"));
    expect(result.current.live.turns[1]?.summary.restatement).toBeNull();
    expect(result.current.live.turns[1]?.run).toBeNull();
  });

  it("lets go of a superseded run and follows the run that replaced it", async () => {
    let thread = makeThread([done, makeRun()]);
    const held: (() => void)[] = [];
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    // The thread refetch the end triggers is held, to see the state in between.
    const superseded = makeRun({ status: "superseded", finished_at: "2026-10-24T12:00:05.000Z", last_event_id: 4 });
    const r2 = makeRun({ id: "r2", revision: 2, prompt: "and the south", last_event_id: 2 });
    thread = makeThread([done, superseded, r2]);
    routes[`GET ${RUNS}/r1`] = () => ({ body: superseded });
    routes[`GET ${THREAD_PATH}`] = () => new Promise<Reply>((resolve) => held.push(() => resolve({ body: thread })));
    send(4, { type: "run.status", run_id: "r1", status: "superseded" });

    expect(streams[0]?.init.signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.activeRun).toBeNull());
    expect(result.current.turns[1]?.run?.status).toBe("superseded");
    expect(result.current.turns[1]?.summary.finished_at).not.toBeNull();

    await waitFor(() => expect(held).toHaveLength(1));
    act(() => held[0]?.());
    await waitFor(() => expect(result.current.activeRun?.id).toBe("r2"));
    expect(streams).toHaveLength(2);
    expect(streams[1]?.url).toBe("/api/v1/workspaces/ws1/runs/r2/events");
    expect(result.current.turns.map((t) => t.summary.status)).toEqual(["complete", "superseded", "running"]);
  });

  it("never makes an earlier run active while the copy still shows it open", async () => {
    const r2 = makeRun({ id: "r2", revision: 2, status: "complete", finished_at: "2026-10-24T12:00:09.000Z", last_event_id: 9 });
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun(), r2]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.thread).toBeDefined());
    expect(result.current.activeRun).toBeNull();
    expect(result.current.turns.map((t) => [t.summary.id, t.summary.status])).toEqual([
      ["r0", "complete"],
      ["r1", "superseded"],
      ["r2", "complete"],
    ]);
    expect(streams).toHaveLength(0);
  });

  it("keeps following a run a worker restarted, its trace started over", async () => {
    const timings = [{ phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: null }];
    const run = makeRun({ timings, restatement: "Net revenue, north only" });
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, run]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    send(4, { type: "run.status", run_id: "r1", status: "queued" });
    await waitFor(() => expect(result.current.activeRun?.status).toBe("queued"));
    expect(result.current.activeRun).toMatchObject({
      timings: [],
      steps: [],
      step: null,
      phase: null,
      stage: null,
      restatement: "Net revenue, north only",
    });
    expect(streams[0]?.init.signal?.aborted).toBe(false);

    send(5, { type: "run.status", run_id: "r1", status: "running" });
    send(6, { type: "stage.started", run_id: "r1", phase: "understand", stage: "ground", at: "2026-10-24T12:00:20.000Z" });
    await waitFor(() => expect(result.current.activeRun?.stage).toBe("ground"));
    expect(result.current.activeRun?.timings.map((t) => t.started_at)).toEqual(["2026-10-24T12:00:20.000Z"]);
    expect(streams).toHaveLength(1);
  });

  it("follows a finished run again when a chart pick queues it under the same id", async () => {
    let thread = makeThread([done]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    routes[`GET ${RUNS}/r0`] = () => ({ body: thread.latest });
    routes[`POST ${RUNS}/r0/chart`] = async (request) => {
      expect(await request.json()).toEqual({ chart: "dot_plot" });
      thread = makeThread([{ ...done, status: "queued", finished_at: null, last_event_id: 13 }]);
      return { status: 202, body: { thread_id: "t1", run_id: "r0" } };
    };
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), pick: usePickChart("ws1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.live.thread).toBeDefined());
    expect(result.current.live.activeRun).toBeNull();
    expect(streams).toHaveLength(0);

    act(() => result.current.pick.mutate({ runId: "r0", chart: "dot_plot" }));
    await waitFor(() => expect(result.current.live.activeRun?.status).toBe("queued"));
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]?.url).toBe("/api/v1/workspaces/ws1/runs/r0/events");
    expect(streams[0]?.init.headers?.["last-event-id"]).toBe("13");

    send(14, { type: "run.status", run_id: "r0", status: "running" });
    send(15, { type: "stage.started", run_id: "r0", phase: "present", stage: "render", at: "2026-10-24T12:01:00.000Z" });
    await waitFor(() => expect(result.current.live.activeRun?.stage).toBe("render"));
  });

  it("closes the stream when the hook unmounts", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    const { unmount } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));
    unmount();
    expect(streams[0]?.init.signal?.aborted).toBe(true);
  });

  describe("expand", () => {
    const r1 = makeRun({ status: "complete", finished_at: "2026-10-24T12:00:09.000Z", last_event_id: 9 });
    const r2 = makeRun({ id: "r2", revision: 2, prompt: "and the south", status: "complete", last_event_id: 8 });

    it("unfolds an earlier turn once, and is stable and idempotent", async () => {
      routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, r1, r2]) });
      routes[`GET ${RUNS}/r0`] = () => ({ body: done });
      const { result, rerender } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
      await waitFor(() => expect(result.current.thread).toBeDefined());
      expect(result.current.turns.map((t) => t.run?.id ?? null)).toEqual([null, null, "r2"]);
      const { expand } = result.current;

      act(() => expand("r0"));
      // Loading: the turn has no run yet.
      expect(result.current.turns[0]?.run).toBeNull();
      await waitFor(() => expect(result.current.turns[0]?.run).toEqual(done));
      expect(result.current.turns[1]?.run).toBeNull();

      act(() => result.current.expand("r0"));
      rerender();
      expect(result.current.expand).toBe(expand);
      expect(callsTo("GET", `${RUNS}/r0`)).toBe(1);
      // The latest is unfolded already: asking for it fetches nothing.
      act(() => expand("r2"));
      await act(() => Promise.resolve());
      expect(callsTo("GET", `${RUNS}/r2`)).toBe(0);
      expect(result.current.turns[2]?.run).toEqual(r2);
    });

    it("shows an unfolded earlier run that still reads open as superseded, ended like the stream would end it", async () => {
      const step = { id: "s1", label: "the prior period" };
      const running = makeRun({
        phase: "analyse",
        stage: "analyse",
        step,
        steps: [
          {
            ...step,
            role: "comparison",
            stage: "analyse",
            started_at: "2026-10-24T12:00:04.000Z",
            elapsed_ms: null,
            verdict: null,
            cached: false,
            sql: null,
            row_count: null,
          },
        ],
      });
      const queued = makeRun({ id: "r2", revision: 2, status: "queued", phase: null, stage: null, started_at: null, last_event_id: 1 });
      const thread = { ...makeThread([done, running, queued]), updated_at: "2026-10-24T12:00:06.000Z" };
      routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
      routes[`GET ${RUNS}/r1`] = () => ({ body: running });
      const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
      await waitFor(() => expect(result.current.activeRun?.id).toBe("r2"));

      act(() => result.current.expand("r1"));
      await waitFor(() => expect(result.current.turns[1]?.run?.id).toBe("r1"));
      // Terminal: no step under way, and an end, the thread's last move standing in for it.
      expect(result.current.turns[1]?.run).toMatchObject({
        status: "superseded",
        step: null,
        finished_at: "2026-10-24T12:00:06.000Z",
      });
      expect(result.current.turns[1]?.run?.steps).toEqual(running.steps);
      expect(result.current.turns[1]?.summary).toMatchObject({
        status: "superseded",
        finished_at: "2026-10-24T12:00:06.000Z",
      });
      // Only the latest run is followed.
      expect(streams.map((s) => s.url)).toEqual(["/api/v1/workspaces/ws1/runs/r2/events"]);
    });

    it("remembers nothing asked for the latest run or a run not the thread's, so neither unfolds later", async () => {
      let thread = makeThread([done, r1]);
      routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
      routes[`GET ${RUNS}/r1`] = () => ({ body: r1 });
      routes[`GET ${RUNS}/elsewhere`] = () => ({ body: makeRun({ id: "elsewhere" }) });
      const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
      await waitFor(() => expect(result.current.thread).toBeDefined());
      act(() => result.current.expand("r1"));
      act(() => result.current.expand("elsewhere"));

      // A newer run arrives: r1 is an earlier turn now, and stays folded.
      thread = makeThread([done, r1, r2]);
      await act(() => client.refetchQueries({ queryKey: keys.thread("ws1", "t1") }));
      await waitFor(() => expect(result.current.turns).toHaveLength(3));
      await act(() => Promise.resolve());
      expect(callsTo("GET", `${RUNS}/r1`)).toBe(0);
      expect(result.current.turns.map((t) => t.run?.id ?? null)).toEqual([null, null, "r2"]);

      // Asked for now, it unfolds.
      act(() => result.current.expand("r1"));
      await waitFor(() => expect(result.current.turns[1]?.run).toEqual(r1));
    });

    it("ignores a run that is not the thread's", async () => {
      routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, r1]) });
      const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
      await waitFor(() => expect(result.current.thread).toBeDefined());
      act(() => result.current.expand("elsewhere"));
      await act(() => Promise.resolve());
      expect(callsTo("GET", `${RUNS}/elsewhere`)).toBe(0);
      expect(result.current.turns.map((t) => t.summary.id)).toEqual(["r0", "r1"]);
    });
  });
});

describe("the event stream's retry policy", () => {
  async function openStream() {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([makeRun()]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));
    return { stream: streams[0] as Stream, live: result };
  }

  it("accepts an event stream", async () => {
    const { stream } = await openStream();
    const ok = new Response("", { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
    expect(await respond(stream, ok)).toBeUndefined();
  });

  it("stops on a 4xx or a response that is not an event stream", async () => {
    const { stream } = await openStream();
    expect(await respond(stream, new Response("", { status: 404 }))).toBeNull();
    const html = new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
    expect(await respond(stream, html)).toBeNull();
  });

  it("backs off and retries on a 5xx or a dropped connection, and says why it is down", async () => {
    const { stream, live } = await openStream();
    expect(await respond(stream, new Response("", { status: 503 }))).toBe(1_000);
    expect(live.current.streamError?.message).toMatch(/503/);
    let retryIn: number | null | undefined;
    act(() => {
      retryIn = stream.init.onerror?.(new TypeError("network")) as number | undefined;
    });
    expect(retryIn).toBe(2_000);
    await respond(stream, eventStream());
    expect(live.current.streamError).toBeNull();
  });
});

describe("useRunStep", () => {
  const STEP = `${RUNS}/r1/steps/s1`;
  const stepResult: StepResult = {
    step_id: "s1",
    label: "the prior period",
    sql: "select region, sum(amount) from sales where quarter = 'Q2' group by 1",
    columns: [],
    rows: [["North", 10]],
    row_count: 1,
    truncated: false,
  };

  const record = (overrides: Partial<StepRecord> = {}): StepRecord => ({
    id: "s1",
    label: "the prior period",
    role: "comparison",
    stage: "analyse",
    started_at: "2026-10-24T12:00:04.000Z",
    elapsed_ms: 800,
    verdict: "as_expected",
    cached: false,
    sql: stepResult.sql,
    row_count: 1,
    ...overrides,
  });
  /** The stale time the step query's observer goes by, resolved for the query. */
  const staleTimeOf = () => {
    const query = client.getQueryCache().find({ queryKey: keys.step("ws1", "r1", "s1") });
    const option = query?.observers[0]?.options.staleTime;
    return typeof option === "function" && query ? option(query as never) : option;
  };

  it("stays idle until both ids are set, then fetches the step once", async () => {
    routes[`GET ${STEP}`] = () => ({ body: stepResult });
    const { result, rerender } = renderHook(
      ({ runId, stepId }: { runId: string | null; stepId: string | null }) => useRunStep("ws1", runId, stepId),
      { wrapper: wrapperFor(), initialProps: { runId: "r1" as string | null, stepId: null as string | null } },
    );
    await act(() => Promise.resolve());
    expect(result.current.fetchStatus).toBe("idle");
    rerender({ runId: null, stepId: "s1" });
    await act(() => Promise.resolve());
    expect(requests).toHaveLength(0);

    rerender({ runId: "r1", stepId: "s1" });
    await waitFor(() => expect(result.current.data).toEqual(stepResult));
    expect(client.getQueryData(keys.step("ws1", "r1", "s1"))).toEqual(stepResult);
    // Nothing tells whether the step had ended: the client's usual stale time.
    expect(staleTimeOf()).toBe(5_000);
  });

  it("keeps a step's rows for good once fetched after the step ended", async () => {
    client.setQueryData(keys.run("ws1", "r1"), makeRun({ steps: [record()] }));
    routes[`GET ${STEP}`] = () => ({ body: stepResult });
    const { result, unmount } = renderHook(() => useRunStep("ws1", "r1", "s1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.data).toEqual(stepResult));
    expect(staleTimeOf()).toBe(Infinity);
    unmount();

    renderHook(() => useRunStep("ws1", "r1", "s1"), { wrapper: wrapperFor() });
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(callsTo("GET", STEP)).toBe(1);
  });

  it("fetches a step again when it ends while shown, the rows fetched while it ran being stale", async () => {
    client.setQueryData(keys.run("ws1", "r1"), makeRun({ step: { id: "s1", label: "the prior period" }, steps: [record({ elapsed_ms: null, verdict: null, sql: null, row_count: null })] }));
    const running: StepResult = { ...stepResult, sql: null, rows: [], row_count: 0 };
    let reply = running;
    routes[`GET ${STEP}`] = () => ({ body: reply });
    const { result } = renderHook(() => useRunStep("ws1", "r1", "s1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.data).toEqual(running));
    expect(staleTimeOf()).toBe(5_000);

    reply = stepResult;
    act(() => {
      client.setQueryData(keys.run("ws1", "r1"), makeRun({ steps: [record()], last_event_id: 4 }));
    });
    await waitFor(() => expect(result.current.data).toEqual(stepResult));
    expect(callsTo("GET", STEP)).toBe(2);
    expect(staleTimeOf()).toBe(Infinity);
  });

  it("counts every step of an ended run as ended, a cut-off one too", async () => {
    client.setQueryData(
      keys.run("ws1", "r1"),
      makeRun({ status: "cancelled", finished_at: "2026-10-24T12:00:05.000Z", steps: [record({ elapsed_ms: null, verdict: null, sql: null, row_count: null })] }),
    );
    routes[`GET ${STEP}`] = () => ({ body: { ...stepResult, sql: null, rows: [], row_count: 0 } });
    const { result } = renderHook(() => useRunStep("ws1", "r1", "s1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleTimeOf()).toBe(Infinity);
    expect(callsTo("GET", STEP)).toBe(1);
  });

  it("fails with no_step as an ApiError, and does not retry", async () => {
    routes[`GET ${STEP}`] = () => ({ status: 404, body: { detail: "No such step.", code: "no_step" } });
    const { result } = renderHook(() => useRunStep("ws1", "r1", "s1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error).toMatchObject({ status: 404, code: "no_step" });
    expect(callsTo("GET", STEP)).toBe(1);
  });
});

describe("useThreadOpened", () => {
  const SIGNALS = "/api/v1/workspaces/ws1/signals";

  it("sends thread_opened once per mount and thread, StrictMode's double mount included", async () => {
    routes[`POST ${SIGNALS}`] = () => ({ status: 204 });
    const { rerender, unmount } = renderHook(({ id }: { id: string }) => useThreadOpened("ws1", id), {
      wrapper: wrapperFor(),
      initialProps: { id: "t1" },
      reactStrictMode: true,
    });
    await waitFor(() => expect(callsTo("POST", SIGNALS)).toBe(1));
    rerender({ id: "t1" });
    await act(() => Promise.resolve());
    expect(callsTo("POST", SIGNALS)).toBe(1);

    rerender({ id: "t2" });
    await waitFor(() => expect(callsTo("POST", SIGNALS)).toBe(2));
    expect(await bodiesTo("POST", SIGNALS)).toEqual([
      { kind: "thread_opened", thread_id: "t1" },
      { kind: "thread_opened", thread_id: "t2" },
    ]);
    unmount();

    // Opened again later: a new mount tells it again.
    renderHook(() => useThreadOpened("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(callsTo("POST", SIGNALS)).toBe(3));
  });

  it("forgets a failure, never retrying it, and sends nothing without a thread", async () => {
    routes[`POST ${SIGNALS}`] = () => ({ status: 500, body: { detail: "storage is down" } });
    const { rerender } = renderHook(({ id }: { id: string }) => useThreadOpened("ws1", id), {
      wrapper: wrapperFor(),
      initialProps: { id: "" },
    });
    await act(() => Promise.resolve());
    expect(requests).toHaveLength(0);

    rerender({ id: "t1" });
    await waitFor(() => expect(callsTo("POST", SIGNALS)).toBe(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(callsTo("POST", SIGNALS)).toBe(1);

    // A dropped connection is no unhandled rejection either.
    routes[`POST ${SIGNALS}`] = () => {
      throw new TypeError("Failed to fetch");
    };
    rerender({ id: "t2" });
    await waitFor(() => expect(callsTo("POST", SIGNALS)).toBe(2));
  });
});

describe("mutations", () => {
  it("rates a run optimistically, in its summary and the latest run, and puts the rating back when the server refuses", async () => {
    client.setQueryData(keys.thread("ws1", "t1"), makeThread([done]));
    let refuse: (reply: Reply) => void = () => {};
    routes[`POST ${RUNS}/r0/feedback`] = () => new Promise<Reply>((resolve) => (refuse = resolve));
    const { result } = renderHook(() => useFeedback("ws1"), { wrapper: wrapperFor() });
    const cached = () => client.getQueryData<Thread>(keys.thread("ws1", "t1"));

    act(() => result.current.mutate({ runId: "r0", rating: "up" }));
    await waitFor(() => expect(cached()?.runs[0]?.feedback).toBe("up"));
    expect(cached()?.latest.feedback).toBe("up");

    refuse({ status: 500, body: { detail: "storage is down" } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("storage is down");
    expect(cached()?.runs[0]?.feedback).toBeNull();
    expect(cached()?.latest.feedback).toBeNull();
  });

  it("rates an earlier run in its summary alone", async () => {
    const r1 = makeRun({ status: "complete", last_event_id: 9 });
    client.setQueryData(keys.thread("ws1", "t1"), makeThread([done, r1]));
    routes[`POST ${RUNS}/r0/feedback`] = () => new Promise<Reply>(() => {});
    const { result } = renderHook(() => useFeedback("ws1"), { wrapper: wrapperFor() });
    const before = client.getQueryData<Thread>(keys.thread("ws1", "t1"));

    act(() => result.current.mutate({ runId: "r0", rating: "down" }));
    await waitFor(() => expect(client.getQueryData<Thread>(keys.thread("ws1", "t1"))?.runs[0]?.feedback).toBe("down"));
    const after = client.getQueryData<Thread>(keys.thread("ws1", "t1"));
    expect(after?.latest).toBe(before?.latest);
    expect(after?.runs[1]).toBe(before?.runs[1]);
  });

  it("keeps the frames the stream folded while a refused rating was out", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    routes[`GET ${RUNS}/r1`] = () => ({ body: makeRun() });
    let refuse: (reply: Reply) => void = () => {};
    routes[`POST ${RUNS}/r1/feedback`] = () => new Promise<Reply>((resolve) => (refuse = resolve));
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), rate: useFeedback("ws1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(streams).toHaveLength(1));

    act(() => result.current.rate.mutate({ runId: "r1", rating: "down" }));
    await waitFor(() => expect(result.current.live.activeRun?.feedback).toBe("down"));
    expect(result.current.live.turns[1]?.summary.feedback).toBe("down");
    send(4, { type: "restatement", run_id: "r1", text: "Net revenue, north only" });

    refuse({ status: 500, body: { detail: "storage is down" } });
    await waitFor(() => expect(result.current.rate.isError).toBe(true));
    const run = client.getQueryData<RunView>(keys.run("ws1", "r1"));
    expect(run?.feedback).toBeNull();
    expect(run?.last_event_id).toBe(4);
    expect(run?.restatement).toBe("Net revenue, north only");
    expect(client.getQueryData<Thread>(keys.thread("ws1", "t1"))?.runs[1]?.feedback).toBeNull();
    expect(result.current.live.activeRun?.restatement).toBe("Net revenue, north only");
    expect(streams[0]?.init.signal?.aborted).toBe(false);
  });

  it("keeps a revision sent while a refused rating was out, and refetches", async () => {
    let thread = makeThread([done]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    let refuse: (reply: Reply) => void = () => {};
    routes[`POST ${RUNS}/r0/feedback`] = () => new Promise<Reply>((resolve) => (refuse = resolve));
    routes[`POST ${THREAD_PATH}/revisions`] = () => {
      thread = makeThread([done, makeRun()]);
      return { status: 202, body: { thread_id: "t1", run_id: "r1" } };
    };
    const { result } = renderHook(
      () => ({ live: useLiveThread("ws1", "t1"), rate: useFeedback("ws1"), revise: useRevise("ws1", "t1") }),
      { wrapper: wrapperFor() },
    );
    await waitFor(() => expect(result.current.live.thread).toBeDefined());

    act(() => result.current.rate.mutate({ runId: "r0", rating: "up" }));
    await waitFor(() => expect(result.current.live.turns[0]?.summary.feedback).toBe("up"));
    act(() => result.current.revise.mutate({ message: "only the north" }));
    await waitFor(() => expect(result.current.live.activeRun?.id).toBe("r1"));
    expect(streams).toHaveLength(1);

    const before = callsTo("GET", THREAD_PATH);
    refuse({ status: 500, body: { detail: "storage is down" } });
    await waitFor(() => expect(result.current.rate.isError).toBe(true));
    expect(result.current.live.turns.map((t) => t.summary.id)).toEqual(["r0", "r1"]);
    expect(result.current.live.turns[0]?.summary.feedback).toBeNull();
    expect(result.current.live.activeRun?.id).toBe("r1");
    expect(streams.filter((s) => !s.init.signal?.aborted)).toHaveLength(1);
    // Settled either way, the thread is fetched again to match the server.
    expect(callsTo("GET", THREAD_PATH)).toBe(before + 1);
  });

  it("does not undo a newer rating when an older one is refused", async () => {
    client.setQueryData(keys.thread("ws1", "t1"), makeThread([done]));
    const pending: ((reply: Reply) => void)[] = [];
    routes[`POST ${RUNS}/r0/feedback`] = () => new Promise<Reply>((resolve) => pending.push(resolve));
    const { result } = renderHook(() => ({ first: useFeedback("ws1"), second: useFeedback("ws1") }), {
      wrapper: wrapperFor(),
    });
    const rating = () => client.getQueryData<Thread>(keys.thread("ws1", "t1"))?.runs[0]?.feedback;

    act(() => result.current.first.mutate({ runId: "r0", rating: "up" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => result.current.second.mutate({ runId: "r0", rating: "down" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(rating()).toBe("down");

    pending[0]?.({ status: 500, body: { detail: "storage is down" } });
    await waitFor(() => expect(result.current.first.isError).toBe(true));
    expect(rating()).toBe("down");
  });

  it("sends a revision exactly as given: typed, a nearest question, a follow-up", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done]) });
    routes[`POST ${THREAD_PATH}/revisions`] = () => ({ status: 202, body: { thread_id: "t1", run_id: "r1" } });
    const { result } = renderHook(() => useRevise("ws1", "t1"), { wrapper: wrapperFor() });

    await act(() => result.current.mutateAsync({ message: "only the north" }));
    await act(() => result.current.mutateAsync({ message: "only the north", via: "composer" }));
    await act(() => result.current.mutateAsync({ message: "Downtime minutes by plant", via: "nearest" }));
    await act(() =>
      result.current.mutateAsync({
        message: "Revenue by plant in the north",
        follows: { run_id: "r0", follow_up_id: "f1" },
        via: undefined,
      }),
    );
    expect(await bodiesTo("POST", `${THREAD_PATH}/revisions`)).toEqual([
      { message: "only the north" },
      { message: "only the north", via: "composer" },
      { message: "Downtime minutes by plant", via: "nearest" },
      { message: "Revenue by plant in the north", follows: { run_id: "r0", follow_up_id: "f1" } },
    ]);
  });

  it("catches the thread up when a follow-up is refused as not the latest", async () => {
    let thread = makeThread([done]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    routes[`POST ${THREAD_PATH}/revisions`] = () => ({
      status: 409,
      body: { detail: "Run r0 is not the latest", code: "not_latest" },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), revise: useRevise("ws1", "t1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.live.thread).toBeDefined());
    // Another tab sent a revision meanwhile.
    thread = makeThread([done, makeRun()]);

    act(() =>
      result.current.revise.mutate({ message: "Revenue by plant", follows: { run_id: "r0", follow_up_id: "f1" } }),
    );
    await waitFor(() => expect(result.current.revise.isError).toBe(true));
    expect(result.current.revise.error).toMatchObject({ status: 409, code: "not_latest" });
    expect(result.current.live.turns.map((t) => t.summary.id)).toEqual(["r0", "r1"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.run("ws1", "r0") });
  });

  it("catches the thread up when a follow-up or a nearest question is no longer answerable", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done]) });
    routes[`POST ${THREAD_PATH}/revisions`] = () => ({
      status: 409,
      body: { detail: "That question is not on offer any more.", code: "not_answerable" },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), revise: useRevise("ws1", "t1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.live.thread).toBeDefined());
    const refused = async (variables: Parameters<typeof result.current.revise.mutateAsync>[0]) => {
      let error: unknown = null;
      await act(() => result.current.revise.mutateAsync(variables).catch((e: unknown) => void (error = e)));
      return error;
    };

    // A follow-up id the run no longer offers: the thread and the run that offered it catch up.
    let before = callsTo("GET", THREAD_PATH);
    expect(await refused({ message: "Revenue by plant", follows: { run_id: "r0", follow_up_id: "f9" } })).toMatchObject({
      status: 409,
      code: "not_answerable",
    });
    expect(callsTo("GET", THREAD_PATH)).toBe(before + 1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.run("ws1", "r0") });

    // A nearest question sent to a run that is not a clarify run: the thread catches up, no run is named.
    invalidate.mockClear();
    before = callsTo("GET", THREAD_PATH);
    expect(await refused({ message: "Downtime minutes by plant", via: "nearest" })).toMatchObject({ code: "not_answerable" });
    expect(callsTo("GET", THREAD_PATH)).toBe(before + 1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["thread", "ws1"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: keys.run("ws1", "r0") });
  });

  it("catches the thread up when a chart pick is refused as not the latest, and on no other failure", async () => {
    let thread = makeThread([done]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    let reply: Reply = { status: 409, body: { detail: "Run r0 is not the latest", code: "not_latest" } };
    routes[`POST ${RUNS}/r0/chart`] = () => reply;
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), pick: usePickChart("ws1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.live.thread).toBeDefined());
    // Another tab revised the thread meanwhile.
    thread = makeThread([done, makeRun()]);

    act(() => result.current.pick.mutate({ runId: "r0", chart: "bar" }));
    await waitFor(() => expect(result.current.pick.isError).toBe(true));
    expect(result.current.pick.error).toMatchObject({ status: 409, code: "not_latest" });
    // Settled once the thread is back: the newer revision shows with the refusal.
    expect(result.current.live.turns.map((t) => t.summary.id)).toEqual(["r0", "r1"]);

    for (const other of [
      { status: 500, body: { detail: "storage is down" } },
      { status: 409, body: { detail: "Not allowed.", code: "not_allowed" } },
      { status: 409, body: { detail: "Conflict." } },
    ]) {
      const before = callsTo("GET", THREAD_PATH);
      reply = other;
      act(() => result.current.pick.mutate({ runId: "r0", chart: "bar" }));
      await waitFor(() => expect(result.current.pick.error?.message).toBe(other.body.detail));
      expect(callsTo("GET", THREAD_PATH)).toBe(before);
    }
  });

  it("catches the thread up when an answer meets a stale run, and keeps the prompt to ask again with", async () => {
    let thread = makeThread([done]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    routes[`POST ${RUNS}/r0/answers`] = () => ({
      status: 409,
      body: {
        detail: "This answer was made by an earlier version of sightline.",
        code: "stale_run",
        errors: [{ loc: ["path", "run_id"], msg: "stale", type: "stale_run", ctx: { prompt: "Revenue by region" } }],
      },
    });
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), answer: useAnswer("ws1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.live.thread).toBeDefined());
    const before = callsTo("GET", THREAD_PATH);
    thread = makeThread([{ ...done, last_event_id: 13 }]);

    act(() => result.current.answer.mutate({ runId: "r0", answers: { p1: "net" } }));
    await waitFor(() => expect(result.current.answer.isError).toBe(true));
    const error = result.current.answer.error as ApiError;
    expect(error).toMatchObject({ status: 409, code: "stale_run" });
    expect(error.errors[0]?.ctx).toEqual({ prompt: "Revenue by region" });
    expect(callsTo("GET", THREAD_PATH)).toBe(before + 1);
  });

  it("refetches the run after an answer, so its stream can reopen", async () => {
    routes[`GET ${RUNS}/r1`] = () => ({ body: makeRun({ status: "asking" }) });
    routes[`POST ${RUNS}/r1/answers`] = async (request) => {
      expect(await request.json()).toEqual({ answers: { p1: null }, text: null });
      return { status: 202, body: { thread_id: "t1", run_id: "r1" } };
    };
    const { result } = renderHook(() => ({ run: useRun("ws1", "r1"), answer: useAnswer("ws1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.run.data?.status).toBe("asking"));
    routes[`GET ${RUNS}/r1`] = () => ({ body: makeRun({ status: "running", last_event_id: 4 }) });

    act(() => result.current.answer.mutate({ runId: "r1", answers: { p1: null } }));
    await waitFor(() => expect(result.current.answer.isSuccess).toBe(true));
    expect(result.current.run.data?.status).toBe("running");
    expect(callsTo("GET", `${RUNS}/r1`)).toBe(2);
  });
});
