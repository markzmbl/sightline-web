import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ReactElement } from "react";
import embed from "vega-embed";
import { summaryOf } from "../src/api/queries";
import type {
  ChartView,
  Clarify,
  Column,
  Definition,
  FollowUp,
  Result,
  RunView,
  Support,
  Turn,
} from "../src/api/types";
import { ChartBlock } from "../src/components/thread/ChartBlock";
import { RowsBlock } from "../src/components/thread/RowsBlock";
import { Transcript, type TranscriptActions, type TranscriptProps } from "../src/components/thread/Transcript";

vi.mock("vega-embed", () => ({
  default: vi.fn(async () => ({ finalize() {}, view: {} })),
}));

afterEach(cleanup);

const CHART: ChartView = {
  chart: "horizontal_bar",
  label: "Ranked bars",
  title: "OEE by line",
  subtitle: ["22–28 Dec 2025"],
  hint: "The lines ranked by OEE",
  score: 0.82,
  min_width: null,
  spec: { mark: "bar", config: { background: "#FFFFFF" } },
  png_url: null,
  options: [
    { chart: "horizontal_bar", label: "Ranked bars", hint: "The lines ranked by OEE", drawn: true, score: 0.82 },
    { chart: "bar", label: "Columns", hint: "Upright bars, one per line", drawn: false, score: 0.71 },
    { chart: "point", label: "Dot plot", hint: null, drawn: false, score: 0.4 },
  ],
};

const smallChart = (mark: string, min_width: number | null = 260): ChartView => ({
  chart: mark,
  label: `small ${mark}`,
  title: null,
  subtitle: [],
  hint: null,
  score: null,
  min_width,
  spec: { mark, height: 160 },
  png_url: null,
  options: [],
});

const RESULT: Result = {
  sql: "SELECT 1",
  step_id: null,
  columns: [],
  rows: [],
  row_count: 0,
  truncated: false,
  chart: CHART,
  findings: [],
  notes: [],
  verdict: "pass",
  concerns: [],
  storyline: null,
  lead: null,
  supports: [],
};

const ASK: RunView["card"] = {
  blocking: true,
  points: [
    {
      id: "kpi",
      step: "meaning",
      question: "Which OEE do you mean?",
      options: [
        { id: "oee", label: "OEE as availability × performance × quality", hint: "" },
        { id: "teep", label: "TEEP, over all calendar time", hint: "" },
      ],
      chosen: null,
      default: "oee",
      by: "rules",
      confidence: null,
      entry_id: null,
      why: "",
      open: true,
      stage: "abstract",
    },
  ],
};

function run(id: string, revision: number, overrides: Partial<RunView> = {}): RunView {
  return {
    id,
    thread_id: "t1",
    revision,
    origin: revision === 0 ? "question" : "revision",
    follows: null,
    takes_back: null,
    prompt: revision === 0 ? "What was the OEE of each line last week?" : `revision ${revision}`,
    status: "complete",
    phase: null,
    stage: null,
    step: null,
    steps: [],
    locale: null,
    started_at: "2026-10-24T19:08:40Z",
    finished_at: "2026-10-24T19:10:47Z",
    restatement: `You want to see the OEE per line, take ${revision}.`,
    definitions: [],
    card: null,
    clarify: null,
    result: { ...RESULT },
    follow_ups: [],
    timings: [],
    error: null,
    feedback: null,
    last_event_id: 9,
    ...overrides,
  };
}

/** Turns as the live thread gives them: every earlier run folded (run null) unless given in full. */
function turns(runs: RunView[], full: readonly string[] = []): Turn[] {
  return runs.map((r, index) => ({
    summary: summaryOf(r),
    run: index === runs.length - 1 || full.includes(r.id) ? r : null,
  }));
}

const NO_CLARIFY: Clarify = { gaps: [], missing: [], record: [], warnings: [], warnings_total: 0 };

const NEAREST: FollowUp[] = [
  { id: "nq1", kind: "nearest", question: "What was the scrap rate of each line last week?" },
  { id: "nq2", kind: "nearest", question: "How many parts did each line scrap last week?" },
];

/** A run that ended because the warehouse cannot answer its question yet. */
function notYet(id: string, revision: number, warnings: string[] = []): RunView {
  return run(id, revision, {
    status: "clarify",
    result: null,
    follow_ups: NEAREST,
    clarify: {
      ...NO_CLARIFY,
      missing: ["scrap cost per part"],
      record: ["the cost of each scrapped part, per order"],
      warnings,
      warnings_total: warnings.length,
    },
  });
}

function actions(overrides: Partial<TranscriptActions> = {}): TranscriptActions {
  return { onAnswer: vi.fn(), onPickChart: vi.fn(), onFeedback: vi.fn(), ...overrides };
}

/** The transcript on the thread's page, where its relative links resolve. */
function at(props: Partial<TranscriptProps> & Pick<TranscriptProps, "turns">): ReactElement {
  const element = <Transcript busy={false} actions={actions()} onExpand={vi.fn()} {...props} />;
  return (
    <MemoryRouter initialEntries={["/w/ws1/t/t1"]}>
      <Routes>
        <Route path="/w/:ws/t/:threadId" element={element} />
      </Routes>
    </MemoryRouter>
  );
}

const folds = () => screen.queryAllByRole("button").filter((b) => b.classList.contains("tx-fold"));

