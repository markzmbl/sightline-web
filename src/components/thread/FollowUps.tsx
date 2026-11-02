import type { FollowUp } from "../../api/types";
import { FOLLOW_UP_KIND } from "./words";

interface Props {
  followUps: FollowUp[];
  busy: boolean;
  /** Sends one; absent, they are a record and show as plain text. */
  onFollowUp?: (followUp: FollowUp) => void;
  /** Shows each one's kind; off where the heading already says it, as clarify's "instead". */
  tagged?: boolean;
  /** The list's accessible name, or the id of the element that names it. */
  label?: string;
  labelledBy?: string;
}

/**
 * The questions sightline offers to ask next, each a full question sent unchanged: as
 * chips on the thread's latest run, as plain text on an earlier one.
 */
export function FollowUps({ followUps, busy, onFollowUp, tagged = true, label, labelledBy }: Props) {
  if (followUps.length === 0) return null;
  const named = { "aria-label": labelledBy ? undefined : label, "aria-labelledby": labelledBy };
  if (!onFollowUp) {
    return (
      <ul className="tx-follow tx-follow--record" {...named}>
        {followUps.map((followUp) => (
          <li key={followUp.id}>
            {tagged && <span className="tx-follow__kind">{FOLLOW_UP_KIND[followUp.kind]}</span>}
            <span className="tx-follow__question">{followUp.question}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="tx-follow" {...named}>
      {followUps.map((followUp) => (
        <li key={followUp.id}>
          <button
            type="button"
            className="tx-follow__chip"
            aria-label={tagged ? `${FOLLOW_UP_KIND[followUp.kind]}: ${followUp.question}` : undefined}
            title={tagged ? undefined : "Ask this instead"}
            disabled={busy}
            onClick={() => onFollowUp(followUp)}
          >
            {tagged && <span className="tx-follow__kind">{FOLLOW_UP_KIND[followUp.kind]}</span>}
            <span className="tx-follow__question">{followUp.question}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
