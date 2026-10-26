import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Result, RunView, StageTiming } from "../src/api/types";
import { groupPhases, StageTrace } from "../src/components/thread/StageTrace";
import { phaseLabel } from "../src/components/thread/phaseLabels";
import { layoutSql, tokenize } from "../src/components/thread/sqlHighlight";

afterEach(cleanup);

const AT = "2026-10-24T19:08:40Z";
const timing = (phase: string, stage: string, elapsed_ms: number | null): StageTiming => ({
  phase,
  stage,
  started_at: AT,
  elapsed_ms,
});

const RESULT: Result = {
  sql: "SELECT line, AVG(oee) AS oee FROM shifts WHERE week = '2026-W42' GROUP BY line ORDER BY oee DESC",
  columns: [
    { name: "line", type: "nominal" },
    { name: "oee", type: "q_ratio" },
  ],
  rows: [
    ["L1", 0.81234567],
    ["L2", null],
  ],
  row_count: 1234,
  truncated: false,
  chart: null,
  findings: [],
};

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    thread_id: "t1",
    revision: 0,
    prompt: "What was the OEE of each line last week?",
    status: "complete",
    phase: null,
    stage: null,
    started_at: AT,
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

// A run part-way through presenting; perceive is the stage under way.
const WORKING = run({
  status: "running",
  phase: "present",
  stage: "perceive",
  result: RESULT,
  timings: [
    timing("understand", "situate", 295),
    timing("understand", "ground", 98),
    timing("understand", "abstract", 97_412),
    timing("analyse", "query", 6),
    timing("present", "idiom", 1_440),
    timing("present", "perceive", null),
  ],
});

// validate sent the run back: abstract again under understand, then analyse and present once more.
const LOOP: StageTiming[] = [
  timing("understand", "situate", 295),
  timing("understand", "abstract", 1_210),
  timing("analyse", "query", 6),
  timing("present", "idiom", 1_440),
  timing("present", "validate", 820),
  timing("present", "reconsider", 3),
  timing("understand", "abstract", 2_480),
  timing("understand", "bind", 12),
  timing("analyse", "derive", 4),
  timing("analyse", "query", 9),
  timing("present", "idiom", 1_100),
  timing("present", "validate", 610),
];

const rows = () => screen.getAllByRole("button").filter((b) => b.classList.contains("tx-trace__row"));

describe("phaseLabel", () => {
  it("speaks of a phase in the past once done and as a gerund while it runs", () => {
    expect(phaseLabel("understand", false)).toBe("Understood");
    expect(phaseLabel("analyse", true)).toBe("Analysing…");
    expect(phaseLabel("present", true)).toBe("Presenting…");
    expect(phaseLabel("look_around", false)).toBe("Look around");
    expect(phaseLabel("look_around", true)).toBe("Look around…");
  });
});