describe("Transcript", () => {
  it("folds earlier turns from their summaries and shows the latest in full", () => {
    const runs = [run("r0", 0), run("r1", 1), run("r2", 2)];
    const onExpand = vi.fn();
    const { rerender } = render(at({ turns: turns(runs), onExpand }));

    expect(folds().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(folds()[0]?.textContent).toContain("take 0");
    expect(folds()[0]?.textContent).toContain("Ranked bars");
    // Only the latest run has its footer.
    expect(screen.getAllByRole("button", { name: "Good answer" })).toHaveLength(1);
    expect(screen.getByText("You want to see the OEE per line, take 2.")).toBeTruthy();

    // Unfolding asks for the run in full, and says it is on its way until it is there.
    fireEvent.click(folds()[0]!);
    expect(onExpand).toHaveBeenCalledWith("r0");
    expect(screen.getByText("Loading this answer…")).toBeTruthy();
    const fold = screen.getByRole("button", { name: "Fold this answer" });
    expect(document.activeElement).toBe(fold);
    expect(screen.getAllByRole("button", { name: "Good answer" })).toHaveLength(1);

    rerender(at({ turns: turns(runs, ["r0"]), onExpand }));
    expect(screen.queryByText("Loading this answer…")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Good answer" })).toHaveLength(2);
    // The same toggle stays, and so does focus on it.
    expect(screen.getByRole("button", { name: "Fold this answer" })).toBe(fold);
    expect(document.activeElement).toBe(fold);

    fireEvent.click(fold);
    expect(folds()).toHaveLength(2);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("says the answer's top on a folded turn, before what sightline understood", () => {
    const answered = run("r0", 0, {
      result: { ...RESULT, storyline: { top: "Augsburg moulding 1 led the lines", key_line: [] }, lead: "sp1" },
    });
    const bare = run("r1", 1, { restatement: null, result: null, status: "failed" });
    render(at({ turns: turns([answered, bare, run("r2", 2)]) }));
    expect(folds()[0]?.querySelector(".tx-fold__text")?.textContent).toBe("Augsburg moulding 1 led the lines");
    expect(folds()[1]?.querySelector(".tx-fold__text")?.textContent).toBe("revision 1");
    expect(folds()[1]?.querySelector(".tx-fold__status")?.textContent).toBe("Failed");
  });

  it("shows the prompt as a user turn, labelled by where it came from", () => {
    const follow = run("r2", 2, {
      origin: "follow_up",
      prompt: "What was the OEE of each machine on Augsburg moulding 1 last week?",
      follows: { run_id: "r1", follow_up_id: "fu2", kind: "next_level" },
    });
    const instead = run("r3", 3, { origin: "nearest", prompt: "What is the revenue per branch?" });
    const takeBack = run("r4", 4, { origin: "take_back", takes_back: 3, prompt: "What is the revenue per branch?" });
    render(at({ turns: turns([run("r0", 0), run("r1", 1), follow, instead, takeBack]) }));

    const eyebrows = [...document.querySelectorAll(".tx-user .eyebrow")].map((e) => e.textContent);
    expect(eyebrows).toEqual(["Revision 1", "Follow-up · One level down", "Instead", "Took back revision 3"]);
    expect(screen.getByText("What was the OEE of each line last week?")).toBeTruthy();
    expect(screen.queryByText("Revision 0")).toBeNull();
    // A take-back's prompt is the text it took back: muted.
    const bubbles = [...document.querySelectorAll(".tx-user__bubble")];
    expect(bubbles.map((b) => b.classList.contains("tx-user__bubble--taken"))).toEqual([false, false, false, false, true]);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toContain("Revision 4");
  });

  it("names a follow-up of each kind by its own word", () => {
    const kinds = ["breakdown", "check", "nearest"] as const;
    const runs = [
      run("r0", 0),
      ...kinds.map((kind, i) =>
        run(`r${i + 1}`, i + 1, { origin: "follow_up", follows: { run_id: `r${i}`, follow_up_id: "f", kind } }),
      ),
    ];
    render(at({ turns: turns(runs) }));
    const eyebrows = [...document.querySelectorAll(".tx-user .eyebrow")].map((e) => e.textContent);
    expect(eyebrows).toEqual(["Follow-up · Break down", "Follow-up · Check", "Follow-up · Instead"]);
  });

  it("offers Take back on the latest revision only, and only when the action exists", () => {
    const onTakeBack = vi.fn();
    const runs = [run("r0", 0), run("r1", 1), run("r2", 2)];
    const { rerender } = render(at({ turns: turns(runs), actions: actions({ onTakeBack }) }));
    const takeBack = screen.getAllByRole("button", { name: "Take back" });
    expect(takeBack).toHaveLength(1);
    fireEvent.click(takeBack[0]!);
    expect(onTakeBack).toHaveBeenCalledWith(2);

    rerender(at({ turns: turns(runs) }));
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();

    rerender(at({ turns: turns([run("r0", 0)]), actions: actions({ onTakeBack }) }));
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();
  });

  it("says when a run failed, and where, keeping the technical detail folded", () => {
    const failed = run("r0", 0, {
      status: "failed",
      result: null,
      error: {
        code: "warehouse_unavailable",
        message: "The warehouse did not answer in time.",
        detail: "Binder Error: column oee not found",
        stage: "query",
        retryable: true,
      },
    });
    render(at({ turns: turns([failed]) }));
    expect(screen.getByText("The warehouse did not answer in time.")).toBeTruthy();
    expect(document.querySelector(".tx-error__title")?.textContent).toBe("The run failed at query.");
    expect(screen.getByText("Asking again may work.")).toBeTruthy();
    const details = document.querySelector(".tx-error details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Binder Error: column oee not found");
    expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull();
  });

  it("does not promise a retry that would not help, nor show details it does not have", () => {
    const failed = run("r0", 0, {
      status: "failed",
      result: null,
      error: { code: "internal", message: "Something went wrong.", detail: null, stage: null, retryable: false },
    });
    render(at({ turns: turns([failed]) }));
    expect(document.querySelector(".tx-error__title")?.textContent).toBe("The run failed.");
    expect(screen.queryByText("Asking again may work.")).toBeNull();
    expect(document.querySelector(".tx-error details")).toBeNull();
  });

  it("says when a run was stopped", () => {
    const stopped = run("r0", 0, { status: "cancelled", result: null });
    render(at({ turns: turns([stopped]) }));
    expect(screen.getByText("Stopped.")).toBeTruthy();
  });

  it("folds a run a newer revision replaced, and offers nothing on it", () => {
    const point = ASK!.points[0]!;
    const replaced = run("r0", 0, {
      status: "superseded",
      result: null,
      card: { blocking: false, points: [{ ...point, chosen: "oee", open: false }] },
      timings: [{ phase: "understand", stage: "situate", started_at: "2026-10-24T19:08:40Z", elapsed_ms: 295 }],
    });
    const revising = run("r1", 1, { status: "running", restatement: null, result: null });
    render(at({ turns: turns([replaced, revising], ["r0"]) }));

    expect(folds()).toHaveLength(1);
    const status = folds()[0]!.querySelector(".tx-fold__status");
    expect(status?.textContent).toBe("Replaced");
    expect(status?.classList.contains("tx-fold__status--superseded")).toBe(true);

    fireEvent.click(folds()[0]!);
    expect(screen.getByText("Replaced by the next revision.").className).toBe("tx-stopped");
    expect(screen.queryByText("Stopped.")).toBeNull();
    expect(screen.queryByText("Choices sightline made")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull();
    // Its trace stays, as a record of how far it got.
    expect(document.querySelector(".tx-trace__row")).not.toBeNull();
  });

  it("drops a replaced run's blocking card, record and all", () => {
    const replaced = run("r0", 0, { status: "superseded", result: null, card: ASK });
    render(at({ turns: turns([replaced, run("r1", 1)], ["r0"]) }));
    fireEvent.click(folds()[0]!);
    expect(screen.queryByText("sightline needs a choice")).toBeNull();
    expect(screen.queryByRole("region", { name: "sightline asked" })).toBeNull();
    expect(screen.queryByRole("button", { name: /TEEP/ })).toBeNull();
  });

  it("says Stopped, not Replaced, on a folded cancelled run", () => {
    const stopped = run("r0", 0, { status: "cancelled", result: null });
    render(at({ turns: turns([stopped, run("r1", 1)]) }));
    expect(folds()[0]?.querySelector(".tx-fold__status")?.textContent).toBe("Stopped");
  });

  it("keeps a replaced chart in the record, without its switcher", async () => {
    vi.mocked(embed).mockClear();
    const replaced = run("r0", 0, { status: "superseded" });
    replaced.result = { ...RESULT, chart: { ...CHART, spec: { mark: "point" } } };
    render(at({ turns: turns([replaced, run("r1", 1)], ["r0"]) }));
    expect(folds()[0]?.textContent).toContain("Ranked bars");
    fireEvent.click(folds()[0]!);

    // The replaced run draws its own chart, beside the latest one.
    const question = screen.getByRole("region", { name: "The question" });
    expect(question.querySelector(".tx-chart")).not.toBeNull();
    expect(document.querySelectorAll(".tx-chart")).toHaveLength(2);
    await vi.waitFor(() =>
      expect(vi.mocked(embed).mock.calls.map(([, spec]) => (spec as { mark?: string }).mark).sort()).toEqual([
        "bar",
        "point",
      ]),
    );
    // Only the latest run offers the other charts.
    expect(within(question).queryByRole("group", { name: "Show it as" })).toBeNull();
    expect(screen.getAllByRole("group", { name: "Show it as" })).toHaveLength(1);
  });

  it("says it is working out the question before the restatement arrives", () => {
    const working = run("r0", 0, { status: "running", restatement: null, result: null });
    render(at({ turns: turns([working]) }));
    expect(screen.getByText("Working out what you mean…")).toBeTruthy();
  });

  it("wires the chart switcher and the feedback to the run", () => {
    const acts = actions();
    render(at({ turns: turns([run("r0", 0), run("r1", 1, { feedback: "down" })]), actions: acts }));

    const group = screen.getByRole("group", { name: "Show it as" });
    // Every option in the server's order, the drawn one pressed.
    expect(within(group).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Ranked bars", "true"],
      ["Columns", "false"],
      ["Dot plot", "false"],
    ]);
    fireEvent.click(within(group).getByRole("button", { name: "Ranked bars" }));
    expect(acts.onPickChart).not.toHaveBeenCalled();
    const columns = within(group).getByRole("button", { name: "Columns" });
    expect(columns.getAttribute("title")).toBe("Upright bars, one per line");
    fireEvent.click(columns);
    expect(acts.onPickChart).toHaveBeenCalledWith("r1", "bar");

    expect(screen.getByRole("button", { name: "Bad answer" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Good answer" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Good answer" }));
    expect(acts.onFeedback).toHaveBeenCalledWith("r1", "up");
  });

  it("offers no switcher for a chart with no other option", () => {
    const only = run("r0", 0, { result: { ...RESULT, chart: { ...CHART, options: [CHART.options[0]!] } } });
    render(at({ turns: turns([only]) }));
    expect(screen.queryByRole("group", { name: "Show it as" })).toBeNull();
  });

  it("offers neither the switcher nor a change of choice on an earlier run, which the server would refuse", () => {
    const acts = actions();
    const point = ASK!.points[0]!;
    const card: RunView["card"] = { blocking: false, points: [{ ...point, chosen: "oee", open: true, by: "s1" }] };
    render(at({ turns: turns([run("r0", 0, { card }), run("r1", 1, { card })], ["r0"]), actions: acts }));
    fireEvent.click(folds()[0]!);

    const [earlier, latest] = screen.getAllByRole("region", { name: /^(The question|Revision 1)$/ });
    expect(within(earlier!).queryByRole("group", { name: "Show it as" })).toBeNull();
    expect(within(earlier!).queryByRole("button", { name: "Change" })).toBeNull();
    // The earlier run's choices stand as they were made, its feedback still welcome.
    const made = within(earlier!).getByRole("region", { name: "Choices sightline made" });
    expect(made.textContent).toContain("OEE as availability × performance × quality");
    expect(made.textContent).toContain("sightline's pick");
    expect(made.textContent).not.toContain("not answered");
    expect(within(earlier!).getByRole("button", { name: "Good answer" })).toBeTruthy();

    expect(within(latest!).getByRole("group", { name: "Show it as" })).toBeTruthy();
    fireEvent.click(within(latest!).getByRole("button", { name: "Change" }));
    fireEvent.click(within(latest!).getByRole("button", { name: "TEEP, over all calendar time" }));
    expect(acts.onAnswer).toHaveBeenCalledWith("r1", { kpi: "teep" }, null);
    expect(acts.onPickChart).not.toHaveBeenCalled();
  });

  it("disables the switcher while busy", () => {
    render(at({ turns: turns([run("r0", 0)]), busy: true }));
    expect((screen.getByRole("button", { name: "Dot plot" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("answers a blocking card for its run", () => {
    const acts = actions();
    const asking = run("r0", 0, { status: "asking", result: null, card: ASK });
    render(at({ turns: turns([asking]), actions: acts }));
    fireEvent.click(screen.getByRole("button", { name: /TEEP/ }));
    expect(acts.onAnswer).toHaveBeenCalledWith("r0", { kpi: "teep" }, null);
  });

  it("keeps a blocking card only as a record once a revision stopped its run", () => {
    const acts = actions();
    const stopped = run("r0", 0, { status: "cancelled", result: null, card: ASK });
    const revising = run("r1", 1, { status: "running", restatement: null, result: null });
    render(at({ turns: turns([stopped, revising], ["r0"]), actions: acts }));

    fireEvent.click(folds()[0]!);
    expect(screen.queryByText("sightline needs a choice")).toBeNull();
    expect(screen.getByRole("region", { name: "sightline asked" }).textContent).toContain("Which OEE do you mean?");
    expect(screen.queryByRole("button", { name: /TEEP/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decide for me" })).toBeNull();
    expect(screen.getByText("Stopped.")).toBeTruthy();
    expect(acts.onAnswer).not.toHaveBeenCalled();
    // Focus follows the fold toggle instead of falling into the run.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fold this answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Fold this answer" }));
    expect(document.activeElement).toBe(folds()[0]);
  });

  it("does not offer a failed run's card either", () => {
    const failed = run("r0", 0, {
      status: "failed",
      result: null,
      card: ASK,
      error: { code: "timeout", message: "The planner timed out", detail: null, stage: "meaning", retryable: true },
    });
    render(at({ turns: turns([failed]) }));
    expect(screen.queryByText("sightline needs a choice")).toBeNull();
    expect(screen.getByText("not answered")).toBeTruthy();
    expect(screen.getByText("The planner timed out")).toBeTruthy();
  });

  it.each(["cancelled", "failed", "clarify"] as const)(
    "keeps the card of a %s run as a record, with nothing to change",
    (status) => {
      const acts = actions();
      // As a stopped asking run leaves it: no longer blocking, its point still open and unanswered.
      const ended = run("r0", 0, { status, result: null, card: { blocking: false, points: ASK!.points } });
      render(at({ turns: turns([ended]), actions: acts }));
      expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
      expect(screen.queryByText("sightline needs a choice")).toBeNull();
      const record = screen.getByRole("region", { name: "sightline asked" });
      expect(record.textContent).toContain("Which OEE do you mean?");
      expect(record.textContent).toContain("not answered");
      expect(record.querySelectorAll("button")).toHaveLength(0);
      expect(acts.onAnswer).not.toHaveBeenCalled();
    },
  );

  it("keeps the choices a stopped run made, unchangeable", () => {
    const point = ASK!.points[0]!;
    const stopped = run("r0", 0, {
      status: "cancelled",
      card: { blocking: false, points: [{ ...point, chosen: "oee", open: false }] },
    });
    render(at({ turns: turns([stopped]) }));
    const record = screen.getByRole("region", { name: "Choices sightline made" });
    expect(record.textContent).toContain("OEE as availability × performance × quality");
    expect(record.textContent).toContain("sightline's pick");
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("lets a complete run's choices be changed, and holds them while it works on the change", () => {
    const acts = actions();
    const point = ASK!.points[0]!;
    const card: RunView["card"] = { blocking: false, points: [{ ...point, chosen: "oee", open: false }] };
    const { rerender } = render(at({ turns: turns([run("r0", 0, { card })]), actions: acts }));
    const change = screen.getByRole("button", { name: "Change" }) as HTMLButtonElement;
    expect(change.disabled).toBe(false);
    fireEvent.click(change);
    fireEvent.click(screen.getByRole("button", { name: "TEEP, over all calendar time" }));
    expect(acts.onAnswer).toHaveBeenCalledWith("r0", { kpi: "teep" }, null);

    rerender(at({ turns: turns([run("r0", 0, { status: "running", card })]), actions: acts }));
    expect((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("holds a blocking card while its run works on the answer", () => {
    const acts = actions();
    const resumed = run("r0", 0, { status: "running", result: null, card: ASK });
    render(at({ turns: turns([resumed]), actions: acts }));
    expect(screen.getByText("sightline needs a choice")).toBeTruthy();
    const teep = screen.getByRole("button", { name: /TEEP/ }) as HTMLButtonElement;
    expect(teep.disabled).toBe(true);
    fireEvent.click(teep);
    expect(acts.onAnswer).not.toHaveBeenCalled();
  });

  it("tags a choice an approved default settled as the key user's, linking to its entry", () => {
    const point = ASK!.points[0]!;
    const card: RunView["card"] = {
      blocking: false,
      points: [
        { ...point, chosen: "oee", open: false, by: "default", entry_id: "default-oee", why: "'OEE' means the ISO one" },
      ],
    };
    render(at({ turns: turns([run("r0", 0, { card })]) }));
    const tag = screen.getByRole("link", { name: "your key user's default" });
    expect(tag.getAttribute("href")).toBe("/w/ws1/review/default-oee");
    expect(screen.getByText("'OEE' means the ISO one")).toBeTruthy();
  });
});

describe("Transcript, definitions", () => {
  const OEE: Definition = {
    name: "oee",
    label: "OEE",
    definition: "availability times effectiveness times quality ratio",
    entry_id: "measure-oee",
    source: { kind: "library", text: "from sightline's KPI library (ISO 22400-2)" },
    status: "proposed",
  };
  const lines = () => [...document.querySelectorAll(".tx-defs__line")].map((line) => line.textContent);

  it("says each definition under the restatement, in the agreed wording", () => {
    const definitions: Definition[] = [
      OEE,
      { ...OEE, name: "scrap_rate", label: "Scrap rate", entry_id: "measure-scrap", status: "approved" },
      {
        ...OEE,
        name: "churn_rate",
        label: "Churn rate",
        definition: null,
        entry_id: null,
        source: { kind: "drafted", text: "drafted by sightline" },
      },
      {
        ...OEE,
        name: "rework_share",
        label: "Rework share",
        entry_id: null,
        source: { kind: "question", text: "as the question states it" },
      },
    ];
    render(at({ turns: turns([run("r0", 0, { definitions })]) }));
    expect(lines()).toEqual([
      "OEE: proposed definition from sightline's KPI library (ISO 22400-2), not yet approved",
      "Scrap rate: approved by your key user (from sightline's KPI library, ISO 22400-2)",
      "Churn rate: proposed definition drafted by sightline, not yet approved",
      "Rework share: as your question defines it, not yet approved",
    ]);
    // The definition in words, where there is one: the restatement never carries it.
    expect([...document.querySelectorAll(".tx-defs__text")]).toHaveLength(3);
    const restatement = screen.getByText("You want to see the OEE per line, take 0.");
    const list = screen.getByRole("list", { name: "Definitions" });
    expect(restatement.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links a registry entry to its review, and an unlisted one nowhere", () => {
    const drafted: Definition = { ...OEE, label: "Churn rate", entry_id: null };
    render(at({ turns: turns([run("r0", 0, { definitions: [OEE, drafted] })]) }));
    expect(screen.getByRole("link", { name: "OEE" }).getAttribute("href")).toBe("/w/ws1/review/measure-oee");
    expect(screen.queryByRole("link", { name: "Churn rate" })).toBeNull();
  });

  it("says no definitions when the run used none", () => {
    render(at({ turns: turns([run("r0", 0)]) }));
    expect(screen.queryByRole("list", { name: "Definitions" })).toBeNull();
  });
});

describe("Transcript, the answer", () => {
  const SUPPORTS: Support[] = [
    { id: "sp1", role: "answer", point: "k1", text: "Each line's OEE", drawn: "main", chart: null, layer: "answer", note: null },
    {
      id: "sp2",
      role: "comparison",
      point: "k3",
      text: "Each line against the average",
      drawn: "small",
      chart: smallChart("bar", 300),
      layer: null,
      note: null,
    },
    {
      id: "sp3",
      role: "reference",
      point: "k3",
      text: "The spread of the lines",
      drawn: "small",
      chart: smallChart("tick", 240),
      layer: null,
      note: null,
    },
    { id: "sp4", role: "context", point: null, text: "Three lines were above the average", drawn: "none", chart: null, layer: null, note: null },
    {
      id: "sp5",
      role: "whole",
      point: null,
      text: "All plants together",
      drawn: "small",
      chart: smallChart("area", null),
      layer: null,
      note: null,
    },
    {
      id: "sp6",
      role: "exception",
      point: "k2",
      text: "Brno welding per shift",
      drawn: "dropped",
      chart: null,
      layer: null,
      note: "Left out: too few shifts to draw",
    },
  ];
  const STORY: Result = {
    ...RESULT,
    chart: {
      ...CHART,
      spec: {
        mark: "bar",
        title: { text: "Augsburg moulding 1 led the lines on OEE", subtitle: ["22–28 Dec 2025", "Lines with output"] },
        config: { title: { fontSize: 16, subtitleFontSize: 12.5, subtitleColor: "#5F6368", subtitlePadding: 6 } },
      },
    },
    storyline: {
      top: "Augsburg moulding 1 led the lines on OEE",
      key_line: [
        { id: "k1", text: "Augsburg moulding 1 reached 79.7%" },
        { id: "k2", text: "Brno welding came last at 71.2%" },
        { id: "k3", text: "Six of the nine lines sat near the average" },
      ],
    },
    lead: "sp1",
    supports: SUPPORTS,
    notes: ["The average is the plain mean of the nine lines"],
  };

  it("says the top once, as the answer's heading, and draws the main chart without the title it repeats", async () => {
    vi.mocked(embed).mockClear();
    render(at({ turns: turns([run("r0", 0, { result: STORY })]) }));
    expect(screen.getByRole("heading", { name: "Augsburg moulding 1 led the lines on OEE" })).toBeTruthy();
    expect(screen.getAllByText("Augsburg moulding 1 led the lines on OEE")).toHaveLength(1);

    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(4));
    const main = vi.mocked(embed).mock.calls.map(([, spec]) => spec as Record<string, unknown>).find((s) => s.title);
    // The bases stay on the paper, in the subtitle's type, as the title's only text.
    expect(main?.title).toEqual({ text: ["22–28 Dec 2025", "Lines with output"], fontSize: 12.5, fontWeight: "normal", color: "#5F6368" });
  });

  it("follows each key point with its small charts, captioned, and the loose supports after the key line", () => {
    render(at({ turns: turns([run("r0", 0, { result: STORY })]) }));
    const points = [...document.querySelectorAll(".tx-keyline__point")];
    expect(points.map((p) => p.querySelector(".tx-keyline__text")?.textContent)).toEqual([
      "Augsburg moulding 1 reached 79.7%",
      "Brno welding came last at 71.2%",
      "Six of the nine lines sat near the average",
    ]);
    // The lead is the main chart: its point gets no small chart of its own.
    expect(points[0]?.querySelector(".tx-small")).toBeNull();
    // A dropped chart says why it was left out, quietly.
    expect(points[1]?.querySelector(".tx-dropped")?.textContent).toBe("Left out: too few shifts to draw");
    const grid = points[2]?.querySelector<HTMLElement>(".tx-smalls");
    expect([...grid!.querySelectorAll("figcaption")].map((c) => c.textContent)).toEqual([
      "Each line against the average",
      "The spread of the lines",
    ]);
    // The widest minimum of the row sets the grid's.
    expect(grid?.style.getPropertyValue("--tx-small-min")).toBe("300px");

    const loose = document.querySelector(".tx-answer > .tx-smalls") as HTMLElement;
    expect([...loose.querySelectorAll("figcaption")].map((c) => c.textContent)).toEqual(["All plants together"]);
    expect(loose.style.getPropertyValue("--tx-small-min")).toBe("260px");
    // A support with no chart adds nothing.
    expect(screen.queryByText("Three lines were above the average")).toBeNull();
    expect(document.querySelectorAll(".tx-chart--small")).toHaveLength(3);
    // Findings belong to an answer without a storyline only.
    expect(document.querySelector(".tx-findings")).toBeNull();
  });

  it("keeps the key line when the chart is missing, as after a run that failed past gather", () => {
    const failed = run("r0", 0, {
      status: "failed",
      result: { ...STORY, chart: null },
      error: { code: "internal", message: "Rendering failed.", detail: null, stage: "render", retryable: false },
    });
    render(at({ turns: turns([failed]) }));
    expect(screen.getByRole("heading", { name: "Augsburg moulding 1 led the lines on OEE" })).toBeTruthy();
    expect(document.querySelectorAll(".tx-keyline__point")).toHaveLength(3);
    expect(document.querySelector(".tx-chart:not(.tx-chart--small)")).toBeNull();
    expect(screen.getByText("Rendering failed.")).toBeTruthy();
  });

  it("draws the chart with its own title and lists the findings without a storyline", async () => {
    vi.mocked(embed).mockClear();
    const titled: ChartView = { ...CHART, spec: { mark: "bar", title: { text: "OEE by line", subtitle: ["last week"] } } };
    render(at({ turns: turns([run("r0", 0, { result: { ...RESULT, chart: titled, findings: ["L1 leads"] } })]) }));
    expect(screen.queryByRole("heading", { name: "OEE by line" })).toBeNull();
    expect(screen.getByText("L1 leads").closest("ul")?.className).toBe("tx-findings");
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(vi.mocked(embed).mock.lastCall?.[1]).toMatchObject({ title: { text: "OEE by line", subtitle: ["last week"] } });
  });

  it("lists every caveat as notes, outside the chart, on any run", () => {
    const notes = ["Rows without a line were left out", "December is incomplete and left out"];
    render(at({ turns: turns([run("r0", 0, { result: { ...RESULT, notes } }), run("r1", 1, { result: STORY })], ["r0"]) }));
    const lists = screen.getAllByRole("region", { name: "Notes" });
    expect(lists).toHaveLength(1);
    fireEvent.click(folds()[0]!);
    const all = screen.getAllByRole("region", { name: "Notes" });
    expect(all.map((n) => [...n.querySelectorAll("li")].map((li) => li.textContent))).toEqual([
      notes,
      ["The average is the plain mean of the nine lines"],
    ]);
    for (const n of all) expect(n.closest(".tx-chart")).toBeNull();
  });

  it("says quietly when sightline is not sure the answer fits, with its concerns", () => {
    const unsure = { ...RESULT, verdict: "warn" as const, concerns: ["The chart may not answer the question"] };
    const { rerender } = render(at({ turns: turns([run("r0", 0, { result: unsure })]) }));
    const note = screen.getByRole("note", { name: "sightline is not sure this answers the question" });
    expect(note.textContent).toContain("The chart may not answer the question");

    rerender(at({ turns: turns([run("r0", 0)]) }));
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("Transcript, follow-ups", () => {
  const FOLLOW_UPS: FollowUp[] = [
    { id: "fu1", kind: "breakdown", question: "How did availability develop per week in Q4 2025?" },
    { id: "fu2", kind: "next_level", question: "What was the OEE of each machine on Augsburg moulding 1 last week?" },
    { id: "fu3", kind: "check", question: "Did the lead hold over the last four weeks?" },
  ];

  it("offers the latest complete run's follow-ups as chips, tagged by kind", () => {
    const onFollowUp = vi.fn();
    const latest = run("r0", 0, { follow_ups: [...FOLLOW_UPS, { id: "fu4", kind: "nearest", question: "What about scrap?" }] });
    render(at({ turns: turns([latest]), actions: actions({ onFollowUp }) }));
    const next = screen.getByRole("list", { name: "Follow-ups" });
    const chips = within(next).getAllByRole("button");
    expect(chips.map((chip) => chip.querySelector(".tx-follow__kind")?.textContent)).toEqual([
      "Break down",
      "One level down",
      "Check",
      "Instead",
    ]);
    const chip = screen.getByRole("button", { name: `One level down: ${FOLLOW_UPS[1]!.question}` });
    fireEvent.click(chip);
    expect(onFollowUp).toHaveBeenCalledWith(latest, FOLLOW_UPS[1]);
  });

  it("holds the chips while a mutation is out, and while the run presents again", () => {
    const onFollowUp = vi.fn();
    const { rerender } = render(
      at({ turns: turns([run("r0", 0, { follow_ups: FOLLOW_UPS })]), busy: true, actions: actions({ onFollowUp }) }),
    );
    const chips = () => within(screen.getByRole("list", { name: "Follow-ups" })).getAllByRole("button") as HTMLButtonElement[];
    expect(chips().every((chip) => chip.disabled)).toBe(true);
    fireEvent.click(chips()[0]!);
    expect(onFollowUp).not.toHaveBeenCalled();

    rerender(at({ turns: turns([run("r0", 0, { status: "running", follow_ups: FOLLOW_UPS })]), actions: actions({ onFollowUp }) }));
    expect(chips().every((chip) => chip.disabled)).toBe(true);
  });

  it("lists an earlier run's follow-ups as plain text", () => {
    const onFollowUp = vi.fn();
    render(
      at({
        turns: turns([run("r0", 0, { follow_ups: FOLLOW_UPS }), run("r1", 1)], ["r0"]),
        actions: actions({ onFollowUp }),
      }),
    );
    fireEvent.click(folds()[0]!);
    const list = screen.getByRole("list", { name: "Follow-ups" });
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(list.textContent).toContain(FOLLOW_UPS[0]!.question);
    expect(list.textContent).toContain("Break down");
  });

  it("offers nothing to send from a failed run", () => {
    const failed = run("r0", 0, {
      status: "failed",
      follow_ups: FOLLOW_UPS,
      error: { code: "internal", message: "Something went wrong.", detail: null, stage: null, retryable: false },
    });
    render(at({ turns: turns([failed]), actions: actions({ onFollowUp: vi.fn() }) }));
    expect(within(screen.getByRole("list", { name: "Follow-ups" })).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("Transcript, clarify", () => {
  it("names the terms it could not match, each suggestion asking again with it", () => {
    const onRevise = vi.fn();
    const unclear = run("r0", 0, {
      status: "clarify",
      result: null,
      clarify: {
        ...NO_CLARIFY,
        gaps: [
          {
            slot: "measure",
            requested: "scrap",
            reason: "no measure by that name",
            suggestions: [
              { id: "scrap_rate", label: "scrap rate", question: "What was the scrap rate of each line last week?" },
              {
                id: "mart_quality_month.rework_count",
                label: "mart_quality_month.rework_count",
                question: "What was the rework count of each line last week?",
              },
            ],
          },
        ],
      },
    });
    render(at({ turns: turns([unclear]), actions: actions({ onRevise }) }));
    expect(screen.getByText("I could not match every term in your question to the data.")).toBeTruthy();
    expect(screen.getByText("scrap").tagName).toBe("STRONG");
    const suggestion = screen.getByRole("button", { name: "scrap rate" });
    expect(suggestion.getAttribute("title")).toBe("What was the scrap rate of each line last week?");
    fireEvent.click(suggestion);
    expect(onRevise).toHaveBeenCalledWith("What was the scrap rate of each line last week?");
    // A long dotted name may wrap after its dot, so it never runs past a phone's column.
    const dotted = [...document.querySelectorAll(".tx-clarify .tx-chip")].find((chip) => chip.textContent?.includes("."));
    expect(dotted?.querySelector("wbr")).not.toBeNull();
    expect(screen.getByText("Pick one of these to ask again with it, or revise the question to say it another way.")).toBeTruthy();
    expect(screen.queryByText("This is not possible with the data yet.")).toBeNull();
    expect(document.querySelector(".tx-clarify details")).toBeNull();
  });

  it("shows a gap's suggestions as text where no revision can be sent", () => {
    const unclear = run("r0", 0, {
      status: "clarify",
      result: null,
      clarify: {
        ...NO_CLARIFY,
        gaps: [
          {
            slot: "measure",
            requested: "scrap",
            reason: "no measure by that name",
            suggestions: [{ id: "scrap_rate", label: "scrap rate", question: "What was the scrap rate?" }],
          },
        ],
      },
    });
    render(at({ turns: turns([unclear]) }));
    expect(screen.queryByRole("button", { name: "scrap rate" })).toBeNull();
    expect(screen.getByText("scrap rate").getAttribute("title")).toBe("What was the scrap rate?");
    expect(screen.getByText("Revise the question to name one of these, or something else.")).toBeTruthy();
  });

  it("says when the data cannot answer the question yet, and offers the nearest questions it can answer", () => {
    const onFollowUp = vi.fn();
    const clarified = notYet("r1", 1);
    render(at({ turns: turns([run("r0", 0), clarified]), actions: actions({ onFollowUp }) }));
    expect(screen.getByRole("heading", { name: "This is not possible with the data yet." })).toBeTruthy();
    expect(screen.getByRole("list", { name: "The data lacks:" }).textContent).toBe("scrap cost per part");
    expect(screen.getByRole("list", { name: "To answer it, someone would have to record:" }).textContent).toBe(
      "the cost of each scrapped part, per order",
    );
    // Not a proxy answer: there are no gaps, so no other measure is put forward in its place.
    expect(screen.queryByText("I could not match every term in your question to the data.")).toBeNull();

    const instead = screen.getByRole("list", { name: "Questions I can answer instead:" });
    const asks = [...instead.querySelectorAll("button")];
    expect(asks.map((b) => b.textContent)).toEqual(NEAREST.map((n) => n.question));
    fireEvent.click(screen.getByRole("button", { name: NEAREST[1]!.question }));
    expect(onFollowUp).toHaveBeenCalledWith(clarified, NEAREST[1]);
    // They are the run's follow-ups, said once, inside the note.
    expect(screen.queryByRole("list", { name: "Follow-ups" })).toBeNull();
  });

  it("shows the nearest questions as text where none can be sent", () => {
    render(at({ turns: turns([notYet("r0", 0)]) }));
    const instead = screen.getByRole("list", { name: "Questions I can answer instead:" });
    expect([...instead.querySelectorAll("li")].map((li) => li.textContent)).toEqual(NEAREST.map((n) => n.question));
    expect(instead.querySelector("button")).toBeNull();
  });

  it("holds the nearest questions while a mutation is out", () => {
    const onFollowUp = vi.fn();
    render(at({ turns: turns([notYet("r0", 0)]), busy: true, actions: actions({ onFollowUp }) }));
    const ask = screen.getByRole("button", { name: NEAREST[0]!.question }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.click(ask);
    expect(onFollowUp).not.toHaveBeenCalled();
  });

  it("offers the nearest questions on the latest run only", () => {
    const onFollowUp = vi.fn();
    render(at({ turns: turns([notYet("r0", 0), run("r1", 1)], ["r0"]), actions: actions({ onFollowUp }) }));
    fireEvent.click(folds()[0]!);
    expect(screen.getByRole("heading", { name: "This is not possible with the data yet." })).toBeTruthy();
    expect(screen.queryByRole("button", { name: NEAREST[0]!.question })).toBeNull();
    expect(screen.getByText(NEAREST[0]!.question)).toBeTruthy();
  });

  it("names the unmatched terms beside what the data lacks", () => {
    const both = run("r0", 0, {
      status: "clarify",
      result: null,
      clarify: {
        ...NO_CLARIFY,
        gaps: [{ slot: "measure", requested: "scrap cost", reason: "no measure by that name", suggestions: [] }],
        missing: ["scrap cost per part"],
      },
    });
    render(at({ turns: turns([both]), actions: actions({ onRevise: vi.fn() }) }));
    const heading = screen.getByRole("heading", { name: "This is not possible with the data yet." });
    const unmatched = screen.getByText("I could not match every term in your question to the data.");
    expect(screen.getByText("Revise the question to say it another way.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Questions I can answer instead:" })).toBeNull();
    // The unmatched terms come first, then what the data lacks.
    expect(unmatched.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("claims no unmatched terms for a clarify report that names none", () => {
    const bare = run("r0", 0, {
      status: "clarify",
      result: null,
      clarify: { ...NO_CLARIFY, warnings: ["The star has no cost facts before 2025."], warnings_total: 1 },
    });
    render(at({ turns: turns([bare]), actions: actions({ onRevise: vi.fn() }) }));
    expect(screen.getByText("This question needs a revision before sightline can answer it.")).toBeTruthy();
    expect(screen.queryByText("I could not match every term in your question to the data.")).toBeNull();
    expect(screen.queryByText("Revise the question to say it another way.")).toBeNull();
    expect(screen.queryByText("This is not possible with the data yet.")).toBeNull();
    expect(document.querySelector(".tx-clarify details")?.textContent).toContain("The star has no cost facts before 2025.");
  });

  it("keeps focus in the thread when a nearest question folds its run", () => {
    const onFollowUp = vi.fn();
    const clarified = notYet("r0", 0);
    const props = { actions: actions({ onFollowUp }) };
    const { rerender } = render(at({ turns: turns([clarified]), ...props }));
    const ask = screen.getByRole("button", { name: NEAREST[0]!.question });
    ask.focus();
    fireEvent.click(ask);
    expect(onFollowUp).toHaveBeenCalledWith(clarified, NEAREST[0]);

    // The revision is out, then its run arrives and the clarify run folds under it.
    rerender(at({ turns: turns([clarified]), busy: true, ...props }));
    const revising = run("r1", 1, { status: "queued", origin: "nearest", prompt: NEAREST[0]!.question, restatement: null, result: null });
    rerender(at({ turns: turns([clarified, revising]), ...props }));
    expect(folds()).toHaveLength(1);
    expect(document.activeElement).toBe(folds()[0]);
  });

  it("leaves focus be when the user had moved it off the run before it folded", () => {
    const clarified = notYet("r0", 0);
    const props = { actions: actions({ onFollowUp: vi.fn() }) };
    const { rerender } = render(at({ turns: turns([clarified]), ...props }));
    const ask = screen.getByRole("button", { name: NEAREST[0]!.question });
    ask.focus();
    ask.blur();
    const revising = run("r1", 1, { status: "queued", restatement: null, result: null });
    rerender(at({ turns: turns([clarified, revising]), ...props }));
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the clarify warnings in folded notes, saying how many more there were", () => {
    const warned = notYet("r0", 0, ["The star has no cost facts before 2025."]);
    warned.clarify = { ...warned.clarify!, warnings_total: 4 };
    render(at({ turns: turns([warned]) }));
    const notes = document.querySelector(".tx-clarify details") as HTMLDetailsElement;
    expect(notes.open).toBe(false);
    expect(notes.querySelector("summary")?.textContent).toBe("Notes");
    expect([...notes.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "The star has no cost facts before 2025.",
      "and 3 more",
    ]);
  });

  it("reads a clarify report that carries gaps only", () => {
    const old = run("r0", 0, {
      status: "clarify",
      result: null,
      clarify: { gaps: [{ slot: "measure", requested: "scrap", reason: "no measure", suggestions: [] }] } as unknown as Clarify,
    });
    render(at({ turns: turns([old]) }));
    expect(screen.getByText("I could not match every term in your question to the data.")).toBeTruthy();
    expect(screen.queryByText("This is not possible with the data yet.")).toBeNull();
  });
});

describe("RowsBlock", () => {
  const column = (name: string, extra: Partial<Column> = {}): Column => ({
    name,
    label: name,
    type: null,
    role: null,
    unit: null,
    format: null,
    description: null,
    ...extra,
  });

  it("heads each column with its label and unit, and formats measures by their specifier, right-aligned", () => {
    const columns = [
      column("line_name", { label: "line name", role: "dimension", description: "Production line" }),
      column("oee", { label: "OEE", role: "measure", unit: "%", format: ",.1f" }),
      column("energy", { label: "kWh per 1,000 good units", role: "measure", unit: "kWh", format: ",.0f" }),
      column("share", { label: "share", role: "measure", format: ".1%" }),
      column("revenue", { label: "revenue", role: "measure", unit: "EUR", format: "~s" }),
      column("code", { label: "code", role: "dimension" }),
    ];
    render(
      <RowsBlock
        result={{ columns, rows: [["Linz", 79.666, 1234.4, 0.4567, 1_500_000, 7]], row_count: 1, truncated: false }}
      />,
    );
    const heads = [...document.querySelectorAll("th")];
    expect(heads.map((th) => th.textContent)).toEqual([
      "line name",
      "OEE (%)",
      "kWh per 1,000 good units",
      "share",
      "revenue (EUR)",
      "code",
    ]);
    expect(heads[0]?.getAttribute("title")).toBe("Production line");
    const cells = [...document.querySelectorAll("td")];
    expect(cells.map((td) => td.textContent)).toEqual(["Linz", "79.7", "1,234", "45.7%", "1.5M", "7"]);
    expect(cells.map((td) => td.classList.contains("tx-rows__num"))).toEqual([false, true, true, true, true, false]);
  });
});

describe("ChartBlock", () => {
  it("embeds the spec as SVG, filling the column, and finalizes it on unmount", async () => {
    const finalize = vi.fn();
    vi.mocked(embed).mockResolvedValueOnce({ finalize, view: {} } as never);
    const { unmount } = render(<ChartBlock chart={CHART} />);
    await vi.waitFor(() => expect(embed).toHaveBeenCalled());
    const [, spec, options] = vi.mocked(embed).mock.lastCall!;
    expect(spec).toMatchObject({ mark: "bar", width: "container" });
    expect(options).toMatchObject({
      renderer: "svg",
      actions: { export: true, source: false, compiled: false, editor: false },
    });
    unmount();
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
  });

  it("draws again when the spec changes, but not for an equal copy of it", async () => {
    const first = vi.fn();
    vi.mocked(embed).mockClear();
    vi.mocked(embed).mockResolvedValueOnce({ finalize: first, view: {} } as never);
    const { rerender } = render(<ChartBlock chart={CHART} />);
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));

    rerender(<ChartBlock chart={{ ...CHART, spec: structuredClone(CHART.spec) }} />);
    expect(embed).toHaveBeenCalledTimes(1);

    rerender(<ChartBlock chart={{ ...CHART, spec: { mark: "point" } }} />);
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    expect(first).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embed).mock.lastCall?.[1]).toMatchObject({ mark: "point" });
  });

  it("keeps a width the spec sets itself", async () => {
    vi.mocked(embed).mockClear();
    render(<ChartBlock chart={{ ...CHART, spec: { mark: "bar", width: 320 } }} />);
    await vi.waitFor(() => expect(embed).toHaveBeenCalled());
    expect(vi.mocked(embed).mock.lastCall?.[1]).toMatchObject({ width: 320 });
  });

  it("drops a title that has no subtitle when it is said elsewhere", async () => {
    vi.mocked(embed).mockClear();
    render(<ChartBlock chart={{ ...CHART, spec: { mark: "bar", title: "Augsburg led" } }} untitled />);
    await vi.waitFor(() => expect(embed).toHaveBeenCalled());
    expect(vi.mocked(embed).mock.lastCall?.[1]).not.toHaveProperty("title");
  });

  it("shows why a chart could not be drawn, with its spec", async () => {
    vi.mocked(embed).mockRejectedValueOnce(new Error("Invalid specification"));
    render(<ChartBlock chart={CHART} />);
    expect(await screen.findByText("The chart could not be drawn: Invalid specification")).toBeTruthy();
    expect(screen.getByText("Spec").tagName).toBe("SUMMARY");
  });
});
