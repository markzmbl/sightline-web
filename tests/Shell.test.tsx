import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { ReviseVariables } from "../src/api/queries";
import type { FollowUp, Me, RegistryCounts, RunView, ThreadSummary, Turn, Workspace } from "../src/api/types";

// The data layer, the transcript and the review page stand in as stubs: this checks the shell's own behaviour.
const api = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let version = 0;
  const state = {
    me: null as unknown as Me,
    create: (_: { question: string }): Promise<{ thread_id: string }> => new Promise(() => {}),
    created: [] as { question: string }[],
    threads: [] as ThreadSummary[],
    /** What the server's search finds, per search text; a text not here finds nothing. */
    search: {} as Record<string, ThreadSummary[]>,
    /** The search text of every useThreads call that searched. */
    searched: [] as string[],
    turns: [] as Turn[],
    activeRun: null as RunView | null,
    /** The thread's load failed: the page has no thread. */
    threadError: null as Error | null,
    expanded: [] as string[],
    opened: [] as string[],
    revising: false,
    revised: [] as ReviseVariables[],
    /** The last revision failed with this. */
    reviseFailure: null as Error | null,
    cancelled: [] as { runId: string }[],
    /** The run and follow-up the stubbed transcript's follow-up button sends. */
    followUp: null as { run: RunView; followUp: FollowUp } | null,
    /** The props the stubbed transcript last got. */
    transcript: null as { turns: Turn[]; onExpand(runId: string): void } | null,
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
  const page = (data: ThreadSummary[]) => ({ data, isPending: false, isError: false, isSuccess: true, isPlaceholderData: false });
  return {
    useMe: () => ({ data: api.me, isPending: false, isError: false }),
    useThreads: (_ws: string, options: { q?: string } = {}) => {
      const q = options.q?.trim() ?? "";
      if (!q) return page(api.threads);
      api.searched.push(q);
      return page(api.search[q] ?? []);
    },
    useCreateThread: () => ({
      ...mutation(),
      mutateAsync: (vars: { question: string }) => {
        api.created.push(vars);
        return api.create(vars);
      },
    }),
    useLiveThread: (_ws: string, threadId: string) => {
      useApi();
      return {
        thread: api.threadError ? undefined : { id: threadId, question: `Question ${threadId}`, runs: [] },
        turns: api.turns,
        activeRun: api.activeRun,
        isLoading: false,
        error: api.threadError,
        streamError: null,
        expand: (runId: string) => void api.expanded.push(runId),
      };
    },
    useThreadOpened: (ws: string, threadId: string) => void api.opened.push(`${ws}/${threadId}`),
    useRevise: () => {
      useApi();
      return {
        ...mutation(),
        isPending: api.revising,
        isError: api.reviseFailure !== null,
        error: api.reviseFailure,
        submittedAt: api.reviseFailure ? 1 : 0,
        reset: () => api.set({ reviseFailure: null }),
        // Like react-query, mutate is pending at once, until a test lets the thread catch up.
        mutate: (vars: ReviseVariables) => api.set({ revised: [...api.revised, vars], revising: true }),
        mutateAsync: async (vars: ReviseVariables) => {
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
// Stands for the transcript's one-click revisions: a clarify gap's suggestion, and a run's follow-up.
vi.mock("../src/components/thread/Transcript", async () => {
  const { createElement, Fragment } = await import("react");
  return {
    Transcript: (props: {
      turns: Turn[];
      onExpand(runId: string): void;
      actions: { onRevise?(text: string): void; onFollowUp?(run: RunView, followUp: FollowUp): void };
    }) => {
      api.transcript = { turns: props.turns, onExpand: props.onExpand };
      const { actions } = props;
      const follow = () => {
        if (api.followUp) actions.onFollowUp?.(api.followUp.run, api.followUp.followUp);
      };
      return createElement(
        Fragment,
        null,
        createElement("button", { type: "button", onClick: () => actions.onRevise?.("OEE by plant") }, "Suggested revision"),
        createElement("button", { type: "button", onClick: follow }, "Follow up"),
      );
    },
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

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: "mf",
  name: "Manufacturing",
  pack: "manufacturing",
  role: "key_user",
  starters: [],
  ...over,
});

const me = (workspaces: Workspace[] = [workspace()], lastWorkspace: string | null = null): Me => ({
  user: { id: "ada", name: "Ada", email: null },
  workspaces,
  last_workspace: lastWorkspace,
});

const run = (over: Partial<RunView>): RunView => ({
  id: "r1",
  thread_id: "t1",
  revision: 0,
  origin: "question",
  prompt: "OEE by line",
  status: "running",
  phase: null,
  stage: null,
  step: null,
  started_at: null,
  finished_at: null,
  restatement: null,
  definitions: [],
  card: null,
  clarify: null,
  result: null,
  follow_ups: [],
  follows: null,
  takes_back: null,
  locale: null,
  timings: [],
  steps: [],
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
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  api.me = me();
  api.create = () => new Promise(() => {});
  api.created = [];
  api.threads = [summary("t1", "OEE by line"), summary("t2", "Scrap rate by shift")];
  api.search = {};
  api.searched = [];
  api.turns = [];
  api.activeRun = null;
  api.threadError = null;
  api.expanded = [];
  api.opened = [];
  api.revising = false;
  api.revised = [];
  api.reviseFailure = null;
  api.cancelled = [];
  api.followUp = null;
  api.transcript = null;
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

describe("the start page", () => {
  const two = [workspace(), workspace({ id: "rs", name: "Restaurant", pack: "restaurant" })];

  it("opens the workspace used last", () => {
    api.me = me(two, "rs");
    const router = renderAt("/");
    expect(router.state.location.pathname).toBe("/w/rs");
  });

  it("opens the first workspace before any was used", () => {
    api.me = me(two, null);
    const router = renderAt("/");
    expect(router.state.location.pathname).toBe("/w/mf");
  });

  it("opens the first workspace when the one used last is no longer the caller's", () => {
    api.me = me(two, "gone");
    const router = renderAt("/");
    expect(router.state.location.pathname).toBe("/w/mf");
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

  it("offers at most four of the pack's example questions, each once, above the recent ones", () => {
    api.me = me([
      workspace({
        starters: [
          "Which line had the most scrap?",
          "  ",
          "OEE per line last week",
          "which line had the most SCRAP?",
          "Energy per 1,000 good units",
          "Downtime by cause",
          "Yield last month",
        ],
      }),
    ]);
    renderAt("/w/mf");
    const examples = screen.getByRole("group", { name: "Example questions" });
    expect(within(examples).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Which line had the most scrap?",
      "OEE per line last week",
      "Energy per 1,000 good units",
      "Downtime by cause",
    ]);
    const recent = screen.getByRole("navigation", { name: "Recent questions" });
    expect(examples.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("asks an example question with one click", async () => {
    api.me = me([workspace({ starters: ["OEE per line last week"] })]);
    api.create = async () => ({ thread_id: "t9" });
    const router = renderAt("/w/mf");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "OEE per line last week" })));
    expect(api.created).toEqual([{ question: "OEE per line last week" }]);
    expect(router.state.location.pathname).toBe("/w/mf/t/t9");
  });

  it("offers no examples when the pack has none", () => {
    renderAt("/w/mf");
    expect(screen.queryByRole("group", { name: "Example questions" })).toBeNull();
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

  it("counts a kind this client does not know yet too", () => {
    api.counts = { data: { measure: 1, synonym: 3 }, isPending: false, isError: false };
    renderAt("/w/mf");
    expect(review().getAttribute("aria-label")).toBe("Review, 4 proposed");
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

  it("is there only for a key user of the workspace open, and asks for no counts otherwise", () => {
    api.me = me([workspace(), workspace({ id: "rs", name: "Restaurant", role: "member" })]);
    renderAt("/w/rs");
    expect(within(sidebar()).queryByRole("link", { name: /^Review/ })).toBeNull();
    expect(api.countsFor).toEqual([]);
    cleanup();

    renderAt("/w/mf");
    expect(review().getAttribute("href")).toBe("/w/mf/review");
  });
});

describe("the sidebar's search", () => {
  const rows = () =>
    within(sidebar())
      .queryAllByRole("link")
      .filter((link) => link.classList.contains("thread-row"))
      .map((link) => link.getAttribute("href"));
  const search = (text: string) =>
    fireEvent.change(within(sidebar()).getByRole("searchbox", { name: "Search questions" }), { target: { value: text } });

  it("filters the list at once, before the server is asked", () => {
    renderAt("/w/mf");
    search("scrap");
    expect(rows()).toEqual(["/w/mf/t/t2"]);
    expect(api.searched).toEqual([]);
  });

  it("asks the server once typing pauses, and adds what it finds", async () => {
    api.search = { "by plant": [summary("t7", "Downtime", "complete")] };
    renderAt("/w/mf");
    search("by plant");
    // Nothing here matches, and the server has not answered yet.
    expect(within(sidebar()).getByText("Searching…")).toBeTruthy();
    await wait(400);
    expect(api.searched).toContain("by plant");
    expect(rows()).toEqual(["/w/mf/t/t7"]);
  });

  it("says nothing matches once the server found nothing either", async () => {
    renderAt("/w/mf");
    search("yield");
    await wait(400);
    expect(within(sidebar()).getByText("No question matches.")).toBeTruthy();
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
  it("heads the page with the thread's question, and tells the server the thread was opened", () => {
    renderAt("/w/mf/t/t1");
    expect(within(main()).getByRole("heading", { name: "Question t1" })).toBeTruthy();
    expect(api.opened).toContain("mf/t1");
    expect(new Set(api.opened)).toEqual(new Set(["mf/t1"]));
  });

  it("hands the transcript the thread's turns and the way to unfold one", () => {
    const first = run({ id: "r0", status: "complete" });
    const latest = run({ id: "r1", revision: 1, origin: "revision", status: "complete" });
    api.turns = [
      { summary: { ...summaryOfRun(first) }, run: null },
      { summary: { ...summaryOfRun(latest) }, run: latest },
    ];
    renderAt("/w/mf/t/t1");
    expect(api.transcript?.turns).toBe(api.turns);
    api.transcript?.onExpand("r0");
    expect(api.expanded).toEqual(["r0"]);
  });

  describe("keeping to the bottom", () => {
    const first = run({ id: "r0", status: "complete" });
    const latest = run({ id: "r1", revision: 1, origin: "revision", status: "complete" });
    const turns = (unfolded: boolean): Turn[] => [
      { summary: summaryOfRun(first), run: unfolded ? first : null },
      { summary: summaryOfRun(latest), run: latest },
    ];

    /** Gives the transcript's scroller the layout jsdom lacks, read back from `box`; the reader starts at the bottom. */
    function layout() {
      const el = document.querySelector<HTMLElement>(".thread__scroll")!;
      const box = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
      Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
      Object.defineProperty(el, "scrollTop", {
        configurable: true,
        get: () => box.scrollTop,
        set: (value: number) => void (box.scrollTop = value),
      });
      fireEvent.scroll(el);
      return { el, box };
    }

    /** New turns arrive, the content grown to `height`. */
    const grow = (box: { scrollHeight: number }, height: number, unfolded: boolean) =>
      act(async () => {
        box.scrollHeight = height;
        api.set({ turns: turns(unfolded) });
      });

    beforeEach(() => {
      api.turns = turns(false);
    });

    it("follows new content while the reader is at the bottom", async () => {
      renderAt("/w/mf/t/t1");
      const { box } = layout();
      await grow(box, 1200, false);
      expect(box.scrollTop).toBe(1200);
    });

    it("stays on an earlier turn the reader unfolds, while its run loads and grows", async () => {
      renderAt("/w/mf/t/t1");
      const { box } = layout();
      await act(async () => api.transcript?.onExpand("r0"));
      expect(api.expanded).toEqual(["r0"]);
      // The loading row, then the run in full: neither pulls the view down away from the turn.
      await grow(box, 1100, false);
      await grow(box, 1600, true);
      expect(box.scrollTop).toBe(600);
    });

    it("follows again once the reader scrolls back down, or sends a revision", async () => {
      renderAt("/w/mf/t/t1");
      const { el, box } = layout();
      await act(async () => api.transcript?.onExpand("r0"));
      await grow(box, 1600, true);
      expect(box.scrollTop).toBe(600);

      box.scrollTop = 1200;
      fireEvent.scroll(el);
      await grow(box, 1800, true);
      expect(box.scrollTop).toBe(1800);

      await act(async () => api.transcript?.onExpand("r0"));
      await grow(box, 2000, true);
      expect(box.scrollTop).toBe(1800);
      box.scrollHeight = 2300;
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggested revision" })));
      expect(box.scrollTop).toBe(2300);
    });
  });

  it("sends a suggested question as a revision, as if it were typed", async () => {
    renderAt("/w/mf/t/t1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggested revision" })));
    expect(api.revised).toEqual([{ message: "OEE by plant" }]);
  });

  it("sends a complete run's follow-up with the run and the follow-up it came from", async () => {
    api.followUp = {
      run: run({ id: "r3", status: "complete" }),
      followUp: { id: "f2", kind: "breakdown", question: "Which shifts drove the drop on line 2?" },
    };
    renderAt("/w/mf/t/t1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Follow up" })));
    expect(api.revised).toEqual([
      { message: "Which shifts drove the drop on line 2?", follows: { run_id: "r3", follow_up_id: "f2" } },
    ]);
  });

  it("sends a complete run's nearest question as a follow-up too: the run's status decides, not the kind", async () => {
    api.followUp = {
      run: run({ id: "r3", status: "complete" }),
      followUp: { id: "f9", kind: "nearest", question: "How did scrap develop per week?" },
    };
    renderAt("/w/mf/t/t1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Follow up" })));
    expect(api.revised).toEqual([
      { message: "How did scrap develop per week?", follows: { run_id: "r3", follow_up_id: "f9" } },
    ]);
  });

  it("sends a clarify run's nearest question via nearest, without follows", async () => {
    api.followUp = {
      run: run({ id: "r3", status: "clarify" }),
      followUp: { id: "n1", kind: "nearest", question: "What was the OEE of each line last week?" },
    };
    renderAt("/w/mf/t/t1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Follow up" })));
    expect(api.revised).toEqual([{ message: "What was the OEE of each line last week?", via: "nearest" }]);
    expect(api.revised[0]).not.toHaveProperty("follows");
  });

  it("moves focus to the composer from a follow-up, which folds away with its turn", async () => {
    api.followUp = {
      run: run({ id: "r3", status: "complete" }),
      followUp: { id: "f2", kind: "check", question: "Does the drop hold without line 4?" },
    };
    renderAt("/w/mf/t/t1");
    const button = screen.getByRole("button", { name: "Follow up" });
    button.focus();
    await act(async () => fireEvent.click(button));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Revise the question" }));
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

  it("shows the analysis step under way beside the stage", () => {
    api.activeRun = run({ status: "running", stage: "analyse", phase: "analyse", step: { id: "s2", label: "the prior period" } });
    renderAt("/w/mf/t/t1");
    expect(screen.getByRole("status").textContent).toContain("Analysing · the prior period…");
  });

  it("shows the revision's run starting at once, not the run it supersedes", () => {
    api.activeRun = run({ status: "running", stage: "analyse", phase: "fetch", step: { id: "s2", label: "the prior period" } });
    api.revising = true;
    renderAt("/w/mf/t/t1");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Starting");
    expect(status.textContent).not.toContain("Analysing");
    expect(status.textContent).not.toContain("the prior period");
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

describe("the thread page's refusals", () => {
  const banner = (failure: Error) => {
    api.reviseFailure = failure;
    renderAt("/w/mf/t/t1");
    return screen.getByRole("alert").textContent;
  };

  it("says a newer revision replaced the answer (not_latest)", () => {
    expect(banner(new ApiError("Not the latest run.", 409, "not_latest"))).toBe(
      "Could not send the revision: a newer revision has replaced this answer.",
    );
  });

  it("says the follow-up is no longer offered (not_answerable)", () => {
    expect(banner(new ApiError("Not answerable.", 409, "not_answerable"))).toBe(
      "Could not send the revision: that is no longer offered for this answer.",
    );
  });

  it("says a run an earlier version made can't be changed, in the agreed sentence (stale_run)", () => {
    expect(banner(new ApiError("Stale.", 409, "stale_run"))).toBe(
      "This answer was made by an earlier version of sightline and can't be changed any more. Ask the question again for a fresh answer.",
    );
  });

  it("says when to try again while too many questions run (too_many_active)", () => {
    expect(banner(new ApiError("Too many.", 429, "too_many_active", [], 5))).toBe(
      "Could not send the revision: too many questions are running; try again in 5 s.",
    );
  });

  it("says to try again in a moment when the server did not say when", () => {
    expect(banner(new ApiError("Too many.", 429, "too_many_active", [], null))).toBe(
      "Could not send the revision: too many questions are running; try again in a moment.",
    );
  });

  it("says the follow-up changed when its question no longer matches (422 follow_up_mismatch)", () => {
    const mismatch = new ApiError("The message is not the follow-up's question.", 422, null, [
      { loc: ["body", "message"], msg: "The message is not the follow-up's question.", type: "follow_up_mismatch" },
    ]);
    expect(banner(mismatch)).toBe("Could not send the revision: the follow-up changed; pick it again.");
  });

  it("says anything else in the server's own words", () => {
    expect(banner(new ApiError("The warehouse is down for maintenance.", 503))).toBe(
      "Could not send the revision: The warehouse is down for maintenance.",
    );
  });

  it("goes away when dismissed", async () => {
    banner(new ApiError("Not the latest run.", 409, "not_latest"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dismiss" })));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a thread that cannot be loaded", () => {
  it("says the thread does not exist when the server says no_thread", () => {
    api.threadError = new ApiError("No thread t1 in mf.", 404, "no_thread");
    renderAt("/w/mf/t/t1");
    expect(within(main()).getByRole("alert").textContent).toContain("This thread does not exist in this workspace.");
    expect(within(main()).getByRole("link", { name: "Ask a new question" }).getAttribute("href")).toBe("/w/mf");
    expect(screen.queryByRole("textbox", { name: "Revise the question" })).toBeNull();
  });

  it("goes by the code, not the words: any other failure could not load it", () => {
    api.threadError = new ApiError("Thread not found upstream (404).", 502);
    renderAt("/w/mf/t/t1");
    const alert = within(main()).getByRole("alert");
    expect(alert.textContent).toContain("Could not load this thread.");
    expect(alert.textContent).toContain("Thread not found upstream (404).");
    expect(alert.textContent).not.toContain("does not exist");
  });
});

/** A turn's summary made from its run, the way the data layer makes one. */
function summaryOfRun(view: RunView): Turn["summary"] {
  return {
    id: view.id,
    revision: view.revision,
    origin: view.origin,
    prompt: view.prompt,
    status: view.status,
    restatement: view.restatement,
    top: null,
    chart: null,
    follows: view.follows,
    takes_back: view.takes_back,
    feedback: view.feedback,
    started_at: view.started_at,
    finished_at: view.finished_at,
  };
}
