import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useRegistry, type RegistryFilters, type RegistrySort } from "../../api/registry";
import type { KindInfo, RegistryEntry, RegistryKind, RegistryStatus } from "../../api/types";
import { ago, capital, DEFAULT_SORT, emptyText, kindWords, reviewPath, STATUS_LABEL } from "./format";
import { useNow } from "./useNow";
import "./review.css";

interface Props {
  ws: string;
  status: RegistryStatus;
  kind: RegistryKind | null;
  /** The search, trimmed; "" searches nothing. */
  q: string;
  sort: RegistrySort;
  /** The server's kinds and their words; undefined until they are in. */
  kinds: readonly KindInfo[] | undefined;
  /** The entry open beside the list, if any. */
  selected: string | null;
  /** The page's search ("?status=…"), kept on every row's link. */
  search: string;
}

const MOVES = ["ArrowDown", "ArrowUp", "Home", "End"];

type Data = ReturnType<typeof useRegistry>["data"];

/** The entries of one tab and kind that match the search, in the order asked for, page by page. */
export function EntryList({ ws, status, kind, q, sort, kinds, selected, search }: Props) {
  // Only what filters goes in: the server's default order is no filter.
  const filters = useMemo<RegistryFilters>(
    () => ({
      status,
      ...(kind ? { kind } : {}),
      ...(q ? { q } : {}),
      ...(sort !== DEFAULT_SORT ? { sort } : {}),
    }),
    [status, kind, q, sort],
  );
  const registry = useRegistry(ws, filters);
  const navigate = useNavigate();
  const now = useNow();
  const links = useRef(new Map<string, HTMLAnchorElement>());

  // A new search or order keeps the entries shown until its own are in, rather than blinking to
  // the skeleton at every pause in typing; a new tab or kind is another list and starts afresh.
  // Only rows are kept: a list kept empty would say the new search found nothing before it has.
  const scope = `${status}\n${kind ?? ""}`;
  const shown = useRef<{ scope: string; data: NonNullable<Data> } | null>(null);
  useEffect(() => {
    if (registry.data) shown.current = { scope, data: registry.data };
  });
  const last = shown.current;
  const kept = registry.isPending && last?.scope === scope && hasRows(last.data) ? last.data : undefined;
  const data = registry.data ?? kept;
  const stale = registry.data === undefined && kept !== undefined;
  const entries = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  if (registry.isPending && !stale) return <ListSkeleton />;

  if (registry.isError) {
    return (
      <div className="rv-list rv-list__note" role="alert">
        <p>Could not load the entries.</p>
        <p className="muted">{registry.error.message}</p>
        <button type="button" className="pill" onClick={() => void registry.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    const plural = kind ? kindWords(kinds, kind).plural : null;
    return <p className="rv-list rv-list__note">{emptyText(status, plural, q)}</p>;
  }

  // Every row is a link in the tab order, as links go; the arrow keys are a shortcut on top that
  // opens the next or the previous entry as they move.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!MOVES.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-entry]") : null;
    if (!row) return;
    const at = entries.findIndex((entry) => entry.id === row.dataset.entry);
    const to =
      event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : at + (event.key === "ArrowDown" ? 1 : -1);
    const target = entries[to];
    event.preventDefault();
    if (!target || to === at) return;
    links.current.get(target.id)?.focus();
    // Moving through the list is not a trail of pages: Back leaves the review, not each row.
    navigate(reviewPath(ws, target.id, search), { replace: true });
  };

  return (
    <div className={stale ? "rv-list rv-list--stale" : "rv-list"} aria-busy={stale || undefined}>
      <ul className="rv-list__rows" aria-label="Entries" onKeyDown={onKeyDown}>
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            kindLabel={capital(kindWords(kinds, entry.kind).label)}
            to={reviewPath(ws, entry.id, search)}
            selected={entry.id === selected}
            now={now}
            ref={(element) => {
              if (element) links.current.set(entry.id, element);
              else links.current.delete(entry.id);
            }}
          />
        ))}
      </ul>
      {registry.hasNextPage && (
        <button
          type="button"
          className="pill rv-list__more"
          disabled={registry.isFetchingNextPage}
          onClick={() => void registry.fetchNextPage()}
        >
          {registry.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

const hasRows = (data: NonNullable<Data>): boolean => data.pages.some((page) => page.items.length > 0);

/** The list while it loads: a few bones, and the words for a screen reader. */
export function ListSkeleton() {
  return (
    <div className="rv-list" aria-busy="true">
      <span className="sr-only">Loading entries</span>
      {[78, 60, 86, 68, 74].map((width, i) => (
        <span key={i} className="rv-list__bone" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

interface RowProps {
  entry: RegistryEntry;
  /** The kind in the server's words, "Data gap". */
  kindLabel: string;
  to: string;
  selected: boolean;
  now: number;
  ref(element: HTMLAnchorElement | null): void;
}

/** One entry: its term and label, its kind and source, how often it was asked, and its status. */
function EntryRow({ entry, kindLabel, to, selected, now, ref }: RowProps) {
  return (
    <li>
      <Link
        ref={ref}
        to={to}
        className="rv-row"
        data-entry={entry.id}
        aria-current={selected ? "page" : undefined}
      >
        <span className="rv-row__line">
          <span className={`rv-dot rv-dot--${entry.status}`} role="img" aria-label={STATUS_LABEL[entry.status]} />
          <span className="rv-row__term">{entry.term}</span>
          <span className="rv-row__label">{entry.label}</span>
          <span className="rv-chip">{kindLabel}</span>
        </span>
        <span className="rv-row__meta">
          <span className="rv-tag">{entry.source.kind}</span>
          <span className="rv-row__demand">{demandShort(entry, now)}</span>
        </span>
      </Link>
    </li>
  );
}

/** "asked 12× · last 3 h ago". */
function demandShort({ demand }: RegistryEntry, now: number): string {
  if (demand.runs === 0) return "not asked yet";
  const last = ago(demand.last_asked, now);
  return last ? `asked ${demand.runs}× · last ${last}` : `asked ${demand.runs}×`;
}
