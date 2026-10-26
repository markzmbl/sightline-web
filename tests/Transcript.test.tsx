import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import embed from "vega-embed";
import type { ChartView, Clarify, RunView } from "../src/api/types";
import { ChartBlock } from "../src/components/thread/ChartBlock";
import { Transcript, type TranscriptActions } from "../src/components/thread/Transcript";

vi.mock("vega-embed", () => ({
  default: vi.fn(async () => ({ finalize() {}, view: {} })),
}));

afterEach(cleanup);

const CHART: ChartView = {
  chart: "horizontal_bar",
  label: "Ranked bars",
  spec: { mark: "bar", config: { background: "#FFFFFF" } },
  png_url: null,
  alternatives: [
    { chart: "bar", label: "Columns", hint: "Upright bars, one per line" },
    { chart: "point", label: "Dot plot", hint: null },
  ],
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
    prompt: revision === 0 ? "What was the OEE of each line last week?" : `revision ${revision}`,
    status: "complete",
    phase: null,
    stage: null,
    started_at: "2026-10-24T19:08:40Z",
    finished_at: "2026-10-24T19:10:47Z",
    restatement: `You want to see the OEE per line, take ${revision}.`,
    card: null,
    clarify: null,
    result: {
      sql: "SELECT 1",
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
      chart: CHART,
      findings: [],
    },
    timings: [],
    error: null,
    feedback: null,
    last_event_id: 9,
    ...overrides,
  };
}

const NO_CLARIFY: Clarify = { gaps: [], missing: [], record: [], nearest: [], warnings: [] };

const NEAREST = ["What was the scrap rate of each line last week?", "How many parts did each line scrap last week?"];

/** A run that ended because the warehouse cannot answer its question yet. */
function notYet(id: string, revision: number, warnings: string[] = []): RunView {
  return run(id, revision, {
    status: "clarify",
    result: null,
    clarify: {
      ...NO_CLARIFY,
      missing: ["scrap cost per part"],
      record: ["the cost of each scrapped part, per order"],
      nearest: NEAREST,
      warnings,
    },
  });
}

function actions(overrides: Partial<TranscriptActions> = {}): TranscriptActions {
  return { onAnswer: vi.fn(), onPickChart: vi.fn(), onFeedback: vi.fn(), ...overrides };
}

const folds = () => screen.queryAllByRole("button").filter((b) => b.classList.contains("tx-fold"));

