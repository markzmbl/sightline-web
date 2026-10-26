import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { createQueryClient } from "../src/api/queries";
import { registryKeys, useRegistry, useRegistryCounts, useRegistryEntry, useReview } from "../src/api/registry";
import type { ErrorItem, RegistryCounts, RegistryEntry, RegistryEntryDetail, RegistryPage, Review } from "../src/api/types";

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
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
});

const ENTRIES = "/api/v1/workspaces/ws1/registry/entries";
const ENTRY = `${ENTRIES}/e1`;
const REVIEW = `${ENTRY}/review`;

const callsTo = (method: string, pathname: string) =>
  requests.filter((r) => r.method === method && new URL(r.url).pathname === pathname).length;
const queryOf = (request: Request | undefined) => Object.fromEntries(new URL(request?.url ?? "").searchParams);

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "e1",
    kind: "measure",
    term: "oee",
    label: "OEE",
    source: { kind: "library", text: "from sightline's KPI library (ISO 22400-2)" },
    status: "proposed",
    demand: { runs: 4, first_asked: "2026-10-20T08:00:00.000Z", last_asked: "2026-10-25T16:00:00.000Z" },
    words: { en: ["oee", "overall equipment effectiveness"], de: ["Gesamtanlageneffektivität"] },
    definition: "availability × performance × quality",
    note: null,
    version: 3,
    updated_at: "2026-10-25T16:00:00.000Z",
    reviewed_by: null,
    gap: null,
    choices: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<RegistryEntry> = {}): RegistryEntryDetail {
  return {
    ...makeEntry(overrides),
    runs: [
      {
        run_id: "r1",
        thread_id: "t1",
        question: "Which plant has the best OEE?",
        rating: "up",
        at: "2026-10-25T16:00:00.000Z",
      },
    ],
  };
}

const counts: RegistryCounts = { measure: 2, default: 1, gap: 1 };

function page(items: RegistryEntry[], next_cursor: string | null = null, pageCounts = counts): RegistryPage {
  return { items, next_cursor, counts: pageCounts };
}

let client: QueryClient;

function wrapperFor() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  client = createQueryClient();
  routes = {};
  requests.length = 0;
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  fetchStub.mockClear();
});

describe("useRegistry", () => {
  it("pages by cursor, 50 at a time, with the filters in the query", async () => {
    const entries = ["e1", "e2", "e3"].map((id) => makeEntry({ id, term: id }));
    routes[`GET ${ENTRIES}`] = (request) =>
      queryOf(request).cursor === "c2" ? { body: page(entries.slice(2)) } : { body: page(entries.slice(0, 2), "c2") };
    const { result } = renderHook(() => useRegistry("ws1", { kind: "measure", status: "proposed" }), {
      wrapper: wrapperFor(),
    });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(true);
    expect(queryOf(requests[0])).toEqual({ kind: "measure", status: "proposed", limit: "50" });

    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(queryOf(requests[1])).toEqual({ kind: "measure", status: "proposed", cursor: "c2", limit: "50" });
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.data?.pages.flatMap((p) => p.items.map((e) => e.id))).toEqual(["e1", "e2", "e3"]);
    expect(result.current.data?.pageParams).toEqual([null, "c2"]);

    // Every page carries the counts, so the badge keeps up with the list.
    expect(client.getQueryData(registryKeys.counts("ws1"))).toEqual(counts);
  });

  it("keeps one list per set of filters", async () => {
    routes[`GET ${ENTRIES}`] = (request) =>
      queryOf(request).kind === "gap" ? { body: page([makeEntry({ id: "g1", kind: "gap" })]) } : { body: page([makeEntry()]) };
    const { result } = renderHook(() => ({ all: useRegistry("ws1", {}), gaps: useRegistry("ws1", { kind: "gap" }) }), {
      wrapper: wrapperFor(),
    });
    await waitFor(() => expect(result.current.gaps.isSuccess && result.current.all.isSuccess).toBe(true));
    expect(result.current.all.data?.pages[0]?.items.map((e) => e.id)).toEqual(["e1"]);
    expect(result.current.gaps.data?.pages[0]?.items.map((e) => e.id)).toEqual(["g1"]);
    expect(callsTo("GET", ENTRIES)).toBe(2);
  });

  it("fails with an ApiError and does not retry a 4xx", async () => {
    routes[`GET ${ENTRIES}`] = () => ({ status: 404, body: { detail: "no such workspace" } });
    const { result } = renderHook(() => useRegistry("ws1", {}), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.status).toBe(404);
    expect(result.current.error?.message).toBe("no such workspace");
    expect(callsTo("GET", ENTRIES)).toBe(1);
  });
});

