// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvent } from "../src/api/runEvents";
import type {
  Card,
  ChartOption,
  ChartView,
  Clarify,
  DecisionPoint,
  Problem,
  RegistryEntryDetail,
  RegistryPage,
  Result,
  RunCreated,
  RunEvent,
  RunStatus,
  RunView,
  Thread,
  ThreadPage,
} from "../src/api/types";

// The mock is Node-only code checked by tsconfig.node.json. A variable specifier keeps
// tsconfig.json (browser types, no node:http) from compiling it through this test.
interface MockModule {
  startMockServer(options: {
    port?: number;
    host?: string;
    speed?: number;
    minStageMs?: number;
    seed?: boolean;
    quiet?: boolean;
    restartEvery?: number;
  }): Promise<{ url: string; close(): Promise<void> }>;
}
interface FixtureModule {
  loadFixtures(): Map<
    string,
    {
      slug: string;
      synthetic?: boolean;
      final_status: string;
      card: Card | null;
      clarify: Clarify | null;
      result: Result | null;
      chart_options: ChartOption[];
    }[]
  >;
}
interface PlanModule {
  chartOptions(fixture: unknown): ChartOption[];
  chartView(fixture: unknown, chart?: string | null): ChartView | null;
}
const SERVER = "../mock/server.ts";
const FIXTURES = "../mock/fixture.ts";
const PLAN = "../mock/plan.ts";

const OPTIONS = { port: 0, speed: 1000, minStageMs: 1, quiet: true };

let base = "";
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { startMockServer } = (await import(/* @vite-ignore */ SERVER)) as MockModule;
  const mock = await startMockServer({ ...OPTIONS, seed: true });
  base = mock.url;
  close = mock.close;
});

afterAll(() => close());

// --- helpers -------------------------------------------------------------------------------

const MFG = "/api/v1/workspaces/manufacturing";
const REST = "/api/v1/workspaces/restaurant";

async function call<T>(method: string, path: string, body?: unknown, at = base): Promise<{ status: number; body: T }> {
  const res = await fetch(at + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function ok<T>(method: string, path: string, body?: unknown, status = method === "GET" ? 200 : 202): Promise<T> {
  const res = await call<T>(method, path, body);
  expect(res.status, `${method} ${path}`).toBe(status);
  return res.body;
}

/** A refusal: its status, and the Problem it carries. */
async function refused(method: string, path: string, body: unknown, status: number): Promise<Problem> {
  const res = await call<Problem>(method, path, body);
  expect(res.status, `${method} ${path}`).toBe(status);
  expect(typeof res.body.detail).toBe("string");
  return res.body;
}

interface Frame {
  id: number;
  event: string;
  data: RunEvent;
}

/** Reads a run's event stream until the server ends it; `onFrame` may act mid-stream. */
async function stream(
  path: string,
  options: { lastEventId?: number; onFrame?: (frame: Frame) => Promise<void> | void; at?: string } = {},
): Promise<{ frames: Frame[]; retry: string | null }> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (options.lastEventId !== undefined) headers["Last-Event-ID"] = String(options.lastEventId);
  const res = await fetch((options.at ?? base) + path, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let retry: string | null = null;
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // a heartbeat comment
        const colon = line.indexOf(":");
        fields.set(line.slice(0, colon), line.slice(colon + 1).trimStart());
      }
      if (fields.has("retry")) retry = fields.get("retry") ?? null;
      const data = fields.get("data");
      if (data === undefined) continue;
      const frame: Frame = { id: Number(fields.get("id")), event: fields.get("event") ?? "", data: JSON.parse(data) as RunEvent };
      frames.push(frame);
      await options.onFrame?.(frame);
    }
  }
  return { frames, retry };
}

const events = (ws: string, runId: string) => `${ws}/runs/${runId}/events`;
const types = (frames: Frame[]) => frames.map((f) => f.data.type);
const statuses = (frames: Frame[]): RunStatus[] =>
  frames.flatMap((f) => (f.data.type === "run.status" ? [f.data.status] : []));
const lastStatus = (frames: Frame[]) => {
  const last = frames.at(-1)?.data;
  return last?.type === "run.status" ? last.status : null;
};
const startedStages = (frames: Frame[]) => frames.flatMap((f) => (f.data.type === "stage.started" ? [f.data.stage] : []));

/**
 * The run as the web client holds it: `start` (a GET) with every newer frame folded
 * by the client's own applyEvent, the way useRunEvents does.
 */
function clientFold(start: RunView, frames: Frame[]): RunView {
  let view = start;
  for (const frame of frames) {
    if (!(frame.id > view.last_event_id)) continue;
    view = { ...applyEvent(view, frame.data), last_event_id: frame.id };
  }
  return view;
}

const unstamped = ({ started_at: _s, finished_at: _f, ...rest }: RunView) => rest;

/** Server and client hold the same run, but for the times each stamps on its own clock. */
function expectSameRun(server: RunView, client: RunView): void {
  expect(unstamped(server)).toEqual(unstamped(client));
  expect(server.started_at === null).toBe(client.started_at === null);
  expect(server.finished_at === null).toBe(client.finished_at === null);
}

const stagesOf = (run: RunView) => run.timings.map((t) => t.stage);

// The tests share one mock and run in order: later ones use the runs earlier ones made.
let oee: RunCreated;
let oeeStart: RunView;
let oeeFrames: Frame[] = [];
/** The OEE thread's latest run once a revision was taken back: the oee-line fixture again. */
let oeeLatest = "";
const OEE_STAGES = [
  "situate", "recall", "define", "ground", "abstract", "bind",
  "enrich", "derive", "query", "idiom", "render", "perceive", "validate",
];
const PRESENT = ["idiom", "render", "perceive", "validate"];

// --- the fixtures ---------------------------------------------------------------------------------

