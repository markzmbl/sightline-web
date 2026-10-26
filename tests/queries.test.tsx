import type { EventSourceMessage, FetchEventSourceInit } from "@microsoft/fetch-event-source";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setToken } from "../src/api/client";
import {
  createQueryClient,
  keys,
  useAnswer,
  useFeedback,
  useLiveThread,
  usePickChart,
  useRevise,
  useRun,
  useThread,
  useThreads,
} from "../src/api/queries";
import type { RunEvent, RunView, Thread, ThreadSummary } from "../src/api/types";

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
}
type Handler = (request: Request) => Reply | Promise<Reply>;
let routes: Record<string, Handler> = {};
const requests: Request[] = [];

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  requests.push(request);
  const { pathname } = new URL(request.url);
  const handler = routes[`${request.method} ${pathname}`];
  const { status = 200, body } = handler ? await handler(request) : { status: 404, body: { detail: `no route ${pathname}` } };
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
});

const callsTo = (method: string, pathname: string) =>
  requests.filter((r) => r.method === method && new URL(r.url).pathname === pathname).length;

function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    thread_id: "t1",
    revision: 1,
    prompt: "only the north",
    status: "running",
    phase: "understand",
    stage: "ground",
    started_at: "2026-10-24T12:00:00.000Z",
    finished_at: null,
    restatement: null,
    card: null,
    clarify: null,
    result: null,
    timings: [],
    error: null,
    feedback: null,
    last_event_id: 3,
    ...overrides,
  };
}

const done = makeRun({
  id: "r0",
  revision: 0,
  prompt: "Revenue by region",
  status: "complete",
  finished_at: "2026-10-24T11:59:00.000Z",
  last_event_id: 12,
});

