// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvent } from "../src/api/runEvents";
import type {
  Card,
  ChartOption,
  ChartView,
  Clarify,
  DecisionPoint,
  Definition,
  FollowUp,
  Me,
  Problem,
  RegistryEntryDetail,
  RegistryPage,
  Result,
  RunCreated,
  RunEvent,
  RunStatus,
  RunView,
  SchemaInfo,
  StepResult,
  Support,
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
    analysis?: boolean;
    maxActive?: number;
  }): Promise<{ url: string; close(): Promise<void> }>;
}
interface FixtureStepShape {
  id: string;
  role: string;
  sql: string | null;
  rows: unknown[][];
}
interface FixtureShape {
  slug: string;
  synthetic?: boolean;
  made_up?: string[];
  question: string;
  final_status: string;
  restatement: string | null;
  definitions: Definition[];
  card: Card | null;
  clarify: Clarify | null;
  follow_ups: (FollowUp & { fixture: string | null })[];
  result: Result | null;
  charts: Record<string, ChartView["spec"]>;
  chart_options: ChartOption[];
  form_point: DecisionPoint | null;
  analysis: {
    synthetic: true;
    storyline: { top: string; key_line: { id: string; text: string }[] };
    lead: string;
    supports: Support[];
    notes: string[];
    steps: FixtureStepShape[];
    follow_ups: (FollowUp & { fixture: string | null })[];
  } | null;
}
interface FixtureModule {
  loadFixtures(): Map<string, FixtureShape[]>;
}
interface PlanModule {
  chartOptions(fixture: unknown): ChartOption[];
  chartView(fixture: unknown, chart: string | null | undefined, analysis: boolean): ChartView | null;
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

async function another(options: Parameters<MockModule["startMockServer"]>[0]) {
  const { startMockServer } = (await import(/* @vite-ignore */ SERVER)) as MockModule;
  return startMockServer({ ...OPTIONS, seed: false, ...options });
}

// --- helpers -------------------------------------------------------------------------------

const MFG = "/api/v1/workspaces/manufacturing";
const REST = "/api/v1/workspaces/restaurant";
const OEE_QUESTION = "What was the OEE of each line last week?";

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  at = base,
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(at + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

async function ok<T>(method: string, path: string, body?: unknown, status = method === "GET" ? 200 : 202, at = base): Promise<T> {
  const res = await call<T>(method, path, body, at);
  expect(res.status, `${method} ${path}`).toBe(status);
  return res.body;
}

/** A refusal: its status, and the Problem it carries. */
async function refused(method: string, path: string, body: unknown, status: number, at = base): Promise<Problem> {
  const res = await call<Problem>(method, path, body, at);
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
const finishedAt = (frames: Frame[], stage: string) =>
  frames.findIndex((f) => f.data.type === "stage.finished" && f.data.stage === stage);

/** Asks a question and reads its stream to the end: the run as created, as it started, and every frame. */
async function ask(ws: string, question: string, at = base) {
  const created = await ok<RunCreated>("POST", `${ws}/threads`, { question }, 202, at);
  const start = await ok<RunView>("GET", `${ws}/runs/${created.run_id}`, undefined, 200, at);
  const { frames } = await stream(events(ws, created.run_id), { at });
  const run = await ok<RunView>("GET", `${ws}/runs/${created.run_id}`, undefined, 200, at);
  return { created, start, frames, run };
}

/** Sends a revision (typed, a follow-up, a nearest question) and reads its run to the end. */
async function revise(ws: string, threadId: string, body: Record<string, unknown>, at = base) {
  const created = await ok<RunCreated>("POST", `${ws}/threads/${threadId}/revisions`, body, 202, at);
  const { frames } = await stream(events(ws, created.run_id), { at });
  const run = await ok<RunView>("GET", `${ws}/runs/${created.run_id}`, undefined, 200, at);
  return { created, frames, run };
}

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

/**
 * Server and client hold the same run, but for the times each stamps on its own clock,
 * and the fields no event carries (the definitions, the follow-ups), which the client
 * reads from getRun when the stream ends.
 */
function expectSameRun(server: RunView, client: RunView): void {
  const strip = ({ started_at: _s, finished_at: _f, definitions: _d, follow_ups: _u, ...rest }: RunView) => rest;
  expect(strip(server)).toEqual(strip(client));
  expect(server.started_at === null).toBe(client.started_at === null);
  expect(server.finished_at === null).toBe(client.finished_at === null);
}

const stagesOf = (run: RunView) => run.timings.map((t) => t.stage);

// The tests share one mock and run in order: later ones use the runs earlier ones made.
let oee: RunCreated;
let oeeStart: RunView;
let oeeFrames: Frame[] = [];
let oeeRun: RunView;
/** The OEE thread's latest run once the follow-up was taken back: the oee-line fixture again. */
let oeeLatest = "";
const OEE_STAGES = [
  "situate", "recall", "define", "ground", "abstract", "bind",
  "enrich", "derive", "query", "idiom", "render", "perceive", "validate",
];
/** The same pass with the analysis' stages: plan before bind, analyse and gather after query. */
const OEE_ANALYSED = [
  "situate", "recall", "define", "ground", "abstract", "plan", "bind",
  "enrich", "derive", "query", "analyse", "gather", "idiom", "render", "perceive", "validate",
];
const PRESENT = ["idiom", "render", "perceive", "validate"];

// --- the fixtures ---------------------------------------------------------------------------------

describe("mock fixtures", () => {
  it("carry the contract's shapes: decision points, the clarify, chart options with scores, notes, definitions", async () => {
    const { loadFixtures } = (await import(/* @vite-ignore */ FIXTURES)) as FixtureModule;
    const all = [...loadFixtures().values()].flat();
    expect(all.length).toBeGreaterThanOrEqual(11);
    const points: DecisionPoint[] = all.flatMap((f) => f.card?.points ?? []);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(["rules", "s1", "s2", "user", "default"]).toContain(point.by);
      expect(typeof point.open).toBe("boolean");
      expect(typeof point.stage).toBe("string");
      expect(typeof point.why).toBe("string");
      expect(point.entry_id).toBeNull();
      expect(point.options.every((o) => typeof o.hint === "string")).toBe(true);
    }
    expect(points.some((p) => p.open)).toBe(true);
    expect(points.some((p) => p.stage === "idiom")).toBe(true);
    // A card beside the chart asks only what the drawing left open (form, point and detail
    // points nobody was sure of) and what an approved default settled; never a meaning point.
    for (const fixture of all.filter((f) => f.card && !f.card.blocking)) {
      expect(fixture.final_status, fixture.slug).toBe("complete");
      for (const point of fixture.card!.points) {
        const asked = (point.open && ["form", "point", "detail"].includes(point.step)) || (point.by === "default" && point.entry_id !== null);
        expect(asked, `${fixture.slug} ${point.id}`).toBe(true);
      }
    }
    expect(all.find((f) => f.slug === "energy")?.card).toBeNull(); // nobody was unsure of anything it drew

    for (const fixture of all.filter((f) => f.final_status === "clarify")) {
      const clarify = fixture.clarify!;
      for (const list of [clarify.gaps, clarify.missing, clarify.record, clarify.warnings]) {
        expect(Array.isArray(list), fixture.slug).toBe(true);
      }
      expect(clarify).not.toHaveProperty("nearest");
      expect(clarify.warnings.length).toBeLessThanOrEqual(5);
      expect(new Set(clarify.warnings).size).toBe(clarify.warnings.length);
      expect(clarify.warnings_total).toBeGreaterThanOrEqual(clarify.warnings.length);
      for (const gap of clarify.gaps) {
        expect(gap.reason).not.toMatch(/star/); // in a user's words, not the core's
        for (const suggestion of gap.suggestions) {
          expect(Object.keys(suggestion).sort()).toEqual(["id", "label", "question"]);
          expect(suggestion.question).toMatch(/\?$/);
          expect(suggestion.question).toContain(suggestion.label);
        }
      }
    }
    const aeq = all.find((f) => f.slug === "aeq-clarify");
    expect(aeq?.clarify?.warnings_total).toBeGreaterThan(5);
    expect(aeq?.clarify?.gaps[0]?.suggestions[0]?.question).toBe(
      "How did scorecard spend, effectiveness and quality ratio develop per week in Q4 2025?",
    );
    expect(aeq?.made_up).toEqual(["restatement"]);

    // The real data-gap ending, not a made-up one; its nearest question is a follow-up now.
    const gap = all.find((f) => f.slug === "margin-gap");
    expect(gap?.synthetic).toBeUndefined();
    expect(gap?.clarify?.missing.length).toBeGreaterThan(0);
    expect(gap?.follow_ups.map((f) => [f.kind, f.question])).toEqual([["nearest", "What is the revenue per branch?"]]);

    // The failed ending is made up, and says so.
    const failed = all.find((f) => f.final_status === "failed");
    expect(failed?.synthetic).toBe(true);

    const complete = all.filter((f) => f.final_status === "complete");
    for (const fixture of complete) {
      const result = fixture.result!;
      // Options by score, highest first, then chart id.
      const scores = fixture.chart_options.map((o) => o.score);
      expect([...scores].sort((a, b) => b - a), fixture.slug).toEqual(scores);
      // One home per text: no "Defined as" in the restatement, no caveat in the subtitle,
      // neither as the note words it nor as the core's raw "* ..." line.
      expect(fixture.restatement, fixture.slug).not.toMatch(/Defined as/);
      for (const line of result.chart?.subtitle ?? []) {
        expect(line, fixture.slug).not.toMatch(/^\*|incomplete|left out|Top \d+ of/i);
        const bare = line.replace(/^\*\s*/, "").toLowerCase();
        for (const note of result.notes) expect(bare, fixture.slug).not.toBe(note.toLowerCase());
      }
      // The chart in plain words for screen readers; the rule ids in usermeta.
      for (const [chart, spec] of Object.entries(fixture.charts)) {
        expect(spec.description, `${fixture.slug} ${chart}`).toMatch(/^[A-Z][^:]*: /);
        expect(spec.description, `${fixture.slug} ${chart}`).not.toMatch(/rules:|[A-Z]+-[A-Z]+-/);
        expect((spec.usermeta as { rules?: unknown }).rules, `${fixture.slug} ${chart}`).toEqual(expect.arrayContaining([expect.stringMatching(/^[A-Z]+-/)]));
      }
      // The chart choice the core made, offering every chart the switcher does.
      expect(fixture.form_point?.step, fixture.slug).toBe("form");
      expect(fixture.form_point?.options.map((o) => o.id).sort(), fixture.slug).toEqual(fixture.chart_options.map((o) => o.chart).sort());
      expect(result.step_id).toBe("st1");
      expect(result.storyline).toBeNull();
      expect(result.supports).toEqual([]);
      for (const column of result.columns) {
        expect(typeof column.label).toBe("string");
        expect(column.role === null || ["dimension", "measure", "time"].includes(column.role)).toBe(true);
        expect(column.format === null).toBe(column.role !== "measure");
      }
      expect(["pass", "warn", "fail"]).toContain(result.verdict);
      expect(result.concerns.length === 0).toBe(result.verdict === "pass");
    }
    const options = all.flatMap((f) => f.chart_options);
    expect(options.every((o) => o.hint === null || typeof o.hint === "string")).toBe(true);
    // idiom's reads, not the form option's "to ..." wording.
    expect(options.find((o) => o.chart === "horizontal_bar")?.hint).toBe("see which categories are the largest and how far apart they are");
    // Without the analysis the core's findings stand.
    expect(all.flatMap((f) => f.result?.findings ?? [])).toContain("line revenue €84k → €105k, Jan–Dec 2025");

    const weekly = all.find((f) => f.slug === "aeq-weekly")!;
    expect(weekly.result?.notes).toEqual(["Incomplete weeks: the data shown starts on 1 Oct 2025 and ends on 23 Dec 2025"]);
    expect(weekly.result?.chart?.subtitle).toEqual(["Oct–Dec 2025"]);
    expect(weekly.definitions.map((d) => [d.name, d.entry_id, d.source.kind])).toEqual([
      ["availability", "measure-availability", "library"],
      ["quality ratio", "measure-quality-ratio", "library"],
      ["effectiveness", "measure-effectiveness", "library"],
    ]);
    const scrap = all.find((f) => f.slug === "scrap")!;
    expect(scrap.result?.notes).toEqual(["Top 10 of 10,370 production orders"]);
    // The question names it without defining it: sightline's draft, the registry entry the key user rejected.
    expect(scrap.definitions.map((d) => [d.entry_id, d.source.kind])).toEqual([["measure-scrap-against-plan", "drafted"]]);
    // "Energy per 1,000 good units" says what it divides: the question's own definition.
    expect(all.find((f) => f.slug === "energy")?.definitions[0]?.source).toEqual({ kind: "question", text: "as the question states it" });
    const line = all.find((f) => f.slug === "oee-line")!;
    expect(line.restatement).toBe("You want to see OEE by line, from 22 Dec 2025 to 28 Dec 2025.");
    expect(line.definitions[0]).toMatchObject({ name: "oee", label: "OEE", entry_id: "measure-oee", status: "proposed" });
    expect(line.definitions[0]?.source.text).toBe("from sightline's KPI library (ISO 22400-2)");
  });

  it("carry a made-up analysis on every complete fixture, marked synthetic, built from the run's rows", async () => {
    const { loadFixtures } = (await import(/* @vite-ignore */ FIXTURES)) as FixtureModule;
    const all = [...loadFixtures().values()].flat();
    for (const fixture of all) {
      const analysis = fixture.analysis;
      if (fixture.final_status !== "complete") {
        expect(analysis, fixture.slug).toBeNull();
        continue;
      }
      expect(analysis?.synthetic, fixture.slug).toBe(true);
      const { storyline, supports, steps, follow_ups } = analysis!;
      expect(storyline.top.length).toBeGreaterThan(0);
      // Two or three points; one where a breaking check limited the claim (tips).
      expect(storyline.key_line.length, fixture.slug).toBeGreaterThanOrEqual(fixture.slug === "tips" ? 1 : 2);
      expect(storyline.key_line.length).toBeLessThanOrEqual(3);
      expect(storyline.key_line.map((k) => k.text)).not.toContain(storyline.top);
      // One home per text: a key point, a caption and a support's words are never a note
      // (a caveat) or a base (the subtitle's), and a support in words alone states a fact
      // of its own rather than a window, an aggregation or a period left out.
      const notes = [...(fixture.result?.notes ?? []), ...analysis!.notes].map((n) => n.toLowerCase());
      const bases = (fixture.result?.chart?.subtitle ?? []).map((b) => b.toLowerCase());
      for (const said of [...storyline.key_line.map((k) => k.text), ...analysis!.supports.map((s) => s.text)]) {
        for (const home of [...notes, ...bases]) expect(said.toLowerCase(), fixture.slug).not.toContain(home);
      }
      for (const support of analysis!.supports.filter((s) => s.drawn === "none")) {
        expect(support.text, `${fixture.slug} ${support.id}`).not.toMatch(/\b(left out|incomplete|is complete|not recorded|counts once|summed over|warehouse holds|last full week)\b/i);
      }
      // At most five: those with a point in key-line order, then those whose point is null.
      expect(supports.length).toBeLessThanOrEqual(5);
      const order = storyline.key_line.map((k) => k.id);
      const ranks = supports.map((s) => (s.point === null ? order.length : order.indexOf(s.point)));
      expect(ranks.every((r) => r >= 0)).toBe(true);
      expect([...ranks].sort((a, b) => a - b), fixture.slug).toEqual(ranks);
      expect(supports.find((s) => s.id === analysis!.lead)?.drawn).toBe("main");
      expect(supports.filter((s) => s.drawn === "main")).toHaveLength(1);
      const small = supports.filter((s) => s.drawn === "small");
      expect(small.length, fixture.slug).toBeGreaterThanOrEqual(1);
      expect(small.length).toBeLessThanOrEqual(2);
      expect(supports.some((s) => s.drawn === "none" && s.text.length > 0), fixture.slug).toBe(true);
      for (const support of supports) {
        expect(support.chart === null).toBe(support.drawn !== "small");
        expect(support.layer === null).toBe(support.drawn !== "main");
        expect(support.note === null).toBe(support.drawn !== "dropped");
      }
      for (const { chart } of small) {
        const spec = chart!.spec;
        expect(spec.description).not.toMatch(/rules:|[A-Z]+-[A-Z]+-/);
        expect([chart!.title, chart!.subtitle, chart!.options, chart!.score, chart!.png_url]).toEqual([null, [], [], null, null]);
        expect(chart!.min_width).toBeGreaterThan(0);
        expect(spec).not.toHaveProperty("width");
        expect(spec).not.toHaveProperty("title");
        for (const many of ["concat", "hconcat", "vconcat", "facet", "repeat"]) expect(spec).not.toHaveProperty(many);
        expect(spec.height).toBeLessThanOrEqual(200);
        expect(spec.config).toEqual(fixture.result?.chart?.spec.config); // the PP theme
      }
      // The answer first, with the run's own SQL and rows.
      expect(steps[0]).toMatchObject({ id: "st1", role: "answer", sql: fixture.result?.sql, rows: fixture.result?.rows });
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      expect(steps.some((s) => s.role === "check" || s.role === "probe" || s.role === "denominator")).toBe(true);
      expect(follow_ups.length).toBeGreaterThan(0);
      expect(follow_ups.length).toBeLessThanOrEqual(3);
      for (const followUp of follow_ups) {
        expect(["breakdown", "next_level", "check"]).toContain(followUp.kind);
        expect(followUp.question).toMatch(/^[A-Z].*\?$/);
        if (followUp.fixture) expect(all.some((f) => f.slug === followUp.fixture)).toBe(true);
      }
    }
    // A breaking check that limited the claim is a note, never a key-line point: the check
    // found no cash tips recorded, so the note speaks of cash and the key line does not.
    const tips = all.find((f) => f.slug === "tips")!.analysis!;
    expect(tips.steps.find((s) => s.role === "check")).toMatchObject({ verdict: "contradicts", rows: [[0]] });
    expect(tips.notes[0]).toMatch(/^Cash tips are not recorded/);
    expect(tips.storyline.key_line.map((k) => k.text).join(" ")).not.toMatch(/cash/i);
    expect(tips.storyline.top).not.toMatch(/cash/i);
    expect(tips.supports.find((s) => s.drawn === "dropped")?.note).toMatch(/only zeros/);
    expect(all.find((f) => f.slug === "oee-line")!.analysis!.storyline.top).toBe("Augsburg moulding 1 led the lines on OEE last week, at 79.7%");
  });

  it("have a view of every chart they offer, with and without the analysis, and every small chart, each valid Vega-Lite", async () => {
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
    const compiles = (spec: unknown, where: string) =>
      expect(() => compile(spec as Parameters<typeof compile>[0], { logger }), where).not.toThrow();
    const complete = [...loadFixtures().values()].flat().filter((f) => f.final_status === "complete");
    let mocked = 0;
    for (const fixture of complete) {
      const options = chartOptions(fixture);
      expect(options.length, fixture.slug).toBeGreaterThan(1);
      for (const analysis of [true, false]) {
        for (const option of options) {
          const where = `${fixture.slug} ${option.chart} ${analysis ? "with" : "without"} the analysis`;
          const view = chartView(fixture, option.chart, analysis);
          expect([view?.chart, view?.label, view?.score, view?.hint], where).toEqual([option.chart, option.label, option.score, option.hint]);
          // Every option, the drawn one flagged, in the same order whatever is drawn.
          expect(view?.options.map((o) => [o.chart, o.drawn]), where).toEqual(options.map((o) => [o.chart, o.chart === option.chart]));
          expect(view?.min_width).toBeNull();
          const title = (view?.spec.title as { text?: unknown } | undefined)?.text;
          expect(view?.title, where).toBe(title);
          if (analysis) expect(view?.title, where).toBe(fixture.analysis?.storyline.top);
          else expect(view?.title, where).toBe(fixture.result?.chart?.title);
          if (option.chart !== fixture.result?.chart?.chart && analysis) mocked += 1;
          // Plain words for screen readers, whoever drew it; rule ids only in usermeta.
          expect(view?.spec.description, where).toMatch(/^[A-Z][^:]*: /);
          expect(view?.spec.description, where).not.toMatch(/rules:|[A-Z]+-[A-Z]+-|drawn by the mock/);
          // The lead's layer is a layer of the main chart by the name Support.layer gives, on every chart.
          const layers = ((view?.spec.layer ?? []) as { name?: string }[]).map((l) => l.name ?? null);
          if (analysis) {
            const lead = fixture.analysis?.supports.find((s) => s.id === fixture.analysis?.lead);
            expect(layers, where).toContain(lead?.layer);
            expect(layers.filter((n) => n !== null), where).toEqual([lead?.layer]);
            expect(view?.spec.name, where).toBeUndefined();
          }
          compiles(view?.spec, where);
        }
      }
      for (const support of fixture.analysis?.supports ?? []) {
        if (support.chart) compiles(support.chart.spec, `${fixture.slug} ${support.id}`);
      }
    }
    expect(mocked).toBeGreaterThan(10);
    expect(said).toEqual([]);
  }, 30_000);
});

// --- the contract -------------------------------------------------------------------------------

describe("mock backend", () => {
  it("names the dev user, a key user with starters in both demo workspaces, and the workspace used last", async () => {
    const me = await ok<Me>("GET", "/api/v1/me");
    expect(me.user).toEqual({ id: "dev", name: "Dev user", email: null });
    expect(me.workspaces.map((w) => [w.id, w.role])).toEqual([
      ["manufacturing", "key_user"],
      ["restaurant", "key_user"],
    ]);
    for (const workspace of me.workspaces) {
      expect(workspace.starters.length).toBeGreaterThanOrEqual(3);
      expect(workspace.starters.length).toBeLessThanOrEqual(5);
    }
    expect(me.workspaces[0]?.starters).toContain("Which production orders had the most scrap against plan?");
    expect(me.last_workspace).toBe("manufacturing"); // the seeded threads' newest
    const nowhere = await refused("GET", "/api/v1/workspaces/nowhere/threads", undefined, 404);
    expect(nowhere.code).toBe("no_workspace");
  });

  it("seeds finished threads spread over the sidebar's date groups", async () => {
    const page = await ok<ThreadPage>("GET", `${MFG}/threads`);
    expect(page.items).toHaveLength(5); // the failed and the asking fixtures are not seeded
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
    expect(restaurant.items).toHaveLength(4);
    expect(restaurant.items.filter((t) => t.status === "clarify")).toHaveLength(1);

    const first = await ok<ThreadPage>("GET", `${MFG}/threads?limit=2`);
    expect(first.items.map((t) => t.id)).toEqual(page.items.slice(0, 2).map((t) => t.id));
    expect(first.next_cursor).toBe("2");
    const rest = await ok<ThreadPage>("GET", `${MFG}/threads?limit=2&cursor=4`);
    expect(rest.items.map((t) => t.id)).toEqual(page.items.slice(4).map((t) => t.id));
    expect(rest.next_cursor).toBeNull();

    const thread = await ok<Thread>("GET", `${MFG}/threads/${page.items[0]?.id}`);
    expect(thread.locale).toBeNull();
    expect(thread.runs).toHaveLength(1);
    const latest = thread.latest;
    expect(thread.runs[0]).toMatchObject({ id: latest.id, revision: 0, origin: "question", takes_back: null, follows: null });
    expect(latest.status).toBe("complete");
    expect(latest.timings.length).toBeGreaterThan(0);
    expect(latest.timings.every((t) => typeof t.elapsed_ms === "number")).toBe(true);
    expect(latest.steps.every((s) => typeof s.elapsed_ms === "number")).toBe(true);
    expect(thread.runs[0]?.top).toBe(latest.result?.storyline?.top);
    expect(thread.runs[0]?.chart).toEqual({ chart: latest.result?.chart?.chart, label: latest.result?.chart?.label });
    const log = await stream(events(MFG, latest.id));
    expect(log.frames.at(-1)?.id).toBe(latest.last_event_id);
    expect(log.frames.map((f) => f.id)).toEqual(log.frames.map((_, i) => i + 1));
    expect(statuses(log.frames)).toEqual(["queued", "running", "complete"]);

    // Users rated some of the seeded runs.
    expect((await ok<RunView>("GET", `${MFG}/runs/run_seed_oee-line`)).feedback).toBe("up");
    expect((await ok<RunView>("GET", `${MFG}/runs/run_seed_scrap`)).feedback).toBe("down");
  });

  it("tells a complete run in the contract's order: queued, running, stages with the steps inside analyse, charts after render", async () => {
    oee = await ok<RunCreated>("POST", `${MFG}/threads`, { question: OEE_QUESTION });
    oeeStart = await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`);
    // Queued, its first frame told before the 202; a worker may have picked it up since.
    expect(["queued", "running"]).toContain(oeeStart.status);
    expect(oeeStart.last_event_id).toBeGreaterThanOrEqual(1);
    expect([oeeStart.origin, oeeStart.revision, oeeStart.locale]).toEqual(["question", 0, null]);

    const { frames, retry } = await stream(events(MFG, oee.run_id));
    oeeFrames = frames;
    expect(retry).toBe("3000");
    expect(frames.map((f) => f.id)).toEqual(frames.map((_, i) => i + 1));
    expect(frames.every((f) => f.event === f.data.type && f.data.run_id === oee.run_id)).toBe(true);
    expect(statuses(frames)).toEqual(["queued", "running", "complete"]);
    expect(types(frames).slice(0, 2)).toEqual(["run.status", "run.status"]);
    expect(startedStages(frames)).toEqual(OEE_ANALYSED);

    // Each stage opens and closes before the next, but analyse holds its steps.
    const stageFrames = frames.filter((f) => f.data.type === "stage.started" || f.data.type === "stage.finished");
    stageFrames.forEach((f, i) => {
      expect(f.data).toMatchObject({ type: i % 2 === 0 ? "stage.started" : "stage.finished", stage: OEE_ANALYSED[Math.floor(i / 2)] });
    });
    const opened = frames.findIndex((f) => f.data.type === "stage.started" && f.data.stage === "analyse");
    const closed = finishedAt(frames, "analyse");
    const stepFrames = frames.flatMap((f, i) => (f.data.type === "step.started" || f.data.type === "step.finished" ? [{ f, i }] : []));
    expect(stepFrames.length).toBe(6);
    expect(stepFrames.every(({ i }) => i > opened && i < closed)).toBe(true);
    expect(stepFrames.map(({ f }) => (f.data.type === "step.started" || f.data.type === "step.finished" ? `${f.data.type}:${f.data.step.id}` : ""))).toEqual([
      "step.started:st1", "step.finished:st1", "step.started:st2", "step.finished:st2", "step.started:st3", "step.finished:st3",
    ]);

    const at = (type: string) => types(frames).indexOf(type as RunEvent["type"]);
    expect(at("restatement")).toBe(finishedAt(frames, "bind") + 1);
    // The main chart right after render, then each small chart with its support.
    const charts = frames.flatMap((f, i) => (f.data.type === "chart" ? [{ i, support: f.data.support_id }] : []));
    expect(charts[0]).toEqual({ i: finishedAt(frames, "render") + 1, support: null });
    expect(charts.slice(1).map((c) => c.support)).toEqual(["sp2"]);
    expect(charts.map((c) => c.i)).toEqual(charts.map((_, k) => (charts[0]?.i ?? 0) + k));
    expect(at("card")).toBe(at("result") - 1);
    expect(at("result")).toBe(frames.length - 2);
  });

  it("serves the run as the client's fold of the stream, with the definitions and follow-ups only getRun has", async () => {
    const run = await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`);
    oeeRun = run;
    expect(run.status).toBe("complete");
    expect(run.last_event_id).toBe(oeeFrames.at(-1)?.id);
    expect(stagesOf(run)).toEqual(OEE_ANALYSED);
    expect(run.timings.every((t) => typeof t.elapsed_ms === "number" && t.elapsed_ms >= 5)).toBe(true);
    expect([run.phase, run.stage, run.step]).toEqual(["present", "validate", null]);
    expect(run.restatement).toBe("You want to see OEE by line, from 22 Dec 2025 to 28 Dec 2025.");
    expect(run.definitions).toEqual([
      expect.objectContaining({ name: "oee", label: "OEE", entry_id: "measure-oee", status: "proposed", source: expect.objectContaining({ kind: "library" }) }),
    ]);
    expect(run.follow_ups.map((f) => [f.id, f.kind])).toEqual([
      ["fu1", "breakdown"],
      ["fu2", "next_level"],
    ]);
    expect(run.follow_ups.every((f) => !("fixture" in f))).toBe(true);
    expect(run.steps.map((s) => [s.id, s.role, s.stage, s.verdict, s.cached])).toEqual([
      ["st1", "answer", "analyse", null, true],
      ["st2", "comparison", "analyse", "as_expected", false],
      ["st3", "check", "analyse", "as_expected", false],
    ]);
    expect(run.steps.every((s) => typeof s.elapsed_ms === "number" && s.sql !== null && s.row_count !== null)).toBe(true);

    const result = run.result!;
    expect(result.chart?.chart).toBe("table");
    expect(result.rows.length).toBe(result.row_count);
    // One home per text: the top is the main chart's title, the findings give way to the storyline.
    expect(result.storyline?.top).toBe("Augsburg moulding 1 led the lines on OEE last week, at 79.7%");
    expect(result.chart?.title).toBe(result.storyline?.top);
    expect((result.chart?.spec.title as { text: string }).text).toBe(result.storyline?.top);
    expect(result.chart?.subtitle).toEqual(["22–28 Dec 2025"]);
    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual([
      "The average of 75.5% is the plain mean of the nine lines, not weighted by their planned busy time",
      "The warehouse holds no full week after 28 Dec 2025, so last week is the week before it",
    ]);
    // The lead names its layer on the main chart.
    expect(((result.chart?.spec.layer ?? []) as { name?: string }[]).map((l) => l.name ?? null)).toEqual([null, null, "answer", null]);
    expect(result.supports[0]?.layer).toBe("answer");
    expect([result.lead, result.step_id, result.sql]).toEqual(["sp1", "st1", run.steps[0]?.sql]);
    expect(result.supports.map((s) => [s.id, s.drawn])).toEqual([
      ["sp1", "main"],
      ["sp2", "small"],
      ["sp3", "none"],
    ]);
    expect(result.chart?.options.map((o) => [o.chart, o.drawn])).toEqual([
      ["horizontal_bar", false],
      ["point", false],
      ["bar", false],
      ["table", true],
    ]);
    expect(result.chart?.options.find((o) => o.chart === "point")?.hint).toMatch(/^see which categories/);
    expect(result.columns.map((c) => [c.name, c.label, c.role, c.unit])).toEqual([
      ["line_name", "line name", "dimension", null],
      ["oee", "OEE", "measure", "%"],
    ]);
    expect([result.verdict, result.concerns.length > 0]).toEqual(["warn", true]);
    expect(run.card?.blocking).toBe(false);
    // The side card: the one point of the drawing nobody was sure of (detail, from idiom).
    expect(run.card?.points.map((p) => [p.id, p.step, p.open, p.stage])).toEqual([["labels", "detail", true, "idiom"]]);
    expect(run.started_at).not.toBeNull();
    expect(run.finished_at).not.toBeNull();
    const folded = clientFold(oeeStart, oeeFrames);
    expectSameRun(run, folded);
    // No event carries them: a client that only folds lacks them until it refetches.
    expect([folded.definitions, folded.follow_ups]).toEqual([[], []]);
  });

  it("resumes a stream after Last-Event-ID, header or query, and refuses a malformed one", async () => {
    const after = await stream(events(MFG, oee.run_id), { lastEventId: 10 });
    expect(after.frames[0]?.id).toBe(11);
    expect(after.frames.map((f) => f.id)).toEqual(oeeFrames.slice(10).map((f) => f.id));

    const res = await fetch(`${base}${events(MFG, oee.run_id)}?last_event_id=${oeeFrames.length - 1}`);
    const text = await res.text();
    expect(text).toMatch(/^retry: 3000\n\n/);
    expect(text.match(/^id: /gm)).toHaveLength(1);
    expect(text).toContain(`id: ${oeeFrames.length}\nevent: run.status\ndata: `);

    const nothing = await stream(events(MFG, oee.run_id), { lastEventId: oeeFrames.length });
    expect(nothing.frames).toEqual([]);

    const malformed = await refused("GET", `${events(MFG, oee.run_id)}?last_event_id=ten`, undefined, 422);
    expect(malformed.errors?.[0]).toMatchObject({ loc: ["query", "last_event_id"], type: "int_parsing" });
    expect((await refused("GET", `${events(MFG, oee.run_id)}?last_event_id=-1`, undefined, 422)).errors?.[0]?.type).toBe("greater_than_equal");
    expect((await refused("GET", events(MFG, "run_nothing"), undefined, 404)).code).toBe("no_run");
  });

  it("serves each step's SQL and rows, and the answer's step by Result.step_id", async () => {
    const average = await ok<StepResult>("GET", `${MFG}/runs/${oee.run_id}/steps/st2`);
    expect(average).toMatchObject({ step_id: "st2", label: "the average over all lines", row_count: 1, truncated: false });
    expect(average.rows).toEqual([[75.48598]]);
    expect(average.sql).toContain(oeeRun.result?.sql ?? "-");
    expect(average.columns.map((c) => c.name)).toEqual(["oee"]);
    const answer = await ok<StepResult>("GET", `${MFG}/runs/${oee.run_id}/steps/st1`);
    expect([answer.sql, answer.rows, answer.row_count]).toEqual([oeeRun.result?.sql, oeeRun.result?.rows, oeeRun.result?.row_count]);
    expect((await refused("GET", `${MFG}/runs/${oee.run_id}/steps/st9`, undefined, 404)).code).toBe("no_step");
    expect((await refused("GET", `${MFG}/runs/run_nothing/steps/st1`, undefined, 404)).code).toBe("no_run");
  });

  it("sends a follow-up as the thread's next run, and a revision typed after it revises the follow-up", async () => {
    const offered = oeeRun.follow_ups[0]!;
    const sent = await revise(MFG, oee.thread_id, { message: offered.question, follows: { run_id: oee.run_id, follow_up_id: offered.id } });
    expect(sent.created.thread_id).toBe(oee.thread_id);
    expect(sent.run).toMatchObject({
      revision: 1,
      origin: "follow_up",
      prompt: offered.question,
      follows: { run_id: oee.run_id, follow_up_id: "fu1", kind: "breakdown" },
      takes_back: null,
      status: "complete",
    });
    expect(sent.run.result?.chart?.chart).toBe("line"); // the fixture the follow-up names: aeq-weekly
    // The registry approved availability: the run says so.
    expect(sent.run.definitions.map((d) => [d.name, d.status])).toEqual([
      ["availability", "approved"],
      ["quality ratio", "proposed"],
      ["effectiveness", "proposed"],
    ]);

    // Typed after the follow-up: it revises the follow-up's question, not the thread's.
    const typed = await revise(MFG, oee.thread_id, { message: "per month instead" });
    expect(typed.run).toMatchObject({ revision: 2, origin: "revision", prompt: "per month instead", follows: null });
    expect(typed.run.restatement).toMatch(/availability, effectiveness and quality ratio/);
    expect(typed.run.status).toBe("clarify"); // the same question's other fixture

    const thread = await ok<Thread>("GET", `${MFG}/threads/${oee.thread_id}`);
    expect(thread.runs.map((r) => [r.revision, r.origin, r.status])).toEqual([
      [0, "question", "complete"],
      [1, "follow_up", "complete"],
      [2, "revision", "clarify"],
    ]);
    expect(thread.runs[1]?.follows?.follow_up_id).toBe("fu1");
    expect(thread.latest.id).toBe(typed.run.id);
    expect((await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`)).status).toBe("complete"); // the parent stands
  });

  it("refuses a follow-up with the contract's codes: 422 via_with_follows and follow_up_mismatch, 404 no_run, 409 not_latest and not_answerable", async () => {
    const path = `${MFG}/threads/${oee.thread_id}/revisions`;
    const offered = oeeRun.follow_ups[0]!;
    const follows = { run_id: oee.run_id, follow_up_id: offered.id };
    const via = await refused("POST", path, { message: offered.question, follows, via: "composer" }, 422);
    expect(via.errors?.[0]).toMatchObject({ loc: ["body", "via"], type: "via_with_follows" });
    expect(via.code).toBeUndefined();
    expect((await refused("POST", path, { message: offered.question, follows: { ...follows, run_id: "run_nothing" } }, 404)).code).toBe("no_run");
    // A run of another thread is no run of this one.
    expect((await refused("POST", path, { message: "x", follows: { run_id: "run_seed_energy", follow_up_id: "fu1" } }, 404)).code).toBe("no_run");
    // The thread moved on: the follow-up's run is not the latest.
    expect((await refused("POST", path, { message: offered.question, follows }, 409)).code).toBe("not_latest");

    // The latest is a clarify run: its follow-ups go via nearest, never with follows.
    const thread = await ok<Thread>("GET", `${MFG}/threads/${oee.thread_id}`);
    const latest = thread.latest;
    expect((await refused("POST", path, { message: "x", follows: { run_id: latest.id, follow_up_id: "fu1" } }, 409)).code).toBe("not_answerable");

    // On a complete latest run: an id it never offered, then a message that is not the question.
    const own = await ask(MFG, "Which lines use the most energy per 1,000 good units?");
    const ownPath = `${MFG}/threads/${own.created.thread_id}/revisions`;
    const first = own.run.follow_ups[0]!;
    const unknown = await refused("POST", ownPath, { message: first.question, follows: { run_id: own.run.id, follow_up_id: "fu9" } }, 409);
    expect(unknown.code).toBe("not_answerable");
    const mismatch = await refused("POST", ownPath, { message: "What else?", follows: { run_id: own.run.id, follow_up_id: first.id } }, 422);
    expect(mismatch.errors?.[0]).toMatchObject({ loc: ["body", "message"], type: "follow_up_mismatch" });
    // Nothing was started by any of these.
    expect((await ok<Thread>("GET", `${MFG}/threads/${own.created.thread_id}`)).runs).toHaveLength(1);
  });

  it("takes a revision back by re-running the one before it, a follow-up's by re-running the parent's reading", async () => {
    const back = await ok<RunCreated>("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/2`);
    await stream(events(MFG, back.run_id));
    const undone = await ok<RunView>("GET", `${MFG}/runs/${back.run_id}`);
    expect(undone).toMatchObject({ revision: 3, origin: "take_back", takes_back: 2, prompt: "per month instead", follows: null, status: "complete" });
    expect(undone.result?.chart?.chart).toBe("line"); // revision 1's reading: the follow-up's

    const parent = await ok<RunCreated>("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/1`);
    await stream(events(MFG, parent.run_id));
    const taken = await ok<RunView>("GET", `${MFG}/runs/${parent.run_id}`);
    expect(taken).toMatchObject({ revision: 4, origin: "take_back", takes_back: 1, prompt: oeeRun.follow_ups[0]?.question, status: "complete" });
    expect(taken.result?.chart?.chart).toBe("table"); // revision 0's fixture again
    oeeLatest = parent.run_id;

    // Taken back already, or beyond the latest: no revision by that number.
    expect((await refused("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/2`, undefined, 404)).code).toBe("no_revision");
    expect((await refused("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/9`, undefined, 404)).code).toBe("no_revision");
    expect((await refused("DELETE", `${MFG}/threads/th_nothing/revisions/1`, undefined, 404)).code).toBe("no_thread");
    const summary = (await ok<ThreadPage>("GET", `${MFG}/threads`)).items.find((t) => t.id === oee.thread_id);
    expect([summary?.revisions, summary?.status, summary?.active_run_id]).toEqual([4, "complete", null]);
  });

  it("supersedes the thread's open run when a revision comes, and leaves a finished one as it is", async () => {
    const open = await ok<RunCreated>("POST", `${MFG}/threads`, { question: "Which lines use the most energy per 1,000 good units?" });
    const next = await ok<RunCreated>("POST", `${MFG}/threads/${open.thread_id}/revisions`, { message: "only Linz" });
    const superseded = await ok<RunView>("GET", `${MFG}/runs/${open.run_id}`);
    expect(superseded.status).toBe("superseded");
    expect(superseded.finished_at).not.toBeNull();
    expect(lastStatus((await stream(events(MFG, open.run_id))).frames)).toBe("superseded");
    const thread = await ok<Thread>("GET", `${MFG}/threads/${open.thread_id}`);
    expect(thread.runs.map((r) => [r.revision, r.status === "superseded"])).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(thread.latest.id).toBe(next.run_id);
    const summary = (await ok<ThreadPage>("GET", `${MFG}/threads`)).items.find((t) => t.id === open.thread_id);
    expect(summary?.revisions).toBe(1);
    expect(summary?.active_run_id).toBe(next.run_id);
    await stream(events(MFG, next.run_id));
  });

  it("supersedes a run mid-stream: its stream ends on superseded alone, and the revision runs to the end", async () => {
    // Stages long enough that nothing is told between reading the run and posting the revision.
    const other = await another({ minStageMs: 80 });
    try {
      const at = other.url;
      const created = await ok<RunCreated>("POST", `${MFG}/threads`, { question: "Which lines use the most energy per 1,000 good units?" }, 202, at);
      const start = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`, undefined, 200, at);
      let revision: RunCreated | null = null;
      let told = 0; // the old run's last frame before the revision
      const old = await stream(events(MFG, created.run_id), {
        at,
        onFrame: async (frame) => {
          if (revision || frame.data.type !== "stage.started" || frame.data.stage === "situate") return;
          // Only while the stage just started is waiting: the run has told nothing since.
          const now = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`, undefined, 200, at);
          if (now.last_event_id !== frame.id) return;
          told = now.last_event_id;
          // Posted directly, never /cancel first.
          revision = await ok<RunCreated>("POST", `${MFG}/threads/${created.thread_id}/revisions`, { message: "per month" }, 202, at);
        },
      });
      expect(revision).not.toBeNull();
      const revised = revision as unknown as RunCreated;
      expect(revised.thread_id).toBe(created.thread_id);
      expect(told).toBeGreaterThan(0);
      // After the revision the old run told its status and nothing else.
      expect(old.frames.filter((f) => f.id > told).map((f) => f.data)).toEqual([
        { type: "run.status", run_id: created.run_id, status: "superseded" },
      ]);
      expect(statuses(old.frames)).toEqual(["queued", "running", "superseded"]);
      expect(types(old.frames)).not.toContain("result");
      const ended = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`, undefined, 200, at);
      expect(ended.status).toBe("superseded");
      expect([ended.result?.storyline ?? null, ended.result?.supports ?? [], ended.follow_ups]).toEqual([null, [], []]);
      expect(ended.last_event_id).toBe(told + 1);
      expect(ended.last_event_id).toBe(old.frames.at(-1)?.id);
      expectSameRun(ended, clientFold(start, old.frames));

      const fresh = await stream(events(MFG, revised.run_id), { at });
      expect(["complete", "clarify"]).toContain(lastStatus(fresh.frames));
      expect(fresh.frames.every((f) => f.data.run_id === revised.run_id)).toBe(true);
      // Nothing more was told by the old run meanwhile.
      expect((await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`, undefined, 200, at)).last_event_id).toBe(told + 1);
    } finally {
      await other.close();
    }
  }, 30_000);

  it("stops at a blocking card and resumes the same run once it is answered, ending with the continuation's side card", async () => {
    const asked = await ok<RunCreated>("POST", `${REST}/threads`, { question: "How much revenue did we make per month in 2025?" });
    const first = await stream(events(REST, asked.run_id));
    expect(statuses(first.frames)).toEqual(["queued", "running", "asking"]);
    expect(types(first.frames).slice(-2)).toEqual(["card", "run.status"]);
    const cardFrame = first.frames.find((f) => f.data.type === "card")?.data;
    expect(cardFrame?.type === "card" && cardFrame.card.blocking).toBe(true);

    let run = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
    const waiting = run;
    expect([run.status, run.finished_at, run.step, run.restatement]).toEqual(["asking", null, null, null]);
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
    expect(types(rest.frames)[2]).toBe("stage.started");
    expect(startedStages(rest.frames)[0]).toBe("plan");
    // As a complete run tells it: the card after the charts, just before the result.
    const told = types(rest.frames);
    expect(told.filter((t) => t === "card")).toHaveLength(1);
    expect(told.indexOf("card")).toBe(told.indexOf("result") - 1);
    expect(told.indexOf("card")).toBeGreaterThan(told.lastIndexOf("chart"));

    run = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
    expect(run.status).toBe("complete");
    // The continuation's own side card replaced the blocking one: the drawing's open point,
    // no meaning point (those block a run, and these were answered).
    expect(run.card?.blocking).toBe(false);
    expect(run.card?.points.map((p) => [p.id, p.step, p.open])).toEqual([["point", "point", true]]);
    expect(run.result?.chart?.chart).toBe("line");
    expect(run.restatement).not.toBeNull();
    expect(run.definitions.map((d) => [d.name, d.status])).toEqual([["delivery revenue", "approved"]]);
    expect(stagesOf(run).slice(0, 4)).toEqual(["situate", "abstract", "plan", "bind"]);
    expect(run.last_event_id).toBe(rest.frames.at(-1)?.id);
    expectSameRun(run, clientFold(waiting, rest.frames));

    expect((await call("POST", `${REST}/runs/${asked.run_id}/feedback`, { rating: "up" })).status).toBe(204);
    expect((await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`)).feedback).toBe("up");
    expect((await call("POST", `${REST}/runs/${asked.run_id}/feedback`, { rating: null })).status).toBe(204);
    expect((await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`)).feedback).toBeNull();
  });

  it("ends an asking run on Stop (cancelled) or a revision (superseded) with its status alone, the blocking card kept", async () => {
    const question = "How much revenue did we make per month in 2025?";
    for (const [leave, ending] of [["cancel", "cancelled"], ["revise", "superseded"]] as const) {
      const asked = await ok<RunCreated>("POST", `${REST}/threads`, { question });
      await stream(events(REST, asked.run_id));
      const waiting = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
      expect([waiting.status, waiting.card?.blocking]).toEqual(["asking", true]);

      if (leave === "cancel") await ok<RunCreated>("POST", `${REST}/runs/${asked.run_id}/cancel`);
      else await ok<RunCreated>("POST", `${REST}/threads/${asked.thread_id}/revisions`, { message: "only delivery" });
      const { frames } = await stream(events(REST, asked.run_id), { lastEventId: waiting.last_event_id });
      expect(types(frames), leave).toEqual(["run.status"]);
      expect(lastStatus(frames)).toBe(ending);

      const left = await ok<RunView>("GET", `${REST}/runs/${asked.run_id}`);
      expect(left.status, leave).toBe(ending);
      expect(left.card, leave).toEqual(waiting.card);
      expectSameRun(left, clientFold(waiting, frames));
      if (leave === "revise") {
        const thread = await ok<Thread>("GET", `${REST}/threads/${asked.thread_id}`);
        await stream(events(REST, thread.latest.id));
      }
    }
  });

  it("switches the latest complete run to any chart it offers, its options in the same order, and refuses one it does not", async () => {
    const before = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    const drawn = before.result?.chart;
    expect(drawn?.chart).toBe("table");
    // An option the run never drew, as the switcher offers it: the mock draws it from the result's rows.
    const picked = drawn?.options[0];
    expect(picked).toMatchObject({ chart: "horizontal_bar", label: "ranked bars", drawn: false });
    const again = await ok<RunCreated>("POST", `${MFG}/runs/${oeeLatest}/chart`, { chart: picked?.chart });
    expect(again.run_id).toBe(oeeLatest);
    const { frames } = await stream(events(MFG, oeeLatest), { lastEventId: before.last_event_id });
    expect(statuses(frames)).toEqual(["queued", "running", "complete"]);
    expect(startedStages(frames)).toEqual(PRESENT);
    // The card as a complete run tells it, after the charts and just before the result.
    expect(types(frames).slice(-3)).toEqual(["card", "result", "run.status"]);
    const chartFrames = frames.flatMap((f) => (f.data.type === "chart" ? [f.data] : []));
    expect(chartFrames.map((c) => [c.chart.chart, c.support_id])).toEqual([
      ["horizontal_bar", null],
      ["horizontal_bar", "sp2"],
    ]);
    const after = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    // The side card did not ask the form point (the core was sure of it): the pick adds it, by the user,
    // before the detail point the card asked.
    expect(after.card?.points.map((p) => [p.id, p.step, p.chosen, p.by, p.open])).toEqual([
      ["idiom", "form", "horizontal_bar", "user", false],
      ["labels", "detail", "all", "s1", true],
    ]);
    // A stage that runs again is a new timing, as the client folds it: the present stages twice.
    expect(stagesOf(after)).toEqual([...stagesOf(before), ...PRESENT]);
    expect(after.timings.every((t) => typeof t.elapsed_ms === "number")).toBe(true);
    const switched = after.result?.chart;
    expect([switched?.chart, switched?.label, switched?.png_url, switched?.title]).toEqual([
      "horizontal_bar",
      "ranked bars",
      null,
      after.result?.storyline?.top,
    ]);
    expect(switched?.options.map((o) => o.chart)).toEqual(drawn?.options.map((o) => o.chart));
    expect(switched?.options.filter((o) => o.drawn).map((o) => o.chart)).toEqual(["horizontal_bar"]);
    const data = switched?.spec.data as { values: unknown[] } | undefined;
    expect(data?.values).toHaveLength(before.result?.rows.length ?? -1);
    expect(switched?.spec.config).toEqual(drawn?.spec.config); // in the drawn chart's theme
    expect(after.result?.rows).toEqual(before.result?.rows);
    // It keeps its follow-ups, its steps and its storyline.
    expect([after.follow_ups, after.steps, after.result?.storyline]).toEqual([before.follow_ups, before.steps, before.result?.storyline]);
    expectSameRun(after, clientFold(before, frames));

    // Back to the chart the run drew: its own rendering again.
    await ok<RunCreated>("POST", `${MFG}/runs/${oeeLatest}/chart`, { chart: "table" });
    const home = await stream(events(MFG, oeeLatest), { lastEventId: after.last_event_id });
    expect(statuses(home.frames)).toEqual(["queued", "running", "complete"]);
    const back = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    expect(back.result?.chart).toEqual(drawn);
    expect(back.card?.points.map((p) => [p.id, p.chosen, p.by])).toEqual([
      ["idiom", "table", "user"],
      ["labels", "all", "s1"],
    ]);

    const never = await refused("POST", `${MFG}/runs/${oeeLatest}/chart`, { chart: "pie" }, 409);
    expect(never.code).toBe("not_answerable");
    expect(never.detail).toBe("The run offers no pie chart; its charts are horizontal_bar, point, bar, table.");
  });

  it("answers a complete run's side card by presenting the same run again", async () => {
    const before = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    expect(before.card?.points.find((p) => p.id === "labels")?.open).toBe(true);
    const again = await ok<RunCreated>("POST", `${MFG}/runs/${oeeLatest}/answers`, { answers: { labels: "none" } });
    expect(again.run_id).toBe(oeeLatest);
    const { frames } = await stream(events(MFG, oeeLatest), { lastEventId: before.last_event_id });
    expect(statuses(frames)).toEqual(["queued", "running", "complete"]);
    expect(types(frames).slice(0, 3)).toEqual(["run.status", "run.status", "stage.started"]);
    expect(types(frames).slice(-3)).toEqual(["card", "result", "run.status"]);
    expect(startedStages(frames)).toEqual(PRESENT);
    const after = await ok<RunView>("GET", `${MFG}/runs/${oeeLatest}`);
    expect(after.card?.points.find((p) => p.id === "labels")).toMatchObject({ chosen: "none", by: "user", open: false });
    // The form point, chosen table by the user earlier, keeps the chart it chose.
    expect(after.result?.chart?.chart).toBe("table");
    expectSameRun(after, clientFold(before, frames));

    // Free text on the card becomes a revision of the thread: a new run.
    const text = await ok<RunCreated>("POST", `${MFG}/runs/${oeeLatest}/answers`, { answers: {}, text: "per week instead" });
    expect(text.run_id).not.toBe(oeeLatest);
    expect(text.thread_id).toBe(after.thread_id);
    await stream(events(MFG, text.run_id));
    const revised = await ok<RunView>("GET", `${MFG}/runs/${text.run_id}`);
    expect([revised.revision, revised.origin, revised.prompt]).toEqual([after.revision + 1, "revision", "per week instead"]);
  });

  it("refuses with the contract's 409 codes, and cancels idempotently", async () => {
    // oee.run_id is revision 0 of a thread that has moved on.
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
    // Free text too: a run that takes no answers takes no card text, and no revision starts.
    expect((await refused("POST", `${MFG}/runs/${created.run_id}/answers`, { answers: {}, text: "only Linz" }, 409)).code).toBe("not_answerable");
    expect((await ok<Thread>("GET", `${MFG}/threads/${created.thread_id}`)).runs).toHaveLength(1);
    expect((await refused("POST", `${MFG}/runs/${created.run_id}/chart`, { chart: "table" }, 409)).code).toBe("not_answerable");

    // Cancelling an ended run: the same 202, nothing changes, no event follows.
    expect(await ok<RunCreated>("POST", `${MFG}/runs/${created.run_id}/cancel`)).toEqual(created);
    expect(await ok<RunCreated>("POST", `${MFG}/runs/${oee.run_id}/cancel`)).toEqual(oee);
    expect(await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`)).toEqual(run);
    expect((await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`)).status).toBe("complete");
    expect((await stream(events(MFG, created.run_id), { lastEventId: run.last_event_id })).frames).toEqual([]);
    expect((await refused("POST", `${MFG}/runs/run_nothing/cancel`, undefined, 404)).code).toBe("no_run");
  });