describe("StageTrace", () => {
  it("groups consecutive stages of a phase into one segment", () => {
    const groups = groupPhases(WORKING);
    expect(groups.map((g) => g.phase)).toEqual(["understand", "analyse", "present"]);
    expect(groups[0]?.stages.map((s) => s.stage)).toEqual(["situate", "ground", "abstract"]);
    expect(groups.map((g) => g.running)).toEqual([false, false, true]);
  });

  it("starts a new segment whenever the phase changes, so a reconsider loop shows twice", () => {
    const groups = groupPhases(run({ timings: LOOP, result: RESULT }));
    expect(groups.map((g) => g.phase)).toEqual(["understand", "analyse", "present", "understand", "analyse", "present"]);
    // The side state sits with the phase it was sent under.
    expect(groups[2]?.stages.map((s) => s.stage)).toEqual(["idiom", "validate", "reconsider"]);
    expect(groups[3]?.stages.map((s) => s.stage)).toEqual(["abstract", "bind"]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(6);
    expect(groups.map((g) => g.elapsedMs)).toEqual([1_505, 6, 2_263, 2_492, 13, 1_710]);
  });

  it("labels and sums each segment of a reconsider loop, with the SQL on the last analyse", () => {
    render(<StageTrace run={run({ timings: LOOP, result: RESULT })} />);
    expect(rows().map((r) => r.querySelector(".tx-trace__label")?.textContent)).toEqual([
      "Understood",
      "Analysed",
      "Presented",
      "Understood",
      "Analysed",
      "Presented",
    ]);
    expect(rows().map((r) => r.querySelector(".tx-trace__summary")?.textContent)).toEqual([
      "· 2 stages · 1.5 s",
      "· 1 stage · 6 ms",
      "· 3 stages · 2.3 s",
      "· 2 stages · 2.5 s",
      "· 2 stages · 13 ms · SQL · 1,234 rows",
      "· 2 stages · 1.7 s",
    ]);

    // Each segment unfolds on its own.
    fireEvent.click(rows()[3]!);
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "true", "false", "false"]);
    expect([...document.querySelectorAll(".tx-trace__name")].map((name) => name.textContent)).toEqual(["abstract", "bind"]);
    fireEvent.click(rows()[3]!);
    fireEvent.click(rows()[1]!);
    expect(document.querySelector(".tx-sql__code")).toBeNull();
    fireEvent.click(rows()[4]!);
    expect(document.querySelectorAll(".tx-sql__code")).toHaveLength(1);
  });

  it("turns one cube, on the second understand, while the loop is under way", () => {
    const looping = run({
      status: "running",
      phase: "understand",
      stage: "abstract",
      timings: [...LOOP.slice(0, 6), timing("understand", "abstract", null)],
    });
    render(<StageTrace run={looping} />);
    expect(rows().map((r) => r.querySelector(".tx-trace__label")?.textContent)).toEqual([
      "Understood",
      "Analysed",
      "Presented",
      "Understanding…",
    ]);
    const cubes = document.querySelectorAll(".tx-trace__mark svg");
    expect(cubes).toHaveLength(1);
    expect(rows()[3]?.contains(cubes[0]!)).toBe(true);
  });

  it("keeps the SQL on the finished analyse while the loop's next analyse runs", () => {
    const looping = run({
      status: "running",
      phase: "analyse",
      stage: "query",
      result: RESULT,
      timings: [...LOOP.slice(0, 9), timing("analyse", "query", null)],
    });
    render(<StageTrace run={looping} />);
    expect(rows().map((r) => r.querySelector(".tx-trace__summary")?.textContent)).toEqual([
      "· 2 stages · 1.5 s",
      "· 1 stage · 6 ms · SQL · 1,234 rows",
      "· 3 stages · 2.3 s",
      "· 2 stages · 2.5 s",
      "· 2 stages · 4 ms",
    ]);
    expect(rows()[4]?.querySelector(".tx-trace__label")?.textContent).toBe("Analysing…");
  });

  it("shows the result on the first pass's analyse while it is still under way", () => {
    const between = run({
      status: "running",
      phase: "analyse",
      stage: "query",
      result: RESULT,
      timings: [timing("understand", "situate", 295), timing("analyse", "query", 6)],
    });
    render(<StageTrace run={between} />);
    expect(rows().map((r) => r.querySelector(".tx-trace__summary")?.textContent)).toEqual([
      "· 1 stage · 0.3 s",
      "· 1 stage · 6 ms · SQL · 1,234 rows",
    ]);
  });

  it("shows nothing under way while a finished run is queued again", () => {
    // An answer to the card beside the chart, or a chart switch: the phase is still the one it ended in.
    const requeued = run({
      status: "queued",
      phase: "present",
      stage: "perceive",
      result: RESULT,
      timings: WORKING.timings.map((t) => (t.elapsed_ms === null ? { ...t, elapsed_ms: 410 } : t)),
    });
    const { rerender } = render(<StageTrace run={requeued} />);
    expect(rows().map((r) => r.querySelector(".tx-trace__label")?.textContent)).toEqual([
      "Understood",
      "Analysed",
      "Presented",
    ]);
    expect(document.querySelectorAll(".tx-trace__mark svg")).toHaveLength(0);

    // The answer applies at abstract: a new understand segment, the only one under way.
    rerender(
      <StageTrace
        run={{
          ...requeued,
          status: "running",
          phase: "understand",
          stage: "abstract",
          timings: [...requeued.timings, timing("understand", "abstract", null)],
        }}
      />,
    );
    expect(rows().map((r) => r.querySelector(".tx-trace__label")?.textContent)).toEqual([
      "Understood",
      "Analysed",
      "Presented",
      "Understanding…",
    ]);
    expect(document.querySelectorAll(".tx-trace__mark svg")).toHaveLength(1);
  });

  it("labels finished phases in the past and the running one as under way", () => {
    render(<StageTrace run={WORKING} />);
    expect(rows().map((r) => r.querySelector(".tx-trace__label")?.textContent)).toEqual([
      "Understood",
      "Analysed",
      "Presenting…",
    ]);
    expect(rows().every((r) => r.getAttribute("aria-expanded") === "false")).toBe(true);
  });

  it("sums each phase's stages and, for analyse, names the SQL and its rows", () => {
    render(<StageTrace run={WORKING} />);
    const summaries = rows().map((r) => r.querySelector(".tx-trace__summary")?.textContent);
    expect(summaries).toEqual([
      "· 3 stages · 1:37",
      "· 1 stage · 6 ms · SQL · 1,234 rows",
      "· 2 stages · 1.4 s",
    ]);
  });

  it("shows each stage's duration when a phase unfolds", () => {
    render(<StageTrace run={WORKING} />);
    const [understand] = rows();
    fireEvent.click(understand!);
    expect(understand!.getAttribute("aria-expanded")).toBe("true");
    const lines = [...document.querySelectorAll(".tx-trace__stage")].map((li) => [
      li.querySelector(".tx-trace__name")?.textContent,
      li.querySelector(".tx-trace__time")?.textContent,
    ]);
    expect(lines).toEqual([
      ["situate", "295 ms"],
      ["ground", "98 ms"],
      ["abstract", "1:37"],
    ]);
    fireEvent.click(understand!);
    expect(document.querySelector(".tx-trace__stage")).toBeNull();
  });

  it("puts the SQL and the rows inside analyse", () => {
    render(<StageTrace run={WORKING} />);
    fireEvent.click(rows()[1]!);
    expect(screen.getByText("query")).toBeTruthy();
    const sql = document.querySelector(".tx-sql__code")?.textContent ?? "";
    expect(sql).toContain("SELECT line, AVG(oee) AS oee");
    expect(document.querySelectorAll(".tx-sql__line").length).toBeGreaterThan(3); // laid out by clause
    expect(screen.getByText("Showing 2 of 1,234 rows")).toBeTruthy();
    expect(screen.getByText("0.8123")).toBeTruthy();
    expect(screen.getByText("–")).toBeTruthy();
  });

  it("marks the running phase with a live cube and the running stage with its gerund", () => {
    render(<StageTrace run={WORKING} />);
    const cubes = document.querySelectorAll(".tx-trace__mark svg");
    expect(cubes).toHaveLength(1);
    expect(rows()[2]?.contains(cubes[0]!)).toBe(true);
    fireEvent.click(rows()[2]!);
    expect(document.querySelector(".tx-trace__stage--running .tx-trace__name")?.textContent).toBe("perceive");
    expect(screen.getByText("Perceiving…")).toBeTruthy();
    expect(screen.getByText("1.4 s")).toBeTruthy();
  });

  it("keeps the same cube turning from one stage to the next", () => {
    const first = run({
      status: "running",
      phase: "understand",
      stage: "situate",
      timings: [timing("understand", "situate", null)],
    });
    const { rerender } = render(<StageTrace run={first} />);
    fireEvent.click(rows()[0]!);
    const cube = document.querySelector(".tx-trace__mark svg");
    expect(cube).not.toBeNull();

    // situate is done in 39 ms and abstract takes over: the cube must not restart from rest.
    rerender(
      <StageTrace
        run={{
          ...first,
          stage: "abstract",
          timings: [timing("understand", "situate", 39), timing("understand", "abstract", null)],
        }}
      />,
    );
    expect(document.querySelector(".tx-trace__mark svg")).toBe(cube);
    expect(document.querySelector(".tx-trace__stage--running .tx-trace__name")?.textContent).toBe("abstract");

    // Between two stages the phase is still under way, and so is its cube.
    rerender(
      <StageTrace
        run={{
          ...first,
          stage: null,
          timings: [timing("understand", "situate", 39), timing("understand", "abstract", 1_210)],
        }}
      />,
    );
    expect(document.querySelector(".tx-trace__mark svg")).toBe(cube);
  });

  it("keeps a phase under way between two of its stages", () => {
    const between = run({
      status: "running",
      phase: "understand",
      timings: [timing("understand", "situate", 295)],
    });
    render(<StageTrace run={between} />);
    expect(rows()[0]?.textContent).toContain("Understanding…");
  });

  it("speaks only in the past once the run has ended", () => {
    const done = run({
      timings: WORKING.timings.map((t) => (t.elapsed_ms === null ? { ...t, elapsed_ms: 29_427 } : t)),
      result: { ...RESULT, sql: null },
    });
    render(<StageTrace run={done} />);
    expect(rows().map((r) => r.querySelector(".tx-trace__label")?.textContent)).toEqual([
      "Understood",
      "Analysed",
      "Presented",
    ]);
    expect(rows()[1]?.textContent).not.toContain("SQL");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("colours the cube for a run that waits on a card", () => {
    const asking = run({
      status: "asking",
      phase: "understand",
      stage: "meaning",
      timings: [timing("understand", "situate", 295), timing("understand", "meaning", null)],
    });
    render(<StageTrace run={asking} />);
    expect(document.querySelector(".tx-trace__mark svg")?.classList.contains("cube--asking")).toBe(true);
  });

  it("renders nothing before the first stage", () => {
    const { container } = render(<StageTrace run={run({ status: "queued" })} />);
    expect(container.innerHTML).toBe("");
  });
});


describe("layoutSql", () => {
  const lines = (sql: string) => layoutSql(sql).split("\n");

  it("breaks a one-line query before each top-level clause", () => {
    expect(lines("SELECT a, SUM(b) FROM t WHERE c = 1 GROUP BY a ORDER BY 2 DESC LIMIT 10")).toEqual([
      "SELECT a, SUM(b)",
      "FROM t",
      "WHERE c = 1",
      "GROUP BY a",
      "ORDER BY 2 DESC",
      "LIMIT 10",
    ]);
  });

  it("still breaks before a clause that opens a bracket", () => {
    expect(lines("SELECT a FROM (SELECT b FROM t) AS s WHERE (a > 1 OR a < 0) ORDER BY a")).toEqual([
      "SELECT a",
      "FROM (SELECT b FROM t) AS s",
      "WHERE (a > 1 OR a < 0)",
      "ORDER BY a",
    ]);
    expect(lines('SELECT x FROM f GROUP BY "x" HAVING (COUNT(*) + COUNT(*)) > 0 ORDER BY x')).toEqual([
      "SELECT x",
      "FROM f",
      'GROUP BY "x"',
      "HAVING (COUNT(*) + COUNT(*)) > 0",
      "ORDER BY x",
    ]);
  });

  it("keeps joins whole and reads LEFT( and RIGHT( as functions", () => {
    const sql =
      "SELECT LEFT(name, 3), RIGHT(code, 2) FROM t LEFT OUTER JOIN u ON t.id = u.id JOIN (SELECT 1 AS id) v ON v.id = t.id";
    expect(lines(sql)).toEqual([
      "SELECT LEFT(name, 3), RIGHT(code, 2)",
      "FROM t",
      "LEFT OUTER JOIN u ON t.id = u.id",
      "JOIN (SELECT 1 AS id) v ON v.id = t.id",
    ]);
    const solid = tokenize("LEFT(name, 3) LEFT JOIN").filter((token) => token.kind !== "space");
    expect(solid.map((token) => `${token.kind}:${token.text}`)).toEqual([
      "function:LEFT",
      "plain:(",
      "plain:name",
      "plain:,",
      "number:3",
      "plain:)",
      "keyword:LEFT",
      "keyword:JOIN",
    ]);
  });

  it("leaves SQL that already has line breaks as its author laid it out", () => {
    expect(layoutSql("SELECT a\n  FROM t WHERE b")).toBe("SELECT a\n  FROM t WHERE b");
  });
});
