import { useNavigate } from "react-router";
import { useMe } from "../../api/queries";
import { ChevronIcon } from "./icons";
import { workspacePath } from "./paths";

/** The workspace picker: a native select dressed as a pill; choosing one opens it. */
export function WorkspaceSwitcher({ ws }: { ws: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const workspaces = me.data?.workspaces ?? [];
  // Until the list arrives (or if the URL names one it lacks), the current id still shows.
  const known = workspaces.some((w) => w.id === ws);

  return (
    <label className="switcher">
      <span className="sr-only">Workspace</span>
      <select
        className="switcher__select"
        value={ws}
        disabled={workspaces.length === 0}
        onChange={(event) => navigate(workspacePath(event.target.value))}
      >
        {!known && <option value={ws}>{me.isPending ? "Loading…" : ws}</option>}
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <span className="switcher__chevron">
        <ChevronIcon />
      </span>
    </label>
  );
}
