import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryCounts, RunView, ThreadSummary } from "../src/api/types";

// The data layer, the transcript and the review page stand in as stubs: this checks the shell's own behaviour.
const api = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let version = 0;
  const state = {
    create: (_: { question: string }): Promise<{ thread_id: string }> => new Promise(() => {}),
    threads: [] as ThreadSummary[],
    activeRun: null as RunView | null,
    revising: false,
    revised: [] as { message: string }[],
    cancelled: [] as { runId: string }[],
    counts: { data: undefined, isPending: true, isError: false } as {
      data: RegistryCounts | undefined;
      isPending: boolean;
      isError: boolean;
    },
    /** The workspace of every useRegistryCounts call. */
    countsFor: [] as string[],
  };
  return Object.assign(state, {
    /** Changes what the stubs return, and renders the stubbed hooks that read it again. */
    set(patch: Partial<typeof state>) {
      Object.assign(state, patch);
      version += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => version,
  });
});

vi.mock("../src/api/queries", async () => {
  const { useSyncExternalStore } = await import("react");
  const useApi = () => useSyncExternalStore(api.subscribe, api.version);
  const mutation = () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false, isError: false, error: null, submittedAt: 0, reset: () => {} });
  return {
    useMe: () => ({ data: { user: { name: "Ada" }, workspaces: [{ id: "mf", name: "Manufacturing" }] }, isPending: false, isError: false }),
    useThreads: () => ({ data: api.threads, isPending: false, isError: false }),
    useCreateThread: () => ({ ...mutation(), mutateAsync: (vars: { question: string }) => api.create(vars) }),
    useLiveThread: (_ws: string, threadId: string) => {
      useApi();
      return {
        thread: { id: threadId, question: `Question ${threadId}`, runs: [] },
        runs: [],
        activeRun: api.activeRun,
        isLoading: false,
        error: null,
        streamError: null,
      };
    },
    useRevise: () => {
      useApi();
      return {
        ...mutation(),
        isPending: api.revising,
        // Like react-query, mutate is pending at once, until a test lets the thread catch up.
        mutate: (vars: { message: string }) => api.set({ revised: [...api.revised, vars], revising: true }),
        mutateAsync: async (vars: { message: string }) => {
          api.revised.push(vars);
          return { thread_id: "t1", run_id: "r2" };
        },
      };
    },
    useTakeBack: mutation,
    useAnswer: mutation,
    useCancel: () => ({ ...mutation(), mutate: (vars: { runId: string }) => void api.cancelled.push(vars) }),
    usePickChart: mutation,
    useFeedback: mutation,
  };
});
vi.mock("../src/api/registry", () => ({
  useRegistryCounts: (ws: string) => {
    api.countsFor.push(ws);
    return api.counts;
  },
}));
// Stands for the transcript's one-click suggestions (clarify's nearest answerable questions).
vi.mock("../src/components/thread/Transcript", async () => {
  const { createElement } = await import("react");
  return {
    Transcript: ({ actions }: { actions: { onRevise?(text: string): void } }) =>
      createElement("button", { type: "button", onClick: () => actions.onRevise?.("OEE by plant") }, "Suggested revision"),
  };
});
// Puts the sidebar button first in its header, like every page in the shell; entry "broken" fails to render.
vi.mock("../src/pages/ReviewPage", async () => {
  const { createElement } = await import("react");
  const { useParams } = await import("react-router");
  const { useShell } = await import("../src/App");
  return {
    ReviewPage: () => {
      const { sidebarButton } = useShell();
      const { entryId = "list" } = useParams();
      if (entryId === "broken") throw new Error("The entry would not render");
      return createElement("header", null, sidebarButton, createElement("h1", null, `Review ${entryId}`));
    },
  };
});

const { routes } = await import("../src/routes");

const now = new Date().toISOString();
const summary = (id: string, question: string, status: ThreadSummary["status"] = "complete"): ThreadSummary => ({
  id,
  question,
  restatement: null,
  status,
  active_run_id: null,
  revisions: 0,
  updated_at: now,
});