  it("refuses to change a run an earlier version of sightline made (stale_run), but sends its follow-ups", async () => {
    const stale = await ok<RunView>("GET", `${MFG}/runs/run_seed_scrap`);
    expect(stale.card?.blocking).toBe(false);
    // Its definition is the registry entry the key user rejected: a rejected entry never answers.
    expect(stale.definitions).toEqual([]);
    for (const [path, body] of [
      ["answers", { answers: { labels: "none" } }],
      ["chart", { chart: "point" }],
    ] as const) {
      const problem = await refused("POST", `${MFG}/runs/run_seed_scrap/${path}`, body, 409);
      expect(problem.code, path).toBe("stale_run");
      expect(problem.detail).toBe(
        "This answer was made by an earlier version of sightline and can't be changed any more. Ask the question again for a fresh answer.",
      );
      expect(problem.errors?.[0]).toMatchObject({ loc: ["path", "run_id"], type: "stale_run", ctx: { prompt: stale.prompt } });
    }
    expect(await ok<RunView>("GET", `${MFG}/runs/run_seed_scrap`)).toEqual(stale);
    // A follow-up stands on its own: today's core answers it.
    const offered = stale.follow_ups[0]!;
    const sent = await revise(MFG, stale.thread_id, { message: offered.question, follows: { run_id: stale.id, follow_up_id: offered.id } });
    expect([sent.run.origin, sent.run.status]).toEqual(["follow_up", "complete"]);
  });

