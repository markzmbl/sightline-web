// The review view's words and URLs: kinds, statuses, times, and the filters the URL carries.
// All of it is pure and takes `now`, so the boundaries are testable.
import type { RegistryKind, RegistryStatus } from "../../api/types";
import { reviewPath as entryPath } from "../sidebar/paths";

export const KINDS: readonly RegistryKind[] = ["measure", "default", "gap"];
export const STATUSES: readonly RegistryStatus[] = ["proposed", "approved", "rejected"];

export const KIND_LABEL: Record<RegistryKind, string> = { measure: "Measure", default: "Default", gap: "Gap" };
export const KIND_PLURAL: Record<RegistryKind, string> = { measure: "Measures", default: "Defaults", gap: "Gaps" };
export const STATUS_LABEL: Record<RegistryStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  rejected: "Rejected",
};

/** /w/:ws/review, or one entry of it; `search` ("?status=…") keeps the list's filters. */
export function reviewPath(ws: string, entryId: string | null = null, search = ""): string {
  return `${entryPath(ws, entryId ?? undefined)}${search}`;
}

/** The status tab in the URL; anything else, or nothing, is the default tab, proposed. */
export function statusParam(value: string | null): RegistryStatus {
  return STATUSES.find((status) => status === value) ?? "proposed";
}

/** The kind filter in the URL; null means all kinds. */
export function kindParam(value: string | null): RegistryKind | null {
  return KINDS.find((kind) => kind === value) ?? null;
}

/** What the list shows when a tab has nothing, e.g. "No measures approved yet." */
export function emptyText(status: RegistryStatus, kind: RegistryKind | null): string {
  const what = kind ? `No ${KIND_PLURAL[kind].toLowerCase()}` : "Nothing";
  if (status === "proposed") return `${what} proposed right now.`;
  if (status === "approved") return `${what} approved yet.`;
  return `${what} rejected.`;
}

/** A sentence from a fragment the server sends in lower case: "drafted by sightline" → "Drafted by sightline." */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?…:]$/.test(capital) ? capital : `${capital}.`;
}

const DAY_MS = 86_400_000;
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Local midnight of a time's day; calendar days, so DST shifts do not matter. */
function midnight(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A time in words: "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then "12 Oct". */
export function ago(iso: string | null, now: number = Date.now()): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return "";
  const elapsed = now - time;
  if (elapsed < 60_000) return "just now"; // a clock running ahead lands here too
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / 3_600_000)} h ago`;
  const days = Math.round((midnight(now) - midnight(time)) / DAY_MS);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(time);
  return date.getFullYear() === new Date(now).getFullYear() ? DAY_MONTH.format(date) : DAY_MONTH_YEAR.format(date);
}

/** A day in full: "12 Oct 2026". */
export function longDate(iso: string | null): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? "" : DAY_MONTH_YEAR.format(new Date(time));
}

/** "1 run", "12 runs". */
export function counted(value: number, one: string, many = `${one}s`): string {
  return `${value} ${value === 1 ? one : many}`;
}

/** Edited fields in words: ["label", "de"] → "the label and the German words". */
export function fieldNames(fields: readonly string[]): string {
  const names = fields.map((field) => (field === "label" ? "the label" : `the ${localeName(field)} words`));
  const last = names.pop();
  if (last === undefined) return "";
  return names.length > 0 ? `${names.join(", ")} and ${last}` : last;
}

let languages: Intl.DisplayNames | null | undefined;

/** A locale's name for screen readers and titles ("German"); the code itself when unknown. */
export function localeName(locale: string): string {
  if (languages === undefined) {
    try {
      languages = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      languages = null;
    }
  }
  try {
    return languages?.of(locale) ?? locale;
  } catch {
    return locale; // not a well-formed language tag
  }
}
