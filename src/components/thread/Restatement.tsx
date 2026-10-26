import { isWorking, type RunView } from "../../api/types";

/** What sightline understood ("You want to see …"), or that it is still working it out. */
export function Restatement({ run }: { run: RunView }) {
  if (run.restatement) return <p className="tx-restatement">{run.restatement}</p>;
  if (isWorking(run.status)) {
    return <p className="tx-restatement tx-restatement--pending">Working out what you mean…</p>;
  }
  return null;
}
