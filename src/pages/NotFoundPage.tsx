import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { useShell } from "../App";
import { workspacePath } from "../components/sidebar/paths";
import { WorkingCube } from "../components/working/WorkingCube";
import "./NotFoundPage.css";

/** Any URL the app does not know. */
export function NotFoundPage() {
  return (
    <main className="notfound">
      <Note title="Nothing here" detail="This page does not exist. Your questions are one click away." to="/" />
    </main>
  );
}

/** The router's error element: a 404 reads as not found, anything else as a fault in the app. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return (
    <main className="notfound">
      <Note {...fault(error)} to="/" />
    </main>
  );
}

/**
 * The error element of the pages inside the shell: the fault shows in place of the page, in the
 * shell's <main>, and the sidebar with the way back to the threads stays.
 */
export function PageErrorPage() {
  const { ws, sidebarButton } = useShell();
  const error = useRouteError();
  const note =
    isRouteErrorResponse(error) && error.status === 404
      ? { title: "Nothing here", detail: "This page does not exist in this workspace." }
      : fault(error);
  return (
    <div className="notfound notfound--page">
      <header className="shell__bar">{sidebarButton}</header>
      <Note {...note} to={workspacePath(ws)} back="Back to your questions" />
    </div>
  );
}

function fault(error: unknown): { title: string; detail: string; failed: true } {
  const detail = error instanceof Error ? error.message : "Something went wrong while showing this page.";
  return { title: "Something went wrong", detail, failed: true };
}

interface NoteProps {
  title: string;
  detail: string;
  failed?: boolean;
  /** Where the way back leads. */
  to: string;
  back?: string;
}

function Note({ title, detail, failed = false, to, back = "Back to sightline" }: NoteProps) {
  return (
    <div className="notfound__note">
      <WorkingCube state={failed ? "failed" : "idle"} size={40} />
      <h1>{title}</h1>
      <p className="muted">{detail}</p>
      <Link to={to} className="pill">
        {back}
      </Link>
    </div>
  );
}