  it("answers bad input with FastAPI-shaped 422s", async () => {
    const missing = await refused("POST", `${MFG}/threads`, {}, 422);
    expect(missing.errors).toEqual([{ loc: ["body", "question"], msg: "Field required", type: "missing" }]);
    expect(missing.code).toBeUndefined();
    const policy = await refused("POST", `${MFG}/threads`, { question: "x", ask: "sometimes" }, 422);
    expect(policy.errors?.[0]).toMatchObject({ loc: ["body", "ask"], type: "enum" });
    const blank = await refused("POST", `${MFG}/threads/${oee.thread_id}/revisions`, { message: "  " }, 422);
    expect(blank.errors?.[0]).toMatchObject({ loc: ["body", "message"], type: "string_too_short" });
    const via = await refused("POST", `${MFG}/threads/${oee.thread_id}/revisions`, { message: "x", via: "email" }, 422);
    expect(via.errors?.[0]).toMatchObject({ loc: ["body", "via"], type: "enum" });
    const follows = await refused("POST", `${MFG}/threads/${oee.thread_id}/revisions`, { message: "x", follows: { run_id: "r" } }, 422);
    expect(follows.errors?.[0]).toMatchObject({ loc: ["body", "follows", "follow_up_id"], type: "missing" });
    const notJson = await refused("POST", `${MFG}/threads`, "{not json", 422);
    expect(notJson.errors?.[0]?.type).toBe("json_invalid");
    const rating = await refused("POST", `${MFG}/runs/${oee.run_id}/feedback`, { rating: "meh" }, 422);
    expect(rating.errors?.[0]).toMatchObject({ loc: ["body", "rating"], type: "enum" });
    const answers = await refused("POST", `${MFG}/runs/${oeeLatest}/answers`, { answers: { labels: 3 } }, 422);
    expect(answers.errors?.[0]).toMatchObject({ loc: ["body", "answers", "labels"], type: "string_type" });
    const n = await refused("DELETE", `${MFG}/threads/${oee.thread_id}/revisions/0`, undefined, 422);
    expect(n.errors?.[0]).toMatchObject({ loc: ["path", "n"], type: "greater_than_equal" });
    const limit = await refused("GET", `${MFG}/threads?limit=0`, undefined, 422);
    expect(limit.errors?.[0]).toMatchObject({ loc: ["query", "limit"], type: "greater_than_equal" });
    const since = await refused("GET", `${MFG}/threads?updated_since=yesterday`, undefined, 422);
    expect(since.errors?.[0]?.loc).toEqual(["query", "updated_since"]);
    expect((await refused("GET", `${MFG}/threads/th_nothing`, undefined, 404)).code).toBe("no_thread");
    expect((await refused("GET", `${MFG}/runs/run_nothing`, undefined, 404)).code).toBe("no_run");
  });

