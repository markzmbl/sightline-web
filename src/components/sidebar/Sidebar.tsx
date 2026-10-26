import { useState, type Ref } from "react";
import { Link } from "react-router";
import { useMe } from "../../api/queries";
import { ThemeToggle } from "../ThemeToggle";
import { WorkingCube } from "../working/WorkingCube";
import { PanelIcon, PlusIcon, SearchIcon } from "./icons";
import { workspacePath } from "./paths";
import { ReviewLink } from "./ReviewLink";
import { ThreadList } from "./ThreadList";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import "./sidebar.css";

interface Props {
  ws: string;
  /** Collapsed, or a closed drawer: out of sight and out of the tab order. */
  hidden: boolean;
  /** An open drawer over the page: announced as a modal dialog. */
  modal?: boolean;
  /** Collapses the sidebar, or closes the drawer on a narrow screen. */
  onHide(): void;
  hideLabel: string;
  ref?: Ref<HTMLElement>;
}

/** The left column: brand, workspace, new question, search, past questions, review, and who is signed in. */
export function Sidebar({ ws, hidden, modal = false, onHide, hideLabel, ref }: Props) {
  const [query, setQuery] = useState("");
  const me = useMe();
  const name = me.data?.user.name;

  return (
    <aside
      id="sidebar"
      className="sidebar"
      aria-label="Sidebar"
      role={modal ? "dialog" : undefined}
      aria-modal={modal || undefined}
      inert={hidden}
      tabIndex={-1}
      ref={ref}
    >
      <div className="sidebar__brand">
        <Link to={workspacePath(ws)} className="sidebar__logo">
          <span aria-hidden="true">
            <WorkingCube size={18} />
          </span>
          <span>sightline</span>
        </Link>
        <button type="button" className="icon-button" onClick={onHide} aria-label={hideLabel} title={hideLabel}>
          <PanelIcon />
        </button>
      </div>

      <div className="sidebar__actions">
        <WorkspaceSwitcher ws={ws} />
        <Link to={workspacePath(ws)} className="sidebar__new">
          <PlusIcon />
          New question
        </Link>
        <label className="sidebar__search">
          <SearchIcon />
          <span className="sr-only">Search questions</span>
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault(); // clears the search, and does not stop a run
                setQuery("");
              }
            }}
          />
        </label>
      </div>

      <ThreadList ws={ws} query={query} />

      <div className="sidebar__tools">
        <ReviewLink ws={ws} />
      </div>

      <footer className="sidebar__footer">
        <span className="sidebar__avatar" aria-hidden="true">
          {name ? name.charAt(0).toUpperCase() : ""}
        </span>
        <span className="sidebar__name">{name ?? ""}</span>
        <ThemeToggle />
      </footer>
    </aside>
  );
}
