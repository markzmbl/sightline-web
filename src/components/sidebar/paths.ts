// The app's URLs in one place, so a workspace or thread id is always encoded the same way.

export const workspacePath = (ws: string): string => `/w/${encodeURIComponent(ws)}`;

export const threadPath = (ws: string, threadId: string): string =>
  `${workspacePath(ws)}/t/${encodeURIComponent(threadId)}`;

/** The key user's review view, or one entry in it. */
export const reviewPath = (ws: string, entryId?: string): string =>
  `${workspacePath(ws)}/review${entryId === undefined ? "" : `/${encodeURIComponent(entryId)}`}`;