describe("useRegistryCounts", () => {
  it("asks for one proposed entry and keeps the counts, every minute and on focus", async () => {
    routes[`GET ${ENTRIES}`] = () => ({ body: page([makeEntry()], "c2") });
    const { result } = renderHook(() => useRegistryCounts("ws1"), { wrapper: wrapperFor() });
    await waitFor(() => expect(result.current.data).toEqual(counts));
    expect(queryOf(requests[0])).toEqual({ status: "proposed", limit: "1" });

    const options = client.getQueryCache().find({ queryKey: registryKeys.counts("ws1") })?.observers[0]?.options;
    expect(options?.refetchInterval).toBe(60_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
  });

  it("is idle without a workspace", async () => {
    const { result } = renderHook(() => useRegistryCounts(""), { wrapper: wrapperFor() });
    await act(() => Promise.resolve());
    expect(result.current.fetchStatus).toBe("idle");
    expect(requests).toHaveLength(0);
  });
});

describe("useRegistryEntry", () => {
  it("loads one entry with the runs that used it, and stays idle without an id", async () => {
    routes[`GET ${ENTRY}`] = () => ({ body: makeDetail() });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRegistryEntry("ws1", id), {
      wrapper: wrapperFor(),
      initialProps: { id: null as string | null },
    });
    await act(() => Promise.resolve());
    expect(result.current.fetchStatus).toBe("idle");
    expect(requests).toHaveLength(0);

    rerender({ id: "e1" });
    await waitFor(() => expect(result.current.data).toEqual(makeDetail()));
    expect(result.current.data?.runs[0]?.question).toBe("Which plant has the best OEE?");
  });
});