const run = (over: Partial<RunView>): RunView => ({
  id: "r1",
  thread_id: "t1",
  revision: 0,
  prompt: "OEE by line",
  status: "running",
  phase: null,
  stage: null,
  started_at: null,
  finished_at: null,
  restatement: null,
  card: null,
  clarify: null,
  result: null,
  timings: [],
  error: null,
  feedback: null,
  last_event_id: 0,
  ...over,
});

function renderAt(path: string, { narrow = false } = {}) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

const main = () => document.querySelector<HTMLElement>("main.shell__main")!;
const sidebar = () => document.getElementById("sidebar")!;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  api.threads = [summary("t1", "OEE by line"), summary("t2", "Scrap rate by shift")];
  api.activeRun = null;
  api.revising = false;
  api.revised = [];
  api.cancelled = [];
  api.counts = { data: undefined, isPending: true, isError: false };
  api.countsFor = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the shell on a narrow screen", () => {
  it("makes the open drawer modal: the page under it is inert", async () => {
    renderAt("/w/mf/t/t1", { narrow: true });
    expect(main().hasAttribute("inert")).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open sidebar" })));
    expect(main().hasAttribute("inert")).toBe(true);
    expect(sidebar().getAttribute("role")).toBe("dialog");
    expect(sidebar().getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(sidebar());

    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(main().hasAttribute("inert")).toBe(false);
    expect(sidebar().getAttribute("role")).toBe(null);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open sidebar" }));
  });

  it("keeps focus in the page after a thread is opened from the drawer", async () => {
    const router = renderAt("/w/mf/t/t1", { narrow: true });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open sidebar" })));
    const row = screen.getByRole("link", { name: /Scrap rate by shift/ });
    row.focus();
    await act(async () => fireEvent.click(row));
    expect(router.state.location.pathname).toBe("/w/mf/t/t2");
    expect(main().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(main().contains(document.activeElement)).toBe(true);
  });

  it("closes the drawer when the review entry is followed", async () => {
    const router = renderAt("/w/mf/t/t1", { narrow: true });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open sidebar" })));
    await act(async () => fireEvent.click(within(sidebar()).getByRole("link", { name: /^Review/ })));
    expect(router.state.location.pathname).toBe("/w/mf/review");
    expect(main().hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("heading", { name: "Review list" })).toBeTruthy();
    // The link went away with the drawer; focus goes on from the button that brings it back.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open sidebar" }));
  });
});

describe("asking a new question", () => {
  it("opens the new thread with the composer focused, ready for a revision", async () => {
    api.create = async () => ({ thread_id: "t9" });
    const router = renderAt("/w/mf");
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "OEE last week" } });
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox", { name: "Your question" }), { key: "Enter" }));
    expect(router.state.location.pathname).toBe("/w/mf/t/t9");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Revise the question" }));
  });

  it("does not pull the user back once they have gone elsewhere", async () => {
    let created: (value: { thread_id: string }) => void = () => {};
    api.create = () => new Promise((resolve) => (created = resolve));
    const router = renderAt("/w/mf");
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "OEE last week" } });
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox", { name: "Your question" }), { key: "Enter" }));
    await act(async () => fireEvent.click(within(sidebar()).getByRole("link", { name: /OEE by line/ })));
    expect(router.state.location.pathname).toBe("/w/mf/t/t1");
    await act(async () => created({ thread_id: "t9" }));
    expect(router.state.location.pathname).toBe("/w/mf/t/t1");
  });

  it("offers a question asked twice once, by its latest thread, and at most three", () => {
    api.threads = [
      summary("t5", "OEE by line"),
      summary("t4", "  oee BY LINE "),
      summary("t3", "Scrap rate by shift"),
      summary("t2", "OEE by line"),
      summary("t1", "Downtime per plant"),
      summary("t0", "Yield last month"),
    ];
    renderAt("/w/mf");
    const pills = within(screen.getByRole("navigation", { name: "Recent questions" })).getAllByRole("link");
    expect(pills.map((pill) => [pill.textContent, pill.getAttribute("href")])).toEqual([
      ["OEE by line", "/w/mf/t/t5"],
      ["Scrap rate by shift", "/w/mf/t/t3"],
      ["Downtime per plant", "/w/mf/t/t1"],
    ]);
  });
});

