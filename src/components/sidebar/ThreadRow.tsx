import { NavLink } from "react-router";
import { isWorking, type ThreadSummary } from "../../api/types";
import { WorkingCube } from "../working/WorkingCube";
import { relativeTime } from "./groupThreads";
import { threadPath } from "./paths";

interface Props {
  ws: string;
  thread: ThreadSummary;
  now: number;
}

/** One past question: its text, a mark while it works, asks or has failed, and when it last moved. */
export function ThreadRow({ ws, thread, now }: Props) {
  return (
    <li>
      <NavLink to={threadPath(ws, thread.id)} className="thread-row" title={thread.question}>
        <span className="thread-row__question">{thread.question}</span>
        <StatusMark status={thread.status} />
        <time className="thread-row__time" dateTime={thread.updated_at}>
          {relativeTime(thread.updated_at, now)}
        </time>
      </NavLink>
    </li>
  );
}

function StatusMark({ status }: { status: ThreadSummary["status"] }) {
  if (isWorking(status)) return <WorkingCube state="working" size={14} label="Working" />;
  if (status === "asking") return <WorkingCube state="asking" size={14} label="Waiting for you" />;
  if (status === "failed") return <span className="thread-row__failed" role="img" aria-label="Failed" />;
  // Complete, clarify, cancelled and superseded carry no mark: nothing waits, and the thread tells how it ended.
  return null;
}
