import { useEffect, useId, useMemo, useState } from "react";
import { useThreads } from "../../api/queries";
import { filterThreads, groupThreads } from "./groupThreads";
import { ThreadRow } from "./ThreadRow";

interface Props {
  ws: string;
  /** The search box's text; filters the list here, without asking the server. */
  query: string;
}

/** The workspace's past questions, grouped by day. */
export function ThreadList({ ws, query }: Props) {
  const threads = useThreads(ws);
  const now = useMinute();
  const id = useId();
  const groups = useMemo(
    () => groupThreads(filterThreads(threads.data ?? [], query), now),
    [threads.data, query, now],
  );

  if (threads.isPending) {
    return (
      <div className="thread-list" aria-busy="true">
        <span className="sr-only">Loading questions</span>
        {[72, 56, 84, 64].map((width) => (
          <span key={width} className="thread-list__skeleton" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }

  if (threads.isError) {
    return (
      <div className="thread-list thread-list__note">
        <p>Could not load your questions.</p>
        <button type="button" className="pill" onClick={() => void threads.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <p className="thread-list thread-list__note">
        {query.trim() ? "No question matches." : "Your questions will show here."}
      </p>
    );
  }

  return (
    <nav className="thread-list" aria-label="Past questions">
      {groups.map((group, i) => (
        <section key={group.label} className="thread-list__group" aria-labelledby={`${id}-${i}`}>
          <h2 id={`${id}-${i}`} className="thread-list__label">
            {group.label}
          </h2>
          <ul>
            {group.items.map((thread) => (
              <ThreadRow key={thread.id} ws={ws} thread={thread} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** The time, refreshed every minute so "5m" and the day groups stay true. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