  it("ends the data-gap question in clarify, its nearest question a follow-up sent via nearest", async () => {
    const { created, start, frames, run } = await ask(REST, "What is the profit margin per branch?");
    expect(statuses(frames)).toEqual(["queued", "running", "clarify"]);
    expect(types(frames).slice(-2)).toEqual(["clarify", "run.status"]);
    expect(types(frames)).not.toContain("result");
    expect(types(frames)).not.toContain("restatement"); // it ended before bind
    const report = frames.find((f) => f.data.type === "clarify")?.data;
    const clarify = report?.type === "clarify" ? report.clarify : null;
    expect(clarify?.gaps).toEqual([]);
    expect(clarify?.missing).toEqual(["Gross profit margin is not possible yet: the warehouse holds no cost of goods sold"]);
    expect(clarify?.record).toEqual(["the cost of the goods sold per sale or per period, from the costing or the general ledger"]);
    expect(clarify?.warnings_total).toBe(clarify?.warnings.length);
    expect(run.clarify).toEqual(clarify);
    expect(run.result).toBeNull();
    expect(run.follow_ups).toEqual([{ id: "nq1", kind: "nearest", question: "What is the revenue per branch?" }]);
    expectSameRun(run, clientFold(start, frames));

    const path = `${REST}/threads/${created.thread_id}/revisions`;
    // Sent with follows, it is refused: a clarify run's questions go via nearest.
    const wrongWay = await refused("POST", path, { message: "What is the revenue per branch?", follows: { run_id: run.id, follow_up_id: "nq1" } }, 409);
    expect(wrongWay.code).toBe("not_answerable");
    expect((await refused("POST", path, { message: "What is the revenue per city?", via: "nearest" }, 409)).code).toBe("not_answerable");

    const nearest = await revise(REST, created.thread_id, { message: "What is the revenue per branch?", via: "nearest" });
    expect(nearest.run).toMatchObject({ revision: 1, origin: "nearest", follows: null, prompt: "What is the revenue per branch?", status: "complete" });
    expect(nearest.run.result?.chart?.chart).toBe("grouped_bar");
    // The latest run is complete now: no nearest question to send.
    expect((await refused("POST", path, { message: "What is the revenue per branch?", via: "nearest" }, 409)).code).toBe("not_answerable");

    // Its chart form point offers charts: a pick sets it, by the user.
    await ok<RunCreated>("POST", `${REST}/runs/${nearest.run.id}/chart`, { chart: "heatmap" });
    const picked = await stream(events(REST, nearest.run.id), { lastEventId: nearest.run.last_event_id });
    const card = picked.frames.find((f) => f.data.type === "card")?.data;
    const idiom = card?.type === "card" ? card.card.points.find((p) => p.id === "idiom") : undefined;
    expect([idiom?.chosen, idiom?.by, idiom?.open]).toEqual(["heatmap", "user", false]);
    const after = await ok<RunView>("GET", `${REST}/runs/${nearest.run.id}`);
    expect(after.result?.chart?.options.map((o) => o.chart)).toEqual(nearest.run.result?.chart?.options.map((o) => o.chart));
    expect(after.card?.points.find((p) => p.id === "idiom")?.chosen).toBe("heatmap");
    expect(after.result?.chart?.chart).toBe("heatmap");

    // Answering the form point on the side card draws the chart it chose; "decide for me"
    // on another point keeps its chosen option and who chose it.
    const order = after.card?.points.find((p) => p.id === "order");
    expect([order?.chosen, order?.by, order?.open]).toEqual(["size", "s1", true]);
    await ok<RunCreated>("POST", `${REST}/runs/${nearest.run.id}/answers`, { answers: { idiom: "point", order: null } });
    const answered = await stream(events(REST, nearest.run.id), { lastEventId: after.last_event_id });
    expect(answered.frames.flatMap((f) => (f.data.type === "chart" && f.data.support_id === null ? [f.data.chart.chart] : []))).toEqual(["point"]);
    const drawn = await ok<RunView>("GET", `${REST}/runs/${nearest.run.id}`);
    expect(drawn.result?.chart?.chart).toBe("point");
    expect(drawn.result?.chart?.options.filter((o) => o.drawn).map((o) => o.chart)).toEqual(["point"]);
    const points = drawn.card?.points ?? [];
    expect(points.find((p) => p.id === "idiom")).toMatchObject({ chosen: "point", by: "user", open: false });
    expect(points.find((p) => p.id === "order")).toMatchObject({ chosen: "size", by: "s1", open: false });
    expectSameRun(drawn, clientFold(after, answered.frames));
  });

