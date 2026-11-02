import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ReactElement } from "react";
import type { Card, DecisionPoint } from "../src/api/types";
import { AskedNote, ChoiceCard } from "../src/components/thread/ChoiceCard";

afterEach(cleanup);

function point(id: string, options: [string, string, string][], extra: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id,
    step: "meaning",
    question: `Which ${id} do you mean?`,
    options: options.map(([optionId, label, hint]) => ({ id: optionId, label, hint })),
    chosen: null,
    default: null,
    by: "rules",
    confidence: null,
    entry_id: null,
    why: "",
    open: false,
    stage: "abstract",
    ...extra,
  };
}

const KPI = point("kpi", [
  ["oee", "Overall equipment effectiveness", "availability × performance × quality"],
  ["availability", "Availability", "run time over planned time"],
  ["yield", "First-pass yield", ""],
]);
const PERIOD = point("period", [
  ["week", "Last calendar week", ""],
  ["seven", "The last seven days", ""],
]);
const LINE = point("line", [
  ["line", "Per line", ""],
  ["plant", "Per plant", ""],
]);

const blocking = (...points: DecisionPoint[]): Card => ({ blocking: true, points });
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("ChoiceCard, blocking", () => {
  it("submits a single point as soon as an option is clicked", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={blocking(KPI)} busy={false} onSubmit={onSubmit} />);
    expect(screen.getByText("sightline needs a choice")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Which kpi do you mean?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(button(/Availability/));
    expect(onSubmit).toHaveBeenCalledWith({ kpi: "availability" }, null);
  });

  it("marks sightline's pick with its confidence", () => {
    const sure: DecisionPoint = { ...KPI, chosen: "oee", by: "s1", confidence: 0.82 };
    render(<ChoiceCard card={blocking(sure)} busy={false} onSubmit={vi.fn()} />);
    expect(button(/Overall equipment/).textContent).toContain("sightline's pick · 82%");
    expect(button(/Availability/).textContent).not.toContain("sightline's pick");
  });

  it("holds several points until each has a selection, then continues", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={blocking(KPI, PERIOD)} busy={false} onSubmit={onSubmit} />);
    const go = button("Continue");
    expect(go.disabled).toBe(true);

    fireEvent.click(button(/First-pass yield/));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button(/First-pass yield/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/Availability/).getAttribute("aria-pressed")).toBe("false");
    expect(go.disabled).toBe(true);

    fireEvent.click(button(/seven days/));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(onSubmit).toHaveBeenCalledWith({ kpi: "yield", period: "seven" }, null);
  });

  it("decides for me with a null for every point", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={blocking(KPI, PERIOD)} busy={false} onSubmit={onSubmit} />);
    fireEvent.click(button("Decide for me"));
    expect(onSubmit).toHaveBeenCalledWith({ kpi: null, period: null }, null);
  });

  it("sends free text from Other… as a revision", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={blocking(KPI)} busy={false} onSubmit={onSubmit} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(button("Other…"));
    const input = screen.getByRole("textbox", { name: "Say what you mean instead" });
    expect(button("Send").disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  scrap rate per line  " } });
    fireEvent.click(button("Send"));
    expect(onSubmit).toHaveBeenCalledWith({}, "scrap rate per line");
  });

  it("disables everything while busy", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={blocking(KPI, PERIOD)} busy onSubmit={onSubmit} />);
    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(5);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    fireEvent.keyDown(screen.getByRole("region"), { key: "1" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("picks the nth option of the first open point with a digit key", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={blocking(KPI)} busy={false} onSubmit={onSubmit} />);
    const card = screen.getByRole("region", { name: "sightline needs a choice" });
    fireEvent.keyDown(card, { key: "9" }); // there is no ninth option
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "3" });
    expect(onSubmit).toHaveBeenCalledWith({ kpi: "yield" }, null);
  });

  it("walks the points with digit keys, and ignores digits typed as text", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={blocking(KPI, PERIOD)} busy={false} onSubmit={onSubmit} />);
    const card = screen.getByRole("region");
    fireEvent.keyDown(card, { key: "2" });
    expect(button(/Availability/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("Other…"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "1" });
    expect(button(/Last calendar week/).getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(card, { key: "1" });
    expect(button(/Last calendar week/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("Continue"));
    expect(onSubmit).toHaveBeenCalledWith({ kpi: "availability", period: "week" }, null);
  });

  it("numbers every option, past the ninth too, though digits reach only nine", () => {
    const onSubmit = vi.fn();
    const many = point(
      "measure",
      Array.from({ length: 12 }, (_, i): [string, string, string] => [`m${i + 1}`, `Measure ${i + 1}`, ""]),
    );
    render(<ChoiceCard card={blocking(many)} busy={false} onSubmit={onSubmit} />);
    const keys = [...document.querySelectorAll(".tx-choice__key")].map((key) => key.textContent);
    expect(keys).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    fireEvent.keyDown(screen.getByRole("region"), { key: "9" });
    expect(onSubmit).toHaveBeenCalledWith({ measure: "m9" }, null);
  });

  it("asks only the points nobody was sure of", () => {
    const onSubmit = vi.fn();
    const sure: DecisionPoint = { ...PERIOD, chosen: "week", by: "s1", confidence: 0.91 };
    const unsure: DecisionPoint = { ...KPI, open: true, why: "Two measures on this star are called OEE." };
    render(<ChoiceCard card={blocking(sure, unsure)} busy={false} onSubmit={onSubmit} />);
    const questions = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(questions).toEqual(["Which kpi do you mean?"]);
    expect(screen.getByText("Two measures on this star are called OEE.").className).toBe("tx-choice__why");
    // A single open point goes as soon as it is picked.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(button(/First-pass yield/));
    expect(onSubmit).toHaveBeenCalledWith({ kpi: "yield" }, null);
  });

  it("shows a hint only where an option has one, and no why when it is empty", () => {
    render(<ChoiceCard card={blocking(KPI)} busy={false} onSubmit={vi.fn()} />);
    const hints = [...document.querySelectorAll(".tx-choice__hint")].map((hint) => hint.textContent);
    expect(hints).toEqual(["availability × performance × quality", "run time over planned time"]);
    expect(button(/First-pass yield/).querySelector(".tx-choice__hint")).toBeNull();
    expect(document.querySelector(".tx-choice__why")).toBeNull();
  });

  it("takes focus when nothing holds it, but not while it cannot be answered", () => {
    const { unmount } = render(<ChoiceCard card={blocking(KPI)} busy onSubmit={vi.fn()} />);
    expect(document.activeElement).toBe(document.body);
    unmount();
    render(<ChoiceCard card={blocking(KPI)} busy={false} onSubmit={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("region"));
  });
});

