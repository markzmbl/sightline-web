import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { RegistrySort } from "../../api/registry";
import type { KindInfo, RegistryCounts, RegistryKind, RegistryStatus } from "../../api/types";
import { capital, countOf, kindWords, SORT_LABEL, SORTS, STATUS_LABEL, STATUSES, totalOf } from "./format";
import "./review.css";

/** The id of a status tab, for the panel it labels. */
export const tabId = (prefix: string, status: RegistryStatus): string => `${prefix}-tab-${status}`;

interface TabsProps {
  status: RegistryStatus;
  counts: RegistryCounts | undefined;
  /** Prefix for the tabs' ids. */
  idPrefix: string;
  /** The id of the panel the tabs control: the list. */
  panelId: string;
  onStatus(status: RegistryStatus): void;
}

/** Proposed (with how many wait), Approved, Rejected: the list's status filter, as tabs. */
export function StatusTabs({ status, counts, idPrefix, panelId, onStatus }: TabsProps) {
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const waiting = counts ? totalOf(counts) : null;

  // Arrow keys move along the tabs and select as they go; Home and End jump to the ends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = STATUSES.indexOf(status);
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % STATUSES.length
        : event.key === "ArrowLeft"
          ? (at - 1 + STATUSES.length) % STATUSES.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? STATUSES.length - 1
              : null;
    const target = next === null ? undefined : STATUSES[next];
    if (!target) return;
    event.preventDefault();
    tabs.current[target]?.focus();
    if (target !== status) onStatus(target);
  };

  return (
    <div className="rv-tabs" role="tablist" aria-label="Status" onKeyDown={onKeyDown}>
      {STATUSES.map((candidate) => {
        const selected = candidate === status;
        return (
          <button
            key={candidate}
            ref={(element) => {
              tabs.current[candidate] = element;
            }}
            id={tabId(idPrefix, candidate)}
            type="button"
            role="tab"
            className="rv-tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onStatus(candidate);
            }}
          >
            {STATUS_LABEL[candidate]}
            {candidate === "proposed" && waiting !== null && waiting > 0 && (
              <>
                {" "}
                <span className="rv-tab__count">{waiting}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface KindProps {
  kind: RegistryKind | null;
  /** The server's kinds and their words, in its order; undefined until they are in. */
  kinds: readonly KindInfo[] | undefined;
  /** Proposed entries per kind, on every tab: what waits for review. The count says so on hover and when read out. */
  counts: RegistryCounts | undefined;
  onKind(kind: RegistryKind | null): void;
}

/** All, then every kind the server names (Measures, Defaults, …), each with how many are proposed: the kind filter. */
export function KindChips({ kind, kinds, counts, onKind }: KindProps) {
  // Until the kinds are in, the kind the URL filters by still shows, pressed, by its own name.
  const listed: RegistryKind[] = kinds ? kinds.map((info) => info.kind) : kind ? [kind] : [];
  const options: { value: RegistryKind | null; label: string; count: number | null }[] = [
    { value: null, label: "All", count: counts ? totalOf(counts) : null },
    ...listed.map((value) => ({
      value,
      label: capital(kindWords(kinds, value).plural),
      count: counts ? countOf(counts, value) : null,
    })),
  ];
  return (
    <div className="rv-kinds" role="group" aria-label="Kind">
      {options.map((option) => (
        <button
          key={option.value ?? ""}
          type="button"
          className="pill rv-kinds__chip"
          aria-pressed={option.value === kind}
          onClick={() => {
            if (option.value !== kind) onKind(option.value);
          }}
        >
          {option.label}
          {option.count !== null && option.count > 0 && (
            <>
              {" "}
              <span className="rv-kinds__count" title={`${option.count} proposed`}>
                {option.count} <span className="sr-only">proposed</span>
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** How long the search box waits after the last key before it searches. */
export const SEARCH_WAIT_MS = 250;

interface SearchProps {
  /** The search in the URL. */
  q: string;
  /** Called with the trimmed text once typing pauses, at once on Enter or Escape; "" searches nothing. */
  onSearch(q: string): void;
}

/** A search over the terms, labels and words; it searches once typing pauses. */
export function SearchBox({ q, onSearch }: SearchProps) {
  const [text, setText] = useState(q);
  // The search last handed on: the URL catches up with it a moment later.
  const sent = useRef(q);
  const latest = useRef(onSearch);
  useEffect(() => {
    latest.current = onSearch;
  });

  const search = (value: string) => {
    if (value === sent.current) return;
    sent.current = value;
    latest.current(value);
  };

  // The URL's search moved by itself (Back, a link): the box follows it. Its own searches arriving do not count.
  useEffect(() => {
    if (q === sent.current) return;
    sent.current = q;
    setText(q);
  }, [q]);

  // Every key starts the wait again; `search` reads only refs, so the text alone restarts it.
  useEffect(() => {
    const value = text.trim();
    if (value === sent.current) return;
    const timer = setTimeout(() => search(value), SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      search(text.trim());
    } else if (event.key === "Escape" && text !== "") {
      event.preventDefault();
      setText("");
      search("");
    }
  };

  return (
    <div className="rv-search" role="search">
      <input
        type="search"
        className="rv-input rv-search__input"
        aria-label="Search entries"
        placeholder="Search terms, labels and words"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

interface SortProps {
  sort: RegistrySort;
  onSort(sort: RegistrySort): void;
}

/** The list's order: last asked, most asked, last changed. */
export function SortSelect({ sort, onSort }: SortProps) {
  const id = useId();
  return (
    <span className="rv-sort">
      <label htmlFor={id} className="rv-sort__label">
        Sort
      </label>
      <select
        id={id}
        className="rv-sort__select"
        value={sort}
        onChange={(event) => {
          const next = SORTS.find((candidate) => candidate === event.target.value);
          if (next && next !== sort) onSort(next);
        }}
      >
        {SORTS.map((candidate) => (
          <option key={candidate} value={candidate}>
            {SORT_LABEL[candidate]}
          </option>
        ))}
      </select>
    </span>
  );
}
