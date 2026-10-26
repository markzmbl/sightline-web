// The sidebar's list logic: date groups, the search filter, the short times, and the
// distinct recent questions the new-question page offers.
// All of it is pure and takes `now`, so the boundaries are testable.

export type GroupLabel = "Today" | "Yesterday" | "Previous 7 days" | "Older";

export interface ThreadGroup<T> {
  label: GroupLabel;
  items: T[];
}

interface Dated {
  updated_at: string;
}

const DAY_MS = 86_400_000;

/** Local midnight `days` days before the day of `now`; calendar days, so DST shifts do not matter. */
function midnight(now: Date, days = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
}

function groupOf(time: number, now: Date): GroupLabel {
  if (Number.isNaN(time)) return "Older";
  if (time >= midnight(now)) return "Today"; // a clock running ahead lands here too
  if (time >= midnight(now, 1)) return "Yesterday";
  if (time >= midnight(now, 7)) return "Previous 7 days";
  return "Older";
}

const ORDER: GroupLabel[] = ["Today", "Yesterday", "Previous 7 days", "Older"];

/**
 * Splits threads by when they were last updated, in local time. The order
 * within a group is the order given (the API sends newest first); empty
 * groups are left out.
 */
export function groupThreads<T extends Dated>(items: readonly T[], now: Date | number = Date.now()): ThreadGroup<T>[] {
  const today = new Date(now);
  const groups = new Map<GroupLabel, T[]>();
  for (const item of items) {
    const label = groupOf(Date.parse(item.updated_at), today);
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }
  return ORDER.flatMap((label) => {
    const group = groups.get(label);
    return group ? [{ label, items: group }] : [];
  });
}

interface Searchable {
  question: string;
  restatement: string | null;
}

/** Threads whose question or restatement contains the query, ignoring case; a blank query keeps all. */
export function filterThreads<T extends Searchable>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter(
    (t) =>
      t.question.toLocaleLowerCase().includes(needle) || (t.restatement ?? "").toLocaleLowerCase().includes(needle),
  );
}

/**
 * The first `limit` threads whose questions differ, trimmed and ignoring case, in the
 * order given (newest first from the API), so a question asked twice offers its latest thread once.
 */
export function distinctQuestions<T extends { question: string }>(items: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    if (kept.length >= limit) break;
    const key = item.question.trim().toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** A thread row's time: "now", "5m", "3h", then the weekday within a week, then "12 Oct". */
export function relativeTime(iso: string, now: Date | number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const today = new Date(now);
  const ago = today.getTime() - time;
  if (ago < 60_000) return "now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m`;
  if (ago < DAY_MS) return `${Math.floor(ago / 3_600_000)}h`;
  const date = new Date(time);
  if (time >= midnight(today, 6)) return WEEKDAY.format(date);
  if (date.getFullYear() === today.getFullYear()) return DAY_MONTH.format(date);
  return DAY_MONTH_YEAR.format(date);
}
