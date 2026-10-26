import { describe, expect, it } from "vitest";
import { applyEvent } from "../src/api/runEvents";
import type { Card, ChartView, Clarify, Result, RunEvent, RunStatus, RunView } from "../src/api/types";

const NOW = "2026-10-24T12:00:30.000Z";

function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    thread_id: "t1",
    revision: 0,
    prompt: "Revenue by region last quarter",
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
    ...overrides,
  };
}

const status = (s: RunStatus): RunEvent => ({ type: "run.status", run_id: "r1", status: s });
const started = (stage: string, at: string, phase = "understand"): RunEvent => ({
  type: "stage.started",
  run_id: "r1",
  phase,
  stage,
  at,
});
const finished = (stage: string, at: string, elapsed_ms: number, phase = "understand"): RunEvent => ({
  type: "stage.finished",
  run_id: "r1",
  phase,
  stage,
  at,
  elapsed_ms,
});

const chart: ChartView = {
  chart: "horizontal_bar",
  label: "Horizontal bars",
  spec: { mark: "bar" },
  png_url: null,
  alternatives: [{ chart: "dot_plot", label: "Dots", hint: null }],
};

const card: Card = {
  blocking: true,
  points: [
    {
      id: "p1",
      step: "meaning",
      question: "Which revenue?",
      options: [
        { id: "gross", label: "Gross", hint: "before returns" },
        { id: "net", label: "Net", hint: "" },
      ],
      chosen: null,
      default: "net",
      by: "rules",
      confidence: 0.4,
      why: "The warehouse records both.",
      open: true,
      stage: "ground",
    },
  ],
};

const result: Result = {
  sql: "select region, sum(amount) from sales group by 1",
  columns: [
    { name: "region", type: "nominal" },
    { name: "revenue", type: "q_ratio" },
  ],
  rows: [
    ["North", 12],
    ["South", 7],
  ],
  row_count: 2,
  truncated: false,
  chart,
  findings: ["North leads"],
};

const noGaps: Clarify = { gaps: [], missing: [], record: [], nearest: [], warnings: [] };

/** A deep copy, to prove a fold left its input as it was. */
const frozen = (run: RunView): RunView => structuredClone(run);