describe("Transcript", () => {
  it("folds earlier runs and shows the latest in full", () => {
    const runs = [run("r0", 0), run("r1", 1), run("r2", 2)];
    render(<Transcript runs={runs} busy={false} actions={actions()} />);

    expect(folds().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(folds()[0]?.textContent).toContain("take 0");
    expect(folds()[0]?.textContent).toContain("Ranked bars");
    // Only the latest run has its footer.
    expect(screen.getAllByRole("button", { name: "Good answer" })).toHaveLength(1);
    expect(screen.getByText("You want to see the OEE per line, take 2.")).toBeTruthy();

    fireEvent.click(folds()[0]!);
    expect(folds()).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Good answer" })).toHaveLength(2);
    const fold = screen.getByRole("button", { name: "Fold this answer" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold);
    expect(folds()).toHaveLength(2);
  });

  it("shows the prompt as a user turn, with the revision above it", () => {
    render(<Transcript runs={[run("r0", 0), run("r1", 1)]} busy={false} actions={actions()} />);
    expect(screen.getByText("What was the OEE of each line last week?")).toBeTruthy();
    expect(screen.getByText("revision 1")).toBeTruthy();
    expect(screen.getByText("Revision 1")).toBeTruthy();
    expect(screen.queryByText("Revision 0")).toBeNull();
  });

  it("offers Take back on the latest revision only, and only when the action exists", () => {
    const onTakeBack = vi.fn();
    const runs = [run("r0", 0), run("r1", 1), run("r2", 2)];
    const { rerender } = render(<Transcript runs={runs} busy={false} actions={actions({ onTakeBack })} />);
    const takeBack = screen.getAllByRole("button", { name: "Take back" });
    expect(takeBack).toHaveLength(1);
    fireEvent.click(takeBack[0]!);
    expect(onTakeBack).toHaveBeenCalledWith(2);

    rerender(<Transcript runs={runs} busy={false} actions={actions()} />);
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();

    rerender(<Transcript runs={[run("r0", 0)]} busy={false} actions={actions({ onTakeBack })} />);
    expect(screen.queryByRole("button", { name: "Take back" })).toBeNull();
  });

  it("says when a run failed, and where", () => {
    const failed = run("r0", 0, {
      status: "failed",
      result: null,
      error: { message: "Binder Error: column oee not found", stage: "query" },
    });
    render(<Transcript runs={[failed]} busy={false} actions={actions()} />);
    expect(screen.getByText("Binder Error: column oee not found")).toBeTruthy();
    expect(document.querySelector(".tx-error__title")?.textContent).toBe("The run failed at query.");
    expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull();
  });

  it("says when a run was stopped", () => {
    const stopped = run("r0", 0, { status: "cancelled", result: null });
    render(<Transcript runs={[stopped]} busy={false} actions={actions()} />);
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
    render(<Transcript runs={[replaced, revising]} busy={false} actions={actions()} />);

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
    render(<Transcript runs={[replaced, run("r1", 1)]} busy={false} actions={actions()} />);
    fireEvent.click(folds()[0]!);
    expect(screen.queryByText("sightline needs a choice")).toBeNull();
    expect(screen.queryByRole("region", { name: "sightline asked" })).toBeNull();
    expect(screen.queryByRole("button", { name: /TEEP/ })).toBeNull();
  });

  it("says Stopped, not Replaced, on a folded cancelled run", () => {
    const stopped = run("r0", 0, { status: "cancelled", result: null });
    render(<Transcript runs={[stopped, run("r1", 1)]} busy={false} actions={actions()} />);
    expect(folds()[0]?.querySelector(".tx-fold__status")?.textContent).toBe("Stopped");
  });

  it("keeps a replaced chart in the record, without its switcher", async () => {
    vi.mocked(embed).mockClear();
    const replaced = run("r0", 0, { status: "superseded" });
    replaced.result = { ...replaced.result!, chart: { ...CHART, spec: { mark: "point" } } };
    render(<Transcript runs={[replaced, run("r1", 1)]} busy={false} actions={actions()} />);
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
    render(<Transcript runs={[working]} busy={false} actions={actions()} />);
    expect(screen.getByText("Working out what you mean…")).toBeTruthy();
  });

  it("names the terms it could not match when the run ends in clarify", () => {
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
            suggestions: ["scrap_rate", "mart_quality_month.rework_count"],
          },
        ],
      },
    });
    render(<Transcript runs={[unclear]} busy={false} actions={actions()} />);
    expect(screen.getByText("I could not match every term in your question to the data.")).toBeTruthy();
    expect(screen.getByText("scrap").tagName).toBe("STRONG");
    expect(screen.getByText("scrap_rate")).toBeTruthy();
    // A long dotted name may wrap after its dot, so it never runs past a phone's column.
    const dotted = [...document.querySelectorAll(".tx-clarify .tx-chip")].find((chip) => chip.textContent?.includes("."));
    expect(dotted?.textContent).toBe("mart_quality_month.rework_count");
    expect(dotted?.querySelector("wbr")).not.toBeNull();
    expect(screen.getByText("Revise the question to name one of these, or something else.")).toBeTruthy();
    expect(screen.queryByText("This is not possible with the data yet.")).toBeNull();
    expect(document.querySelector(".tx-clarify details")).toBeNull();
  });

  it("says when the data cannot answer the question yet, and offers questions it can answer", () => {
    const onRevise = vi.fn();
    render(<Transcript runs={[run("r0", 0), notYet("r1", 1)]} busy={false} actions={actions({ onRevise })} />);
    expect(screen.getByRole("heading", { name: "This is not possible with the data yet." })).toBeTruthy();
    expect(screen.getByRole("list", { name: "The data lacks:" }).textContent).toBe("scrap cost per part");
    expect(screen.getByRole("list", { name: "To answer it, someone would have to record:" }).textContent).toBe(
      "the cost of each scrapped part, per order",
    );
    // Not a proxy answer: there are no gaps, so no other measure is put forward in its place.
    expect(screen.queryByText("I could not match every term in your question to the data.")).toBeNull();

    const instead = screen.getByRole("list", { name: "Questions I can answer instead:" });
    const asks = [...instead.querySelectorAll("button")];
    expect(asks.map((b) => b.textContent)).toEqual(NEAREST);
    fireEvent.click(asks[1]!);
    expect(onRevise).toHaveBeenCalledWith(NEAREST[1]);
  });

  it("shows the questions it can answer as text where no revision can be sent", () => {
    render(<Transcript runs={[notYet("r0", 0)]} busy={false} actions={actions()} />);
    const instead = screen.getByRole("list", { name: "Questions I can answer instead:" });
    expect([...instead.querySelectorAll("li")].map((li) => li.textContent)).toEqual(NEAREST);
    expect(instead.querySelector("button")).toBeNull();
  });

  it("holds the suggested questions while a mutation is out", () => {
    const onRevise = vi.fn();
    render(<Transcript runs={[notYet("r0", 0)]} busy actions={actions({ onRevise })} />);
    const ask = screen.getByRole("button", { name: NEAREST[0] }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.click(ask);
    expect(onRevise).not.toHaveBeenCalled();
  });

  it("offers suggested questions on the latest run only", () => {
    const onRevise = vi.fn();
    render(<Transcript runs={[notYet("r0", 0), run("r1", 1)]} busy={false} actions={actions({ onRevise })} />);
    fireEvent.click(folds()[0]!);
    expect(screen.getByRole("heading", { name: "This is not possible with the data yet." })).toBeTruthy();
    expect(screen.queryByRole("button", { name: NEAREST[0] })).toBeNull();
    expect(screen.getByText(NEAREST[0]!)).toBeTruthy();
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
    render(<Transcript runs={[both]} busy={false} actions={actions({ onRevise: vi.fn() })} />);
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
      clarify: { ...NO_CLARIFY, warnings: ["The star has no cost facts before 2025."] },
    });
    render(<Transcript runs={[bare]} busy={false} actions={actions({ onRevise: vi.fn() })} />);
    expect(screen.getByText("This question needs a revision before sightline can answer it.")).toBeTruthy();
    expect(screen.queryByText("I could not match every term in your question to the data.")).toBeNull();
    expect(screen.queryByText("Revise the question to say it another way.")).toBeNull();
    expect(screen.queryByText("This is not possible with the data yet.")).toBeNull();
    expect(document.querySelector(".tx-clarify details")?.textContent).toContain("The star has no cost facts before 2025.");
  });

  it("keeps focus in the thread when a suggested question folds its run", () => {
    const onRevise = vi.fn();
    const clarified = notYet("r0", 0);
    const { rerender } = render(<Transcript runs={[clarified]} busy={false} actions={actions({ onRevise })} />);
    const ask = screen.getByRole("button", { name: NEAREST[0] });
    ask.focus();
    fireEvent.click(ask);
    expect(onRevise).toHaveBeenCalledWith(NEAREST[0]);

    // The revision is out, then its run arrives and the clarify run folds under it.
    rerender(<Transcript runs={[clarified]} busy actions={actions({ onRevise })} />);
    const revising = run("r1", 1, { status: "queued", prompt: NEAREST[0]!, restatement: null, result: null });
    rerender(<Transcript runs={[clarified, revising]} busy={false} actions={actions({ onRevise })} />);
    expect(folds()).toHaveLength(1);
    expect(document.activeElement).toBe(folds()[0]);
  });

  it("leaves focus be when the user had moved it off the run before it folded", () => {
    const clarified = notYet("r0", 0);
    const { rerender } = render(<Transcript runs={[clarified]} busy={false} actions={actions({ onRevise: vi.fn() })} />);
    const ask = screen.getByRole("button", { name: NEAREST[0] });
    ask.focus();
    ask.blur();
    const revising = run("r1", 1, { status: "queued", restatement: null, result: null });
    rerender(<Transcript runs={[clarified, revising]} busy={false} actions={actions({ onRevise: vi.fn() })} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the clarify warnings in folded notes", () => {
    const warned = notYet("r0", 0, ["The star has no cost facts before 2025."]);
    render(<Transcript runs={[warned]} busy={false} actions={actions()} />);
    const notes = document.querySelector(".tx-clarify details") as HTMLDetailsElement;
    expect(notes.open).toBe(false);
    expect(notes.querySelector("summary")?.textContent).toBe("Notes");
    expect(notes.textContent).toContain("The star has no cost facts before 2025.");
  });

  it("reads a clarify report that carries gaps only", () => {
    const old = run("r0", 0, {
      status: "clarify",
      result: null,
      clarify: { gaps: [{ slot: "measure", requested: "scrap", reason: "no measure", suggestions: [] }] } as unknown as Clarify,
    });
    render(<Transcript runs={[old]} busy={false} actions={actions()} />);
    expect(screen.getByText("I could not match every term in your question to the data.")).toBeTruthy();
    expect(screen.queryByText("This is not possible with the data yet.")).toBeNull();
  });

  it("wires the chart switcher and the feedback to the run", () => {
    const acts = actions();
    render(<Transcript runs={[run("r0", 0), run("r1", 1, { feedback: "down" })]} busy={false} actions={acts} />);

    const current = screen.getByRole("button", { name: "Ranked bars" });
    expect(current.getAttribute("aria-pressed")).toBe("true");
    const columns = screen.getByRole("button", { name: "Columns" });
    expect(columns.getAttribute("title")).toBe("Upright bars, one per line");
    fireEvent.click(columns);
    expect(acts.onPickChart).toHaveBeenCalledWith("r1", "bar");

    expect(screen.getByRole("button", { name: "Bad answer" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Good answer" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Good answer" }));
    expect(acts.onFeedback).toHaveBeenCalledWith("r1", "up");
  });

  it("offers neither the switcher nor a change of choice on an earlier run, which the server would refuse", () => {
    const acts = actions();
    const point = ASK!.points[0]!;
    const card: RunView["card"] = { blocking: false, points: [{ ...point, chosen: "oee", open: true, by: "s1" }] };
    render(<Transcript runs={[run("r0", 0, { card }), run("r1", 1, { card })]} busy={false} actions={acts} />);
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
    render(<Transcript runs={[run("r0", 0)]} busy actions={actions()} />);
    expect((screen.getByRole("button", { name: "Dot plot" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("answers a blocking card for its run", () => {
    const acts = actions();
    const asking = run("r0", 0, {
      status: "asking",
      result: null,
      card: ASK,
    });
    render(<Transcript runs={[asking]} busy={false} actions={acts} />);
    fireEvent.click(screen.getByRole("button", { name: /TEEP/ }));
    expect(acts.onAnswer).toHaveBeenCalledWith("r0", { kpi: "teep" }, null);
  });

  it("keeps a blocking card only as a record once a revision stopped its run", () => {
    const acts = actions();
    const stopped = run("r0", 0, { status: "cancelled", result: null, card: ASK });
    const revising = run("r1", 1, { status: "running", restatement: null, result: null });
    render(<Transcript runs={[stopped, revising]} busy={false} actions={acts} />);

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
      error: { message: "The planner timed out", stage: "meaning" },
    });
    render(<Transcript runs={[failed]} busy={false} actions={actions()} />);
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
      render(<Transcript runs={[ended]} busy={false} actions={acts} />);
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
    render(<Transcript runs={[stopped]} busy={false} actions={actions()} />);
    const record = screen.getByRole("region", { name: "Choices sightline made" });
    expect(record.textContent).toContain("OEE as availability × performance × quality");
    expect(record.textContent).toContain("sightline's pick");
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("lets a complete run's choices be changed, and holds them while it works on the change", () => {
    const acts = actions();
    const point = ASK!.points[0]!;
    const card: RunView["card"] = { blocking: false, points: [{ ...point, chosen: "oee", open: false }] };
    const { rerender } = render(<Transcript runs={[run("r0", 0, { card })]} busy={false} actions={acts} />);
    const change = screen.getByRole("button", { name: "Change" }) as HTMLButtonElement;
    expect(change.disabled).toBe(false);
    fireEvent.click(change);
    fireEvent.click(screen.getByRole("button", { name: "TEEP, over all calendar time" }));
    expect(acts.onAnswer).toHaveBeenCalledWith("r0", { kpi: "teep" }, null);

    rerender(<Transcript runs={[run("r0", 0, { status: "running", card })]} busy={false} actions={acts} />);
    expect((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("holds a blocking card while its run works on the answer", () => {
    const acts = actions();
    const resumed = run("r0", 0, { status: "running", result: null, card: ASK });
    render(<Transcript runs={[resumed]} busy={false} actions={acts} />);
    expect(screen.getByText("sightline needs a choice")).toBeTruthy();
    const teep = screen.getByRole("button", { name: /TEEP/ }) as HTMLButtonElement;
    expect(teep.disabled).toBe(true);
    fireEvent.click(teep);
    expect(acts.onAnswer).not.toHaveBeenCalled();
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

  it("shows why a chart could not be drawn, with its spec", async () => {
    vi.mocked(embed).mockRejectedValueOnce(new Error("Invalid specification"));
    render(<ChartBlock chart={CHART} />);
    expect(await screen.findByText("The chart could not be drawn: Invalid specification")).toBeTruthy();
    expect(screen.getByText("Spec").tagName).toBe("SUMMARY");
  });
});