describe("mock fixtures", () => {
  it("carry the contract's shapes: decision points as the core has them, the full clarify, chart hints", async () => {
    const { loadFixtures } = (await import(/* @vite-ignore */ FIXTURES)) as FixtureModule;
    const all = [...loadFixtures().values()].flat();
    expect(all.length).toBeGreaterThanOrEqual(10);
    const points: DecisionPoint[] = all.flatMap((f) => f.card?.points ?? []);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(["rules", "s1", "s2", "user"]).toContain(point.by);
      expect(typeof point.open).toBe("boolean");
      expect(typeof point.stage).toBe("string");
      expect(typeof point.why).toBe("string");
      expect(point.options.every((o) => typeof o.hint === "string")).toBe(true);
    }
    expect(points.some((p) => p.open)).toBe(true);
    expect(points.some((p) => p.stage === "idiom")).toBe(true);

    for (const fixture of all.filter((f) => f.final_status === "clarify")) {
      const clarify = fixture.clarify!;
      for (const list of [clarify.gaps, clarify.missing, clarify.record, clarify.nearest, clarify.warnings]) {
        expect(Array.isArray(list), fixture.slug).toBe(true);
      }
    }
    // The real data-gap ending, not a made-up one: no fixture is synthetic.
    const gap = all.find((f) => f.slug === "margin-gap");
    expect(gap?.synthetic).toBeUndefined();
    expect(gap?.clarify?.missing.length).toBeGreaterThan(0);
    expect(gap?.clarify?.nearest).toEqual(["What is the revenue per branch?"]);

    const options = all.flatMap((f) => f.chart_options);
    expect(options.every((o) => o.hint === null || typeof o.hint === "string")).toBe(true);
    // idiom's reads, not the form option's "to ..." wording.
    expect(options.find((o) => o.chart === "horizontal_bar")?.hint).toBe("see which categories are the largest and how far apart they are");
    const findings = all.flatMap((f) => f.result?.findings ?? []);
    expect(findings).toContain("line revenue €84k → €105k, Jan–Dec 2025");
  });

  it("have a view of every chart they offer, the drawn one or the mock's, each a valid Vega-Lite spec", async () => {
    const { loadFixtures } = (await import(/* @vite-ignore */ FIXTURES)) as FixtureModule;
    const { chartOptions, chartView } = (await import(/* @vite-ignore */ PLAN)) as PlanModule;
    const { compile } = await import("vega-lite");
    type Options = NonNullable<Parameters<typeof compile>[1]>;
    // What Vega-Lite would warn about (a field it cannot use, an encoding it drops) fails the test.
    const said: string[] = [];
    const logger = {
      level: () => 0,
      warn: (...message: unknown[]) => (said.push(message.join(" ")), logger),
      error: (...message: unknown[]) => (said.push(message.join(" ")), logger),
      info: () => logger,
      debug: () => logger,
    } as unknown as NonNullable<Options["logger"]>;
    const complete = [...loadFixtures().values()].flat().filter((f) => f.final_status === "complete");
    let mocked = 0;
    for (const fixture of complete) {
      const options = chartOptions(fixture);
      expect(options.length, fixture.slug).toBeGreaterThan(1);
      for (const option of options) {
        const where = `${fixture.slug} ${option.chart}`;
        const view = chartView(fixture, option.chart);
        expect([view?.chart, view?.label], where).toEqual([option.chart, option.label]);
        expect(view?.alternatives.map((a) => a.chart), where).toEqual(options.filter((o) => o !== option).map((o) => o.chart));
        if (option.chart !== fixture.result?.chart?.chart) mocked += 1;
        expect(() => compile(view?.spec as unknown as Parameters<typeof compile>[0], { logger }), where).not.toThrow();
      }
    }
    expect(mocked).toBeGreaterThan(10);
    expect(said).toEqual([]);
  });
});

// --- the contract -------------------------------------------------------------------------------

