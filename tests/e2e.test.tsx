// The whole client against the mock backend: the real routes, hooks, event streams and
// pages in jsdom, the mock's HTTP server in the same process. What the user does is
// what the test does (type, press, pick); what the server holds is read beside it.
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import embed from "vega-embed";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, ApiError, unwrap } from "../src/api/client";
import { createQueryClient, keys } from "../src/api/queries";
import type { RegistryEntryDetail, RegistryPage, RunView, Thread } from "../src/api/types";
import { totalOf } from "../src/components/review/format";

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

vi.mock("vega-embed", () => ({
  default: vi.fn(async () => ({ finalize() {}, view: {} })),
}));

interface MockModule {
  startMockServer(options: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }>;
}
interface FixtureModule {
  loadFixtures(dir: URL): unknown;
}
const SERVER = "../mock/server.ts";
const FIXTURES = "../mock/fixture.ts";
// Under jsdom, Vite serves `new URL("./fixtures/", import.meta.url)` as a page URL, so the
// mock's own default does not reach the files; the test gives it a file URL instead.
const here = import.meta.url;
const FIXTURES_DIR = new URL("../mock/fixtures/", here);

// Same-origin as the page sees it; the stub sends every call on to the mock.
const nodeFetch = globalThis.fetch;
let base = "";
const calls: string[] = [];
async function toMock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const response = await nodeFetch(`${base}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
  calls.push(`${request.method} ${url.pathname} ${response.status}`);
  return response;
}

let close: () => Promise<void> = async () => {};
const { routes } = await import("../src/routes");

async function startMock(options: Record<string, unknown> = {}) {
  const { startMockServer } = (await import(/* @vite-ignore */ SERVER)) as MockModule;
  const { loadFixtures } = (await import(/* @vite-ignore */ FIXTURES)) as FixtureModule;
  const fixtures = loadFixtures(FIXTURES_DIR);
  const mock = await startMockServer({ port: 0, speed: 1000, minStageMs: 25, quiet: true, fixtures, ...options });
  base = mock.url;
  close = mock.close;
}

beforeAll(() => {
  globalThis.fetch = toMock as typeof fetch;
  if (typeof window !== "undefined") window.fetch = toMock as typeof fetch;
});
afterEach(async () => {
  cleanup();
  await close();
});
afterAll(() => {
  globalThis.fetch = nodeFetch;
});

/** What the server holds, read the way a test reads it: straight from the mock. */
async function server<T>(path: string): Promise<T> {
  const response = await nodeFetch(`${base}${path}`);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}
async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await nodeFetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

function mount(at: string): { client: QueryClient; router: ReturnType<typeof createMemoryRouter> } {
  const client = createQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [at] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

const LONG = { timeout: 8_000 };

function send(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

const pairs = () => [...document.querySelectorAll<HTMLElement>("section.tx-pair")];
const lastPair = () => pairs().at(-1)!;
const threadIdOf = (router: ReturnType<typeof createMemoryRouter>) =>
  /\/t\/([^/]+)$/.exec(router.state.location.pathname)?.[1] ?? "";

/** Server and client hold the same run, but for the times each stamps on its own clock. */
const unstamped = ({ started_at: _s, finished_at: _f, ...rest }: RunView) => rest;

describe("the client against the mock", () => {
  it("asks, revises mid-run (the old run superseded), and switches the chart", async () => {
    await startMock();
    const { client, router } = mount("/w/manufacturing");
    const MFG = "/api/v1/workspaces/manufacturing";

    // The sidebar badge sums the proposed counts the server gives.
    const page = await server<RegistryPage>(`${MFG}/registry/entries?status=proposed&limit=1`);
    const proposed = totalOf(page.counts);
    await screen.findByRole("link", { name: `Review, ${proposed} proposed` }, LONG);

    send(await screen.findByRole("textbox", { name: "Your question" }), "Which lines use the most energy per 1,000 good units?");
    await waitFor(() => expect(threadIdOf(router)).not.toBe(""), LONG);
    const threadId = threadIdOf(router);
    // Revise while the first run works: posted directly, the server supersedes the run.
    await waitFor(() => expect(lastPair().querySelector(".tx-trace")).not.toBeNull(), LONG);
    const first = (await server<Thread>(`${MFG}/threads/${threadId}`)).runs[0]!;
    expect(["queued", "running"]).toContain(first.status);
    send(screen.getByRole("textbox", { name: "Revise the question" }), "per month instead");

    await waitFor(() => expect(pairs()).toHaveLength(2), LONG);
    await waitFor(() => expect(lastPair().querySelector(".tx-run--complete")).not.toBeNull(), LONG);
    const thread = await server<Thread>(`${MFG}/threads/${threadId}`);
    expect(thread.runs.map((r) => r.status)).toEqual(["superseded", "complete"]);
    // The old run folds with its status; the client's copy of it is the server's.
    expect(within(pairs()[0]!).getByRole("button", { expanded: false }).textContent).toMatch(/Replaced/);
    const old = client.getQueryData<RunView>(keys.run("manufacturing", first.id));
    expect(old).toBeDefined();
    expect(unstamped(old!)).toEqual(unstamped(await server<RunView>(`${MFG}/runs/${first.id}`)));
    expect(calls.some((c) => c.startsWith(`POST ${MFG}/runs/${first.id}/cancel`))).toBe(false);

    const latest = thread.latest;
    expect(unstamped(client.getQueryData<RunView>(keys.run("manufacturing", latest.id))!)).toEqual(unstamped(latest));
    expect(latest.status).toBe("complete");
    const switcher = within(lastPair()).getByRole("group", { name: "Show it as" });
    const alternative = latest.result!.chart!.options.find((option) => !option.drawn)!;
    vi.mocked(embed).mockClear();
    fireEvent.click(within(switcher).getByRole("button", { name: alternative.label }));
    // The same run presents again: queued, running, complete, with the picked chart.
    await waitFor(
      () => expect(within(lastPair()).getByRole("button", { pressed: true }).textContent).toBe(alternative.label),
      LONG,
    );
    const again = await server<RunView>(`${MFG}/runs/${latest.id}`);
    expect(again.id).toBe(latest.id);
    expect(again.status).toBe("complete");
    expect(again.result?.chart?.chart).toBe(alternative.chart);
    expect(again.timings.length).toBeGreaterThan(latest.timings.length);
    const live = client.getQueryData<RunView>(keys.run("manufacturing", latest.id))!;
    expect(unstamped(live)).toEqual(unstamped(again));
    await waitFor(() => expect(vi.mocked(embed).mock.lastCall?.[1]).toMatchObject({ $schema: expect.any(String) }));
    expect(screen.queryByRole("alert")).toBeNull();

    // Another tab revises the thread; this one, behind, switches the chart of a run that is no
    // longer the latest. The server refuses (not_latest), the banner says so in words, and the
    // thread catches up with the revision it speaks of.
    const elsewhere = await post<{ run_id: string }>(`${MFG}/threads/${threadId}/revisions`, { message: "only Linz" });
    expect(elsewhere.status).toBe(202);
    const next = (await server<RunView>(`${MFG}/runs/${latest.id}`)).result!.chart!.options.find((option) => !option.drawn)!;
    fireEvent.click(within(lastPair()).getByRole("button", { name: next.label }));
    const banner = await screen.findByRole("alert", undefined, LONG);
    expect(banner.textContent).toBe("Could not switch the chart: a newer revision has replaced this answer.");
    await waitFor(() => expect(pairs()).toHaveLength(3), LONG);
    expect(within(lastPair()).getByText("only Linz")).toBeTruthy();
    // The earlier runs offer nothing the server would refuse.
    for (const pair of pairs().slice(0, -1)) {
      fireEvent.click(within(pair).getByRole("button", { expanded: false }));
      expect(within(pair).queryByRole("group", { name: "Show it as" })).toBeNull();
      expect(within(pair).queryByRole("button", { name: "Change" })).toBeNull();
    }
  }, 30_000);

  it("answers the blocking card, then changes a choice beside the chart: the same run each time", async () => {
    await startMock();
    const { client, router } = mount("/w/restaurant");
    const REST = "/api/v1/workspaces/restaurant";
    send(await screen.findByRole("textbox", { name: "Your question" }), "How much revenue did we make per month in 2025?");
    const card = await screen.findByRole("region", { name: "sightline needs a choice" }, LONG);
    const threadId = threadIdOf(router);
    const asked = (await server<Thread>(`${REST}/threads/${threadId}`)).latest;
    expect([asked.status, asked.card?.blocking]).toEqual(["asking", true]);
    await screen.findByText("answer the card, or revise the question");

    fireEvent.click(within(card).getByRole("button", { name: "Decide for me" }));
    await waitFor(() => expect(lastPair().querySelector(".tx-run--complete")).not.toBeNull(), LONG);
    const done = await server<RunView>(`${REST}/runs/${asked.id}`);
    expect([done.id, done.status, done.card?.blocking]).toEqual([asked.id, "complete", false]);
    // The side card replaces the answered one: it asks only what the drawing left open.
    expect(done.card?.points.map((p) => p.id)).toEqual(["point"]);
    expect(unstamped(client.getQueryData<RunView>(keys.run("restaurant", asked.id))!)).toEqual(unstamped(done));
    expect((await server<Thread>(`${REST}/threads/${threadId}`)).runs).toHaveLength(1);

    // Beside the chart now: change one choice, and the same run presents again.
    const made = within(lastPair()).getByRole("region", { name: "Choices sightline made" });
    const point = done.card!.points[0]!;
    const other = point.options.find((o) => o.id !== point.chosen)!;
    const row = within(made).getByText(point.question).closest("li")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Change" }));
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: other.label }));
    await waitFor(async () => {
      const run = await server<RunView>(`${REST}/runs/${asked.id}`);
      expect(run.card?.points.find((p) => p.id === point.id)).toMatchObject({ chosen: other.id, by: "user" });
      expect(run.status).toBe("complete");
    }, LONG);
    await waitFor(() => expect(within(lastPair()).getByText("your choice")).toBeTruthy(), LONG);
    expect(screen.queryByRole("alert")).toBeNull();
  }, 30_000);

  it("ends the gap question as not possible yet, and sends a nearest question as a revision", async () => {
    await startMock();
    const { router } = mount("/w/restaurant");
    const REST = "/api/v1/workspaces/restaurant";
    send(await screen.findByRole("textbox", { name: "Your question" }), "What is the profit margin per branch?");
    await screen.findByRole("heading", { name: "This is not possible with the data yet." }, LONG);
    const threadId = threadIdOf(router);
    const ended = (await server<Thread>(`${REST}/threads/${threadId}`)).latest;
    expect(ended.status).toBe("clarify");
    for (const item of [...ended.clarify!.missing, ...ended.clarify!.record]) expect(screen.getByText(item)).toBeTruthy();

    const nearest = ended.follow_ups.find((f) => f.kind === "nearest")!.question;
    fireEvent.click(screen.getByRole("button", { name: nearest }));
    await waitFor(() => expect(pairs()).toHaveLength(2), LONG);
    expect(within(lastPair()).getByText(nearest)).toBeTruthy();
    // Focus went on to the composer, ready for the next revision.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Revise the question" }));
    await waitFor(() => expect(lastPair().querySelector(".tx-run--complete")).not.toBeNull(), LONG);
    const thread = await server<Thread>(`${REST}/threads/${threadId}`);
    expect(thread.runs.map((r) => [r.revision, r.prompt, r.status])).toEqual([
      [0, "What is the profit margin per branch?", "clarify"],
      [1, nearest, "complete"],
    ]);
  }, 30_000);

  it("follows a run its worker restarts: the trace starts over, as the server's", async () => {
    await startMock({ seed: false, restartEvery: 1 });
    const { client, router } = mount("/w/manufacturing");
    send(await screen.findByRole("textbox", { name: "Your question" }), "What was the OEE of each line last week?");
    await waitFor(() => expect(threadIdOf(router)).not.toBe(""), LONG);
    await waitFor(() => expect(lastPair().querySelector(".tx-run--complete")).not.toBeNull(), LONG);
    const thread = await server<Thread>(`/api/v1/workspaces/manufacturing/threads/${threadIdOf(router)}`);
    const run = thread.latest;
    const live = client.getQueryData<RunView>(keys.run("manufacturing", run.id));
    expect(live).toBeDefined();
    expect(unstamped(live!)).toEqual(unstamped(run));
    expect(run.timings.map((t) => t.stage)).toHaveLength(16); // one pass, the second attempt's
  }, 30_000);

  it("carries the 409 codes and the 422 items into ApiError", async () => {
    await startMock();
    const MFG = "/api/v1/workspaces/manufacturing";
    const thread = await server<Thread>(`${MFG}/threads/th_seed_oee-line`);
    const run = thread.runs[0]!;
    const fail = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        return error as ApiError;
      }
      throw new Error("no error");
    };
    const pie = await fail(
      api
        .POST("/api/v1/workspaces/{ws}/runs/{run_id}/chart", {
          params: { path: { ws: "manufacturing", run_id: run.id } },
          body: { chart: "pie" },
        })
        .then(unwrap),
    );
    expect([pie.status, pie.code]).toEqual([409, "not_answerable"]);
    expect(pie.message).toMatch(/^The run offers no pie chart/);

    await post(`${MFG}/threads/${thread.id}/revisions`, { message: "per week" });
    const older = await fail(
      api
        .POST("/api/v1/workspaces/{ws}/runs/{run_id}/chart", {
          params: { path: { ws: "manufacturing", run_id: run.id } },
          body: { chart: "table" },
        })
        .then(unwrap),
    );
    expect([older.status, older.code]).toEqual([409, "not_latest"]);

    const review = (body: { action: "edit" | "approve"; version: number; changes?: { words: Record<string, string[]> } }) =>
      api
        .POST("/api/v1/workspaces/{ws}/registry/entries/{entry_id}/review", {
          params: { path: { ws: "manufacturing", entry_id: "measure-quality-ratio" } },
          body,
        })
        .then(unwrap);
    const collision = await fail(review({ action: "edit", version: 1, changes: { words: { de: ["gae"] } } }));
    expect([collision.status, collision.code]).toEqual([422, null]);
    expect(collision.errors).toEqual([
      {
        loc: ["body", "changes", "words", "de", 0],
        msg: expect.any(String),
        type: "word_collision",
        ctx: { word: "gae", collides_with: "oee" },
      },
    ]);
    const stale = await fail(review({ action: "approve", version: 7 }));
    expect([stale.status, stale.code]).toEqual([409, "version_conflict"]);
  });

  it("reviews entries: approve, a stale version, an edit with a word another term has", async () => {
    await startMock();
    const MFG = "/api/v1/workspaces/manufacturing";
    const { router } = mount("/w/manufacturing/review");
    const counts = (await server<RegistryPage>(`${MFG}/registry/entries?limit=1`)).counts;
    const proposed = totalOf(counts);
    await screen.findByRole("link", { name: `Review, ${proposed} proposed` }, LONG);
    const rows = await screen.findByRole("list", { name: "Entries" }, LONG);

    // Approve: the entry moves on a version, and the badge counts one fewer.
    fireEvent.click(within(rows).getByText("oee").closest("a")!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/manufacturing/review/measure-oee"));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }, LONG));
    await screen.findByText("Approved.", undefined, LONG);
    const oee = await server<RegistryEntryDetail>(`${MFG}/registry/entries/measure-oee`);
    expect([oee.status, oee.version, oee.reviewed_by]).toEqual(["approved", 2, "Dev user"]);
    await screen.findByRole("link", { name: `Review, ${proposed - 1} proposed` }, LONG);

    // Someone else reviews effectiveness while it is open here: Approve meets version_conflict.
    await act(() => router.navigate("/w/manufacturing/review/measure-effectiveness"));
    await screen.findByRole("heading", { name: "effectiveness" }, LONG);
    const elsewhere = await post<RegistryEntryDetail>(`${MFG}/registry/entries/measure-effectiveness/review`, {
      action: "edit",
      version: 1,
      changes: { label: "Performance rate" },
    });
    expect(elsewhere.status).toBe(200);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText(/Someone reviewed this entry first/, undefined, LONG);
    await screen.findByText("Performance rate", { selector: ".rv-detail__label" }, LONG);
    const stale = await post<{ code?: string }>(`${MFG}/registry/entries/measure-effectiveness/review`, {
      action: "approve",
      version: 1,
    });
    expect([stale.status, stale.body.code]).toEqual([409, "version_conflict"]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved.", undefined, LONG);
    expect((await server<RegistryEntryDetail>(`${MFG}/registry/entries/measure-effectiveness`)).version).toBe(3);

    // An edit with a word that names another term: 422 word_collision, shown at the word.
    await act(() => router.navigate("/w/manufacturing/review/measure-quality-ratio"));
    await screen.findByRole("heading", { name: "quality ratio" }, LONG);
    send(screen.getByRole("textbox", { name: "Add a word in English" }), "OEE");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("A word already names another term. Change or remove it, then save again.", undefined, LONG);
    expect(screen.getByText("“OEE” already names oee.")).toBeTruthy();
    const collided = await post<{ errors: { loc: unknown[]; type: string; ctx: unknown }[] }>(
      `${MFG}/registry/entries/measure-quality-ratio/review`,
      { action: "edit", version: 1, changes: { words: { en: ["quality ratio", "OEE"] } } },
    );
    expect(collided.status).toBe(422);
    expect(collided.body.errors[0]).toEqual({
      loc: ["body", "changes", "words", "en", 1],
      msg: expect.any(String),
      type: "word_collision",
      ctx: { word: "OEE", collides_with: "oee" },
    });
    expect((await server<RegistryEntryDetail>(`${MFG}/registry/entries/measure-quality-ratio`)).version).toBe(1);
  }, 30_000);
});