  it("ends a failed run with its error event just before run.status failed", async () => {
    const { start, frames, run } = await ask(MFG, "Which machines had the most unplanned downtime yesterday?");
    expect(statuses(frames)).toEqual(["queued", "running", "failed"]);
    expect(types(frames).slice(-2)).toEqual(["error", "run.status"]);
    expect(types(frames).indexOf("restatement")).toBe(finishedAt(frames, "bind") + 1);
    expect(run.error).toEqual({
      code: "warehouse_unavailable",
      message: "The warehouse did not answer in time, so the question could not be run. Asking again in a moment may work.",
      detail: "mock: a made-up failure in query (no warehouse behind the mock)",
      stage: "query",
      retryable: true,
    });
    expect([run.result, run.follow_ups, run.finished_at === null]).toEqual([null, [], false]);
    expectSameRun(run, clientFold(start, frames));
    // A failed run takes no answers, its card text neither.
    const text = await refused("POST", `${MFG}/runs/${run.id}/answers`, { answers: {}, text: "yesterday afternoon" }, 409);
    expect(text.code).toBe("not_answerable");
    expect((await ok<Thread>("GET", `${MFG}/threads/${run.thread_id}`)).runs).toHaveLength(1);
  });

  it("searches threads by their words and their time, takes signals, and describes the schema", async () => {
    const energy = await ok<ThreadPage>("GET", `${MFG}/threads?q=ENERGY`);
    expect(energy.items.map((t) => t.id)).toContain("th_seed_energy");
    expect(energy.items.every((t) => /energy/i.test(t.question) || /energy/i.test(t.restatement ?? "") || t.revisions > 0)).toBe(true);
    // A prompt counts: the follow-up's question is in the OEE thread.
    expect((await ok<ThreadPage>("GET", `${MFG}/threads?q=${encodeURIComponent("quality ratio develop")}`)).items.map((t) => t.id)).toContain(oee.thread_id);
    expect((await ok<ThreadPage>("GET", `${MFG}/threads?q=zebra`)).items).toEqual([]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await ok<ThreadPage>("GET", `${MFG}/threads?updated_since=${future}`)).items).toEqual([]);
    const hour = new Date(Date.now() - 3_600_000).toISOString();
    const recent = await ok<ThreadPage>("GET", `${MFG}/threads?updated_since=${hour}`);
    expect(recent.items.length).toBeGreaterThan(0);
    expect(recent.items.every((t) => t.updated_at >= hour)).toBe(true);
    expect(recent.items.map((t) => t.id)).not.toContain("th_seed_energy");

    const before = (await ok<Thread>("GET", `${REST}/threads/th_seed_tips`)).updated_at;
    expect((await call("POST", `${REST}/signals`, { kind: "thread_opened", thread_id: "th_seed_tips" })).status).toBe(204);
    expect((await ok<Thread>("GET", `${REST}/threads/th_seed_tips`)).updated_at).toBe(before);
    expect((await ok<Me>("GET", "/api/v1/me")).last_workspace).toBe("restaurant");
    expect((await refused("POST", `${REST}/signals`, { kind: "thread_opened", thread_id: "th_nothing" }, 404)).code).toBe("no_thread");
    expect((await refused("POST", `${REST}/signals`, { kind: "thread_closed", thread_id: "th_seed_tips" }, 422)).errors?.[0]?.loc).toEqual(["body", "kind"]);
    // Feedback does not move the thread either.
    await call("POST", `${REST}/runs/run_seed_tips/feedback`, { rating: "down" });
    expect((await ok<Thread>("GET", `${REST}/threads/th_seed_tips`)).updated_at).toBe(before);

    const schema = await ok<SchemaInfo>("GET", `${MFG}/schema`);
    const shifts = schema.tables.find((t) => t.name === "fct_production_shifts");
    expect(shifts?.label).toBe("production shifts");
    expect(shifts?.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["production_order", "shift_date"]));
    expect(shifts?.columns.find((c) => c.name === "shift_date")?.role).toBe("time");
    expect(schema.measures.find((m) => m.name === "oee")).toMatchObject({ label: "OEE", unit: "%" });
    expect(schema.measures.find((m) => m.name === "oee")?.description).not.toMatch(/proposed/);
    expect((await refused("GET", "/api/v1/workspaces/nowhere/schema", undefined, 404)).code).toBe("no_workspace");
  });

  it("restarts a run when its worker does: queued after running, then the whole trace again", async () => {
    const other = await another({ restartEvery: 1 });
    try {
      const { start, frames, run } = await ask(MFG, OEE_QUESTION, other.url);
      expect(statuses(frames)).toEqual(["queued", "running", "queued", "running", "complete"]);
      expect(startedStages(frames)).toEqual([...OEE_ANALYSED.slice(0, 2), ...OEE_ANALYSED]);
      // The restart cleared the trace: one pass of the stages and steps, the second attempt's.
      expect(stagesOf(run)).toEqual(OEE_ANALYSED);
      expect(run.steps.map((s) => s.id)).toEqual(["st1", "st2", "st3"]);
      expectSameRun(run, clientFold(start, frames));
    } finally {
      await other.close();
    }
  });

  it("keeps a step the run's end cut off, with the time until the end, on getRun alone", async () => {
    const other = await another({ minStageMs: 60 });
    try {
      const created = await ok<RunCreated>("POST", `${MFG}/threads`, { question: OEE_QUESTION }, 202, other.url);
      const start = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`, undefined, 200, other.url);
      let mid: RunView | null = null;
      let stepMid: StepResult | null = null;
      const { frames } = await stream(events(MFG, created.run_id), {
        at: other.url,
        onFrame: async (frame) => {
          if (mid || frame.data.type !== "step.started" || frame.data.step.id !== "st2") return;
          mid = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`, undefined, 200, other.url);
          stepMid = await ok<StepResult>("GET", `${MFG}/runs/${created.run_id}/steps/st2`, undefined, 200, other.url);
          await ok<RunCreated>("POST", `${MFG}/runs/${created.run_id}/cancel`, undefined, 202, other.url);
        },
      });
      const during = mid as unknown as RunView;
      expect(during.step).toEqual({ id: "st2", label: "the average over all lines" });
      expect(during.stage).toBe("analyse");
      expect(during.steps.at(-1)).toMatchObject({ id: "st2", elapsed_ms: null, verdict: null, sql: null });
      // Neither under way nor cut off does a step have SQL or rows, as its record says.
      const nothing = { step_id: "st2", label: "the average over all lines", sql: null, columns: [], rows: [], row_count: 0, truncated: false };
      expect(stepMid).toEqual(nothing);
      expect(await ok<StepResult>("GET", `${MFG}/runs/${created.run_id}/steps/st2`, undefined, 200, other.url)).toEqual(nothing);
      // The step that ran before it has both.
      const first = await ok<StepResult>("GET", `${MFG}/runs/${created.run_id}/steps/st1`, undefined, 200, other.url);
      expect([first.sql === null, first.rows.length > 0]).toEqual([false, true]);
      expect(statuses(frames)).toEqual(["queued", "running", "cancelled"]);
      expect(frames.some((f) => f.data.type === "step.finished" && f.data.step.id === "st2")).toBe(false);
      const run = await ok<RunView>("GET", `${MFG}/runs/${created.run_id}`, undefined, 200, other.url);
      expect(run.step).toBeNull();
      const cut = run.steps.find((s) => s.id === "st2");
      expect(cut).toMatchObject({ verdict: null, sql: null, row_count: null, cached: false });
      expect(typeof cut?.elapsed_ms).toBe("number");
      expect(run.result?.storyline ?? null).toBeNull();
      // The client's fold has it open until it refetches; all else is the same.
      const folded = clientFold(start, frames);
      expect(folded.steps.find((s) => s.id === "st2")?.elapsed_ms).toBeNull();
      expectSameRun(run, { ...folded, steps: folded.steps.map((s) => (s.id === "st2" ? { ...s, elapsed_ms: cut?.elapsed_ms ?? null } : s)) });
    } finally {
      await other.close();
    }
  });

  it("refuses a run beyond the workspace's limit with 429 too_many_active and Retry-After", async () => {
    const other = await another({ minStageMs: 5_000 });
    try {
      const open: RunCreated[] = [];
      for (const question of [OEE_QUESTION, "Which lines use the most energy per 1,000 good units?", "Which production orders had the most scrap?"]) {
        open.push(await ok<RunCreated>("POST", `${MFG}/threads`, { question }, 202, other.url));
      }
      const res = await call<Problem>("POST", `${MFG}/threads`, { question: OEE_QUESTION }, other.url);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("too_many_active");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another workspace has its own limit; a revision supersedes its thread's run, so it fits.
      await ok<RunCreated>("POST", `${REST}/threads`, { question: "Revenue by city and channel" }, 202, other.url);
      const revised = await ok<RunCreated>("POST", `${MFG}/threads/${open[0]?.thread_id}/revisions`, { message: "per week" }, 202, other.url);
      expect((await ok<RunView>("GET", `${MFG}/runs/${open[0]?.run_id}`, undefined, 200, other.url)).status).toBe("superseded");
      const back = await call<Problem>("DELETE", `${MFG}/threads/${open[1]?.thread_id}/revisions/1`, undefined, other.url);
      expect(back.status).toBe(404); // no revision 1 yet: the 404 comes before the limit
      await ok<RunCreated>("POST", `${MFG}/runs/${revised.run_id}/cancel`, undefined, 202, other.url);
      await ok<RunCreated>("POST", `${MFG}/threads`, { question: OEE_QUESTION }, 202, other.url);
    } finally {
      await other.close();
    }
  });

  it("answers as the backend does today when the analysis is off: no storyline, supports, steps or follow-ups", async () => {
    const other = await another({ analysis: false, seed: true });
    try {
      const { start, frames, run } = await ask(MFG, OEE_QUESTION, other.url);
      expect(startedStages(frames)).toEqual(OEE_STAGES);
      expect(types(frames).filter((t) => t.startsWith("step."))).toEqual([]);
      expect(frames.filter((f) => f.data.type === "chart")).toHaveLength(1);
      expect([run.steps, run.step, run.follow_ups, run.locale]).toEqual([[], null, [], null]);
      const result = run.result!;
      expect([result.storyline, result.lead, result.supports, result.notes]).toEqual([null, null, [], []]);
      expect(result.chart?.title).toBe("OEE by line");
      expect(result.step_id).toBe("st1");
      const answer = await ok<StepResult>("GET", `${MFG}/runs/${run.id}/steps/st1`, undefined, 200, other.url);
      expect([answer.label, answer.rows]).toEqual(["OEE per line last week", result.rows]);
      expect((await refused("GET", `${MFG}/runs/${run.id}/steps/st2`, undefined, 404, other.url)).code).toBe("no_step");
      expectSameRun(run, clientFold(start, frames));
      const delivery = await ok<RunView>("GET", `${REST}/runs/run_seed_delivery-monthly`, undefined, 200, other.url);
      expect(delivery.result?.findings).toEqual(["line revenue €84k → €105k, Jan–Dec 2025"]);
      const thread = await ok<Thread>("GET", `${MFG}/threads/${run.thread_id}`, undefined, 200, other.url);
      expect(thread.runs[0]?.top).toBeNull();
    } finally {
      await other.close();
    }
  });
});

