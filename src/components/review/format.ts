// The review view's words and URLs: kinds, statuses, sorts, times, and the filters the URL carries.
// All of it is pure and takes `now`, so the boundaries are testable.
import type { RegistrySort } from "../../api/registry";
import type { KindInfo, RegistryCounts, RegistryKind, RegistryStatus } from "../../api/types";
import { reviewPath as entryPath } from "../sidebar/paths";

export const STATUSES: readonly RegistryStatus[] = ["proposed", "approved", "rejected"];

export const STATUS_LABEL: Record<RegistryStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  rejected: "Rejected",
};

/** The list's orders, the server's default first. */
export const SORTS: readonly RegistrySort[] = ["last_asked", "demand", "updated"];
export const DEFAULT_SORT: RegistrySort = "last_asked";

export const SORT_LABEL: Record<RegistrySort, string> = {
  last_asked: "Last asked",
  demand: "Most asked",
  updated: "Last changed",
};

/** /w/:ws/review, or one entry of it; `search` ("?status=…") keeps the list's filters. */
export function reviewPath(ws: string, entryId: string | null = null, search = ""): string {
  return `${entryPath(ws, entryId ?? undefined)}${search}`;
}

/** The status tab in the URL; anything else, or nothing, is the default tab, proposed. */
export function statusParam(value: string | null): RegistryStatus {
  return STATUSES.find((status) => status === value) ?? "proposed";
}

/** The kinds this client was built with; the server may name more. */
const KNOWN_KINDS = { measure: true, default: true, gap: true } satisfies Record<RegistryKind, true>;

const isKnownKind = (value: string): value is RegistryKind => Object.hasOwn(KNOWN_KINDS, value);

/**
 * The kind filter in the URL; null means all kinds. Once the server has named its kinds,
 * only one of them filters; before, only one this client knows does (see kindAwaited).
 */
export function kindParam(value: string | null, kinds: readonly KindInfo[] | undefined): RegistryKind | null {
  if (!value) return null;
  if (!kinds) return isKnownKind(value) ? value : null;
  return kinds.find((info) => info.kind === value)?.kind ?? null;
}

/**
 * Whether the URL's kind waits for the server's kinds: one this client does not know, before
 * they are in. It may be a kind of a later contract, or one the server would refuse.
 */
export function kindAwaited(value: string | null, kinds: readonly KindInfo[] | undefined): boolean {
  return value !== null && value !== "" && kinds === undefined && !isKnownKind(value);
}

/** The order in the URL; anything else, or nothing, is the server's default. */
export function sortParam(value: string | null): RegistrySort {
  return SORTS.find((sort) => sort === value) ?? DEFAULT_SORT;
}

/**
 * A kind's display words, as the server sends them ("data gap", "data gaps"). A kind the
 * server has not described (yet) goes by its own name.
 */
export function kindWords(kinds: readonly KindInfo[] | undefined, kind: string): { label: string; plural: string } {
  const info = kinds?.find((candidate) => candidate.kind === kind);
  return info ? { label: info.label, plural: info.plural } : { label: kind, plural: kind };
}

/** A word as a chip or a heading shows it: "data gap" → "Data gap". */
export function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Proposed entries of one kind; a kind the counts leave out has none. */
export const countOf = (counts: RegistryCounts, kind: string): number => counts[kind] ?? 0;

/** Proposed entries of every kind, those this client does not know included. */
export const totalOf = (counts: RegistryCounts): number =>
  Object.values(counts).reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);

/**
 * What the list shows when a tab has nothing, e.g. "No measures approved yet.", or with a
 * search, "No measures approved match “oee”." `plural` is the kind's, null for all kinds.
 */
export function emptyText(status: RegistryStatus, plural: string | null, q = ""): string {
  const search = q.trim();
  if (search) {
    return plural ? `No ${plural} ${status} match “${search}”.` : `Nothing ${status} matches “${search}”.`;
  }
  const what = plural ? `No ${plural}` : "Nothing";
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
