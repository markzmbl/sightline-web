import { useEffect, useId, useMemo, useState } from "react";
import { useThreads } from "../../api/queries";
import { filterThreads, groupThreads, mergeThreads } from "./groupThreads";
import { ThreadRow } from "./ThreadRow";

interface Props {
  ws: string;
  /** The search box's text: filters the list here at once, and asks the server once typing pauses. */
  query: string;
}

/** How long typing must pause before the server is asked. */
const SEARCH_DELAY_MS = 300;

/** The workspace's past questions, grouped by day. */
export function ThreadList({ ws, query }: Props) {
  const threads = useThreads(ws);
  const needle = query.trim();
  const asked = useDebounced(needle, SEARCH_DELAY_MS);
  // While the box is blank this is the list above, the same query.
  const search = useThreads(ws, { q: asked });
  const now = useMinute();
  const id = useId();

  // The server's search finds what the list here cannot (a revision's prompt, a thread beyond
  // the list); its answer for the text in the box joins what the filter here found at once.
  // Until it is in, or should it fail, the filter here is the answer.
  const found = needle !== "" && asked === needle && search.isSuccess && !search.isPlaceholderData ? search.data : null;
  const groups = useMemo(() => {
    const filtered = filterThreads(threads.data ?? [], query);
    return groupThreads(found ? mergeThreads(filtered, found) : filtered, now);
  }, [threads.data, query, found, now]);

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
    // Nothing here yet, while the server still looks.
    const searching = needle !== "" && found === null && !search.isError;
    return (
      <p className="thread-list thread-list__note" aria-live="polite">
        {!needle ? "Your questions will show here." : searching ? "Searching…" : "No question matches."}
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

/** The value once it has held still for `ms`; a blank value at once, so clearing the box does not wait. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === "") {
      setSettled("");
      return;
    }
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value === "" ? "" : settled;
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
