import { describe, expect, it } from "vitest";
import { applyEvent } from "../src/api/runEvents";
import type {
  AnalysisStep,
  Card,
  ChartView,
  Clarify,
  Result,
  RunEvent,
  RunStatus,
  RunView,
  StepRecord,
  StepRole,
  StepVerdict,
  Support,
} from "../src/api/types";

const NOW = "2026-10-24T12:00:30.000Z";

function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    thread_id: "t1",
    revision: 0,
    origin: "question",
    prompt: "Revenue by region last quarter",
    status: "queued",
    phase: null,
    stage: null,
    step: null,
    started_at: null,
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

const prior: AnalysisStep = { id: "s1", label: "the prior period" };
const byPlant: AnalysisStep = { id: "s2", label: "the change by plant" };

const stepStarted = (step: AnalysisStep, at: string, role: StepRole = "comparison"): RunEvent => ({
  type: "step.started",
  run_id: "r1",
  step,
  role,
  stage: "analyse",
  at,
});
const stepFinished = (
  step: AnalysisStep,
  at: string,
  elapsed_ms: number,
  rest: { verdict?: StepVerdict | null; cached?: boolean; sql?: string | null; row_count?: number | null; role?: StepRole } = {},
): RunEvent => ({
  type: "step.finished",
  run_id: "r1",
  step,
  role: rest.role ?? "comparison",
  stage: "analyse",
  at,
  elapsed_ms,
  verdict: rest.verdict === undefined ? "as_expected" : rest.verdict,
  cached: rest.cached ?? false,
  sql: rest.sql === undefined ? "select 1" : rest.sql,
  row_count: rest.row_count === undefined ? 4 : rest.row_count,
});

/** A step's record while it runs. */
const running = (step: AnalysisStep, at: string, role: StepRole = "comparison"): StepRecord => ({
  id: step.id,
  label: step.label,
  role,
  stage: "analyse",
  started_at: at,
  elapsed_ms: null,
  verdict: null,
  cached: false,
  sql: null,
  row_count: null,
});

const chart: ChartView = {
  chart: "horizontal_bar",
  label: "Horizontal bars",
  hint: "compare the regions",
  spec: { mark: "bar", title: { text: "North leads the regions" } },
  png_url: null,
  title: "North leads the regions",
  subtitle: ["Net revenue, last quarter"],
  score: 0.9,
  min_width: null,
  options: [
    { chart: "horizontal_bar", label: "Horizontal bars", hint: null, score: 0.9, drawn: true },
    { chart: "dot_plot", label: "Dots", hint: null, score: 0.7, drawn: false },
  ],
};

const small: ChartView = {
  chart: "sparkline",
  label: "Sparkline",
  hint: null,
  spec: { mark: "line", height: 40 },
  png_url: null,
  title: null,
  subtitle: [],
  score: null,
  min_width: 160,
  options: [],
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
      entry_id: null,
    },
  ],
};

const supports: Support[] = [
  { id: "u1", role: "answer", drawn: "main", layer: "answer", note: null, point: "k1", text: "North sold most", chart: null },
  { id: "u2", role: "comparison", drawn: "small", layer: null, note: null, point: "k2", text: "Up on the prior quarter", chart: null },
];

const result: Result = {
  sql: "select region, sum(amount) from sales group by 1",
  step_id: "s0",
  columns: [
    { name: "region", label: "Region", type: "nominal", role: "dimension", unit: null, format: null, description: null },
    { name: "revenue", label: "Revenue", type: "q_ratio", role: "measure", unit: "EUR", format: ",.0f", description: null },
  ],
  rows: [
    ["North", 12],
    ["South", 7],
  ],
  row_count: 2,
  truncated: false,
  chart,
  verdict: "pass",
  concerns: [],
  notes: ["Returns are left out."],
  findings: [],
  storyline: {
    top: "North leads the regions",
    key_line: [
      { id: "k1", text: "North sold most" },
      { id: "k2", text: "Up on the prior quarter" },
    ],
  },
  lead: "u1",
  supports,
};

const noGaps: Clarify = { gaps: [], missing: [], record: [], warnings: [], warnings_total: 0 };

const failure: RunEvent = {
  type: "error",
  run_id: "r1",
  code: "warehouse_unavailable",
  retryable: true,
  message: "The warehouse did not answer.",
  detail: "timeout after 30 s",
  stage: "query",
};

/** A deep copy, to prove a fold left its input as it was. */
const frozen = (run: RunView): RunView => structuredClone(run);