describe("the sidebar's review entry", () => {
  const review = () => within(sidebar()).getByRole("link", { name: /^Review/ });

  it("counts the proposals of every kind in its badge, for the workspace open", () => {
    api.counts = { data: { measure: 2, default: 1, gap: 2 }, isPending: false, isError: false };
    renderAt("/w/mf");
    expect(review().getAttribute("aria-label")).toBe("Review, 5 proposed");
    expect(review().getAttribute("href")).toBe("/w/mf/review");
    expect(review().querySelector(".sidebar__badge")?.textContent).toBe("5");
    expect(api.countsFor.length).toBeGreaterThan(0);
    expect(new Set(api.countsFor)).toEqual(new Set(["mf"]));
  });

  it("caps the badge at 99+, and says the real number", () => {
    api.counts = { data: { measure: 60, default: 30, gap: 12 }, isPending: false, isError: false };
    renderAt("/w/mf");
    expect(review().querySelector(".sidebar__badge")?.textContent).toBe("99+");
    expect(review().getAttribute("aria-label")).toBe("Review, 102 proposed");
  });

  it("shows no badge when the counts could not be loaded", () => {
    api.counts = { data: undefined, isPending: false, isError: true };
    renderAt("/w/mf");
    expect(review().querySelector(".sidebar__badge")).toBeNull();
    expect(within(sidebar()).getByRole("link", { name: "Review" })).toBe(review());
  });

  it("shows no badge while the counts load, nor when nothing is proposed", () => {
    renderAt("/w/mf");
    expect(review().querySelector(".sidebar__badge")).toBeNull();
    expect(review().getAttribute("aria-label")).toBeNull();
    expect(review().textContent).toBe("Review");
    cleanup();

    api.counts = { data: { measure: 0, default: 0, gap: 0 }, isPending: false, isError: false };
    renderAt("/w/mf");
    expect(review().querySelector(".sidebar__badge")).toBeNull();
    expect(review().textContent).toBe("Review");
  });

  it("is the current page on the review list and on an entry, and not elsewhere", () => {
    renderAt("/w/mf/review");
    expect(review().getAttribute("aria-current")).toBe("page");
    cleanup();
    renderAt("/w/mf/review/m_oee");
    expect(review().getAttribute("aria-current")).toBe("page");
    cleanup();
    renderAt("/w/mf/t/t1");
    expect(review().getAttribute("aria-current")).toBeNull();
  });
});

describe("the review routes", () => {
  it("open the review page inside the shell, from the sidebar", async () => {
    const router = renderAt("/w/mf");
    await act(async () => fireEvent.click(within(sidebar()).getByRole("link", { name: /^Review/ })));
    expect(router.state.location.pathname).toBe("/w/mf/review");
    expect(within(main()).getByRole("heading", { name: "Review list" })).toBeTruthy();
  });

  it("open one entry by its id", () => {
    renderAt("/w/mf/review/m_oee");
    expect(within(main()).getByRole("heading", { name: "Review m_oee" })).toBeTruthy();
    expect(sidebar()).toBeTruthy();
  });
});