describe("mock backend", () => {
  it("names the dev user and both demo workspaces", async () => {
    const me = await ok<{ user: { id: string; email: string | null }; workspaces: { id: string }[] }>("GET", "/api/v1/me");
    expect(me.user.id).toBe("dev");
    expect(me.user.email).toBeNull();
    expect(me.workspaces.map((w) => w.id)).toEqual(["manufacturing", "restaurant"]);
    expect((await call("GET", "/api/v1/workspaces/nowhere/threads")).status).toBe(404);
  });

  it("seeds finished threads spread over the sidebar's date groups", async () => {
    const page = await ok<ThreadPage>("GET", `${MFG}/threads`);
    expect(page.items).toHaveLength(5);
    expect(page.next_cursor).toBeNull();
    expect(page.items.every((t) => ["complete", "clarify"].includes(t.status) && t.active_run_id === null)).toBe(true);
    const times = page.items.map((t) => Date.parse(t.updated_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const DAY = 86_400_000;
    const ages = times.map((t) => (Date.now() - t) / DAY);
    expect(ages.some((a) => a < 1)).toBe(true);
    expect(ages.some((a) => a >= 1 && a < 2)).toBe(true);
    expect(ages.some((a) => a >= 2 && a < 7)).toBe(true);
    expect(ages.some((a) => a >= 7)).toBe(true);

    const restaurant = await ok<ThreadPage>("GET", `${REST}/threads`);
    expect(restaurant.items).toHaveLength(4); // the asking fixture is not seeded; the margin gap is
    expect(restaurant.items.filter((t) => t.status === "clarify")).toHaveLength(1);

    const first = await ok<ThreadPage>("GET", `${MFG}/threads?limit=2`);
    expect(first.items.map((t) => t.id)).toEqual(page.items.slice(0, 2).map((t) => t.id));
    expect(first.next_cursor).toBe("2");
    const rest = await ok<ThreadPage>("GET", `${MFG}/threads?limit=2&cursor=4`);
    expect(rest.items.map((t) => t.id)).toEqual(page.items.slice(4).map((t) => t.id));
    expect(rest.next_cursor).toBeNull();

    const thread = await ok<Thread>("GET", `${MFG}/threads/${page.items[0]?.id}`);
    const run = thread.runs[0]!;
    expect(run.status).toBe("complete");
    expect(run.timings.length).toBeGreaterThan(0);
    expect(run.timings.every((t) => typeof t.elapsed_ms === "number")).toBe(true);
    const log = await stream(events(MFG, run.id));
    expect(log.frames.at(-1)?.id).toBe(run.last_event_id);
    expect(log.frames.map((f) => f.id)).toEqual(log.frames.map((_, i) => i + 1));

    // Users rated some of the seeded runs.
    expect((await ok<RunView>("GET", `${MFG}/runs/run_seed_oee-line`)).feedback).toBe("up");
    expect((await ok<RunView>("GET", `${MFG}/runs/run_seed_scrap`)).feedback).toBe("down");
  });

  it("replays a fixture into a live run and ends the stream on complete", async () => {
    oee = await ok<RunCreated>("POST", `${MFG}/threads`, { question: "What was the OEE of each line last week?" });
    oeeStart = await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`);
    expect(["queued", "running"]).toContain(oeeStart.status);

    const { frames, retry } = await stream(events(MFG, oee.run_id));
    oeeFrames = frames;
    expect(retry).toBe("2000");
    expect(frames.map((f) => f.id)).toEqual(frames.map((_, i) => i + 1));
    expect(frames.every((f) => f.event === f.data.type && f.data.run_id === oee.run_id)).toBe(true);
    expect(frames[0]?.data).toMatchObject({ type: "run.status", status: "running" });

    const stageFrames = frames.filter((f) => f.data.type === "stage.started" || f.data.type === "stage.finished");
    const order = startedStages(frames);
    expect(order).toEqual(OEE_STAGES);
    stageFrames.forEach((f, i) => {
      const stage = order[Math.floor(i / 2)];
      expect(f.data).toMatchObject({ type: i % 2 === 0 ? "stage.started" : "stage.finished", stage });
    });

    const at = (type: string) => types(frames).indexOf(type as RunEvent["type"]);
    const finishedBind = frames.findIndex((f) => f.data.type === "stage.finished" && f.data.stage === "bind");
    expect(at("restatement")).toBe(finishedBind + 1);
    expect(at("chart")).toBeGreaterThan(0);
    expect(at("chart")).toBeLessThan(at("result"));
    expect(at("card")).toBe(at("result") - 1);
    expect(lastStatus(frames)).toBe("complete");
    expect(statuses(frames)).toEqual(["running", "complete"]);
  });

  it("serves the run as the client's fold of the stream", async () => {
    const run = await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`);
    expect(run.status).toBe("complete");
    expect(run.revision).toBe(0);
    expect(run.last_event_id).toBe(oeeFrames.at(-1)?.id);
    expect(stagesOf(run)).toEqual(OEE_STAGES);
    expect(run.timings.every((t) => typeof t.elapsed_ms === "number" && t.elapsed_ms >= 5)).toBe(true);
    expect(run.phase).toBe("present");
    expect(run.stage).toBe("validate");
    expect(run.restatement).toMatch(/OEE|oEE/);
    expect(run.result?.chart?.chart).toBe("table");
    expect(run.result?.rows.length).toBe(run.result?.row_count);
    expect(run.result?.chart?.alternatives.find((a) => a.chart === "point")?.hint).toMatch(/^see which categories/);
    expect(run.card?.blocking).toBe(false);
    // The side card: the point nobody was sure of (open, from idiom), and the least sure other.
    expect(run.card?.points.map((p) => [p.id, p.open, p.stage])).toEqual([
      ["reading", false, "abstract"],
      ["labels", true, "idiom"],
    ]);
    expect(run.started_at).not.toBeNull();
    expect(run.finished_at).not.toBeNull();
    expectSameRun(run, clientFold(oeeStart, oeeFrames));
  });

  it("resumes a stream after Last-Event-ID, header or query", async () => {
    const after = await stream(events(MFG, oee.run_id), { lastEventId: 10 });
    expect(after.frames[0]?.id).toBe(11);
    expect(after.frames.map((f) => f.id)).toEqual(oeeFrames.slice(10).map((f) => f.id));

    const res = await fetch(`${base}${events(MFG, oee.run_id)}?last_event_id=${oeeFrames.length - 1}`);
    const text = await res.text();
    expect(text.match(/^id: /gm)).toHaveLength(1);
    expect(text).toContain(`id: ${oeeFrames.length}\nevent: run.status\ndata: `);

    const nothing = await stream(events(MFG, oee.run_id), { lastEventId: oeeFrames.length });
    expect(nothing.frames).toEqual([]);
  });

  it("revises a thread as a new run, superseding the open one, and takes a revision back", async () => {
    const revised = await ok<RunCreated>("POST", `${MFG}/threads/${oee.thread_id}/revisions`, { message: "per week instead" });
    expect(revised.thread_id).toBe(oee.thread_id);
    expect(revised.run_id).not.toBe(oee.run_id);
    const { frames } = await stream(events(MFG, revised.run_id));
    expect(["complete", "clarify", "asking"]).toContain(lastStatus(frames));
    // A run that had already finished is not touched: the revision is simply the next run.
    expect((await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`)).status).toBe("complete");

    let thread = await ok<Thread>("GET", `${MFG}/threads/${oee.thread_id}`);
    expect(thread.runs.map((r) => [r.revision, r.prompt])).toEqual([
      [0, "What was the OEE of each line last week?"],
      [1, "per week instead"],
    ]);

    const open = await ok<RunCreated>("POST", `${MFG}/threads`, { question: "Which lines use the most energy per 1,000 good units?" });
    const next = await ok<RunCreated>("POST", `${MFG}/threads/${open.thread_id}/revisions`, { message: "only Linz" });
    const superseded = await ok<RunView>("GET", `${MFG}/runs/${open.run_id}`);
    expect(superseded.status).toBe("superseded");
    expect(superseded.finished_at).not.toBeNull();
    expect(lastStatus((await stream(events(MFG, open.run_id))).frames)).toBe("superseded");
    thread = await ok<Thread>("GET", `${MFG}/threads/${open.thread_id}`);
    expect(thread.runs.map((r) => r.revision)).toEqual([0, 1]);
    expect(thread.runs[1]?.id).toBe(next.run_id);
    const summary = (await ok<ThreadPage>("GET", `${MFG}/threads`)).items.find((t) => t.id === open.thread_id);
    expect(summary?.revisions).toBe(1);
    expect(summary?.active_run_id).toBe(next.run_id);
    await stream(events(MFG, next.run_id));

    const back = await ok<RunCreated>("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/1`);
    await stream(events(MFG, back.run_id));
    const taken = await ok<RunView>("GET", `${MFG}/runs/${back.run_id}`);
    expect([taken.revision, taken.prompt, taken.status]).toEqual([2, "Take back revision 1", "complete"]);
    expect(taken.result?.chart?.chart).toBe("table"); // revision 0's fixture again
    oeeLatest = back.run_id;
    expect((await call("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/9`)).status).toBe(404);
  });

  it("supersedes a run mid-stream: its stream ends on superseded, and the revision runs to the end", async () => {
    const created = await ok<RunCreated>("POST", `${MFG}/threads`, { question: "Which lines use the most energy per 1,000 good units?" });
    const start = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`);
    let revision: RunCreated | null = null;
    const old = await stream(events(MFG, created.run_id), {
      onFrame: async (frame) => {
        if (revision || frame.data.type !== "stage.finished") return;
        // Posted directly, never /cancel first.
        revision = await ok<RunCreated>("POST", `${MFG}/threads/${created.thread_id}/revisions`, { message: "per month" });
      },
    });
    expect(revision).not.toBeNull();
    const revised = revision as unknown as RunCreated;
    expect(revised.thread_id).toBe(created.thread_id);
    expect(lastStatus(old.frames)).toBe("superseded");
    expect(statuses(old.frames)).toEqual(["running", "superseded"]);
    expect(types(old.frames)).not.toContain("result");
    const ended = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`);
    expect(ended.status).toBe("superseded");
    expect(ended.last_event_id).toBe(old.frames.at(-1)?.id);
    expectSameRun(ended, clientFold(start, old.frames));

    const fresh = await stream(events(MFG, revised.run_id));
    expect(["complete", "clarify"]).toContain(lastStatus(fresh.frames));
    expect(fresh.frames.every((f) => f.data.run_id === revised.run_id)).toBe(true);
    const thread = await ok<Thread>("GET", `${MFG}/threads/${created.thread_id}`);
    expect(thread.runs.map((r) => [r.revision, r.status])).toEqual([
      [0, "superseded"],
      [1, lastStatus(fresh.frames)],
    ]);
  });

  it("stops at a blocking card and resumes the same run once it is answered: queued, then running", async () => {
    const asked = await ok<RunCreated>("POST", `${REST}/threads`, { question: "How much revenue did we make per month in 2025?" });
    const first = await stream(events(REST, asked.run_id));
    expect(lastStatus(first.frames)).toBe("asking");
    const cardFrame = first.frames.find((f) => f.data.type === "card")?.data;
    expect(cardFrame?.type === "card" && cardFrame.card.blocking).toBe(true);

    let run = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
    const waiting = run;
    expect(run.status).toBe("asking");
    expect(run.finished_at).toBeNull();
    expect(run.card?.blocking).toBe(true);
    expect(run.card?.points.map((p) => p.id)).toEqual(["area", "shape", "measure", "order"]);
    expect(run.card?.points.every((p) => p.stage === "abstract" && p.why === "")).toBe(true);
    expect((await ok<ThreadPage>("GET", `${REST}/threads`)).items[0]).toMatchObject({ status: "asking", active_run_id: asked.run_id });

    const resumed = await ok<RunCreated>("POST", `${REST}/runs/${asked.run_id}/answers`, {
      answers: { area: "fact_order_lines", order: null },
      text: null,
    });
    expect(resumed).toEqual(asked);
    const rest = await stream(events(REST, asked.run_id), { lastEventId: run.last_event_id });
    expect(rest.frames[0]?.id).toBe(run.last_event_id + 1);
    expect(statuses(rest.frames)).toEqual(["queued", "running", "complete"]);
    expect(startedStages(rest.frames)[0]).toBe("bind");

    run = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
    expect(run.status).toBe("complete");
    expect(run.card?.blocking).toBe(false);
    const area = run.card?.points.find((p) => p.id === "area");
    const order = run.card?.points.find((p) => p.id === "order");
    expect([area?.chosen, area?.by, area?.open]).toEqual(["fact_order_lines", "user", false]);
    expect([order?.chosen, order?.by]).toEqual(["ascending", "s1"]); // the default, decided for the user
    expect(run.result?.chart?.chart).toBe("line");
    expect(stagesOf(run).slice(0, 3)).toEqual(["situate", "abstract", "bind"]);
    expect(run.last_event_id).toBe(rest.frames.at(-1)?.id);
    expectSameRun(run, clientFold(waiting, rest.frames));

    expect((await call("POST", `${REST}/runs/${asked.run_id}/feedback`, { rating: "up" })).status).toBe(204);
    expect((await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`)).feedback).toBe("up");
  });

  it("ends an asking run on Stop (cancelled) or a revision (superseded), its blocking card kept as what was asked", async () => {
    const question = "How much revenue did we make per month in 2025?";
    for (const [leave, ending] of [["cancel", "cancelled"], ["revise", "superseded"]] as const) {
      const asked = await ok<RunCreated>("POST", `${REST}/threads`, { question });
      await stream(events(REST, asked.run_id));
      const waiting = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
      expect([waiting.status, waiting.card?.blocking]).toEqual(["asking", true]);

      if (leave === "cancel") await ok<RunCreated>("POST", `${REST}/runs/${asked.run_id}/cancel`);
      else await ok<RunCreated>("POST", `${REST}/threads/${asked.thread_id}/revisions`, { message: "only delivery" });
      // The status alone ends the wait: no card event, as the backend only sets the status.
      const { frames } = await stream(events(REST, asked.run_id), { lastEventId: waiting.last_event_id });
      expect(types(frames), leave).toEqual(["run.status"]);
      expect(lastStatus(frames)).toBe(ending);

      const left = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
      expect(left.status, leave).toBe(ending);
      expect(left.card, leave).toEqual(waiting.card);
      expectSameRun(left, clientFold(waiting, frames));
    }
  });

  it("switches the latest complete run to any chart it offers, queued then running, and refuses one it does not", async () => {
    const before = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    const drawn = before.result?.chart;
    expect(drawn?.chart).toBe("table");
    // An alternative the run never drew, as the switcher offers it: the mock draws it from the result's rows.
    const picked = drawn?.alternatives[0];
    expect(picked).toMatchObject({ chart: "horizontal_bar", label: "ranked bars" });
    const again = await ok<RunCreated>("POST", `${MFG}/runs/${oeeLatest}/chart`, { chart: picked?.chart });
    expect(again.run_id).toBe(oeeLatest);
    const { frames } = await stream(events(MFG, oeeLatest), { lastEventId: before.last_event_id });
    expect(statuses(frames)).toEqual(["queued", "running", "complete"]);
    expect(startedStages(frames)).toEqual(PRESENT);
    const chartFrame = frames.find((f) => f.data.type === "chart")?.data;
    expect(chartFrame?.type === "chart" && chartFrame.chart.chart).toBe("horizontal_bar");
    const after = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    // A stage that runs again is a new timing, as the client folds it: the present stages twice.
    expect(stagesOf(after)).toEqual([...stagesOf(before), ...PRESENT]);
    expect(after.timings.every((t) => typeof t.elapsed_ms === "number")).toBe(true);
    const switched = after.result?.chart;
    expect([switched?.chart, switched?.label, switched?.png_url]).toEqual(["horizontal_bar", "ranked bars", null]);
    expect(switched?.alternatives.map((a) => a.chart)).toEqual(["table", "point", "bar"]);
    const data = switched?.spec.data as { values: unknown[] } | undefined;
    expect(data?.values).toHaveLength(before.result?.rows.length ?? -1);
    expect(switched?.spec.config).toEqual(drawn?.spec.config); // in the drawn chart's theme
    expect(after.result?.rows).toEqual(before.result?.rows);
    expectSameRun(after, clientFold(before, frames));

    // Back to the chart the run drew: its own rendering again.
    await ok<RunCreated>("POST", `${MFG}/runs/${oeeLatest}/chart`, { chart: "table" });
    const home = await stream(events(MFG, oeeLatest), { lastEventId: after.last_event_id });
    expect(statuses(home.frames)).toEqual(["queued", "running", "complete"]);
    expect((await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`)).result?.chart).toEqual(drawn);

    const never = await refused("POST", `${MFG}/runs/${oeeLatest}/chart`, { chart: "pie" }, 409);
    expect(never.code).toBe("not_answerable");
    expect(never.detail).toBe("The run offers no pie chart; its charts are table, horizontal_bar, point, bar.");
  });

  it("answers a complete run's side card by presenting the same run again", async () => {
    const before = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    expect(before.card?.points.find((p) => p.id === "labels")?.open).toBe(true);
    const again = await ok<RunCreated>("POST", `${MFG}/runs/${oeeLatest}/answers`, { answers: { labels: "none" } });
    expect(again.run_id).toBe(oeeLatest);
    const { frames } = await stream(events(MFG, oeeLatest), { lastEventId: before.last_event_id });
    expect(statuses(frames)).toEqual(["queued", "running", "complete"]);
    expect(types(frames).slice(0, 4)).toEqual(["run.status", "run.status", "card", "stage.started"]);
    expect(startedStages(frames)).toEqual(PRESENT);
    const after = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    expect(after.card?.points.find((p) => p.id === "labels")).toMatchObject({ chosen: "none", by: "user", open: false });
    expectSameRun(after, clientFold(before, frames));
  });

  it("refuses with the contract's 409 codes: not_latest for an older run, not_answerable for one that cannot take it", async () => {
    // oee.run_id is revision 0 of a thread that has moved on to revision 2.
    for (const [path, body] of [
      ["answers", { answers: { labels: "none" } }],
      ["answers", { answers: {}, text: "per month instead" }],
      ["chart", { chart: "table" }],
    ] as const) {
      expect((await refused("POST", `${MFG}/runs/${oee.run_id}/${path}`, body, 409)).code, path).toBe("not_latest");
    }

    const created = await ok<RunCreated>("POST", `${MFG}/threads`, { question: "Which lines use the most energy per 1,000 good units?" });
    let cancelledAt = 0;
    const { frames } = await stream(events(MFG, created.run_id), {
      onFrame: async (frame) => {
        if (cancelledAt || frame.data.type !== "stage.finished") return;
        cancelledAt = frame.id;
        await ok<RunCreated>("POST", `${MFG}/runs/${created.run_id}/cancel`);
      },
    });
    expect(cancelledAt).toBeGreaterThan(0);
    expect(lastStatus(frames)).toBe("cancelled");
    expect(types(frames)).not.toContain("result");
    const run = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`);
    expect(run.status).toBe("cancelled");
    expect(run.finished_at).not.toBeNull();
    expect(run.last_event_id).toBe(frames.at(-1)?.id);
    expect((await refused("POST", `${MFG}/runs/${created.run_id}/answers`, { answers: {} }, 409)).code).toBe("not_answerable");
    expect((await refused("POST", `${MFG}/runs/${created.run_id}/chart`, { chart: "table" }, 409)).code).toBe("not_answerable");
  });

  it("answers bad input with FastAPI-shaped 422s", async () => {
    const missing = await refused("POST", `${MFG}/threads`, {}, 422);
    expect(missing.errors).toEqual([{ loc: ["body", "question"], msg: "Field required", type: "missing" }]);
    const blank = await refused("POST", `${MFG}/threads/${oee.thread_id}/revisions`, { message: "  " }, 422);
    expect(blank.errors?.[0]).toMatchObject({ loc: ["body", "message"], type: "string_too_short" });
    const notJson = await refused("POST", `${MFG}/threads`, "{not json", 422);
    expect(notJson.errors?.[0]?.type).toBe("json_invalid");
    const rating = await refused("POST", `${MFG}/runs/${oee.run_id}/feedback`, { rating: "meh" }, 422);
    expect(rating.errors?.[0]).toMatchObject({ loc: ["body", "rating"], type: "enum" });
    const answers = await refused("POST", `${MFG}/runs/${oeeLatest}/answers`, { answers: { labels: 3 } }, 422);
    expect(answers.errors?.[0]).toMatchObject({ loc: ["body", "answers", "labels"], type: "string_type" });
    const n = await refused("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/0`, undefined, 422);
    expect(n.errors?.[0]).toMatchObject({ loc: ["path", "n"], type: "greater_than_equal" });
  });

  it("ends the data-gap question in clarify: what is missing, what to record, the nearest questions", async () => {
    const asked = await ok<RunCreated>("POST", `${REST}/threads`, { question: "What is the profit margin per branch?" });
    const { frames } = await stream(events(REST, asked.run_id));
    expect(lastStatus(frames)).toBe("clarify");
    expect(types(frames)).not.toContain("result");
    const clarify = frames.find((f) => f.data.type === "clarify")?.data;
    expect(clarify?.type).toBe("clarify");
    const report = clarify?.type === "clarify" ? clarify.clarify : null;
    expect(report?.gaps).toEqual([]);
    expect(report?.missing).toEqual(["Gross profit margin is not possible yet: the warehouse holds no cost of goods sold"]);
    expect(report?.record).toEqual(["the cost of the goods sold per sale or per period, from the costing or the general ledger"]);
    expect(report?.nearest).toEqual(["What is the revenue per branch?"]);
    expect(report?.warnings.length).toBeGreaterThan(0);
    const run = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
    expect(run.clarify).toEqual(report);
    expect(run.result).toBeNull();

    // A nearest question, offered as a one-click revision, gets a chart.
    const nearest = await ok<RunCreated>("POST", `${REST}/threads/${asked.thread_id}/revisions`, { message: report?.nearest[0] });
    await stream(events(REST, nearest.run_id));
    const answered = await ok<RunView>("GET", `${REST}/runs/${nearest.run_id}`);
    expect(answered.status).toBe("complete");
    expect(answered.result?.chart).not.toBeNull();
  });

  it("restarts a run when its worker does: queued after running, then the whole trace again", async () => {
    const { startMockServer } = (await import(/* @vite-ignore */ SERVER)) as MockModule;
    const other = await startMockServer({ ...OPTIONS, seed: false, restartEvery: 1 });
    try {
      const res = await call<RunCreated>("POST", `${MFG}/threads`, { question: "What was the OEE of each line last week?" }, other.url);
      expect(res.status).toBe(202);
      const start = (await call<RunView>("GET", `${MFG}/runs/${res.body.run_id}`, undefined, other.url)).body;
      const { frames } = await stream(events(MFG, res.body.run_id), { at: other.url });
      expect(statuses(frames)).toEqual(["running", "queued", "running", "complete"]);
      expect(startedStages(frames)).toEqual([...OEE_STAGES.slice(0, 2), ...OEE_STAGES]);
      const run = (await call<RunView>("GET", `${MFG}/runs/${res.body.run_id}`, undefined, other.url)).body;
      // The restart cleared the trace: one pass of the stages, the second attempt's.
      expect(stagesOf(run)).toEqual(OEE_STAGES);
      expectSameRun(run, clientFold(start, frames));
    } finally {
      await other.close();
    }
  });
});

// --- the key-user registry -----------------------------------------------------------------------

describe("mock registry", () => {
  const entries = (ws: string, query = "") => `${ws}/registry/entries${query}`;

  it("lists entries most recently asked first, filtered, paged, with the proposed counts whatever the filter", async () => {
    const all = await ok<RegistryPage>("GET", entries(MFG));
    expect(all.next_cursor).toBeNull();
    expect(all.counts).toEqual({ measure: 4, default: 1, gap: 1 });
    expect(new Set(all.items.map((e) => e.kind))).toEqual(new Set(["measure", "default", "gap"]));
    const asked = all.items.map((e) => e.demand.last_asked ?? "");
    expect([...asked].sort().reverse()).toEqual(asked);
    for (const entry of all.items) {
      expect(entry.words.en?.length).toBeGreaterThan(0);
      expect(entry.words.de?.length).toBeGreaterThan(0);
      expect(entry.version).toBeGreaterThanOrEqual(1);
      expect(entry.reviewed_by === null).toBe(entry.status === "proposed");
      expect(entry.demand.runs).toBeGreaterThan(0);
      expect(entry.gap === null).toBe(entry.kind !== "gap");
      expect(entry.choices === null).toBe(entry.kind !== "default");
    }
    expect(all.items.some((e) => e.status === "approved")).toBe(true);
    expect(all.items.some((e) => e.status === "rejected")).toBe(true);

    const measures = await ok<RegistryPage>("GET", entries(MFG, "?kind=measure"));
    expect(measures.items.every((e) => e.kind === "measure")).toBe(true);
    expect(measures.items.map((e) => e.id)).toEqual(all.items.filter((e) => e.kind === "measure").map((e) => e.id));
    const approved = await ok<RegistryPage>("GET", entries(MFG, "?status=approved"));
    expect(approved.items.map((e) => e.term)).toEqual(["availability"]);
    expect(approved.counts).toEqual(all.counts);
    const proposedDefaults = await ok<RegistryPage>("GET", entries(MFG, "?kind=default&status=proposed"));
    expect(proposedDefaults.items.map((e) => e.term)).toEqual(["best plant"]);

    const ids: string[] = [];
    let cursor: string | null = "";
    let pages = 0;
    while (cursor !== null) {
      const page: RegistryPage = await ok<RegistryPage>("GET", entries(MFG, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`));
      expect(page.items.length).toBeLessThanOrEqual(3);
      ids.push(...page.items.map((e) => e.id));
      cursor = page.next_cursor;
      pages += 1;
    }
    expect(pages).toBe(Math.ceil(all.items.length / 3));
    expect(ids).toEqual(all.items.map((e) => e.id));

    const restaurant = await ok<RegistryPage>("GET", entries(REST));
    expect(restaurant.counts).toEqual({ measure: 1, default: 1, gap: 1 });
    expect(restaurant.items.length).toBeGreaterThanOrEqual(6);

    expect((await refused("GET", entries(MFG, "?kind=kpi"), undefined, 422)).errors?.[0]).toMatchObject({
      loc: ["query", "kind"],
      type: "enum",
    });
    expect((await refused("GET", entries(MFG, "?limit=0"), undefined, 422)).errors?.[0]).toMatchObject({
      loc: ["query", "limit"],
      type: "greater_than_equal",
    });
    expect((await call("GET", entries("/api/v1/workspaces/nowhere"))).status).toBe(404);
  });

  it("details an entry with the runs that asked for it, which open as real threads", async () => {
    const entry = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-oee"));
    expect(entry).toMatchObject({
      kind: "measure",
      term: "oee",
      label: "OEE",
      source: { kind: "library", text: "from sightline's KPI library (ISO 22400-2)" },
      status: "proposed",
      version: 1,
      reviewed_by: null,
    });
    // The definition in the core's words, from the restatement's "Defined as:".
    expect(entry.definition).toMatch(/^availability \(actual production time \(run hours\) over planned busy time/);
    expect(entry.definition).toMatch(/good quantity over produced quantity\)$/);
    expect(entry.words.de).toContain("gesamtanlageneffektivität");

    // The seeded OEE run, and the live ones this file made that replayed the same fixture.
    const ids = entry.runs.map((r) => r.run_id);
    expect(ids).toContain("run_seed_oee-line");
    expect(ids).toContain(oee.run_id);
    expect(ids).toContain(oeeLatest);
    expect(entry.demand.runs).toBe(6 + entry.runs.length);
    expect(entry.demand.last_asked).toBe(entry.runs[0]?.at);
    expect(entry.runs.map((r) => r.at)).toEqual(entry.runs.map((r) => r.at).sort().reverse());
    for (const used of entry.runs) {
      const thread = await ok<Thread>("GET", `${MFG}/threads/${used.thread_id}`);
      const run = thread.runs.find((r) => r.id === used.run_id);
      expect(run, used.run_id).toBeDefined();
      expect(used.question).toBe(thread.question);
      expect(used.rating).toBe(run?.feedback ?? null);
    }
    expect(entry.runs.find((r) => r.run_id === "run_seed_oee-line")?.rating).toBe("up");

    // The clarify run asked for it too.
    const availability = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-availability"));
    expect(availability.runs.map((r) => r.thread_id)).toEqual(expect.arrayContaining(["th_seed_aeq-clarify", "th_seed_aeq-weekly"]));
    expect([availability.status, availability.version, availability.reviewed_by]).toEqual(["approved", 2, "Dev user"]);

    const plant = await ok<RegistryEntryDetail>("GET", entries(MFG, "/default-best-plant"));
    expect(plant.definition).toBe("OEE");
    expect(plant.source.kind).toBe("learned");
    expect(plant.choices).toEqual([
      { option: "oee", label: "OEE", count: 7 },
      { option: "availability", label: "availability", count: 2 },
      { option: "scrap_rate", label: "scrap rate", count: 1 },
    ]);

    const margin = await ok<RegistryEntryDetail>("GET", entries(REST, "/gap-profit-margin"));
    expect(margin.gap).toEqual({
      missing: ["Gross profit margin is not possible yet: the warehouse holds no cost of goods sold"],
      record: ["the cost of the goods sold per sale or per period, from the costing or the general ledger"],
    });
    expect(margin.runs.map((r) => r.thread_id)).toContain("th_seed_margin-gap");
    const revenue = await ok<RegistryEntryDetail>("GET", entries(REST, "/default-revenue"));
    expect(revenue.choices?.map((c) => c.label)).toEqual(["line revenue", "amount", "unit price"]);

    expect((await call("GET", entries(MFG, "/measure-nothing"))).status).toBe(404);
  });

  it("lists, for every entry with demand, runs that open as real threads", async () => {
    for (const ws of [MFG, REST]) {
      const page = await ok<RegistryPage>("GET", entries(ws));
      for (const listed of page.items) {
        const entry = await ok<RegistryEntryDetail>("GET", entries(ws, `/${listed.id}`));
        expect(entry.demand.runs, entry.id).toBeGreaterThan(0);
        expect(entry.runs.length, entry.id).toBeGreaterThan(0);
        expect(entry.runs.length, entry.id).toBeLessThanOrEqual(entry.demand.runs);
        for (const used of entry.runs) {
          const thread = await ok<Thread>("GET", `${ws}/threads/${used.thread_id}`);
          expect(thread.runs.some((r) => r.id === used.run_id), `${entry.id} ${used.run_id}`).toBe(true);
        }
      }
    }
    const plant = await ok<RegistryEntryDetail>("GET", entries(MFG, "/default-best-plant"));
    expect(plant.runs.map((r) => r.run_id)).toEqual(expect.arrayContaining(["run_seed_oee-line", "run_seed_energy"]));
    // A rejected entry keeps the runs from before its rejection.
    const tipRate = await ok<RegistryEntryDetail>("GET", entries(REST, "/measure-tip-rate"));
    expect(tipRate.status).toBe("rejected");
    expect(tipRate.runs.map((r) => r.run_id)).toContain("run_seed_tips");
    expect(tipRate.runs.every((r) => r.at < tipRate.updated_at)).toBe(true);
  });

  it("approves, then refuses the stale version, then reopens and rejects, each review a new version", async () => {
    const path = entries(MFG, "/measure-oee/review");
    const approved = await ok<RegistryEntryDetail>("POST", path, { action: "approve", version: 1, note: "As in the plant report." }, 200);
    expect(approved).toMatchObject({ status: "approved", version: 2, reviewed_by: "Dev user", note: "As in the plant report." });
    expect(Date.now() - Date.parse(approved.updated_at)).toBeLessThan(60_000);
    expect(approved.runs.length).toBeGreaterThan(0);
    expect((await ok<RegistryPage>("GET", entries(MFG))).counts.measure).toBe(3);

    // Someone reviewed it first: the stale version is refused, whatever the action.
    const stale = await refused("POST", path, { action: "reject", version: 1 }, 409);
    expect(stale.code).toBe("version_conflict");
    expect((await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-oee"))).version).toBe(2);
    // On the current version, a move its status does not allow.
    expect((await refused("POST", path, { action: "approve", version: 2 }, 409)).code).toBe("not_latest");

    const reopened = await ok<RegistryEntryDetail>("POST", path, { action: "reopen", version: 2 }, 200);
    expect([reopened.status, reopened.version]).toEqual(["proposed", 3]);
    expect((await refused("POST", path, { action: "reopen", version: 3 }, 409)).code).toBe("not_latest");
    const rejected = await ok<RegistryEntryDetail>("POST", path, { action: "reject", version: 3 }, 200);
    expect([rejected.status, rejected.version]).toEqual(["rejected", 4]);
    expect((await ok<RegistryPage>("GET", entries(MFG))).counts.measure).toBe(3);
    const back = await ok<RegistryEntryDetail>("POST", path, { action: "reopen", version: 4 }, 200);
    expect([back.status, back.version]).toEqual(["proposed", 5]);
    expect((await ok<RegistryPage>("GET", entries(MFG))).counts.measure).toBe(4);

    const bad = await refused("POST", path, { action: "promote" }, 422);
    expect(bad.errors?.map((e) => [e.loc, e.type])).toEqual([
      [["body", "action"], "enum"],
      [["body", "version"], "missing"],
    ]);
  });

  it("edits the label and words only, and refuses a word another entry already uses", async () => {
    const path = entries(MFG, "/measure-effectiveness/review");
    const before = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-effectiveness"));

    const collision = await refused(
      "POST",
      path,
      { action: "edit", version: before.version, changes: { words: { en: ["effectiveness", "OEE", "performance rate"] } } },
      422,
    );
    expect(collision.errors).toEqual([
      {
        loc: ["body", "changes", "words", "en", 1],
        msg: '"OEE" already names oee.',
        type: "word_collision",
        ctx: { word: "OEE", collides_with: "oee" },
      },
    ]);
    const german = await refused("POST", path, { action: "edit", version: before.version, changes: { words: { de: ["Verfügbarkeit"] } } }, 422);
    expect(german.errors?.[0]?.ctx).toEqual({ word: "Verfügbarkeit", collides_with: "availability" });
    // A refused edit changes nothing.
    expect(await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-effectiveness"))).toEqual(before);

    const empty = await refused("POST", path, { action: "edit", version: before.version, changes: { label: "  " } }, 422);
    expect(empty.errors?.[0]).toMatchObject({ loc: ["body", "changes", "label"], type: "string_too_short" });
    const nothing = await refused("POST", path, { action: "edit", version: before.version }, 422);
    expect(nothing.errors?.[0]?.loc).toEqual(["body", "changes"]);

    const edited = await ok<RegistryEntryDetail>(
      "POST",
      path,
      {
        action: "edit",
        version: before.version,
        // A rejected entry's words are free again ("scrap against plan" was rejected).
        changes: { label: "Performance", words: { de: ["effektivität", "leistungsgrad", "Leistung", "leistung"] } },
      },
      200,
    );
    expect(edited).toMatchObject({ label: "Performance", status: "proposed", version: before.version + 1, reviewed_by: "Dev user" });
    expect(edited.words).toEqual({ en: before.words.en, de: ["effektivität", "leistungsgrad", "Leistung"] });
    expect([edited.term, edited.definition, edited.kind]).toEqual([before.term, before.definition, before.kind]);

    const free = await ok<RegistryEntryDetail>(
      "POST",
      path,
      { action: "edit", version: edited.version, changes: { words: { en: [...(before.words.en ?? []), "scrap against plan"] } } },
      200,
    );
    expect(free.words.en).toContain("scrap against plan");
    expect(free.version).toBe(edited.version + 1);

    // Reopening the rejected entry would give it the word back: refused at the word's place in its words.
    const scrap = entries(MFG, "/measure-scrap-against-plan");
    const rejected = await ok<RegistryEntryDetail>("GET", scrap);
    expect([rejected.status, rejected.words.en?.[0]]).toEqual(["rejected", "scrap against plan"]);
    const reopen = await refused("POST", `${scrap}/review`, { action: "reopen", version: rejected.version }, 422);
    expect(reopen.errors).toEqual([
      {
        loc: ["body", "changes", "words", "en", 0],
        msg: '"scrap against plan" already names effectiveness.',
        type: "word_collision",
        ctx: { word: "scrap against plan", collides_with: "effectiveness" },
      },
    ]);
    expect(reopen.detail).toBe('"scrap against plan" already names effectiveness: take it out of "Scrap against plan" to reopen it.');
    expect(await ok<RegistryEntryDetail>("GET", scrap)).toEqual(rejected);
    // Taken out, it reopens; no two entries in use share a word.
    const trimmed = await ok<RegistryEntryDetail>(
      "POST",
      `${scrap}/review`,
      { action: "edit", version: rejected.version, changes: { words: { en: ["actual to planned scrap"] } } },
      200,
    );
    expect(trimmed.status).toBe("rejected");
    const reopened = await ok<RegistryEntryDetail>("POST", `${scrap}/review`, { action: "reopen", version: trimmed.version }, 200);
    expect([reopened.status, reopened.words.en]).toEqual(["proposed", ["actual to planned scrap"]]);
    const inUse = (await ok<RegistryPage>("GET", entries(MFG))).items.filter((e) => e.status !== "rejected");
    const said = inUse.flatMap((e) => Object.entries(e.words).flatMap(([locale, list]) => list.map((w) => `${locale}:${w.toLowerCase()}`)));
    expect(new Set(said).size).toBe(said.length);
  });
});
