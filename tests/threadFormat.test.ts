import { describe, expect, it } from "vitest";
import type { Definition, RunSummary } from "../src/api/types";
import { formatBySpecifier } from "../src/components/thread/format";
import { definitionWording, originLabel } from "../src/components/thread/words";

describe("formatBySpecifier", () => {
  it.each([
    [1234.567, ",.0f", "1,235"],
    [1234.567, ",.2f", "1,234.57"],
    [1234.567, ".1f", "1234.6"],
    [0.4567, ".1%", "45.7%"],
    [0.5, ".0%", "50%"],
    [0.5, ".2~%", "50%"],
    [1234.5, ",d", "1,235"],
    [1_500_000, "~s", "1.5M"],
    [1_500_000, ".3s", "1.50M"],
    [999.96, ".3s", "1.00k"],
    [0.0042, "~s", "4.2m"],
    [0, "~s", "0"],
    [12345.678, ",", "12,345.678"],
  ])("formats %d by %s as %s", (value, specifier, text) => {
    expect(formatBySpecifier(value, specifier)).toBe(text);
  });

  it("formats a specifier outside the subset, or none, as a plain number", () => {
    expect(formatBySpecifier(0.81234567, null)).toBe("0.8123");
    expect(formatBySpecifier(1234.5, "$,.2f")).toBe("1,234.5");
    expect(formatBySpecifier(1234.5, ">10,.1f")).toBe("1,234.5");
  });
});

describe("definitionWording", () => {
  const definition = (extra: Partial<Definition>): Definition => ({
    name: "oee",
    label: "OEE",
    definition: null,
    entry_id: null,
    source: { kind: "library", text: "from sightline's KPI library (ISO 22400-2)" },
    status: "proposed",
    ...extra,
  });

  it("words each status and source as agreed", () => {
    expect(definitionWording(definition({}))).toBe(
      "proposed definition from sightline's KPI library (ISO 22400-2), not yet approved",
    );
    expect(definitionWording(definition({ status: "approved" }))).toBe(
      "approved by your key user (from sightline's KPI library, ISO 22400-2)",
    );
    const drafted = { kind: "drafted", text: "drafted by sightline" } as const;
    expect(definitionWording(definition({ source: drafted }))).toBe(
      "proposed definition drafted by sightline, not yet approved",
    );
    expect(definitionWording(definition({ source: drafted, status: "approved" }))).toBe(
      "approved by your key user (drafted by sightline)",
    );
    const question = { kind: "question", text: "as the question states it" } as const;
    expect(definitionWording(definition({ source: question }))).toBe("as your question defines it, not yet approved");
    expect(definitionWording(definition({ source: question, status: "approved" }))).toBe(
      "approved by your key user (as your question defines it)",
    );
  });
});

describe("originLabel", () => {
  const summary = (extra: Partial<RunSummary>): RunSummary => ({
    id: "r1",
    revision: 2,
    origin: "revision",
    prompt: "per month instead",
    status: "complete",
    restatement: null,
    top: null,
    chart: null,
    follows: null,
    takes_back: null,
    feedback: null,
    started_at: null,
    finished_at: null,
    ...extra,
  });

  it("says where each turn came from", () => {
    expect(originLabel(summary({ origin: "question", revision: 0 }))).toBeNull();
    expect(originLabel(summary({}))).toBe("Revision 2");
    expect(
      originLabel(summary({ origin: "follow_up", follows: { run_id: "r0", follow_up_id: "fu1", kind: "breakdown" } })),
    ).toBe("Follow-up · Break down");
    expect(originLabel(summary({ origin: "follow_up" }))).toBe("Follow-up");
    expect(originLabel(summary({ origin: "nearest" }))).toBe("Instead");
    expect(originLabel(summary({ origin: "take_back", takes_back: 1 }))).toBe("Took back revision 1");
  });
});