// --- the key-user registry -----------------------------------------------------------------------

describe("mock registry", () => {
  const entries = (ws: string, query = "") => `${ws}/registry/entries${query}`;

  it("lists entries in the order asked for, filtered, searched, paged, with the proposed counts and the kinds' words", async () => {
    const all = await ok<RegistryPage>("GET", entries(MFG));
    expect(all.next_cursor).toBeNull();
    expect(all.counts).toEqual({ measure: 4, default: 1, gap: 1 });
    expect(all.kinds).toEqual([
      { kind: "measure", label: "measure", plural: "measures" },
      { kind: "default", label: "default", plural: "defaults" },
      { kind: "gap", label: "data gap", plural: "data gaps" },
    ]);
    expect(new Set(all.items.map((e) => e.kind))).toEqual(new Set(["measure", "default", "gap"]));
    const asked = all.items.map((e) => e.demand.last_asked ?? "");
    expect([...asked].sort().reverse()).toEqual(asked);
    for (const entry of all.items) {
      expect(entry.words.en?.length).toBeGreaterThan(0);
      expect(entry.words.de?.length).toBeGreaterThan(0);
      expect(entry.version).toBeGreaterThanOrEqual(1);
      expect(entry.reviewed_by === null).toBe(entry.status === "proposed");
      expect(entry.reviewed_at === null).toBe(entry.reviewed_by === null);
      expect(entry.demand.runs).toBeGreaterThan(0);
      expect(entry.gap === null).toBe(entry.kind !== "gap");
      expect(entry.choices === null).toBe(entry.kind !== "default");
      expect(entry.chosen_option === null).toBe(entry.kind !== "default");
    }
    expect(all.items.find((e) => e.id === "default-best-plant")?.chosen_option).toBe("oee");
    expect(all.items.some((e) => e.status === "approved")).toBe(true);
    expect(all.items.some((e) => e.status === "rejected")).toBe(true);

    const byDemand = await ok<RegistryPage>("GET", entries(MFG, "?sort=demand"));
    const runs = byDemand.items.map((e) => e.demand.runs);
    expect([...runs].sort((a, b) => b - a)).toEqual(runs);
    const byUpdate = await ok<RegistryPage>("GET", entries(MFG, "?sort=updated"));
    const updated = byUpdate.items.map((e) => e.updated_at);
    expect([...updated].sort().reverse()).toEqual(updated);
    expect((await refused("GET", entries(MFG, "?sort=newest"), undefined, 422)).errors?.[0]).toMatchObject({ loc: ["query", "sort"], type: "enum" });

    // A search over terms, labels and words, in any locale and case.
    expect((await ok<RegistryPage>("GET", entries(MFG, "?q=GAE"))).items.map((e) => e.id)).toEqual(["measure-oee"]);
    expect((await ok<RegistryPage>("GET", entries(MFG, "?q=energy"))).items.map((e) => e.id).sort()).toEqual([
      "gap-energy-cost",
      "measure-energy-per-good-unit",
    ]);
    expect((await ok<RegistryPage>("GET", entries(MFG, "?q=zebra"))).items).toEqual([]);

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
    expect((await refused("GET", entries("/api/v1/workspaces/nowhere"), undefined, 404)).code).toBe("no_workspace");
  });

  it("details an entry with its newest runs, which open as real threads, and its history", async () => {
    const entry = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-oee"));
    expect(entry).toMatchObject({
      kind: "measure",
      term: "oee",
      label: "OEE",
      source: { kind: "library", text: "from sightline's KPI library (ISO 22400-2)" },
      status: "proposed",
      version: 1,
      reviewed_by: null,
      reviewed_at: null,
    });
    // The definition in the core's words, as the run's definitions[] has it.
    expect(entry.definition).toMatch(/^availability \(actual production time \(run hours\) over planned busy time/);
    expect(entry.definition).toMatch(/good quantity over produced quantity\)$/);
    expect(entry.words.de).toContain("gesamtanlageneffektivität");

    // The seeded OEE run, and the live ones this file made that replayed the same fixture.
    const ids = entry.runs.map((r) => r.run_id);
    expect(ids).toContain("run_seed_oee-line");
    expect(ids).toContain(oee.run_id);
    expect(ids).toContain(oeeLatest);
    expect(entry.runs.length).toBeLessThanOrEqual(20);
    expect(entry.runs_total).toBe(entry.demand.runs);
    expect(entry.demand.runs).toBe(6 + entry.runs.length);
    expect(entry.demand.last_asked).toBe(entry.runs[0]?.at);
    expect(entry.runs.map((r) => r.at)).toEqual(entry.runs.map((r) => r.at).sort().reverse());
    for (const used of entry.runs) {
      const thread = await ok<Thread>("GET", `${MFG}/threads/${used.thread_id}`);
      const run = thread.runs.find((r) => r.id === used.run_id);
      expect(run, used.run_id).toBeDefined();
      expect(used.question).toBe(thread.question);
      expect([used.revision, used.prompt]).toEqual([run?.revision, run?.prompt]);
      expect(used.rating).toBe(run?.feedback ?? null);
    }
    expect(entry.runs.find((r) => r.run_id === "run_seed_oee-line")?.rating).toBe("up");
    expect(entry.runs.find((r) => r.run_id === oeeLatest)?.revision).toBe(4);
    // Proposed by sightline, then asked for: no review, so the version stays.
    expect(entry.history.map((c) => [c.action, c.version, c.by])).toEqual([
      ["proposed", 1, null],
      ["demand", 1, null],
    ]);
    expect(entry.history.at(-1)?.at).toBe(entry.demand.last_asked);

    // The clarify run asked for it too.
    const availability = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-availability"));
    expect(availability.runs.map((r) => r.thread_id)).toEqual(expect.arrayContaining(["th_seed_aeq-clarify", "th_seed_aeq-weekly"]));
    expect([availability.status, availability.version, availability.reviewed_by]).toEqual(["approved", 2, "Dev user"]);
    expect(availability.history.map((c) => c.action)).toEqual(["proposed", "approve", "demand"]);
    expect(availability.reviewed_at).toBe(availability.history.find((c) => c.action === "approve")?.at);

    const plant = await ok<RegistryEntryDetail>("GET", entries(MFG, "/default-best-plant"));
    expect([plant.definition, plant.chosen_option, plant.source.kind]).toEqual(["OEE", "oee", "learned"]);
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
    expect(revenue.chosen_option).toBe("fact_order_lines.line_revenue");

    expect((await refused("GET", entries(MFG, "/measure-nothing"), undefined, 404)).code).toBe("no_entry");
  });

  it("lists, for every entry with demand, runs that open as real threads", async () => {
    for (const ws of [MFG, REST]) {
      const page = await ok<RegistryPage>("GET", entries(ws));
      for (const listed of page.items) {
        const entry = await ok<RegistryEntryDetail>("GET", entries(ws, `/${listed.id}`));
        expect(entry.demand.runs, entry.id).toBeGreaterThan(0);
        expect(entry.runs.length, entry.id).toBeGreaterThan(0);
        expect(entry.runs.length, entry.id).toBeLessThanOrEqual(entry.runs_total);
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

  it("approves, then refuses the stale version, then reopens and rejects, each review a new version in the history", async () => {
    const path = entries(MFG, "/measure-oee/review");
    const approved = await ok<RegistryEntryDetail>("POST", path, { action: "approve", version: 1, note: "As in the plant report." }, 200);
    expect(approved).toMatchObject({ status: "approved", version: 2, reviewed_by: "Dev user", note: "As in the plant report." });
    expect(Date.now() - Date.parse(approved.updated_at)).toBeLessThan(60_000);
    expect(approved.reviewed_at).toBe(approved.updated_at);
    expect(approved.history.at(-1)).toMatchObject({ action: "approve", version: 2, by: "Dev user", note: "As in the plant report." });
    expect(approved.runs.length).toBeGreaterThan(0);
    expect((await ok<RegistryPage>("GET", entries(MFG))).counts.measure).toBe(3);

    // Someone reviewed it first: the stale version is refused, whatever the action.
    const stale = await refused("POST", path, { action: "reject", version: 1 }, 409);
    expect(stale.code).toBe("version_conflict");
    expect((await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-oee"))).version).toBe(2);
    // On the current version, a move its status does not allow.
    expect((await refused("POST", path, { action: "approve", version: 2 }, 409)).code).toBe("not_allowed");

    const reopened = await ok<RegistryEntryDetail>("POST", path, { action: "reopen", version: 2 }, 200);
    expect([reopened.status, reopened.version]).toEqual(["proposed", 3]);
    expect((await refused("POST", path, { action: "reopen", version: 3 }, 409)).code).toBe("not_allowed");
    const rejected = await ok<RegistryEntryDetail>("POST", path, { action: "reject", version: 3 }, 200);
    expect([rejected.status, rejected.version]).toEqual(["rejected", 4]);
    expect((await ok<RegistryPage>("GET", entries(MFG))).counts.measure).toBe(3);
    const back = await ok<RegistryEntryDetail>("POST", path, { action: "reopen", version: 4 }, 200);
    expect([back.status, back.version]).toEqual(["proposed", 5]);
    expect((await ok<RegistryPage>("GET", entries(MFG))).counts.measure).toBe(4);
    expect(back.history.filter((c) => c.by === "Dev user").map((c) => [c.action, c.version])).toEqual([
      ["approve", 2],
      ["reopen", 3],
      ["reject", 4],
      ["reopen", 5],
    ]);

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
    expect(edited.history.at(-1)).toMatchObject({ action: "edit", version: edited.version });

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

  it("applies a review from the next run on: an approved definition says so, a rejected one no longer answers", async () => {
    const oeeEntry = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-oee"));
    await ok<RegistryEntryDetail>("POST", entries(MFG, "/measure-oee/review"), { action: "approve", version: oeeEntry.version }, 200);
    const runs = (await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-oee"))).demand.runs;
    const { run } = await ask(MFG, OEE_QUESTION);
    expect(run.definitions.map((d) => [d.name, d.status, d.label])).toEqual([["oee", "approved", "OEE"]]);
    // An earlier run keeps what it said; demand moved, the version did not.
    expect((await ok<RunView>("GET", `${MFG}/runs/${oee.run_id}`)).definitions[0]?.status).toBe("proposed");
    const after = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-oee"));
    expect([after.demand.runs, after.version]).toEqual([runs + 1, oeeEntry.version + 1]);

    // An edited label is the label the next run shows.
    const effectiveness = await ok<RegistryEntryDetail>("GET", entries(MFG, "/measure-effectiveness"));
    const weekly = await ask(MFG, "How did availability, effectiveness and quality ratio develop per week in Q4 2025?");
    expect(weekly.run.definitions.find((d) => d.name === "effectiveness")?.label).toBe(effectiveness.label);

    // Reopened (above), the rejected scrap definition answers again, as sightline drafted it.
    const scrap = await ask(MFG, "Which production orders had the most scrap against plan in 2025?");
    expect(scrap.run.definitions.map((d) => [d.name, d.status, d.source.kind, d.entry_id])).toEqual([
      ["scrap against plan", "proposed", "drafted", "measure-scrap-against-plan"],
    ]);
    // The energy question states its own definition, and the entry keeps that source.
    const energy = await ask(MFG, "Which lines use the most energy per 1,000 good units?");
    expect(energy.run.definitions.map((d) => [d.name, d.source.kind])).toEqual([["energy per good unit", "question"]]);

    const tip = await ok<RegistryEntryDetail>("GET", entries(REST, "/measure-average-tip"));
    await ok<RegistryEntryDetail>("POST", entries(REST, "/measure-average-tip/review"), { action: "reject", version: tip.version }, 200);
    const tips = await ask(REST, "What is the average tip by payment method?");
    expect(tips.run.definitions).toEqual([]);
  });
});
