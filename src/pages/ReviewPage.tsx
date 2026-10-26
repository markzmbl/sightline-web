import { useEffect, useId } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { useRegistryCounts } from "../api/registry";
import type { RegistryKind, RegistryStatus } from "../api/types";
import { useShell } from "../App";
import { EntryDetail } from "../components/review/EntryDetail";
import { EntryList } from "../components/review/EntryList";
import { kindParam, reviewPath, statusParam } from "../components/review/format";
import { BackIcon } from "../components/review/icons";
import { KindChips, StatusTabs, tabId } from "../components/review/ReviewFilters";
import "./ReviewPage.css";

// Route: /w/:ws/review and /w/:ws/review/:entryId, inside the app shell. The list's
// filters live in the URL (?status=approved&kind=measure), so a link or Back keeps them.

/** The key user's review of what sightline proposes: list on the left, the entry on the right. */
export function ReviewPage(): React.JSX.Element {
  const { ws, sidebarButton } = useShell();
  const { entryId = null } = useParams();
  const [params, setParams] = useSearchParams();
  const { search } = useLocation();
  const status = statusParam(params.get("status"));
  const kind = kindParam(params.get("kind"));
  const counts = useRegistryCounts(ws);
  const id = useId();
  const panelId = `${id}-panel`;

  useEffect(() => {
    document.title = "Review · sightline";
    return () => {
      document.title = "sightline";
    };
  }, []);

  // A filter left at its default leaves the URL: /review is the proposed entries of every kind.
  const setFilter = (key: "status" | "kind", value: string | null) => {
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

  const back = (
    <Link to={reviewPath(ws, null, search)} className="review__back">
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
            <KindChips kind={kind} counts={counts.data} onKind={onKind} />
            <EntryList ws={ws} status={status} kind={kind} selected={entryId} search={search} />
          </div>
        </div>
        <div className="review__detail">
          {entryId ? (
            <EntryDetail key={`${ws}/${entryId}`} ws={ws} entryId={entryId} back={back} />
          ) : (
            <p className="review__placeholder">Pick an entry to review it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
