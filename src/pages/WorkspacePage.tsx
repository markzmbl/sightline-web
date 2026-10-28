import { useEffect, useRef, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useCreateThread, useMe, useThreads } from "../api/queries";
import { useShell } from "../App";
import { Composer } from "../components/composer/Composer";
import { distinctQuestions } from "../components/sidebar/groupThreads";
import { threadPath } from "../components/sidebar/paths";
import { WorkingCube } from "../components/working/WorkingCube";
import "./WorkspacePage.css";

/** A workspace with no question open: the empty state of a new session, ready to ask. */
export function WorkspacePage() {
  const { ws, sidebarButton } = useShell();
  // A fresh page per workspace, so the composer does not carry text across.
  return <NewQuestion key={ws} ws={ws} sidebarButton={sidebarButton} />;
}

const STARTERS_SHOWN = 4;

/** The pack's example questions to offer: at most four, each once, none blank. */
function startersOf(starters: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const starter of starters) {
    const text = starter.trim();
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === STARTERS_SHOWN) break;
  }
  return kept;
}

function NewQuestion({ ws, sidebarButton }: { ws: string; sidebarButton: ReactNode }) {
  const me = useMe();
  const threads = useThreads(ws);
  const create = useCreateThread(ws);
  const navigate = useNavigate();
  const workspace = me.data?.workspaces.find((w) => w.id === ws);
  const starters = startersOf(workspace?.starters ?? []);
  // A question asked twice is offered once, by its latest thread.
  const recent = distinctQuestions(threads.data ?? [], 3);

  useEffect(() => {
    document.title = workspace ? `${workspace.name} · sightline` : "sightline";
  }, [workspace]);

  // Set in the effect, not at declaration, so StrictMode's remount leaves it true.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ask = async (question: string) => {
    const created = await create.mutateAsync({ question });
    // The user may have gone elsewhere while it was asked; the new thread waits in the sidebar.
    if (mounted.current) navigate(threadPath(ws, created.thread_id));
  };

  if (me.data && !workspace) {
    return (
      <div className="workspace">
        <header className="shell__bar">{sidebarButton}</header>
        <div className="workspace__body">
          <p className="workspace__missing">
            There is no workspace “{ws}” for you. <Link to="/">Open one of yours</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace">
      <header className="shell__bar">{sidebarButton}</header>
      <div className="workspace__body">
        <div className="workspace__hero">
          <WorkingCube size={48} />
          <h1>What do you want to know?</h1>
          <p className="muted">{workspace?.name ?? " "}</p>
        </div>
        <Composer
          placeholder="Ask a question about your data…"
          onSubmit={ask}
          autoFocus
          label="Your question"
        />
        {create.isError && (
          <p className="workspace__error" role="alert">
            Could not ask: {create.error.message}
          </p>
        )}
        {starters.length > 0 && (
          <div className="workspace__starters" role="group" aria-label="Example questions">
            {starters.map((starter) => (
              <button
                key={starter}
                type="button"
                className="pill workspace__starter"
                disabled={create.isPending}
                // A failure shows like a typed question's, above.
                onClick={() => void ask(starter).catch(() => undefined)}
              >
                {starter}
              </button>
            ))}
          </div>
        )}
        {recent.length > 0 && (
          <nav className="workspace__recent" aria-label="Recent questions">
            {recent.map((thread) => (
              <Link key={thread.id} to={threadPath(ws, thread.id)} className="pill" title={thread.question}>
                <span>{thread.question}</span>
              </Link>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