describe("applyEvent", () => {
  it("never mutates the run it folds into", () => {
    const run = makeRun({
      status: "running",
      started_at: "2026-10-24T12:00:00.000Z",
      timings: [{ phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: null }],
      step: prior,
      steps: [running(prior, "2026-10-24T12:00:02.000Z")],
      result,
    });
    const before = frozen(run);
    const events: RunEvent[] = [
      status("complete"),
      status("queued"),
      started("query", "2026-10-24T12:00:05.000Z", "analyse"),
      finished("ground", "2026-10-24T12:00:04.000Z", 3000),
      stepStarted(byPlant, "2026-10-24T12:00:05.000Z"),
      stepFinished(prior, "2026-10-24T12:00:04.000Z", 2000),
      { type: "restatement", run_id: "r1", text: "Net revenue by region" },
      { type: "card", run_id: "r1", card },
      { type: "clarify", run_id: "r1", clarify: noGaps },
      failure,
      { type: "chart", run_id: "r1", chart, support_id: null },
      { type: "chart", run_id: "r1", chart: small, support_id: "u2" },
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

    it("starts the trace and the steps over when a worker restarts the run (queued after running)", () => {
      const run = makeRun({
        status: "running",
        phase: "analyse",
        stage: "analyse",
        started_at: "2026-10-24T12:00:00.000Z",
        restatement: "Net revenue by region",
        card: { ...card, blocking: false },
        result,
        timings: [
          { phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: 1000 },
          { phase: "analyse", stage: "analyse", started_at: "2026-10-24T12:00:02.000Z", elapsed_ms: null },
        ],
        step: byPlant,
        steps: [
          { ...running(prior, "2026-10-24T12:00:02.000Z"), elapsed_ms: 500, verdict: "as_expected" },
          running(byPlant, "2026-10-24T12:00:03.000Z"),
        ],
        last_event_id: 7,
      });
      const before = frozen(run);
      const next = applyEvent(run, status("queued"), NOW);
      expect(next).toEqual({
        ...before,
        status: "queued",
        timings: [],
        steps: [],
        step: null,
        phase: null,
        stage: null,
      });
      expect(run).toEqual(before);

      // The stages it runs again make a fresh trace.
      const again = applyEvent(next, started("ground", "2026-10-24T12:00:20.000Z"), NOW);
      expect(again.timings.map((t) => [t.stage, t.started_at])).toEqual([["ground", "2026-10-24T12:00:20.000Z"]]);
      expect(again.started_at).toBe("2026-10-24T12:00:00.000Z");
    });

    it("keeps the trace and the steps when a finished run is queued again (re-present) and appends to it", () => {
      const timings = [
        { phase: "understand", stage: "ground", started_at: "2026-10-24T11:00:01.000Z", elapsed_ms: 1000 },
        { phase: "present", stage: "render", started_at: "2026-10-24T11:00:05.000Z", elapsed_ms: 800 },
      ];
      const steps = [{ ...running(prior, "2026-10-24T11:00:02.000Z"), elapsed_ms: 400, verdict: "as_expected" as const }];
      const run = makeRun({
        status: "complete",
        phase: "present",
        stage: "render",
        started_at: "2026-10-24T11:00:00.000Z",
        finished_at: "2026-10-24T11:00:06.000Z",
        result,
        timings,
        steps,
      });
      const queued = applyEvent(run, status("queued"), NOW);
      expect(queued.status).toBe("queued");
      expect(queued.finished_at).toBeNull();
      expect(queued.timings).toEqual(timings);
      expect(queued.steps).toEqual(steps);
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

  describe("steps", () => {
    const analysing = () =>
      applyEvent(makeRun({ status: "running" }), started("analyse", "2026-10-24T12:00:01.000Z", "analyse"), NOW);

    it("opens a record for a started step and makes it the step under way", () => {
      const next = applyEvent(analysing(), stepStarted(prior, "2026-10-24T12:00:02.000Z"), NOW);
      expect(next.step).toEqual(prior);
      expect(next.steps).toEqual([running(prior, "2026-10-24T12:00:02.000Z")]);
      // A step is no stage: the stage under way stays.
      expect(next.stage).toBe("analyse");
    });

    it("closes the step's record with everything its finish tells, and clears the step under way", () => {
      let run = applyEvent(analysing(), stepStarted(prior, "2026-10-24T12:00:02.000Z", "probe"), NOW);
      run = applyEvent(
        run,
        stepFinished(prior, "2026-10-24T12:00:03.500Z", 1500, {
          role: "comparison",
          verdict: "contradicts",
          cached: true,
          sql: "select plant, oee from oee_by_plant",
          row_count: 0,
        }),
        NOW,
      );
      expect(run.step).toBeNull();
      expect(run.steps).toEqual([
        {
          ...running(prior, "2026-10-24T12:00:02.000Z"),
          role: "comparison",
          elapsed_ms: 1500,
          verdict: "contradicts",
          cached: true,
          sql: "select plant, oee from oee_by_plant",
          row_count: 0,
        },
      ]);
    });

    it("keeps the step under way when another step finishes", () => {
      let run = applyEvent(analysing(), stepStarted(prior, "2026-10-24T12:00:02.000Z"), NOW);
      run = applyEvent(run, stepStarted(byPlant, "2026-10-24T12:00:02.100Z", "decomposition"), NOW);
      expect(run.step).toEqual(byPlant);
      run = applyEvent(run, stepFinished(prior, "2026-10-24T12:00:03.000Z", 1000, { verdict: null, sql: null, row_count: null }), NOW);
      expect(run.step).toEqual(byPlant);
      expect(run.steps.map((s) => [s.id, s.elapsed_ms, s.verdict])).toEqual([
        ["s1", 1000, null],
        ["s2", null, null],
      ]);
    });

    it("records a finish it never saw start as a finished step, its start counted back", () => {
      const next = applyEvent(analysing(), stepFinished(prior, "2026-10-24T12:00:03.000Z", 1000), NOW);
      expect(next.steps).toEqual([
        {
          id: "s1",
          label: "the prior period",
          role: "comparison",
          stage: "analyse",
          started_at: "2026-10-24T12:00:02.000Z",
          elapsed_ms: 1000,
          verdict: "as_expected",
          cached: false,
          sql: "select 1",
          row_count: 4,
        },
      ]);
      expect(next.step).toBeNull();
    });

    it("clears the step under way when the run asks", () => {
      const run = applyEvent(analysing(), stepStarted(prior, "2026-10-24T12:00:02.000Z"), NOW);
      expect(applyEvent(run, status("asking"), NOW).step).toBeNull();
    });

    it.each(["cancelled", "failed", "superseded"] as const)(
      "leaves a step cut off by %s open in the record, for getRun's elapsed_ms",
      (end) => {
        let run = applyEvent(analysing(), stepStarted(prior, "2026-10-24T12:00:02.000Z"), NOW);
        run = applyEvent(run, stepFinished(prior, "2026-10-24T12:00:03.000Z", 1000), NOW);
        run = applyEvent(run, stepStarted(byPlant, "2026-10-24T12:00:03.000Z", "decomposition"), NOW);
        const next = applyEvent(run, status(end), NOW);
        expect(next.step).toBeNull();
        expect(next.steps).toEqual([run.steps[0], running(byPlant, "2026-10-24T12:00:03.000Z", "decomposition")]);
      },
    );

    it("keeps no step under way across a complete or a clarify", () => {
      for (const end of ["complete", "clarify"] as const) {
        const run = makeRun({ status: "running", step: prior, steps: [running(prior, "2026-10-24T12:00:02.000Z")] });
        expect(applyEvent(run, status(end), NOW).step).toBeNull();
      }
    });

    it("copies the steps it changes", () => {
      const run = applyEvent(analysing(), stepStarted(prior, "2026-10-24T12:00:02.000Z"), NOW);
      const record = run.steps[0];
      const next = applyEvent(run, stepFinished(prior, "2026-10-24T12:00:03.000Z", 1000), NOW);
      expect(next.steps).not.toBe(run.steps);
      expect(record?.elapsed_ms).toBeNull();
    });
  });

  describe("content", () => {
    it("takes the restatement, card, clarify and error", () => {
      const clarify: Clarify = {
        ...noGaps,
        gaps: [
          {
            slot: "measure",
            requested: "churn",
            reason: "no such measure",
            suggestions: [{ id: "g1", label: "cancellations", question: "Cancellations by region last quarter" }],
          },
        ],
      };
      let run = makeRun({ status: "running" });
      run = applyEvent(run, { type: "restatement", run_id: "r1", text: "Net revenue by region" }, NOW);
      run = applyEvent(run, { type: "card", run_id: "r1", card }, NOW);
      run = applyEvent(run, { type: "clarify", run_id: "r1", clarify }, NOW);
      run = applyEvent(run, failure, NOW);
      expect(run.restatement).toBe("Net revenue by region");
      expect(run.card).toEqual(card);
      expect(run.clarify).toEqual(clarify);
      expect(run.error).toEqual({
        code: "warehouse_unavailable",
        retryable: true,
        message: "The warehouse did not answer.",
        detail: "timeout after 30 s",
        stage: "query",
      });
    });

    it("takes a restatement told again, the latest standing", () => {
      let run = makeRun({ status: "running" });
      run = applyEvent(run, { type: "restatement", run_id: "r1", text: "Net revenue by region" }, NOW);
      run = applyEvent(run, { type: "restatement", run_id: "r1", text: "Net revenue by region, last quarter" }, NOW);
      expect(run.restatement).toBe("Net revenue by region, last quarter");
    });

    it("takes a not-possible-yet clarify whole: what is missing and what to record", () => {
      const clarify: Clarify = {
        ...noGaps,
        missing: ["planned production time per machine"],
        record: ["each machine's planned shifts"],
      };
      const next = applyEvent(makeRun({ status: "running" }), { type: "clarify", run_id: "r1", clarify }, NOW);
      expect(next.clarify).toBe(clarify);
    });

    it("creates a neutral result shell for a main chart that arrives first", () => {
      const next = applyEvent(makeRun({ status: "running" }), { type: "chart", run_id: "r1", chart, support_id: null }, NOW);
      const shell: Result = {
        sql: null,
        step_id: null,
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        chart,
        verdict: "pass",
        concerns: [],
        notes: [],
        findings: [],
        storyline: null,
        lead: null,
        supports: [],
      };
      expect(next.result).toEqual(shell);
      // The result event replaces the shell whole.
      expect(applyEvent(next, { type: "result", run_id: "r1", result }, NOW).result).toBe(result);
    });

    it("swaps the main chart of a result it already has", () => {
      const run = makeRun({ status: "running", result: { ...result, chart: null } });
      const next = applyEvent(run, { type: "chart", run_id: "r1", chart, support_id: null }, NOW);
      expect(next.result).toEqual({ ...result, chart });
      expect(run.result?.chart).toBeNull();
    });

    it("gives a small chart to the support it names, and to nothing else", () => {
      const run = makeRun({ status: "running", result });
      const next = applyEvent(run, { type: "chart", run_id: "r1", chart: small, support_id: "u2" }, NOW);
      expect(next.result?.chart).toBe(chart);
      expect(next.result?.supports.map((s) => s.chart)).toEqual([null, small]);
      expect(next.result?.supports[0]).toBe(supports[0]);
      expect(run.result?.supports[1]?.chart).toBeNull();
    });

    it("leaves a small chart whose support is not in yet to the result event", () => {
      const before = makeRun({ status: "running" });
      expect(applyEvent(before, { type: "chart", run_id: "r1", chart: small, support_id: "u2" }, NOW)).toBe(before);
      const shell = applyEvent(before, { type: "chart", run_id: "r1", chart, support_id: null }, NOW);
      expect(applyEvent(shell, { type: "chart", run_id: "r1", chart: small, support_id: "u9" }, NOW)).toBe(shell);
    });

    it("takes a result whole", () => {
      const run = makeRun({ status: "running", result: { ...result, rows: [], notes: [] } });
      expect(applyEvent(run, { type: "result", run_id: "r1", result }, NOW).result).toBe(result);
    });
  });

  it("folds a whole run's replay into its final view", () => {
    const withSmall: Result = {
      ...result,
      supports: result.supports.map((s) => (s.id === "u2" ? { ...s, chart: small } : s)),
    };
    const replay: RunEvent[] = [
      status("queued"),
      status("running"),
      started("ground", "2026-10-24T12:00:01.000Z"),
      finished("ground", "2026-10-24T12:00:02.000Z", 1000),
      started("bind", "2026-10-24T12:00:02.000Z"),
      finished("bind", "2026-10-24T12:00:02.500Z", 500),
      { type: "restatement", run_id: "r1", text: "Net revenue by region, last quarter" },
      started("analyse", "2026-10-24T12:00:03.000Z", "analyse"),
      stepStarted(prior, "2026-10-24T12:00:03.000Z"),
      stepFinished(prior, "2026-10-24T12:00:04.000Z", 1000),
      finished("analyse", "2026-10-24T12:00:04.000Z", 1000, "analyse"),
      started("render", "2026-10-24T12:00:05.000Z", "present"),
      finished("render", "2026-10-24T12:00:06.000Z", 1000, "present"),
      { type: "chart", run_id: "r1", chart, support_id: null },
      { type: "chart", run_id: "r1", chart: small, support_id: "u2" },
      { type: "result", run_id: "r1", result: withSmall },
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
        result: withSmall,
        timings: [
          { phase: "understand", stage: "ground", started_at: "2026-10-24T12:00:01.000Z", elapsed_ms: 1000 },
          { phase: "understand", stage: "bind", started_at: "2026-10-24T12:00:02.000Z", elapsed_ms: 500 },
          { phase: "analyse", stage: "analyse", started_at: "2026-10-24T12:00:03.000Z", elapsed_ms: 1000 },
          { phase: "present", stage: "render", started_at: "2026-10-24T12:00:05.000Z", elapsed_ms: 1000 },
        ],
        steps: [
          {
            ...running(prior, "2026-10-24T12:00:03.000Z"),
            elapsed_ms: 1000,
            verdict: "as_expected",
            sql: "select 1",
            row_count: 4,
          },
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