describe("useReview", () => {
  /** The review view as it stands: two lists, the counts, the entry, and the review. */
  async function openReview() {
    const hook = renderHook(
      () => ({
        all: useRegistry("ws1", {}),
        proposed: useRegistry("ws1", { status: "proposed" }),
        counts: useRegistryCounts("ws1"),
        entry: useRegistryEntry("ws1", "e1"),
        review: useReview("ws1", "e1"),
      }),
      { wrapper: wrapperFor() },
    );
    const { result } = hook;
    await waitFor(() =>
      expect(
        result.current.all.isSuccess &&
          result.current.proposed.isSuccess &&
          result.current.counts.isSuccess &&
          result.current.entry.isSuccess,
      ).toBe(true),
    );
    return hook;
  }

  /** Runs the review to its end, and what it rejected with, if anything. */
  async function review(result: { current: { review: { mutateAsync: (r: Review) => Promise<unknown> } } }, body: Review) {
    let failure: unknown = null;
    await act(async () => {
      await result.current.review.mutateAsync(body).catch((error: unknown) => (failure = error));
    });
    return failure;
  }

  it("posts the review, shows the new version at once, and refetches the lists and the counts", async () => {
    let server = { entry: makeDetail(), counts };
    routes[`GET ${ENTRIES}`] = () => ({ body: page([server.entry], null, server.counts) });
    routes[`GET ${ENTRY}`] = () => ({ body: server.entry });
    routes[`POST ${REVIEW}`] = async (request) => {
      expect(await request.json()).toEqual({ action: "approve", version: 3, note: "the ISO definition" });
      server = {
        entry: makeDetail({ status: "approved", version: 4, reviewed_by: "dev", note: "the ISO definition" }),
        counts: { ...counts, measure: 1 },
      };
      return { body: server.entry };
    };
    const { result } = await openReview();
    const lists = callsTo("GET", ENTRIES);
    expect(lists).toBe(3);

    expect(await review(result, { action: "approve", version: 3, note: "the ISO definition" })).toBeNull();
    // Settled only once the lists and the counts it moved are back.
    expect(client.getQueryData(registryKeys.counts("ws1"))).toEqual({ ...counts, measure: 1 });
    expect(callsTo("GET", ENTRIES)).toBe(lists + 3);
    // The entry is the answer itself, not fetched again.
    expect(client.getQueryData<RegistryEntryDetail>(registryKeys.entry("ws1", "e1"))).toEqual(server.entry);
    expect(callsTo("GET", ENTRY)).toBe(1);

    await waitFor(() => expect(result.current.entry.data?.version).toBe(4));
    expect(result.current.entry.data?.status).toBe("approved");
    expect(result.current.proposed.data?.pages[0]?.items[0]?.status).toBe("approved");
    expect(result.current.counts.data?.measure).toBe(1);
  });

  it("loads the version someone else left when the review conflicts, then fails with the conflict", async () => {
    let entry = makeDetail();
    routes[`GET ${ENTRIES}`] = () => ({ body: page([entry]) });
    routes[`GET ${ENTRY}`] = () => ({ body: entry });
    routes[`POST ${REVIEW}`] = () => {
      entry = makeDetail({ status: "rejected", version: 4, reviewed_by: "anna", note: "we use our own OEE" });
      return { status: 409, body: { detail: "Someone reviewed this entry first.", code: "version_conflict" } };
    };
    const { result } = await openReview();
    const lists = callsTo("GET", ENTRIES);

    const failure = await review(result, { action: "approve", version: 3 });
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 409, code: "version_conflict", message: "Someone reviewed this entry first." });
    // By the time it fails, the version someone else left is in, and the lists moved too.
    expect(client.getQueryData<RegistryEntryDetail>(registryKeys.entry("ws1", "e1"))?.version).toBe(4);
    expect(callsTo("GET", ENTRY)).toBe(2);
    expect(callsTo("GET", ENTRIES)).toBe(lists + 3);

    await waitFor(() => expect(result.current.review.error?.code).toBe("version_conflict"));
    expect(result.current.entry.data?.reviewed_by).toBe("anna");
  });

  it("surfaces a word collision intact and refetches nothing", async () => {
    const collision: ErrorItem = {
      loc: ["body", "changes", "words", "de", 0],
      msg: "Verfügbarkeit already names another term.",
      type: "word_collision",
      ctx: { word: "Verfügbarkeit", collides_with: "availability" },
    };
    routes[`GET ${ENTRIES}`] = () => ({ body: page([makeEntry()]) });
    routes[`GET ${ENTRY}`] = () => ({ body: makeDetail() });
    routes[`POST ${REVIEW}`] = async (request) => {
      expect(await request.json()).toEqual({
        action: "edit",
        version: 3,
        changes: { label: "OEE", words: { de: ["Verfügbarkeit"] } },
      });
      return { status: 422, body: { detail: "A word names another term.", errors: [collision] } };
    };
    const { result } = await openReview();
    const before = requests.length;

    const failure = await review(result, {
      action: "edit",
      version: 3,
      changes: { label: "OEE", words: { de: ["Verfügbarkeit"] } },
    });
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 422, code: null, message: "A word names another term." });
    expect((failure as ApiError).errors).toEqual([collision]);
    // One request, the review itself: nothing changed on the server.
    expect(requests.length).toBe(before + 1);
    await waitFor(() => expect(result.current.review.error?.errors[0]?.type).toBe("word_collision"));
    expect(result.current.entry.data?.version).toBe(3);
  });

  it("reads FastAPI's own validation shape, items in detail, as errors too", async () => {
    const item: ErrorItem = { loc: ["body", "version"], msg: "Field required", type: "missing" };
    routes[`GET ${ENTRY}`] = () => ({ body: makeDetail() });
    routes[`POST ${REVIEW}`] = () => ({ status: 422, body: { detail: [item] } });
    const { result } = renderHook(() => ({ review: useReview("ws1", "e1") }), { wrapper: wrapperFor() });

    const failure = await review(result, { action: "approve", version: 3 });
    expect(failure).toMatchObject({ status: 422, code: null, message: "Field required" });
    expect((failure as ApiError).errors).toEqual([item]);
  });

  describe("when the view moves to another entry while a review is pending", () => {
    const E2 = `${ENTRIES}/e2`;
    let release: (reply: Reply) => void = () => {};

    /** The entry view on e1 with its review, the review started and the view moved to e2 at once. */
    async function moveWhilePending(body: Review) {
      routes[`GET ${ENTRY}`] = () => ({ body: makeDetail() });
      routes[`GET ${E2}`] = () => ({ body: makeDetail({ id: "e2", term: "availability", label: "Availability", version: 7 }) });
      routes[`POST ${REVIEW}`] = () => new Promise<Reply>((resolve) => (release = resolve));
      const hook = renderHook(
        ({ id }: { id: string }) => ({ entry: useRegistryEntry("ws1", id), review: useReview("ws1", id) }),
        { wrapper: wrapperFor(), initialProps: { id: "e1" } },
      );
      const { result, rerender } = hook;
      await waitFor(() => expect(result.current.entry.data?.id).toBe("e1"));

      let settled: Promise<unknown> = Promise.resolve();
      // Started and moved in one go, before the request is out: the request still goes to e1.
      act(() => {
        settled = result.current.review.mutateAsync(body).then(
          () => null,
          (error: unknown) => error,
        );
        rerender({ id: "e2" });
      });
      await waitFor(() => expect(result.current.entry.data?.id).toBe("e2"));
      await waitFor(() => expect(callsTo("POST", REVIEW)).toBe(1));
      expect(callsTo("POST", `${E2}/review`)).toBe(0);
      // The view on e2 shows no review of its own.
      expect(result.current.review.isIdle).toBe(true);
      return { ...hook, settled };
    }

    it("stores the answer under the entry it reviewed", async () => {
      const { result, settled } = await moveWhilePending({ action: "approve", version: 3 });
      const approved = makeDetail({ status: "approved", version: 4, reviewed_by: "dev" });
      let failure: unknown;
      await act(async () => {
        release({ body: approved });
        failure = await settled;
      });
      expect(failure).toBeNull();

      expect(client.getQueryData<RegistryEntryDetail>(registryKeys.entry("ws1", "e1"))).toEqual(approved);
      expect(client.getQueryData<RegistryEntryDetail>(registryKeys.entry("ws1", "e2"))).toMatchObject({ id: "e2", version: 7 });
      expect(result.current.entry.data).toMatchObject({ id: "e2", version: 7 });
      expect(result.current.review.isIdle).toBe(true);
    });

    it("marks the entry it reviewed stale on a conflict, not the one on view", async () => {
      const { result, settled } = await moveWhilePending({ action: "approve", version: 3 });
      let failure: unknown;
      await act(async () => {
        release({ status: 409, body: { detail: "Someone reviewed this entry first.", code: "version_conflict" } });
        failure = await settled;
      });
      expect(failure).toMatchObject({ status: 409, code: "version_conflict" });

      const state = (id: string) => client.getQueryCache().find({ queryKey: registryKeys.entry("ws1", id), exact: true })?.state;
      expect(state("e1")?.isInvalidated).toBe(true);
      expect(state("e2")?.isInvalidated).toBe(false);
      // e2 is on view and was not fetched again; e1 is fetched when it is opened again.
      expect(callsTo("GET", E2)).toBe(1);
      expect(result.current.entry.data).toMatchObject({ id: "e2", version: 7 });
    });
  });

  it("fails with status 0 when the connection drops", async () => {
    routes[`POST ${REVIEW}`] = () => {
      throw new TypeError("Failed to fetch");
    };
    const { result } = renderHook(() => ({ review: useReview("ws1", "e1") }), { wrapper: wrapperFor() });

    const failure = await review(result, { action: "reject", version: 3 });
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 0, code: null, message: "Failed to fetch" });
    expect(requests).toHaveLength(1);
  });
});
