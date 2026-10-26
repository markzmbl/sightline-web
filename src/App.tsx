import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Outlet, RouterProvider, useLocation, useOutletContext, useParams, type DataRouter } from "react-router";
import { createQueryClient } from "./api/queries";
import { PanelIcon } from "./components/sidebar/icons";
import { Sidebar } from "./components/sidebar/Sidebar";
import "./components/shell.css";

/** The app: one query client for its whole life, around the router. */
export function App({ router }: { router: DataRouter }) {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

/** What the shell hands the pages inside it. */
export interface ShellContext {
  ws: string;
  /** The button that brings the sidebar back; null while the sidebar shows. Pages put it first in their header. */
  sidebarButton: ReactNode;
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

const COLLAPSED_KEY = "sightline.sidebar";
// Below the chat column's width the sidebar becomes a drawer over the page.
const NARROW = "(max-width: 759.98px)";

/** The layout of /w/:ws: the sidebar beside the page, like the Claude desktop app. */
export function Shell() {
  const { ws = "" } = useParams();
  const { pathname } = useLocation();
  const narrow = useMediaQuery(NARROW);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  // The control pressed goes away with the change, so focus moves on once it is done.
  const focusNext = useRef<RefObject<HTMLElement | null> | null>(null);
  const hidden = narrow ? !drawerOpen : collapsed;
  // The open drawer is a modal: the page under the scrim is out of reach until it closes.
  const modal = narrow && drawerOpen;

  useEffect(() => {
    // Focus left inside a sidebar that went away (the workspace switcher navigated, say)
    // goes on from the button that brings it back.
    const stranded = hidden && sidebar.current?.contains(document.activeElement) ? opener.current : null;
    (focusNext.current?.current ?? stranded)?.focus();
    focusNext.current = null;
  }, [hidden]);

  // Navigating closes the drawer, and so does a window grown wide enough for the sidebar.
  useEffect(() => setDrawerOpen(false), [pathname, narrow]);

  // A link followed in the drawer to another page: the drawer closes before that page renders,
  // so the button focus went to leaves with the old page. Once the new page is in (and has taken
  // focus itself, if it does), focus left nowhere goes on from the new page's button.
  const followed = useRef(false);
  useEffect(() => {
    if (!followed.current) return;
    followed.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) opener.current?.focus();
  }, [pathname]);

  // Escape closes the drawer, before the status line can take it for "stop the run".
  useEffect(() => {
    if (!narrow || !drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // In a search box with text, Escape clears the text first (the box prevents the default itself).
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "search" && target.value) return;
      event.preventDefault();
      focusNext.current = opener;
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [narrow, drawerOpen]);

  const setStoredCollapsed = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(COLLAPSED_KEY, value ? "collapsed" : "open");
    } catch {
      // Storage may be blocked; the choice then lasts for this page only.
    }
  };

  const show = () => {
    focusNext.current = sidebar;
    if (narrow) setDrawerOpen(true);
    else setStoredCollapsed(false);
  };
  const hide = () => {
    focusNext.current = opener;
    if (narrow) setDrawerOpen(false);
    else setStoredCollapsed(true);
  };

  const sidebarButton = hidden ? (
    <button
      ref={opener}
      type="button"
      className="icon-button"
      onClick={show}
      aria-label="Open sidebar"
      aria-controls="sidebar"
      aria-expanded={false}
      title="Open sidebar"
    >
      <PanelIcon />
    </button>
  ) : null;

  const classes = ["shell", narrow ? "shell--narrow" : "", hidden ? "shell--hidden" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <div
        className="shell__sidebar"
        onClick={(event) => {
          // A link in the drawer closes it, even one to the page already open. Focus goes to
          // the button that reopens it; a page the link opens anew takes it from there.
          const link = narrow && event.target instanceof Element ? event.target.closest("a") : null;
          if (link) {
            focusNext.current = opener;
            followed.current = link.pathname !== pathname;
            setDrawerOpen(false);
          }
        }}
      >
        <Sidebar
          ws={ws}
          hidden={hidden}
          modal={modal}
          onHide={hide}
          hideLabel={narrow ? "Close sidebar" : "Collapse sidebar"}
          ref={sidebar}
        />
      </div>
      {modal && <div className="shell__scrim" aria-hidden="true" onClick={hide} />}
      <main className="shell__main" inert={modal}>
        <Outlet context={{ ws, sidebarButton } satisfies ShellContext} />
      </main>
    </div>
  );
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