function makeThread(runs: RunView[]): Thread {
  return {
    id: "t1",
    question: "Revenue by region",
    created_at: "2026-10-24T11:58:00.000Z",
    updated_at: "2026-10-24T12:00:00.000Z",
    runs,
  };
}

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

  it("lists the first page's items, sending no Authorization header (v1 has no auth)", async () => {
    routes["GET /api/v1/workspaces/ws1/threads"] = () => ({ body: { items, next_cursor: "c2" } });
    const { result } = renderHook(() => useThreads("ws1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.data).toEqual(items));
    const request = requests[0];
    expect(new URL(request?.url ?? "").searchParams.get("limit")).toBe("100");
    expect(request?.headers.has("Authorization")).toBe(false);
  });

  it("polls only while a thread is open", async () => {
    routes["GET /api/v1/workspaces/ws1/threads"] = () => ({ body: { items, next_cursor: null } });
    const { result } = renderHook(() => useThreads("ws1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = client.getQueryCache().find({ queryKey: keys.threads("ws1") });
    const interval = query?.observers[0]?.options.refetchInterval;
    if (typeof interval !== "function" || !query) throw new Error("expected a refetchInterval function");
    expect(interval(query as never)).toBe(10_000);
    client.setQueryData(keys.threads("ws1"), items.slice(1));
    expect(interval(query as never)).toBe(false);
  });
});

describe("useThread", () => {
  it("fails with the server's detail and does not retry a 4xx", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ status: 404, body: { detail: "no such thread" } });
    const { result } = renderHook(() => useThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.message).toBe("no such thread");
    expect((result.current.error as ApiError).status).toBe(404);
    expect(callsTo("GET", THREAD_PATH)).toBe(1);
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
  it("picks the last open run and follows its stream from where the view stands", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });

    await waitFor(() => expect(result.current.activeRun?.id).toBe("r1"));
    expect(result.current.runs.map((r) => r.id)).toEqual(["r0", "r1"]);
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
    expect(result.current.runs[1]?.phase).toBe("analyse");
    expect(cached()?.last_event_id).toBe(4);

    // The same id twice (a reconnect overlapping the last frame) folds once.
    send(4, { type: "restatement", run_id: "r1", text: "duplicate" });
    expect(cached()?.restatement).toBeNull();
    send(5, { type: "restatement", run_id: "r1", text: "Net revenue, north only" });
    await waitFor(() => expect(result.current.activeRun?.restatement).toBe("Net revenue, north only"));

    thread = makeThread([done, makeRun({ status: "complete", last_event_id: 6, finished_at: "2026-10-24T12:00:09.000Z" })]);
    const before = callsTo("GET", THREAD_PATH);
    send(6, { type: "run.status", run_id: "r1", status: "complete" });

    expect(streams[0]?.init.signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.activeRun).toBeNull());
    expect(result.current.runs[1]?.status).toBe("complete");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.thread("ws1", "t1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.threads("ws1") });
    await waitFor(() => expect(callsTo("GET", THREAD_PATH)).toBe(before + 1));
    await waitFor(() => expect(result.current.thread?.runs[1]?.status).toBe("complete"));
    expect(streams).toHaveLength(1);
  });

  it("shows an asking run as active without opening a stream", async () => {
    const asking = makeRun({ status: "asking", stage: "ask" });
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, asking]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.activeRun?.status).toBe("asking"));
    expect(streams).toHaveLength(0);
  });

  it("has no active run when every run has ended", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.thread).toBeDefined());
    expect(result.current.activeRun).toBeNull();
    expect(result.current.runs).toEqual([done]);
    expect(streams).toHaveLength(0);
  });

  it("keeps a cached run that has folded more events than the thread's copy", async () => {
    client.setQueryData(keys.run("ws1", "r1"), makeRun({ stage: "render", phase: "present", last_event_id: 9 }));
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    routes["GET /api/v1/workspaces/ws1/runs/r1"] = () => ({ body: makeRun() });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.activeRun?.stage).toBe("render"));
    expect(streams[0]?.init.headers?.["last-event-id"]).toBe("9");
  });

  it("moves a cached run forward to a fresher thread copy", async () => {
    client.setQueryData(keys.run("ws1", "r1"), makeRun({ stage: "ground", last_event_id: 2 }));
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun({ stage: "query", last_event_id: 7 })]) });
    routes["GET /api/v1/workspaces/ws1/runs/r1"] = () => ({ body: makeRun({ stage: "query", last_event_id: 7 }) });
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
    routes["GET /api/v1/workspaces/ws1/runs/r1"] = () => ({
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
    routes["GET /api/v1/workspaces/ws1/runs/r1"] = () => ({ body: ended });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(streams).toHaveLength(1));

    thread = makeThread([done, ended]);
    const before = callsTo("GET", THREAD_PATH);
    await respond(streams[0] as Stream, new Response("", { status: 401 }));
    await waitFor(() => expect(result.current.activeRun).toBeNull());
    expect(result.current.runs[1]?.status).toBe("complete");
    expect(result.current.streamError).toBeNull();
    await waitFor(() => expect(callsTo("GET", THREAD_PATH)).toBe(before + 1));
    expect(streams).toHaveLength(1);
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
    routes["GET /api/v1/workspaces/ws1/runs/r2"] = () => ({ body: r2 });
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
    expect(result.current.live.runs.map((r) => [r.id, r.status])).toEqual([
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
    expect(result.current.live.runs[1]?.restatement).toBeNull();
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
    routes[`GET ${THREAD_PATH}`] = () => new Promise<Reply>((resolve) => held.push(() => resolve({ body: thread })));
    send(4, { type: "run.status", run_id: "r1", status: "superseded" });

    expect(streams[0]?.init.signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.activeRun).toBeNull());
    expect(result.current.runs[1]?.status).toBe("superseded");
    expect(result.current.runs[1]?.finished_at).not.toBeNull();

    await waitFor(() => expect(held).toHaveLength(1));
    act(() => held[0]?.());
    await waitFor(() => expect(result.current.activeRun?.id).toBe("r2"));
    expect(streams).toHaveLength(2);
    expect(streams[1]?.url).toBe("/api/v1/workspaces/ws1/runs/r2/events");
    expect(result.current.runs.map((r) => r.status)).toEqual(["complete", "superseded", "running"]);
  });

  it("never makes an earlier run active while the copy still shows it open", async () => {
    const r2 = makeRun({ id: "r2", revision: 2, status: "complete", finished_at: "2026-10-24T12:00:09.000Z", last_event_id: 9 });
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun(), r2]) });
    const { result } = renderHook(() => useLiveThread("ws1", "t1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.thread).toBeDefined());
    expect(result.current.activeRun).toBeNull();
    expect(result.current.runs.map((r) => [r.id, r.status])).toEqual([
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
    routes["GET /api/v1/workspaces/ws1/runs/r0"] = () => ({ body: thread.runs[0] });
    routes["POST /api/v1/workspaces/ws1/runs/r0/chart"] = async (request) => {
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

describe("mutations", () => {
  it("rates a run optimistically and puts the rating back when the server refuses", async () => {
    client.setQueryData(keys.thread("ws1", "t1"), makeThread([done]));
    let refuse: (reply: Reply) => void = () => {};
    routes["POST /api/v1/workspaces/ws1/runs/r0/feedback"] = () => new Promise<Reply>((resolve) => (refuse = resolve));
    const { result } = renderHook(() => useFeedback("ws1"), { wrapper: wrapperFor() });

    act(() => result.current.mutate({ runId: "r0", rating: "up" }));
    await waitFor(() => expect(client.getQueryData<Thread>(keys.thread("ws1", "t1"))?.runs[0]?.feedback).toBe("up"));

    refuse({ status: 500, body: { detail: "storage is down" } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("storage is down");
    expect(client.getQueryData<Thread>(keys.thread("ws1", "t1"))?.runs[0]?.feedback).toBeNull();
  });

  it("keeps the frames the stream folded while a refused rating was out", async () => {
    routes[`GET ${THREAD_PATH}`] = () => ({ body: makeThread([done, makeRun()]) });
    routes["GET /api/v1/workspaces/ws1/runs/r1"] = () => ({ body: makeRun() });
    let refuse: (reply: Reply) => void = () => {};
    routes["POST /api/v1/workspaces/ws1/runs/r1/feedback"] = () => new Promise<Reply>((resolve) => (refuse = resolve));
    const { result } = renderHook(() => ({ live: useLiveThread("ws1", "t1"), rate: useFeedback("ws1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(streams).toHaveLength(1));

    act(() => result.current.rate.mutate({ runId: "r1", rating: "down" }));
    await waitFor(() => expect(result.current.live.activeRun?.feedback).toBe("down"));
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
    routes["POST /api/v1/workspaces/ws1/runs/r0/feedback"] = () => new Promise<Reply>((resolve) => (refuse = resolve));
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
    await waitFor(() => expect(result.current.live.runs[0]?.feedback).toBe("up"));
    act(() => result.current.revise.mutate({ message: "only the north" }));
    await waitFor(() => expect(result.current.live.activeRun?.id).toBe("r1"));
    expect(streams).toHaveLength(1);

    const before = callsTo("GET", THREAD_PATH);
    refuse({ status: 500, body: { detail: "storage is down" } });
    await waitFor(() => expect(result.current.rate.isError).toBe(true));
    expect(result.current.live.runs.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(result.current.live.runs[0]?.feedback).toBeNull();
    expect(result.current.live.activeRun?.id).toBe("r1");
    expect(streams.filter((s) => !s.init.signal?.aborted)).toHaveLength(1);
    // Settled either way, the thread is fetched again to match the server.
    expect(callsTo("GET", THREAD_PATH)).toBe(before + 1);
  });

  it("does not undo a newer rating when an older one is refused", async () => {
    client.setQueryData(keys.thread("ws1", "t1"), makeThread([done]));
    const pending: ((reply: Reply) => void)[] = [];
    routes["POST /api/v1/workspaces/ws1/runs/r0/feedback"] = () => new Promise<Reply>((resolve) => pending.push(resolve));
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

  it("catches the thread up when a chart pick is refused as not the latest, and on no other failure", async () => {
    let thread = makeThread([done]);
    routes[`GET ${THREAD_PATH}`] = () => ({ body: thread });
    let reply: Reply = { status: 409, body: { detail: "Run r0 is not the latest", code: "not_latest" } };
    routes["POST /api/v1/workspaces/ws1/runs/r0/chart"] = () => reply;
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
    expect(result.current.live.runs.map((r) => r.id)).toEqual(["r0", "r1"]);

    const before = callsTo("GET", THREAD_PATH);
    reply = { status: 500, body: { detail: "storage is down" } };
    act(() => result.current.pick.mutate({ runId: "r0", chart: "bar" }));
    await waitFor(() => expect(result.current.pick.error?.message).toBe("storage is down"));
    expect(callsTo("GET", THREAD_PATH)).toBe(before);
  });

  it("refetches the run after an answer, so its stream can reopen", async () => {
    routes["GET /api/v1/workspaces/ws1/runs/r1"] = () => ({ body: makeRun({ status: "asking" }) });
    routes["POST /api/v1/workspaces/ws1/runs/r1/answers"] = async (request) => {
      expect(await request.json()).toEqual({ answers: { p1: null }, text: null });
      return { status: 202, body: { thread_id: "t1", run_id: "r1" } };
    };
    const { result } = renderHook(() => ({ run: useRun("ws1", "r1"), answer: useAnswer("ws1") }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.run.data?.status).toBe("asking"));
    routes["GET /api/v1/workspaces/ws1/runs/r1"] = () => ({ body: makeRun({ status: "running", last_event_id: 4 }) });

    act(() => result.current.answer.mutate({ runId: "r1", answers: { p1: null } }));
    await waitFor(() => expect(result.current.answer.isSuccess).toBe(true));
    expect(result.current.run.data?.status).toBe("running");
    expect(callsTo("GET", "/api/v1/workspaces/ws1/runs/r1")).toBe(2);
  });
});
