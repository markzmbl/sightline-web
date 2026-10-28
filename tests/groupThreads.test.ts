import { describe, expect, it } from "vitest";
import { distinctQuestions, filterThreads, groupThreads, mergeThreads, relativeTime } from "../src/components/sidebar/groupThreads";

// All times are local, built from calendar parts, so the tests hold in any time zone.
const NOW = new Date(2026, 9, 24, 15, 30); // Saturday 24 October 2026, 15:30
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(year, month, day, hour, minute, second, ms).toISOString();

const thread = (id: string, updated_at: string) => ({ id, updated_at });
const labels = (groups: { label: string; items: { id: string }[] }[]) =>
  groups.map((g) => [g.label, g.items.map((t) => t.id)]);

describe("groupThreads", () => {
  it("puts local midnight in today and the moment before it in yesterday", () => {
    const groups = groupThreads([thread("midnight", at(2026, 9, 24, 0, 0, 0, 0)), thread("before", at(2026, 9, 23, 23, 59, 59, 999))], NOW);
    expect(labels(groups)).toEqual([
      ["Today", ["midnight"]],
      ["Yesterday", ["before"]],
    ]);
  });

  it("ends yesterday at the midnight before it", () => {
    const groups = groupThreads([thread("start", at(2026, 9, 23, 0, 0)), thread("earlier", at(2026, 9, 22, 23, 59, 59, 999))], NOW);
    expect(labels(groups)).toEqual([
      ["Yesterday", ["start"]],
      ["Previous 7 days", ["earlier"]],
    ]);
  });

  it("keeps the previous 7 days back to midnight seven days ago, and the rest as older", () => {
    const groups = groupThreads([thread("edge", at(2026, 9, 17, 0, 0)), thread("older", at(2026, 9, 16, 23, 59, 59, 999))], NOW);
    expect(labels(groups)).toEqual([
      ["Previous 7 days", ["edge"]],
      ["Older", ["older"]],
    ]);
  });

  it("keeps the order it is given within each group, and the groups in time order", () => {
    const items = [
      thread("old-b", at(2026, 0, 2)),
      thread("today-a", at(2026, 9, 24, 9)),
      thread("week", at(2026, 9, 20)),
      thread("today-b", at(2026, 9, 24, 14)),
      thread("old-a", at(2025, 11, 31)),
    ];
    expect(labels(groupThreads(items, NOW))).toEqual([
      ["Today", ["today-a", "today-b"]],
      ["Previous 7 days", ["week"]],
      ["Older", ["old-b", "old-a"]],
    ]);
  });

  it("leaves out empty groups and returns nothing for no threads", () => {
    expect(labels(groupThreads([thread("x", at(2026, 9, 1))], NOW))).toEqual([["Older", ["x"]]]);
    expect(groupThreads([], NOW)).toEqual([]);
  });

  it("files a time ahead of the clock under today and an unreadable one under older", () => {
    const groups = groupThreads([thread("ahead", at(2026, 9, 25, 2)), thread("bad", "not a date")], NOW);
    expect(labels(groups)).toEqual([
      ["Today", ["ahead"]],
      ["Older", ["bad"]],
    ]);
  });

  it("counts calendar days, not 24-hour spans, across a clock change", () => {
    // European clocks go back on 25 October 2026, so that day has 25 hours there.
    const now = new Date(2026, 9, 26, 0, 30);
    const items = [
      thread("y-start", at(2026, 9, 25)),
      thread("y-before", at(2026, 9, 24, 23, 59, 59, 999)),
      thread("w-edge", at(2026, 9, 19)),
      thread("older", at(2026, 9, 18, 23, 59, 59, 999)),
    ];
    expect(labels(groupThreads(items, now))).toEqual([
      ["Yesterday", ["y-start"]],
      ["Previous 7 days", ["y-before", "w-edge"]],
      ["Older", ["older"]],
    ]);
  });
});

describe("filterThreads", () => {
  const items = [
    { id: "a", question: "OEE by line last week", restatement: null },
    { id: "b", question: "Scrap rate", restatement: "Scrap share of output, by Line, for September" },
    { id: "c", question: "Claims per region", restatement: "Open claims by region" },
  ];

  it("matches the question or the restatement, ignoring case", () => {
    expect(filterThreads(items, "LINE").map((t) => t.id)).toEqual(["a", "b"]);
    expect(filterThreads(items, "open claims").map((t) => t.id)).toEqual(["c"]);
  });

  it("keeps everything for a blank query and nothing for a miss", () => {
    expect(filterThreads(items, "   ")).toHaveLength(3);
    expect(filterThreads(items, "revenue")).toEqual([]);
  });
});

describe("distinctQuestions", () => {
  const items = [
    { id: "a", question: "OEE by line" },
    { id: "b", question: " oee BY line  " },
    { id: "c", question: "Scrap rate" },
    { id: "d", question: "OEE by line last week" },
    { id: "e", question: "Claims per region" },
  ];

  it("keeps the first of each question, trimmed and ignoring case, in the order given", () => {
    expect(distinctQuestions(items, 10).map((t) => t.id)).toEqual(["a", "c", "d", "e"]);
  });

  it("stops at the limit, counting distinct questions only", () => {
    expect(distinctQuestions(items, 3).map((t) => t.id)).toEqual(["a", "c", "d"]);
    expect(distinctQuestions(items, 0)).toEqual([]);
    expect(distinctQuestions([], 3)).toEqual([]);
  });
});

describe("mergeThreads", () => {
  const ids = (items: { id: string }[]) => items.map((t) => t.id);

  it("adds what only the second list has, most recently updated first", () => {
    const here = [thread("a", at(2026, 9, 24, 12)), thread("c", at(2026, 9, 20))];
    const server = [thread("b", at(2026, 9, 23)), thread("a", at(2026, 9, 24, 12)), thread("d", at(2026, 8, 1))];
    expect(ids(mergeThreads(here, server))).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the first list's copy of a thread both have", () => {
    const mine = { id: "a", updated_at: at(2026, 9, 24), question: "here" };
    const theirs = { id: "a", updated_at: at(2026, 9, 24), question: "server" };
    expect(mergeThreads([mine], [theirs])).toEqual([mine]);
  });

  it("keeps the order given for threads updated at the same moment, the first list's before the second's", () => {
    const same = at(2026, 9, 24, 9);
    expect(ids(mergeThreads([thread("x", same), thread("y", same)], [thread("z", same)]))).toEqual(["x", "y", "z"]);
  });

  it("puts an unreadable time last", () => {
    expect(ids(mergeThreads([thread("bad", "soon")], [thread("ok", at(2026, 9, 1))]))).toEqual(["ok", "bad"]);
  });
});

describe("relativeTime", () => {
  it("counts minutes and hours within a day", () => {
    expect(relativeTime(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe("now");
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe("5m");
    expect(relativeTime(new Date(NOW.getTime() - 3 * 3_600_000 - 1).toISOString(), NOW)).toBe("3h");
  });

  it("names the weekday within the week, then the date", () => {
    expect(relativeTime(at(2026, 9, 19, 10), NOW)).toBe("Mon");
    expect(relativeTime(at(2026, 9, 12, 10), NOW)).toBe("12 Oct");
    expect(relativeTime(at(2025, 9, 12, 10), NOW)).toBe("12 Oct 2025");
  });

  it("says nothing for an unreadable time", () => {
    expect(relativeTime("soon", NOW)).toBe("");
  });
});