describe("a page that fails", () => {
  it("shows its fault inside the shell, with the sidebar and the way back still there", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = renderAt("/w/mf/review/broken");
      expect(within(main()).getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
      expect(within(main()).getByText("The entry would not render")).toBeTruthy();
      expect(within(main()).getByRole("link", { name: "Back to your questions" }).getAttribute("href")).toBe("/w/mf");
      // Another page, opened from the sidebar, renders again.
      await act(async () => fireEvent.click(within(sidebar()).getByRole("link", { name: /Scrap rate by shift/ })));
      expect(router.state.location.pathname).toBe("/w/mf/t/t2");
      expect(within(main()).getByRole("heading", { name: "Question t2" })).toBeTruthy();
    } finally {
      quiet.mockRestore();
    }
  });

  it("keeps the button that brings a collapsed sidebar back", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      localStorage.setItem("sightline.sidebar", "collapsed");
      renderAt("/w/mf/review/broken");
      expect(within(main()).getByRole("button", { name: "Open sidebar" })).toBeTruthy();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("the sidebar's thread rows", () => {
  it("mark a thread that works or failed, and none that was superseded or cancelled", () => {
    api.threads = [
      summary("t1", "Alpha", "superseded"),
      summary("t2", "Bravo", "cancelled"),
      summary("t3", "Charlie", "running"),
      summary("t4", "Delta", "failed"),
    ];
    renderAt("/w/mf");
    const mark = (question: string) =>
      within(within(sidebar()).getByRole("link", { name: new RegExp(question) })).queryByRole("img");
    expect(mark("Alpha")).toBeNull();
    expect(mark("Bravo")).toBeNull();
    expect(mark("Charlie")?.getAttribute("aria-label")).toBe("Working");
    expect(mark("Delta")?.getAttribute("aria-label")).toBe("Failed");
  });
});

describe("the thread page", () => {
  it("sends a suggested question as a revision, as if it were typed", async () => {
    renderAt("/w/mf/t/t1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggested revision" })));
    expect(api.revised).toEqual([{ message: "OEE by plant" }]);
  });

  it("moves focus to the composer from a suggestion, which folds away with its turn", async () => {
    renderAt("/w/mf/t/t1");
    const suggestion = screen.getByRole("button", { name: "Suggested revision" });
    suggestion.focus();
    expect(document.activeElement).toBe(suggestion);
    await act(async () => fireEvent.click(suggestion));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Revise the question" }));
  });

  it("posts a revision during a run directly, without stopping the run first", async () => {
    api.activeRun = run({ status: "running", stage: "query", phase: "fetch" });
    renderAt("/w/mf/t/t1");
    const box = screen.getByRole("textbox", { name: "Revise the question" });
    fireEvent.change(box, { target: { value: "by shift instead" } });
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(api.revised).toEqual([{ message: "by shift instead" }]);
    expect(api.cancelled).toEqual([]);
  });

  it("shows the open run's stage, with a way to stop it", async () => {
    api.activeRun = run({ status: "running", stage: "query", phase: "fetch" });
    renderAt("/w/mf/t/t1");
    expect(screen.getByRole("status").textContent).toContain("Querying");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    expect(api.cancelled).toEqual([{ runId: "r1" }]);
  });

  it("shows the revision's run starting at once, not the run it supersedes", () => {
    api.activeRun = run({ status: "running", stage: "query", phase: "fetch" });
    api.revising = true;
    renderAt("/w/mf/t/t1");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Starting");
    expect(status.textContent).not.toContain("Querying");
    expect(status.textContent).not.toContain("fetch");
    // No id to stop yet: neither the status line nor the composer offers it.
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("hands the status line from the run a revision supersedes to the revision's run", async () => {
    api.activeRun = run({ id: "r1", status: "running", stage: "query", phase: "fetch" });
    renderAt("/w/mf/t/t1");
    expect(screen.getByRole("status").textContent).toContain("Querying");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggested revision" })));
    // On its way: the new run shows starting at once, and the old one can no longer be stopped from here.
    expect(screen.getByRole("status").textContent).toContain("Starting");
    expect(screen.getByRole("status").textContent).not.toContain("Querying");
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();

    // The thread caught up: the revision's run is the active one, with its own stage and stop.
    await act(async () =>
      api.set({
        revising: false,
        activeRun: run({ id: "r2", revision: 1, prompt: "OEE by plant", stage: "abstract", phase: "understand" }),
      }),
    );
    expect(screen.getByRole("status").textContent).toContain("Abstracting");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    expect(api.cancelled).toEqual([{ runId: "r2" }]);
  });

  it("shows no status line for a superseded run", () => {
    api.activeRun = run({ status: "superseded", stage: "query", phase: "fetch" });
    renderAt("/w/mf/t/t1");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