describe("AskedNote", () => {
  it("records what a stopped run asked, with nothing to press", () => {
    const answered: DecisionPoint = { ...PERIOD, chosen: "week", by: "user" };
    render(<AskedNote card={blocking(KPI, answered)} />);
    expect(screen.getByRole("region", { name: "sightline asked" })).toBeTruthy();
    expect(screen.getByText("Which kpi do you mean?")).toBeTruthy();
    expect(screen.getByText("not answered")).toBeTruthy();
    expect(screen.getByText("Last calendar week")).toBeTruthy();
    expect(screen.getByText("your choice")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("records only the open points, unanswered whatever sightline leaned to", () => {
    const leaned: DecisionPoint = { ...KPI, chosen: "oee", by: "s1", confidence: 0.4, open: true };
    const settled: DecisionPoint = { ...PERIOD, chosen: "week", by: "rules" };
    render(<AskedNote card={blocking(settled, leaned)} />);
    expect(screen.getByText("Which kpi do you mean?")).toBeTruthy();
    expect(screen.queryByText("Which period do you mean?")).toBeNull();
    expect(screen.getByText("not answered")).toBeTruthy();
    expect(screen.queryByText("Overall equipment effectiveness")).toBeNull();
  });

  it("records what a card beside the chart left open, as asked", () => {
    const leaned: DecisionPoint = { ...KPI, chosen: "oee", by: "s2", open: true, why: "Two measures are called OEE." };
    render(<AskedNote card={{ blocking: false, points: [{ ...PERIOD, chosen: "week" }, leaned] }} />);
    expect(screen.getByRole("region", { name: "sightline asked" })).toBeTruthy();
    expect(screen.getByText("not answered")).toBeTruthy();
    expect(screen.getByText("Two measures are called OEE.").className).toBe("tx-made__why");
    expect(screen.queryByText("Which period do you mean?")).toBeNull();
  });

  it("records the choices made, when the card asked nothing", () => {
    const settled: DecisionPoint = { ...PERIOD, chosen: "week", by: "s2", confidence: 0.4 };
    render(<AskedNote card={{ blocking: false, points: [settled] }} />);
    expect(screen.getByRole("region", { name: "Choices sightline made" })).toBeTruthy();
    expect(screen.getByText("Last calendar week")).toBeTruthy();
    expect(screen.getByText("sightline's pick")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("ChoiceCard, beside the chart", () => {
  const made = (...points: DecisionPoint[]): Card => ({ blocking: false, points });
  const lines = () =>
    [...document.querySelectorAll(".tx-made__line")].map((line) => [
      line.querySelector(".tx-made__question")?.textContent,
      line.querySelector(".tx-made__by")?.textContent,
    ]);

  it("lists the unsure choices first, otherwise in the order they came", () => {
    const card = made(
      { ...PERIOD, chosen: "week", by: "rules" },
      { ...KPI, chosen: "oee", by: "s1", confidence: 0.55, open: true },
      { ...LINE, chosen: "plant", by: "user" },
      { ...point("shift", [["all", "All shifts", ""]]), chosen: "all", by: "s2", open: true },
    );
    render(<ChoiceCard card={card} busy={false} onSubmit={vi.fn()} />);
    expect(lines()).toEqual([
      ["Which kpi do you mean?", "sightline's pick · 55%"],
      ["Which shift do you mean?", "sightline's pick"],
      ["Which period do you mean?", "sightline's pick"],
      ["Which line do you mean?", "your choice"],
    ]);
  });

  it("gives the System 1 confidence with S1's own pick only", () => {
    // The confidence is S1's: often the doubt that sent the point on to S2 or the rules.
    const card = made(
      { ...PERIOD, chosen: "week", by: "s2", confidence: 0.31 },
      { ...LINE, chosen: "line", by: "rules", confidence: 0.31 },
      { ...KPI, chosen: "oee", by: "s1", confidence: 0.31 },
    );
    render(<ChoiceCard card={card} busy={false} onSubmit={vi.fn()} />);
    expect(lines()).toEqual([
      ["Which period do you mean?", "sightline's pick"],
      ["Which line do you mean?", "sightline's pick"],
      ["Which kpi do you mean?", "sightline's pick · 31%"],
    ]);
  });

  it("says why a choice was made, when there is something to say", () => {
    const card = made(
      { ...PERIOD, chosen: "week", why: "Your workspace reads last week as the calendar week." },
      { ...LINE, chosen: "line" },
    );
    render(<ChoiceCard card={card} busy={false} onSubmit={vi.fn()} />);
    const whys = [...document.querySelectorAll(".tx-made__why")].map((why) => why.textContent);
    expect(whys).toEqual(["Your workspace reads last week as the calendar week."]);
  });

  it("lists the choices made and lets one be changed", () => {
    const onSubmit = vi.fn();
    render(<ChoiceCard card={made({ ...PERIOD, chosen: "week", by: "s1", confidence: 0.64 })} busy={false} onSubmit={onSubmit} />);
    expect(screen.getByText("Choices sightline made")).toBeTruthy();
    expect(screen.getByText("Last calendar week")).toBeTruthy();
    expect(screen.getByText("sightline's pick · 64%")).toBeTruthy();

    const change = button("Change");
    expect(change.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(change);
    expect(button("Last calendar week").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("The last seven days"));
    expect(onSubmit).toHaveBeenCalledWith({ period: "seven" }, null);
  });
});

describe("ChoiceCard, a key user's default", () => {
  /** On the thread's page, where the tag's link resolves. */
  const onThread = (ui: ReactElement) => (
    <MemoryRouter initialEntries={["/w/ws1/t/t1"]}>
      <Routes>
        <Route path="/w/:ws/t/:threadId" element={ui} />
      </Routes>
    </MemoryRouter>
  );
  const settled: DecisionPoint = {
    ...LINE,
    chosen: "plant",
    by: "default",
    entry_id: "default-best-plant",
    why: "'best plant' means the highest OEE",
  };

  it("tags a choice an approved default settled as the key user's, linking to its entry, with what it says", () => {
    render(onThread(<ChoiceCard card={{ blocking: false, points: [settled] }} busy={false} onSubmit={vi.fn()} />));
    const tag = screen.getByRole("link", { name: "your key user's default" });
    expect(tag.getAttribute("href")).toBe("/w/ws1/review/default-best-plant");
    expect(screen.getByText("Per plant")).toBeTruthy();
    expect(screen.getByText("'best plant' means the highest OEE").className).toBe("tx-made__why");
    // It can still be changed, like any choice beside the chart.
    expect(button("Change").disabled).toBe(false);
  });

  it("tags it without a link when no entry is named", () => {
    render(<AskedNote card={{ blocking: false, points: [{ ...settled, entry_id: null }] }} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("your key user's default").tagName).toBe("SPAN");
  });

  it("names the default on an option of a blocking card as text", () => {
    render(<ChoiceCard card={blocking({ ...settled, open: true })} busy={false} onSubmit={vi.fn()} />);
    expect(button(/Per plant/).textContent).toContain("your key user's default");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
