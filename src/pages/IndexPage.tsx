import { Navigate } from "react-router";
import { useMe } from "../api/queries";
import { workspacePath } from "../components/sidebar/paths";
import { WorkingCube } from "../components/working/WorkingCube";
import "./IndexPage.css";

/** "/": straight into the workspace the caller used last, or else the first they may use. */
export function IndexPage() {
  const me = useMe();

  if (me.isPending) {
    return (
      <main className="index">
        <WorkingCube state="working" size={32} label="Loading" />
      </main>
    );
  }

  if (me.isError) {
    return (
      <main className="index">
        <div className="index__note" role="alert">
          <h1>Could not reach sightline</h1>
          <p className="muted">{me.error.message}</p>
          <button type="button" className="pill" onClick={() => void me.refetch()} disabled={me.isFetching}>
            {me.isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      </main>
    );
  }

  const { workspaces, last_workspace } = me.data;
  // The last one used, while it is still one of theirs.
  const open = workspaces.find((w) => w.id === last_workspace) ?? workspaces[0];
  if (!open) {
    return (
      <main className="index">
        <div className="index__note">
          <h1>No workspace yet</h1>
          <p className="muted">Ask an administrator to give {me.data.user.name} a workspace.</p>
        </div>
      </main>
    );
  }

  return <Navigate to={workspacePath(open.id)} replace />;
}