describe("applyEvent", () => {
  it("never mutates the run it folds into", () => {
    const run = makeRun({
      status: "running",
      started_at: "2026-10-24T12:00:00.000Z",
      timings: [{ phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: null }],
    });
    const before = frozen(run);
    const events: RunEvent[] = [
      status("complete"),
      started("query", "2026-10-24T12:00:05.000Z", "analyse"),
      finished("ground", "2026-10-24T12:00:04.000Z", 3000),
      { type: "restatement", run_id: "r1", text: "Net revenue by region" },
      { type: "card", run_id: "r1", card },
      { type: "clarify", run_id: "r1", clarify: noGaps },
      { type: "error", run_id: "r1", message: "boom", stage: "query" },
      { type: "chart", run_id: "r1", chart },
      { type: "result", run_id: "r1", result },
    ];
    for (const event of events) {
      const next = applyEvent(run, event, NOW);
      expect(next).not.toBe(run);
      expect(run).toEqual(before);
    }
  });

  it("returns the run itself for an event type it does not know", () => {
    const run = makeRun({ status: "running" });
    const future = { type: "thought", run_id: "r1", text: "hmm" } as unknown as RunEvent;
    expect(applyEvent(run, future, NOW)).toBe(run);
  });

  describe("run.status", () => {
    it("stamps started_at when the run starts running", () => {
      const next = applyEvent(makeRun(), status("running"), NOW);
      expect(next.status).toBe("running");
      expect(next.started_at).toBe(NOW);
      expect(next.finished_at).toBeNull();
    });

    it("keeps a started_at it already has", () => {
      const next = applyEvent(makeRun({ started_at: "2026-10-24T11:59:00.000Z" }), status("running"), NOW);
      expect(next.started_at).toBe("2026-10-24T11:59:00.000Z");
    });

    it.each(["complete", "clarify", "failed", "cancelled", "superseded"] as const)("stamps finished_at on %s", (end) => {
      const next = applyEvent(makeRun({ status: "running", started_at: NOW }), status(end), NOW);
      expect(next.status).toBe(end);
      expect(next.finished_at).toBe(NOW);
    });

    it("keeps a finished_at it already has", () => {
      const run = makeRun({ status: "complete", finished_at: "2026-10-24T11:00:00.000Z" });
      expect(applyEvent(run, status("failed"), NOW).finished_at).toBe("2026-10-24T11:00:00.000Z");
    });

    it("does not finish a run that waits on the card", () => {
      const next = applyEvent(makeRun({ status: "running", started_at: NOW }), status("asking"), NOW);
      expect(next.status).toBe("asking");
      expect(next.finished_at).toBeNull();
    });

    it("clears finished_at when a finished run runs again (re-present)", () => {
      const run = makeRun({
        status: "complete",
        started_at: "2026-10-24T11:00:00.000Z",
        finished_at: "2026-10-24T11:00:20.000Z",
      });
      const next = applyEvent(run, status("running"), NOW);
      expect(next.status).toBe("running");
      expect(next.finished_at).toBeNull();
      expect(next.started_at).toBe("2026-10-24T11:00:00.000Z");
    });

    it("resumes from asking without restamping started_at", () => {
      const run = makeRun({ status: "asking", started_at: "2026-10-24T11:00:00.000Z" });
      const next = applyEvent(run, status("running"), NOW);
      expect(next.started_at).toBe("2026-10-24T11:00:00.000Z");
      expect(next.finished_at).toBeNull();
    });

    it("starts the trace over when a worker restarts the run (queued after running)", () => {
      const run = makeRun({
        status: "running",
        phase: "analyse",
        stage: "query",
        started_at: "2026-10-24T12:00:00.000Z",
        restatement: "Net revenue by region",
        card: { ...card, blocking: false },
        result,
        timings: [
          { phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: 1000 },
          { phase: "analyse", stage: "query", started_at: "2026-10-24T12:00:02.000Z", elapsed_ms: null },
        ],
        last_event_id: 7,
      });
      const before = frozen(run);
      const next = applyEvent(run, status("queued"), NOW);
      expect(next).toEqual({ ...before, status: "queued", timings: [], phase: null, stage: null });
      expect(run).toEqual(before);

      // The stages it runs again make a fresh trace.
      const again = applyEvent(next, started("ground", "2026-10-24T12:00:20.000Z"), NOW);
      expect(again.timings.map((t) => [t.stage, t.started_at])).toEqual([["ground", "2026-10-24T12:00:20.000Z"]]);
      expect(again.started_at).toBe("2026-10-24T12:00:00.000Z");
    });

    it("keeps the trace when a finished run is queued again (re-present) and appends to it", () => {
      const timings = [
        { phase: "understand", stage: "ground", started_at: "2026-10-24T11:00:01.000Z", elapsed_ms: 1000 },
        { phase: "present", stage: "render", started_at: "2026-10-24T11:00:05.000Z", elapsed_ms: 800 },
      ];
      const run = makeRun({
        status: "complete",
        phase: "present",
        stage: "render",
        started_at: "2026-10-24T11:00:00.000Z",
        finished_at: "2026-10-24T11:00:06.000Z",
        result,
        timings,
      });
      const queued = applyEvent(run, status("queued"), NOW);
      expect(queued.status).toBe("queued");
      expect(queued.finished_at).toBeNull();
      expect(queued.timings).toEqual(timings);
      expect([queued.phase, queued.stage]).toEqual(["present", "render"]);

      let next = applyEvent(queued, status("running"), NOW);
      next = applyEvent(next, started("render", "2026-10-24T12:00:01.000Z", "present"), NOW);
      expect(next.timings.map((t) => [t.stage, t.elapsed_ms])).toEqual([
        ["ground", 1000],
        ["render", 800],
        ["render", null],
      ]);
      expect(next.result).toBe(result);
    });

    it("keeps the trace when an answered card queues the run again", () => {
      const timings = [{ phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: 900 }];
      const run = makeRun({ status: "asking", phase: "understand", stage: "ask", timings, card });
      const next = applyEvent(run, status("queued"), NOW);
      expect(next.timings).toEqual(timings);
      expect(next.stage).toBe("ask");
    });

    it("ends a superseded run like a cancelled one, keeping what it showed", () => {
      const timings = [{ phase: "analyse", stage: "query", started_at: "2026-10-24T12:00:02.000Z", elapsed_ms: null }];
      const run = makeRun({ status: "running", phase: "analyse", stage: "query", started_at: NOW, timings });
      const next = applyEvent(run, status("superseded"), NOW);
      expect(next.status).toBe("superseded");
      expect(next.finished_at).toBe(NOW);
      expect(next.timings).toEqual(timings);
      expect(next.stage).toBe("query");
    });
  });

  describe("stages", () => {
    it("moves the run to a started stage and opens its timing", () => {
      const next = applyEvent(makeRun({ status: "running" }), started("ground", "2026-10-24T12:00:01.000Z"), NOW);
      expect(next.phase).toBe("understand");
      expect(next.stage).toBe("ground");
      expect(next.started_at).toBe("2026-10-24T12:00:01.000Z");
      expect(next.timings).toEqual([
        { phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: null },
      ]);
    });

    it("closes the stage's open timing and keeps the current stage", () => {
      let run = makeRun({ status: "running" });
      run = applyEvent(run, started("ground", "2026-10-24T12:00:01.000Z"), NOW);
      run = applyEvent(run, started("query", "2026-10-24T12:00:02.000Z", "analyse"), NOW);
      run = applyEvent(run, finished("ground", "2026-10-24T12:00:03.000Z", 2000), NOW);
      expect(run.stage).toBe("query");
      expect(run.phase).toBe("analyse");
      expect(run.timings.map((t) => [t.stage, t.elapsed_ms])).toEqual([
        ["ground", 2000],
        ["query", null],
      ]);
    });

    it("pairs a repeated stage with its latest open timing", () => {
      let run = makeRun({ status: "running" });
      run = applyEvent(run, started("validate", "2026-10-24T12:00:01.000Z", "present"), NOW);
      run = applyEvent(run, finished("validate", "2026-10-24T12:00:02.000Z", 1000, "present"), NOW);
      run = applyEvent(run, started("reconsider", "2026-10-24T12:00:03.000Z", "present"), NOW);
      run = applyEvent(run, started("validate", "2026-10-24T12:00:04.000Z", "present"), NOW);
      run = applyEvent(run, finished("validate", "2026-10-24T12:00:04.500Z", 500, "present"), NOW);
      expect(run.timings.map((t) => [t.stage, t.started_at, t.elapsed_ms])).toEqual([
        ["validate", "2026-10-24T12:00:01.000Z", 1000],
        ["reconsider", "2026-10-24T12:00:03.000Z", null],
        ["validate", "2026-10-24T12:00:04.000Z", 500],
      ]);
    });

    it("records a finish it never saw start as a finished timing", () => {
      const next = applyEvent(makeRun({ status: "running" }), finished("render", "2026-10-24T12:00:09.000Z", 800, "present"), NOW);
      expect(next.timings).toEqual([
        { phase: "present", stage: "render", started_at: "2026-10-24T12:00:09.000Z", elapsed_ms: 800 },
      ]);
      expect(next.stage).toBeNull();
    });

    it("copies the timings it changes", () => {
      const run = applyEvent(makeRun(), started("ground", "2026-10-24T12:00:01.000Z"), NOW);
      const timing = run.timings[0];
      const next = applyEvent(run, finished("ground", "2026-10-24T12:00:02.000Z", 1000), NOW);
      expect(next.timings).not.toBe(run.timings);
      expect(timing?.elapsed_ms).toBeNull();
    });
  });

  describe("content", () => {
    it("takes the restatement, card, clarify and error", () => {
      const clarify: Clarify = {
        ...noGaps,
        gaps: [{ slot: "measure", requested: "churn", reason: "no such measure", suggestions: ["cancellations"] }],
      };
      let run = makeRun({ status: "running" });
      run = applyEvent(run, { type: "restatement", run_id: "r1", text: "Net revenue by region" }, NOW);
      run = applyEvent(run, { type: "card", run_id: "r1", card }, NOW);
      run = applyEvent(run, { type: "clarify", run_id: "r1", clarify }, NOW);
      run = applyEvent(run, { type: "error", run_id: "r1", message: "the warehouse timed out", stage: "query" }, NOW);
      expect(run.restatement).toBe("Net revenue by region");
      expect(run.card).toEqual(card);
      expect(run.clarify).toEqual(clarify);
      expect(run.error).toEqual({ message: "the warehouse timed out", stage: "query" });
    });

    it("takes a not-possible-yet clarify whole: what is missing, what to record, the nearest questions", () => {
      const clarify: Clarify = {
        ...noGaps,
        missing: ["planned production time per machine"],
        record: ["each machine's planned shifts"],
        nearest: ["Downtime minutes by plant last quarter", "Good units per hour by plant"],
      };
      const next = applyEvent(makeRun({ status: "running" }), { type: "clarify", run_id: "r1", clarify }, NOW);
      expect(next.clarify).toBe(clarify);
    });

    it("creates a result shell for a chart that arrives first", () => {
      const next = applyEvent(makeRun({ status: "running" }), { type: "chart", run_id: "r1", chart }, NOW);
      expect(next.result).toEqual({
        sql: null,
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        chart,
        findings: [],
      });
    });

    it("swaps the chart of a result it already has", () => {
      const run = makeRun({ status: "running", result: { ...result, chart: null } });
      const next = applyEvent(run, { type: "chart", run_id: "r1", chart }, NOW);
      expect(next.result).toEqual({ ...result, chart });
      expect(run.result?.chart).toBeNull();
    });

    it("takes a result whole", () => {
      const run = makeRun({ status: "running", result: { ...result, rows: [], findings: [] } });
      expect(applyEvent(run, { type: "result", run_id: "r1", result }, NOW).result).toBe(result);
    });
  });

  it("folds a whole run's replay into its final view", () => {
    const replay: RunEvent[] = [
      status("running"),
      started("ground", "2026-10-24T12:00:01.000Z"),
      { type: "restatement", run_id: "r1", text: "Net revenue by region, last quarter" },
      finished("ground", "2026-10-24T12:00:02.000Z", 1000),
      started("query", "2026-10-24T12:00:02.000Z", "analyse"),
      finished("query", "2026-10-24T12:00:05.000Z", 3000, "analyse"),
      started("render", "2026-10-24T12:00:05.000Z", "present"),
      { type: "chart", run_id: "r1", chart },
      finished("render", "2026-10-24T12:00:06.000Z", 1000, "present"),
      { type: "result", run_id: "r1", result },
      status("complete"),
    ];
    const final = replay.reduce((run, event) => applyEvent(run, event, NOW), makeRun());
    expect(final).toEqual(
      makeRun({
        status: "complete",
        phase: "present",
        stage: "render",
        started_at: NOW,
        finished_at: NOW,
        restatement: "Net revenue by region, last quarter",
        result,
        timings: [
          { phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: 1000 },
          { phase: "analyse", stage: "query", started_at: "2026-10-24T12:00:02.000Z", elapsed_ms: 3000 },
          { phase: "present", stage: "render", started_at: "2026-10-24T12:00:05.000Z", elapsed_ms: 1000 },
        ],
      }),
    );
  });

  it("stamps with the current time when no time is given", () => {
    const before = Date.now();
    const next = applyEvent(makeRun(), status("running"));
    expect(next.started_at).not.toBeNull();
    expect(Date.parse(next.started_at ?? "")).toBeGreaterThanOrEqual(before - 1);
  });
});
