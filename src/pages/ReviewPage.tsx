import { useEffect, useId } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { useRegistryCounts, useRegistryKinds, type RegistrySort } from "../api/registry";
import type { RegistryKind, RegistryStatus } from "../api/types";
import { useShell } from "../App";
import { EntryDetail } from "../components/review/EntryDetail";
import { EntryList, ListSkeleton } from "../components/review/EntryList";
import { DEFAULT_SORT, kindAwaited, kindParam, reviewPath, sortParam, statusParam } from "../components/review/format";
import { BackIcon } from "../components/review/icons";
import { KindChips, SearchBox, SortSelect, StatusTabs, tabId } from "../components/review/ReviewFilters";
import "./ReviewPage.css";

// Route: /w/:ws/review and /w/:ws/review/:entryId, inside the app shell. The list's filters live
// in the URL (?status=approved&kind=measure&q=oee&sort=demand), so a link or Back keeps them.

type Filter = "status" | "kind" | "q" | "sort";

/** The key user's review of what sightline proposes: list on the left, the entry on the right. */
export function ReviewPage(): React.JSX.Element {
  const { ws, sidebarButton } = useShell();
  const { entryId = null } = useParams();
  const [params, setParams] = useSearchParams();
  const { search } = useLocation();
  const counts = useRegistryCounts(ws);
  const kinds = useRegistryKinds(ws);
  const status = statusParam(params.get("status"));
  const urlKind = params.get("kind");
  const kind = kindParam(urlKind, kinds.data);
  // A kind this client does not know holds the list until the server's kinds say whether it is one
  // (it filters) or not (it is dropped); the chips show it pressed meanwhile. Kinds that fail drop it.
  const held = kinds.isPending && kindAwaited(urlKind, kinds.data);
  const q = params.get("q")?.trim() ?? "";
  const sort = sortParam(params.get("sort"));
  const id = useId();
  const panelId = `${id}-panel`;

  useEffect(() => {
    document.title = "Review · sightline";
    return () => {
      document.title = "sightline";
    };
  }, []);

  // A filter left at its default leaves the URL: /review is the proposed entries of every kind, last asked first.
  const setFilter = (key: Filter, value: string | null) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };
  const onStatus = (next: RegistryStatus) => setFilter("status", next === "proposed" ? null : next);
  const onKind = (next: RegistryKind | null) => setFilter("kind", next);
  const onSearch = (next: string) => setFilter("q", next || null);
  const onSort = (next: RegistrySort) => setFilter("sort", next === DEFAULT_SORT ? null : next);

  const list = reviewPath(ws, null, search);
  const back = (
    <Link to={list} className="review__back">
      <BackIcon />
      All entries
    </Link>
  );

  return (
    <div className="review">
      <header className="shell__bar review__head">
        {sidebarButton}
        <div className="review__heading">
          <h1 className="review__title">Review</h1>
          <p className="review__lede">
            What sightline proposes for your workspace. Approve what is right; reject what is not.
          </p>
        </div>
      </header>
      <div className={entryId ? "review__split review__split--open" : "review__split"}>
        <div className="review__master">
          <StatusTabs status={status} counts={counts.data} idPrefix={id} panelId={panelId} onStatus={onStatus} />
          <div id={panelId} role="tabpanel" aria-labelledby={tabId(id, status)} className="review__panel">
            <KindChips
              kind={held && urlKind ? (urlKind as RegistryKind) : kind}
              kinds={kinds.data}
              counts={counts.data}
              onKind={onKind}
            />
            <div className="review__tools">
              <SearchBox q={q} onSearch={onSearch} />
              <SortSelect sort={sort} onSort={onSort} />
            </div>
            {held ? (
              <ListSkeleton />
            ) : (
              <EntryList
                ws={ws}
                status={status}
                kind={kind}
                q={q}
                sort={sort}
                kinds={kinds.data}
                selected={entryId}
                search={search}
              />
            )}
          </div>
        </div>
        <div className="review__detail">
          {entryId ? (
            <EntryDetail key={`${ws}/${entryId}`} ws={ws} entryId={entryId} back={back} list={list} kinds={kinds.data} />
          ) : (
            <p className="review__placeholder">Pick an entry to review it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
