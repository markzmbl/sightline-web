import { NavLink } from "react-router";
import { useRegistryCounts } from "../../api/registry";
import type { RegistryCounts } from "../../api/types";
import { ReviewIcon } from "./icons";
import { reviewPath } from "./paths";

/** The way to the key user's review view, with how many proposals wait there. */
export function ReviewLink({ ws }: { ws: string }) {
  const counts = useRegistryCounts(ws);
  // Loading or failed: no badge, rather than a 0 that may not be true.
  const proposed = counts.data ? totalProposed(counts.data) : 0;

  return (
    <NavLink
      to={reviewPath(ws)}
      className="sidebar__review"
      aria-label={proposed > 0 ? `Review, ${proposed} proposed` : undefined}
    >
      <ReviewIcon />
      <span className="sidebar__review-label">Review</span>
      {proposed > 0 && (
        <span className="sidebar__badge" aria-hidden="true">
          {proposed > 99 ? "99+" : proposed}
        </span>
      )}
    </NavLink>
  );
}

/** Proposed entries over every kind, a kind this client does not know yet included. */
function totalProposed(counts: RegistryCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0);
}
