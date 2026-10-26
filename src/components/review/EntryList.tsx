import { useMemo, useRef, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useRegistry, type RegistryFilters } from "../../api/registry";
import type { RegistryEntry, RegistryKind, RegistryStatus } from "../../api/types";
import { ago, emptyText, KIND_LABEL, reviewPath, STATUS_LABEL } from "./format";
import { useNow } from "./useNow";
import "./review.css";

interface Props {
  ws: string;
  status: RegistryStatus;
  kind: RegistryKind | null;
  /** The entry open beside the list, if any. */
  selected: string | null;
  /** The page's search ("?status=…"), kept on every row's link. */
  search: string;
}

const MOVES = ["ArrowDown", "ArrowUp", "Home", "End"];

/** The entries of one tab and kind, most recently asked first, page by page. */
export function EntryList({ ws, status, kind, selected, search }: Props) {
  const filters = useMemo<RegistryFilters>(() => (kind ? { status, kind } : { status }), [status, kind]);
  const registry = useRegistry(ws, filters);
  const navigate = useNavigate();
  const now = useNow();
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const entries = useMemo(() => registry.data?.pages.flatMap((page) => page.items) ?? [], [registry.data]);

  if (registry.isPending) {
    return (
      <div className="rv-list" aria-busy="true">
        <span className="sr-only">Loading entries</span>
        {[78, 60, 86, 68, 74].map((width, i) => (
          <span key={i} className="rv-list__bone" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }

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

  if (entries.length === 0) return <p className="rv-list rv-list__note">{emptyText(status, kind)}</p>;

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
    <div className="rv-list">
      <ul className="rv-list__rows" aria-label="Entries" onKeyDown={onKeyDown}>
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
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

interface RowProps {
  entry: RegistryEntry;
  to: string;
  selected: boolean;
  now: number;
  ref(element: HTMLAnchorElement | null): void;
}

/** One entry: its term and label, its kind and source, how often it was asked, and its status. */
function EntryRow({ entry, to, selected, now, ref }: RowProps) {
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
          <span className="rv-chip">{KIND_LABEL[entry.kind]}</span>
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
