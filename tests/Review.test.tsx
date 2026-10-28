import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { RegistryFilters } from "../src/api/registry";
import type { EntryChange, KindInfo, RegistryCounts, RegistryEntryDetail, RegistryKind, Review } from "../src/api/types";
import { SEARCH_WAIT_MS } from "../src/components/review/ReviewFilters";
import { ReviewPage } from "../src/pages/ReviewPage";

// The registry hooks stand in as fakes over a little store: the lists filter it, the entry
// reads it, and a review answers with whatever the test puts in `answer`.
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let tick = 0;
  return {
    entries: [] as RegistryEntryDetail[],
    counts: {} as RegistryCounts,
    /** The kinds' words as the server sends them; undefined while they are on their way. */
    kinds: undefined as KindInfo[] | undefined,
    /** The kinds could not be loaded: no kinds, and no longer pending. */
    kindsFailed: false,
    hasNextPage: false,
    fetchNextPage: (): void => {},
    /** Every filter the list asked with, the latest last. */
    filters: [] as RegistryFilters[],
    /** Lists still on their way: pending, no data. */
    pending: (_filters: RegistryFilters): boolean => false,
    /** What loading an entry fails with, by id. */
    failures: {} as Record<string, ApiError>,
    reviews: [] as { entryId: string; body: Review }[],
    /** How a review answers; unset, it never does (it stays pending). */
    answer: null as ((entryId: string, body: Review) => Promise<RegistryEntryDetail>) | null,
    /** How long the lists take to come back after an answer, while the review is still pending. */
    settle: (): Promise<void> => Promise.resolve(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot: () => tick,
    /** Every hook reads the store again, as when a query settles. */
    refresh() {
      tick += 1;
      for (const listener of listeners) listener();
    },
    /** A new version of an entry, as a refetch would bring it. */
    put(entry: RegistryEntryDetail) {
      store.entries = store.entries.map((existing) => (existing.id === entry.id ? entry : existing));
      store.refresh();
    },
    /** The kinds come in. */
    setKinds(kinds: KindInfo[]) {
      store.kinds = kinds;
      store.refresh();
    },
  };
});

vi.mock("../src/api/registry", async () => {
  const { useState, useSyncExternalStore } = await import("react");
  const useStore = () => useSyncExternalStore(store.subscribe, store.snapshot);
  interface State {
    isPending: boolean;
    error: ApiError | null;
    variables: Review | undefined;
  }
  const idle: State = { isPending: false, error: null, variables: undefined };
  const said = (entry: RegistryEntryDetail) => [entry.term, entry.label, ...Object.values(entry.words).flat()];
  return {
    registryKeys: {},
    useRegistry: (_ws: string, filters: RegistryFilters) => {
      useStore();
      store.filters.push(filters);
      const page = { isError: false, error: null, hasNextPage: store.hasNextPage, isFetchingNextPage: false };
      const more = { fetchNextPage: () => store.fetchNextPage(), refetch: () => {} };
      if (store.pending(filters)) return { ...page, ...more, isPending: true, data: undefined, hasNextPage: false };
      const needle = filters.q?.toLocaleLowerCase();
      const items = store.entries.filter(
        (entry) =>
          (!filters.status || entry.status === filters.status) &&
          (!filters.kind || entry.kind === filters.kind) &&
          (!needle || said(entry).some((text) => text.toLocaleLowerCase().includes(needle))),
      );
      if (filters.sort === "demand") items.sort((a, b) => b.demand.runs - a.demand.runs);
      return {
        ...page,
        ...more,
        isPending: false,
        data: { pages: [{ items, next_cursor: null, counts: store.counts, kinds: store.kinds ?? [] }], pageParams: [null] },
      };
    },
    useRegistryCounts: () => {
      useStore();
      return { data: store.counts, isPending: false, isError: false };
    },
    useRegistryKinds: () => {
      useStore();
      const isPending = store.kinds === undefined && !store.kindsFailed;
      return { data: store.kinds, isPending, isError: store.kindsFailed };
    },
    useRegistryEntry: (_ws: string, entryId: string | null) => {
      useStore();
      const error = entryId ? (store.failures[entryId] ?? null) : null;
      // As a failed refetch leaves it: the entry loaded before stays at hand beside the error.
      const data = store.entries.find((entry) => entry.id === entryId);
      return { data, isPending: data === undefined && !error, isError: error !== null, error, refetch: () => {} };
    },
    useReview: (_ws: string, entryId: string) => {
      const [state, setState] = useState<State>(idle);
      return {
        ...state,
        reset: () => setState(idle),
        mutate: (body: Review, options?: { onSuccess?(detail: RegistryEntryDetail): void }) => {
          store.reviews.push({ entryId, body });
          setState({ isPending: true, error: null, variables: body });
          const answer = store.answer ?? (() => new Promise<RegistryEntryDetail>(() => {}));
          answer(entryId, body).then(
            async (detail) => {
              // As the hook does: the entry is at its new version while the lists reload, still pending.
              store.put(detail);
              await store.settle();
              setState({ isPending: false, error: null, variables: body });
              options?.onSuccess?.(detail);
            },
            (error: ApiError) => setState({ isPending: false, error, variables: body }),
          );
        },
      };
    },
  };
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const KINDS: KindInfo[] = [
  { kind: "measure", label: "measure", plural: "measures" },
  { kind: "default", label: "default", plural: "defaults" },
  { kind: "gap", label: "data gap", plural: "data gaps" },
];

function entry(over: Partial<RegistryEntryDetail> = {}): RegistryEntryDetail {
  const base: RegistryEntryDetail = {
    id: "m_oee",
    kind: "measure",
    term: "OEE",
    label: "Overall equipment effectiveness",
    source: { kind: "library", text: "from sightline's KPI library (ISO 22400-2)" },
    status: "proposed",
    demand: { runs: 12, first_asked: "2026-10-03T09:00:00Z", last_asked: ago(3 * HOUR) },
    words: { en: ["OEE", "equipment effectiveness"], de: ["Gesamtanlageneffektivität", "GAE"] },
    definition: "availability × performance × quality",
    note: null,
    version: 3,
    updated_at: ago(2 * HOUR),
    reviewed_by: null,
    reviewed_at: null,
    gap: null,
    choices: null,
    chosen_option: null,
    runs: [
      {
        run_id: "r1",
        thread_id: "t1",
        question: "OEE by plant last week",
        prompt: "OEE by plant last week",
        revision: 0,
        rating: "up",
        at: ago(3 * HOUR),
      },
      {
        run_id: "r2",
        thread_id: "t2",
        question: "Which line had the best OEE?",
        prompt: "by shift instead",
        revision: 2,
        rating: null,
        at: ago(5 * HOUR),
      },
    ],
    runs_total: 2,
    history: [],
  };
  return { ...base, ...over };
}

const OEE = entry({
  history: [
    { version: 1, action: "proposed", by: null, at: ago(6 * DAY), note: null },
    { version: 2, action: "reject", by: "Ada", at: ago(5 * DAY), note: "Not how we count it" },
    { version: 3, action: "reopen", by: "Bea", at: ago(4 * DAY), note: null },
    { version: 3, action: "demand", by: null, at: ago(3 * HOUR), note: "12 runs asked for it" },
  ],
});
const BEST = entry({
  id: "d_best",
  kind: "default",
  term: "best plant",
  label: "Best plant, by OEE",
  source: { kind: "learned", text: "learned from users' answers on the card" },
  definition: "OEE",
  demand: { runs: 30, first_asked: "2026-10-01T09:00:00Z", last_asked: ago(4 * HOUR) },
  words: { en: ["best plant"] },
  version: 1,
  // The option's label is not the definition's wording: the default is marked by its id.
  choices: [
    { option: "output", label: "Output", count: 3 },
    { option: "oee", label: "Overall equipment effectiveness", count: 9 },
  ],
  chosen_option: "oee",
  runs: [],
  runs_total: 0,
});
const SCRAP = entry({
  id: "g_scrap",
  kind: "gap",
  term: "scrap cost",
  label: "Cost of scrap",
  source: { kind: "drafted", text: "drafted by sightline" },
  definition: null,
  demand: { runs: 2, first_asked: "2026-10-20T09:00:00Z", last_asked: ago(5 * HOUR) },
  words: { en: ["scrap cost"] },
  version: 1,
  gap: { missing: ["a cost per scrapped unit"], record: ["the material cost of each scrapped part"] },
  runs: [],
  runs_total: 0,
});
const AVAILABILITY = entry({
  id: "m_avail",
  term: "Availability",
  label: "Run time over planned time",
  status: "approved",
  reviewed_by: "Ada",
  // Demand moved it since: the review's own time is the one to show.
  reviewed_at: ago(2 * HOUR),
  updated_at: ago(10 * 60_000),
  version: 2,
  words: { en: ["availability"] },
});

/** A registry that takes every review: an edit's changes, a status move, one version up. */
async function accept(entryId: string, body: Review): Promise<RegistryEntryDetail> {
  const at = store.entries.find((candidate) => candidate.id === entryId) as RegistryEntryDetail;
  const moves = { approve: "approved", reject: "rejected", reopen: "proposed" } as const;
  return {
    ...at,
    label: body.changes?.label ?? at.label,
    words: { ...at.words, ...body.changes?.words },
    status: body.action === "edit" ? at.status : moves[body.action],
    version: at.version + 1,
    reviewed_by: "Dev",
    reviewed_at: ago(0),
    updated_at: ago(0),
  };
}

beforeEach(() => {
  store.entries = [OEE, BEST, SCRAP, AVAILABILITY];
  store.counts = { measure: 1, default: 1, gap: 1 };
  store.kinds = KINDS;
  store.kindsFailed = false;
  store.hasNextPage = false;
  store.fetchNextPage = () => {};
  store.filters = [];
  store.pending = () => false;
  store.failures = {};
  store.reviews = [];
  store.answer = null;
  store.settle = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The review page inside a stand-in shell, as the app routes it. */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/w/:ws",
        element: <Outlet context={{ ws: "mf", sidebarButton: null }} />,
        children: [
          { path: "review", element: <ReviewPage /> },
          { path: "review/:entryId", element: <ReviewPage /> },
          { path: "t/:threadId", element: <p>A thread</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const lastFilters = () => store.filters.at(-1);
const list = () => screen.getByRole("list", { name: "Entries" });
const terms = () => [...list().querySelectorAll(".rv-row__term")].map((term) => term.textContent);
const row = (term: string): HTMLElement => {
  const found = within(list())
    .getAllByRole("link")
    .find((link) => link.querySelector(".rv-row__term")?.textContent === term);
  if (!found) throw new Error(`no row for ${term}`);
  return found;
};
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const labelBox = () => screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement;
const searchBox = () => screen.getByRole("searchbox", { name: "Search entries" }) as HTMLInputElement;
const sortBox = () => screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement;
/** The version the entry's header shows, "v3". */
const version = () => document.querySelector(".rv-detail__meta .mono")?.textContent;
const click = (element: Element) => act(async () => void fireEvent.click(element));
const type = (element: Element, value: string) =>
  act(async () => void fireEvent.change(element, { target: { value } }));
const press = (element: Element, key: string) => act(async () => void fireEvent.keyDown(element, { key }));
const enter = (element: Element) => press(element, "Enter");
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const addWord = async (language: string, word: string) => {
  const input = screen.getByRole("textbox", { name: `Add a word in ${language}` });
  await type(input, word);
  await enter(input);
};
const chips = (language: string) =>
  [...screen.getByRole("group", { name: `Words in ${language}` }).querySelectorAll(".rv-word__text")].map(
    (chip) => chip.textContent,
  );

describe("the review page", () => {
  it("names itself and asks for an entry while none is open", () => {
    renderAt("/w/mf/review");
    expect(document.title).toBe("Review · sightline");
    expect(screen.getByRole("heading", { level: 1, name: "Review" })).toBeTruthy();
    expect(
      screen.getByText("What sightline proposes for your workspace. Approve what is right; reject what is not."),
    ).toBeTruthy();
    expect(screen.getByText("Pick an entry to review it.")).toBeTruthy();
  });

  it("drives the list's filters through the URL with the tabs and the kind chips", async () => {
    const router = renderAt("/w/mf/review");
    expect(lastFilters()).toEqual({ status: "proposed" });
    expect(screen.getByRole("tab", { name: /^Proposed/ }).textContent).toBe("Proposed 3");
    expect(screen.getByRole("tab", { name: /^Proposed/ }).getAttribute("aria-selected")).toBe("true");
    expect(button("Measures 1 proposed").getAttribute("aria-pressed")).toBe("false");
    expect(button("All 3 proposed").getAttribute("aria-pressed")).toBe("true");
    expect(button("Measures 1 proposed").querySelector(".rv-kinds__count")?.getAttribute("title")).toBe("1 proposed");
    expect(terms()).toEqual(["OEE", "best plant", "scrap cost"]);

    await click(screen.getByRole("tab", { name: "Approved" }));
    expect(router.state.location.search).toBe("?status=approved");
    expect(lastFilters()).toEqual({ status: "approved" });
    expect(terms()).toEqual(["Availability"]);
    // The chips count what waits for review on every tab, and say so.
    expect(button("Measures 1 proposed").getAttribute("aria-pressed")).toBe("false");

    await click(button(/^Measures/));
    expect(router.state.location.search).toBe("?status=approved&kind=measure");
    expect(lastFilters()).toEqual({ status: "approved", kind: "measure" });
    expect(button(/^Measures/).getAttribute("aria-pressed")).toBe("true");

    await click(screen.getByRole("tab", { name: "Rejected" }));
    expect(lastFilters()).toEqual({ status: "rejected", kind: "measure" });
    expect(screen.getByText("No measures rejected.")).toBeTruthy();

    await click(button(/^All/));
    expect(router.state.location.search).toBe("?status=rejected");
    expect(screen.getByText("Nothing rejected.")).toBeTruthy();

    await click(screen.getByRole("tab", { name: /^Proposed/ }));
    expect(router.state.location.search).toBe("");
    expect(lastFilters()).toEqual({ status: "proposed" });
  });

  it("reads the filters from the URL it opens at", () => {
    renderAt("/w/mf/review?status=proposed&kind=gap&q=scrap&sort=updated");
    expect(lastFilters()).toEqual({ status: "proposed", kind: "gap", q: "scrap", sort: "updated" });
    expect(terms()).toEqual(["scrap cost"]);
    expect(button("Data gaps 1 proposed").getAttribute("aria-pressed")).toBe("true");
    expect(searchBox().value).toBe("scrap");
    expect(sortBox().value).toBe("updated");
  });

  it("says when a tab has nothing", () => {
    store.entries = [AVAILABILITY];
    renderAt("/w/mf/review");
    expect(screen.getByText("Nothing proposed right now.")).toBeTruthy();
  });

  it("shows a row's term, label, kind, source, demand and status", () => {
    renderAt("/w/mf/review");
    const oee = row("OEE");
    expect(oee.querySelector(".rv-row__label")?.textContent).toBe("Overall equipment effectiveness");
    expect(oee.querySelector(".rv-chip")?.textContent).toBe("Measure");
    expect(oee.querySelector(".rv-tag")?.textContent).toBe("library");
    expect(oee.querySelector(".rv-row__demand")?.textContent).toBe("asked 12× · last 3 h ago");
    expect(within(oee).getByRole("img", { name: "Proposed" })).toBeTruthy();
    // The kind in the server's words.
    expect(row("scrap cost").querySelector(".rv-chip")?.textContent).toBe("Data gap");
  });

  it("loads more entries when there are more", async () => {
    const more = vi.fn();
    store.hasNextPage = true;
    store.fetchNextPage = more;
    renderAt("/w/mf/review");
    await click(button("Load more"));
    expect(more).toHaveBeenCalledOnce();
  });
});

describe("the kinds the server names", () => {
  // A kind this client was not built with, and one the server sends no words for.
  const GLOSSARY = entry({
    id: "x_shift",
    kind: "glossary" as RegistryKind,
    term: "late shift",
    label: "The shift from 14:00 to 22:00",
    source: { kind: "question", text: "as the question states it" },
    definition: "the shift that starts at 14:00",
    demand: { runs: 4, first_asked: "2026-10-02T09:00:00Z", last_asked: ago(6 * HOUR) },
    words: { en: ["late shift"] },
    version: 2,
    runs: [],
    runs_total: 0,
  });
  const RULE = entry({ id: "x_rule", kind: "rule" as RegistryKind, term: "weekdays only", runs: [], runs_total: 0 });

  beforeEach(() => {
    store.entries = [OEE, GLOSSARY, RULE];
    store.kinds = [...KINDS, { kind: "glossary" as RegistryKind, label: "glossary term", plural: "glossary terms" }];
    // No count for gaps: none are proposed.
    store.counts = { measure: 1, default: 1, glossary: 2, rule: 1 };
  });

  it("offers a chip for every kind, in the server's order and words, counting the ones it does not know", async () => {
    const router = renderAt("/w/mf/review");
    const group = screen.getByRole("group", { name: "Kind" });
    expect(within(group).getAllByRole("button").map((chip) => chip.textContent)).toEqual([
      "All 5 proposed",
      "Measures 1 proposed",
      "Defaults 1 proposed",
      "Data gaps",
      "Glossary terms 2 proposed",
    ]);
    expect(screen.getByRole("tab", { name: /^Proposed/ }).textContent).toBe("Proposed 5");

    await click(button(/^Glossary terms/));
    expect(router.state.location.search).toBe("?kind=glossary");
    expect(lastFilters()).toEqual({ status: "proposed", kind: "glossary" });
    expect(terms()).toEqual(["late shift"]);
    expect(row("late shift").querySelector(".rv-chip")?.textContent).toBe("Glossary term");

    await click(screen.getByRole("tab", { name: "Rejected" }));
    expect(screen.getByText("No glossary terms rejected.")).toBeTruthy();
  });

  it("names a kind the server sends no words for by its own name", () => {
    renderAt("/w/mf/review");
    expect(row("weekdays only").querySelector(".rv-chip")?.textContent).toBe("Rule");
  });

  it("shows an entry of an unknown kind with the fields every entry has", () => {
    renderAt("/w/mf/review/x_shift");
    const detail = screen.getByRole("article", { name: "late shift" });
    expect(within(detail).getByText("Glossary term", { selector: ".rv-chip" })).toBeTruthy();
    expect(within(detail).getByText("The shift from 14:00 to 22:00")).toBeTruthy();
    expect(within(detail).getByText("Proposed")).toBeTruthy();
    expect(within(detail).getByText("As the question states it.")).toBeTruthy();
    expect(within(detail).getByText("The shift that starts at 14:00.")).toBeTruthy();
    expect(within(detail).getByText(/^Asked in 4 runs, first 2 Oct 2026/)).toBeTruthy();
    expect(within(detail).queryByText(/^Defined as/)).toBeNull();
    expect(within(detail).queryByRole("region", { name: "What users picked" })).toBeNull();
    expect(button("Approve")).toBeTruthy();
  });

  const chipTexts = () =>
    within(screen.getByRole("group", { name: "Kind" }))
      .getAllByRole("button")
      .map((chip) => chip.textContent);
  const GLOSSARY_KIND: KindInfo = { kind: "glossary" as RegistryKind, label: "glossary term", plural: "glossary terms" };

  it("holds a kind it does not know until the kinds are in, then filters by it when the server names it", async () => {
    store.kinds = undefined;
    renderAt("/w/mf/review?kind=glossary");
    // Nothing asked yet: the server might refuse the kind.
    expect(store.filters).toEqual([]);
    expect(screen.getByText("Loading entries")).toBeTruthy();
    expect(chipTexts()).toEqual(["All 5 proposed", "Glossary 2 proposed"]);
    expect(button(/^Glossary/).getAttribute("aria-pressed")).toBe("true");

    await act(async () => store.setKinds([...KINDS, GLOSSARY_KIND]));
    expect(store.filters.length).toBeGreaterThan(0);
    expect(store.filters.every((filters) => filters.kind === GLOSSARY_KIND.kind)).toBe(true);
    expect(terms()).toEqual(["late shift"]);
    expect(button(/^Glossary terms/).getAttribute("aria-pressed")).toBe("true");
  });

  it("drops a kind the server does not name once the kinds are in, never asking with it", async () => {
    store.kinds = undefined;
    renderAt("/w/mf/review?kind=nonsense");
    expect(store.filters).toEqual([]);
    expect(screen.getByText("Loading entries")).toBeTruthy();
    expect(button("Nonsense").getAttribute("aria-pressed")).toBe("true");

    await act(async () => store.setKinds(KINDS));
    expect(store.filters.length).toBeGreaterThan(0);
    expect(store.filters.every((filters) => filters.kind === undefined)).toBe(true);
    expect(button(/^All/).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Nonsense" })).toBeNull();
    expect(terms()).toEqual(["OEE", "late shift", "weekdays only"]);
  });

  it("filters at once by a kind it knows, before the kinds are in", () => {
    store.kinds = undefined;
    renderAt("/w/mf/review?kind=measure");
    expect(store.filters.length).toBeGreaterThan(0);
    expect(store.filters.every((filters) => filters.kind === "measure")).toBe(true);
    expect(terms()).toEqual(["OEE"]);
  });

  it("drops a kind it does not know when the kinds cannot be loaded", () => {
    store.kinds = undefined;
    store.kindsFailed = true;
    renderAt("/w/mf/review?kind=glossary");
    expect(lastFilters()).toEqual({ status: "proposed" });
    expect(button(/^All/).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the search and the order", () => {
  it("searches once typing pauses, through the URL", async () => {
    vi.useFakeTimers();
    const router = renderAt("/w/mf/review");
    await type(searchBox(), "  oee ");
    await wait(SEARCH_WAIT_MS - 50);
    expect(router.state.location.search).toBe("");
    // Another key starts the wait again.
    await type(searchBox(), "  scrap ");
    await wait(SEARCH_WAIT_MS - 50);
    expect(router.state.location.search).toBe("");
    await wait(50);
    expect(router.state.location.search).toBe("?q=scrap");
    expect(lastFilters()).toEqual({ status: "proposed", q: "scrap" });
    expect(terms()).toEqual(["scrap cost"]);
    // The box keeps what was typed while the URL catches up.
    expect(searchBox().value).toBe("  scrap ");

    await type(searchBox(), "zzz");
    await wait(SEARCH_WAIT_MS);
    expect(screen.getByText("Nothing proposed matches “zzz”.")).toBeTruthy();
    await click(button(/^Measures/));
    expect(screen.getByText("No measures proposed match “zzz”.")).toBeTruthy();
    expect(router.state.location.search).toBe("?q=zzz&kind=measure");

    await type(searchBox(), "   ");
    await wait(SEARCH_WAIT_MS);
    expect(router.state.location.search).toBe("?kind=measure");
    expect(lastFilters()).toEqual({ status: "proposed", kind: "measure" });
  });

  it("searches at once on Enter, and Escape clears it", async () => {
    vi.useFakeTimers();
    const router = renderAt("/w/mf/review");
    // Every move of the URL, a replace included, is a location of its own.
    const moves: string[] = [];
    const stop = router.subscribe((state) => {
      if (moves.at(-1) !== state.location.key) moves.push(state.location.key);
    });
    await type(searchBox(), "best");
    await enter(searchBox());
    expect(router.state.location.search).toBe("?q=best");
    expect(terms()).toEqual(["best plant"]);
    expect(moves).toHaveLength(1);
    // The pause that ends after Enter searches nothing again.
    await wait(SEARCH_WAIT_MS);
    expect(moves).toHaveLength(1);
    stop();

    await press(searchBox(), "Escape");
    expect(searchBox().value).toBe("");
    expect(router.state.location.search).toBe("");
    expect(terms()).toEqual(["OEE", "best plant", "scrap cost"]);
  });

  it("follows the URL when it moves by itself", async () => {
    const router = renderAt("/w/mf/review?q=oee");
    expect(searchBox().value).toBe("oee");
    await act(async () => void (await router.navigate("/w/mf/review?q=scrap")));
    expect(searchBox().value).toBe("scrap");
    expect(terms()).toEqual(["scrap cost"]);
    await act(async () => void (await router.navigate("/w/mf/review")));
    expect(searchBox().value).toBe("");
  });

  it("keeps the entries shown while a search's own are on their way, but not across tabs", async () => {
    vi.useFakeTimers();
    renderAt("/w/mf/review");
    store.pending = (filters) => filters.q !== undefined || filters.status !== "proposed";
    await type(searchBox(), "scrap");
    await wait(SEARCH_WAIT_MS);
    expect(lastFilters()).toEqual({ status: "proposed", q: "scrap" });
    expect(terms()).toEqual(["OEE", "best plant", "scrap cost"]);
    expect(list().closest(".rv-list")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Loading entries")).toBeNull();

    await click(screen.getByRole("tab", { name: "Approved" }));
    expect(screen.getByText("Loading entries")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Entries" })).toBeNull();
  });

  it("says a search found nothing only once its own answer is in", async () => {
    vi.useFakeTimers();
    renderAt("/w/mf/review?q=zzz");
    expect(screen.getByText("Nothing proposed matches “zzz”.")).toBeTruthy();
    store.pending = (filters) => filters.q === "oee";
    await type(searchBox(), "oee");
    await wait(SEARCH_WAIT_MS);
    expect(lastFilters()).toEqual({ status: "proposed", q: "oee" });
    // An empty list is not kept: neither search's note shows while the new one loads.
    expect(screen.queryByText(/matches “/)).toBeNull();
    expect(screen.getByText("Loading entries")).toBeTruthy();

    store.pending = () => false;
    await act(async () => store.refresh());
    expect(terms()).toEqual(["OEE", "best plant"]);
  });

  it("keeps no empty tab while a search on it loads", async () => {
    vi.useFakeTimers();
    renderAt("/w/mf/review?status=rejected");
    expect(screen.getByText("Nothing rejected.")).toBeTruthy();
    store.pending = (filters) => filters.q !== undefined;
    await type(searchBox(), "oee");
    await wait(SEARCH_WAIT_MS);
    expect(lastFilters()).toEqual({ status: "rejected", q: "oee" });
    expect(screen.queryByText(/^Nothing rejected/)).toBeNull();
    expect(screen.getByText("Loading entries")).toBeTruthy();
  });

  it("orders the list by the sort chosen, the default leaving the URL", async () => {
    const router = renderAt("/w/mf/review");
    expect(sortBox().value).toBe("last_asked");
    expect([...sortBox().options].map((option) => option.textContent)).toEqual([
      "Last asked",
      "Most asked",
      "Last changed",
    ]);

    await act(async () => void fireEvent.change(sortBox(), { target: { value: "demand" } }));
    expect(router.state.location.search).toBe("?sort=demand");
    expect(lastFilters()).toEqual({ status: "proposed", sort: "demand" });
    expect(terms()).toEqual(["best plant", "OEE", "scrap cost"]);

    await act(async () => void fireEvent.change(sortBox(), { target: { value: "last_asked" } }));
    expect(router.state.location.search).toBe("");
    expect(lastFilters()).toEqual({ status: "proposed" });
  });
});

describe("an open entry", () => {
  it("opens from its row, keeping the list's filters", async () => {
    const router = renderAt("/w/mf/review?kind=measure");
    await click(row("OEE"));
    expect(router.state.location.pathname).toBe("/w/mf/review/m_oee");
    expect(router.state.location.search).toBe("?kind=measure");
    expect(row("OEE").getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("Pick an entry to review it.")).toBeNull();

    const detail = screen.getByRole("article", { name: "OEE" });
    expect(within(detail).getByRole("heading", { level: 2, name: "OEE" })).toBeTruthy();
    expect(within(detail).getByText("Overall equipment effectiveness")).toBeTruthy();
    expect(within(detail).getByText("Measure", { selector: ".rv-chip" })).toBeTruthy();
    expect(version()).toBe("v3");
    expect(within(detail).getByText("Proposed")).toBeTruthy();
    expect(within(detail).getByText("From sightline's KPI library (ISO 22400-2).")).toBeTruthy();
    expect(within(detail).getByText("availability × performance × quality").parentElement?.textContent).toBe(
      "Defined as availability × performance × quality",
    );
    expect(within(detail).getByText("Asked in 12 runs, first 3 Oct 2026, last 3 h ago.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /All entries/ }).getAttribute("href")).toBe("/w/mf/review?kind=measure");
  });

  it("moves the selection with the arrow keys, every row in the tab order besides", async () => {
    const router = renderAt("/w/mf/review/m_oee");
    expect(within(list()).getAllByRole("link").map((link) => link.getAttribute("tabindex"))).toEqual([
      null,
      null,
      null,
    ]);
    row("OEE").focus();
    await act(async () => void fireEvent.keyDown(row("OEE"), { key: "ArrowDown" }));
    expect(router.state.location.pathname).toBe("/w/mf/review/d_best");
    expect(document.activeElement).toBe(row("best plant"));
    expect(screen.getByRole("heading", { level: 2, name: "best plant" })).toBeTruthy();

    await act(async () => void fireEvent.keyDown(row("best plant"), { key: "ArrowUp" }));
    expect(router.state.location.pathname).toBe("/w/mf/review/m_oee");
  });

  it("lists the runs that used it: the question, a later revision and what was sent, linked to the thread", () => {
    renderAt("/w/mf/review/m_oee");
    const used = screen.getByRole("region", { name: "Used in" });
    const links = within(used).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/w/mf/t/t1", "/w/mf/t/t2"]);
    expect(links.map((link) => link.querySelector(".rv-runs__question")?.textContent)).toEqual([
      "OEE by plant last week",
      "Which line had the best OEE?",
    ]);
    // The question itself is revision 0: what was sent is the question, said once.
    expect(links.map((link) => link.querySelector(".rv-runs__revision")?.textContent ?? null)).toEqual([
      null,
      "Revision 2 · by shift instead",
    ]);
    expect(within(used).getAllByRole("img", { name: /^Rated/ }).map((icon) => icon.getAttribute("aria-label"))).toEqual(
      ["Rated good"],
    );
    expect(within(used).queryByText(/more$/)).toBeNull();
  });

  it("says how many more runs used it than it lists", () => {
    store.entries = [entry({ runs_total: 14 })];
    renderAt("/w/mf/review/m_oee");
    const used = screen.getByRole("region", { name: "Used in" });
    expect(within(used).getByText("and 12 more")).toBeTruthy();
  });

  it("says when no run used it yet", () => {
    renderAt("/w/mf/review/g_scrap");
    expect(within(screen.getByRole("region", { name: "Used in" })).getByText("Not used in a run yet.")).toBeTruthy();
  });

  it("shows its history, newest first, sightline's own changes worded as what happened", () => {
    renderAt("/w/mf/review/m_oee");
    const history = screen.getByRole("region", { name: "History" });
    const rows = within(history).getAllByRole("listitem");
    expect(rows.map((item) => item.querySelector(".rv-history__what")?.textContent)).toEqual([
      "Demand updated",
      "Reopened by Bea",
      "Rejected by Ada",
      "Proposed by sightline",
    ]);
    expect(rows.map((item) => item.querySelector(".rv-history__version")?.textContent)).toEqual([
      "v3",
      "v3",
      "v2",
      "v1",
    ]);
    expect(rows.map((item) => item.querySelector(".rv-history__note")?.textContent ?? null)).toEqual([
      "12 runs asked for it.",
      null,
      "“Not how we count it”",
      null,
    ]);
    const when = rows[0]?.querySelector("time");
    expect(when?.textContent).toBe("3 h ago");
    expect(when?.getAttribute("dateTime")).toBe(OEE.history[3]?.at);
    expect(within(history).queryByRole("button")).toBeNull();
  });

  it("shows the newest changes of a long history, and all of them on asking", async () => {
    const changes: EntryChange[] = Array.from({ length: 7 }, (_, i) => ({
      version: i + 1,
      action: i === 0 ? "proposed" : "edit",
      by: i === 0 ? null : "Ada",
      at: ago((8 - i) * HOUR),
      note: null,
    }));
    store.entries = [entry({ history: changes, version: 7 })];
    renderAt("/w/mf/review/m_oee");
    const history = screen.getByRole("region", { name: "History" });
    const versions = () =>
      within(history)
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".rv-history__version")?.textContent);
    expect(versions()).toEqual(["v7", "v6", "v5", "v4", "v3"]);
    const all = within(history).getByRole("button", { name: "Show all 7 changes" });
    expect(all.getAttribute("aria-expanded")).toBe("false");
    await click(all);
    expect(versions()).toEqual(["v7", "v6", "v5", "v4", "v3", "v2", "v1"]);
    expect(within(history).getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("approves with the version shown, then offers Reopen", async () => {
    store.answer = async () => ({
      ...OEE,
      status: "approved",
      version: 4,
      reviewed_by: "Dev",
      reviewed_at: ago(0),
      updated_at: ago(0),
    });
    renderAt("/w/mf/review/m_oee");
    // Both live regions are in place, empty, before there is anything to say.
    const regions = screen.getAllByRole("status");
    expect(regions.map((region) => region.textContent)).toEqual(["", ""]);
    button("Approve").focus();
    await click(button("Approve"));
    expect(store.reviews).toEqual([{ entryId: "m_oee", body: { action: "approve", version: 3 } }]);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(button("Reopen").disabled).toBe(false);
    // The button pressed went away with the review: focus goes on to the one that took its place.
    expect(document.activeElement).toBe(button("Reopen"));
    expect(screen.getByText("Approved.")).toBe(regions[1]);
    expect(version()).toBe("v4");
    expect(screen.getByText(/reviewed by Dev · just now/)).toBeTruthy();
  });

  it("sends the note with a rejection and holds the actions while it is pending", async () => {
    renderAt("/w/mf/review/m_oee");
    await type(screen.getByRole("textbox", { name: /^Note/ }), "  Not how we count it  ");
    await click(button("Reject"));
    expect(store.reviews).toEqual([
      { entryId: "m_oee", body: { action: "reject", version: 3, note: "Not how we count it" } },
    ]);
    expect(button("Approve").disabled).toBe(true);
    expect(button("Reject").disabled).toBe(true);
  });

  it("offers Reopen, and no Approve, for an approved entry, saying who reviewed it when", async () => {
    renderAt("/w/mf/review/m_avail?status=approved");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    // The review's time, not the entry's last change.
    expect(document.querySelector(".rv-detail__meta")?.textContent).toBe("v2 · reviewed by Ada · 2 h ago");
    await click(button("Reopen"));
    expect(store.reviews).toEqual([{ entryId: "m_avail", body: { action: "reopen", version: 2 } }]);
  });

  it("shows a review's note once, in the history beside the review it came with", () => {
    store.entries = [
      {
        ...AVAILABILITY,
        note: "Checked against ISO",
        history: [
          { version: 1, action: "proposed", by: null, at: ago(3 * DAY), note: null },
          { version: 2, action: "approve", by: "Ada", at: ago(2 * HOUR), note: "Checked against ISO" },
        ],
      },
    ];
    renderAt("/w/mf/review/m_avail?status=approved");
    const notes = screen.getAllByText(/Checked against ISO/);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.classList.contains("rv-history__note")).toBe(true);
    expect(notes[0]?.textContent).toBe("“Checked against ISO”");
  });

  it("shows the entry's note under its header when the history does not carry it", () => {
    store.entries = [{ ...AVAILABILITY, note: "Checked against ISO", history: [] }];
    renderAt("/w/mf/review/m_avail?status=approved");
    const notes = screen.getAllByText(/Checked against ISO/);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.classList.contains("rv-detail__said-note")).toBe(true);
  });

  it("edits the label and the words, and saves them with the version shown", async () => {
    store.answer = async (_id, body) => ({ ...OEE, ...body.changes, version: 4 }) as RegistryEntryDetail;
    renderAt("/w/mf/review/m_oee");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness"]);
    expect(chips("German")).toEqual(["Gesamtanlageneffektivität", "GAE"]);

    await click(button("Remove “GAE”"));
    await addWord("English", "  overall   effectiveness ");
    await addWord("English", "oee"); // already there, whatever its case
    await type(screen.getByRole("textbox", { name: "Label" }), "Overall equipment effectiveness (OEE)");
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness", "overall effectiveness"]);
    expect(chips("German")).toEqual(["Gesamtanlageneffektivität"]);
    // A review would save the edits first, and says so.
    expect(button("Approve").disabled).toBe(false);
    expect(screen.getByText("Approving or rejecting saves your edits first.")).toBeTruthy();

    await click(button("Save changes"));
    expect(store.reviews).toEqual([
      {
        entryId: "m_oee",
        body: {
          action: "edit",
          version: 3,
          changes: {
            label: "Overall equipment effectiveness (OEE)",
            words: {
              en: ["OEE", "equipment effectiveness", "overall effectiveness"],
              de: ["Gesamtanlageneffektivität"],
            },
          },
        },
      },
    ]);
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(version()).toBe("v4");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(button("Approve").disabled).toBe(false);
  });

  it("discards the edits", async () => {
    renderAt("/w/mf/review/m_oee");
    await click(button("Remove “OEE”"));
    await type(screen.getByRole("textbox", { name: "Label" }), "Something else");
    await click(button("Discard"));
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness"]);
    expect((screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe(
      "Overall equipment effectiveness",
    );
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(store.reviews).toEqual([]);
  });

  it("will not save an empty label", async () => {
    renderAt("/w/mf/review/m_oee");
    await type(screen.getByRole("textbox", { name: "Label" }), "   ");
    expect(button("Save changes").disabled).toBe(true);
    expect(button("Approve").disabled).toBe(true);
    expect(screen.getByText("The label cannot be empty.")).toBeTruthy();
  });

  it("takes spaces around the label for no edit, and the saved entry as it comes back", async () => {
    let settle: () => void = () => {};
    store.settle = () => new Promise<void>((resolve) => (settle = resolve));
    // The registry words it its own way: the label trimmed, a word in its own case.
    store.answer = async (entryId, body) => {
      const saved = await accept(entryId, body);
      return { ...saved, words: { ...saved.words, en: ["OEE", "equipment effectiveness", "Overall Effectiveness"] } };
    };
    renderAt("/w/mf/review/m_oee");
    await type(labelBox(), " Overall equipment effectiveness  ");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    await type(labelBox(), "OEE, overall ");
    await addWord("English", "overall effectiveness");
    await click(button("Save changes"));
    expect(store.reviews[0]?.body.changes?.label).toBe("OEE, overall");
    // The answer is in while the lists reload: the key user's own save overrules nothing.
    expect(version()).toBe("v4");
    expect(screen.getAllByRole("status").map((region) => region.textContent)).toEqual(["", ""]);

    await act(async () => settle());
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(screen.getAllByRole("status")[0]?.textContent).toBe("");
    expect(labelBox().value).toBe("OEE, overall");
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness", "Overall Effectiveness"]);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(button("Approve").disabled).toBe(false);
  });

  it("saves the edits first when a review is asked with them unsaved", async () => {
    store.answer = accept;
    renderAt("/w/mf/review/m_oee");
    await addWord("English", "overall effectiveness");
    await type(screen.getByRole("textbox", { name: /^Note/ }), "Checked against ISO 22400-2");
    await click(button("Approve"));
    expect(store.reviews.map((review) => review.body)).toEqual([
      {
        action: "edit",
        version: 3,
        changes: { label: OEE.label, words: { en: [...OEE.words.en!, "overall effectiveness"], de: OEE.words.de } },
      },
      { action: "approve", version: 4, note: "Checked against ISO 22400-2" },
    ]);
    expect(screen.getByText("Saved and approved.")).toBeTruthy();
    expect(version()).toBe("v5");
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness", "overall effectiveness"]);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(button("Reopen").disabled).toBe(false);
  });

  it("gives every entry a row for English and German, and sends only the words there are", async () => {
    store.answer = accept;
    renderAt("/w/mf/review/g_scrap");
    expect(chips("English")).toEqual(["scrap cost"]);
    expect(chips("German")).toEqual([]);

    // A German word added and taken away again leaves nothing to send.
    await addWord("German", "Ausschuss");
    await click(button("Remove “Ausschuss”"));
    await type(labelBox(), "Cost of scrapped parts");
    await click(button("Save changes"));
    expect(store.reviews[0]?.body).toEqual({
      action: "edit",
      version: 1,
      changes: { label: "Cost of scrapped parts", words: { en: ["scrap cost"] } },
    });

    await addWord("German", "Ausschusskosten");
    await click(button("Save changes"));
    expect(store.reviews[1]?.body.changes?.words).toEqual({ en: ["scrap cost"], de: ["Ausschusskosten"] });
    expect(chips("German")).toEqual(["Ausschusskosten"]);
  });
});

describe("a review that meets trouble", () => {
  const conflict = () => new ApiError("Someone reviewed it first", 409, "version_conflict");

  it("says someone reviewed first and keeps the edits that still apply", async () => {
    store.answer = async () => {
      // As the hook does: the latest version is in before the error shows.
      store.put({ ...OEE, version: 4, label: "OEE (ISO 22400-2)", reviewed_by: "Bea", reviewed_at: ago(0) });
      throw conflict();
    };
    renderAt("/w/mf/review/m_oee");
    await addWord("English", "overall effectiveness");
    await click(button("Save changes"));

    expect(
      screen.getByText(
        "Someone reviewed this entry first. You are now looking at the latest version." +
          " Your edits still apply and are not saved yet.",
      ),
    ).toBeTruthy();
    expect(version()).toBe("v4");
    expect(screen.getByText(/reviewed by Bea/)).toBeTruthy();
    // The label was theirs to change; the English words are still the user's edit.
    expect((screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe("OEE (ISO 22400-2)");
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness", "overall effectiveness"]);

    store.answer = null;
    await click(button("Save changes"));
    expect(store.reviews[1]?.body).toEqual({
      action: "edit",
      version: 4,
      changes: {
        label: "OEE (ISO 22400-2)",
        words: { en: ["OEE", "equipment effectiveness", "overall effectiveness"], de: OEE.words.de },
      },
    });
  });

  it("says the entry was moved when its status no longer allows the review, and shows it as it stands", async () => {
    store.answer = async () => {
      // The hook loads the entry as it stands before the error shows.
      store.put({ ...OEE, status: "approved", version: 4, reviewed_by: "Bea", reviewed_at: ago(0) });
      throw new ApiError("OEE is approved already; reopen it to review it again.", 409, "not_allowed");
    };
    renderAt("/w/mf/review/m_oee");
    await click(button("Reject"));

    expect(screen.getAllByRole("status")[0]?.textContent).toBe(
      "This entry was moved since you opened it; here it is as it stands.",
    );
    // Said once, in the notice: no banner with the server's words besides.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/approved already/)).toBeNull();
    expect(version()).toBe("v4");
    expect(screen.getByText(/reviewed by Bea · just now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(button("Reopen").disabled).toBe(false);
  });

  it("keeps the edits that still apply when the entry was moved", async () => {
    store.answer = async () => {
      store.put({ ...OEE, status: "rejected", version: 4 });
      throw new ApiError("Not allowed", 409, "not_allowed");
    };
    renderAt("/w/mf/review/m_oee");
    await addWord("English", "overall effectiveness");
    await click(button("Save changes"));
    expect(screen.getAllByRole("status")[0]?.textContent).toBe(
      "This entry was moved since you opened it; here it is as it stands." +
        " Your edits still apply and are not saved yet.",
    );
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness", "overall effectiveness"]);
  });

  it("discards the edits the newer version overruled, and says so", async () => {
    store.answer = async () => {
      store.put({ ...OEE, version: 4, words: { ...OEE.words, en: ["OEE"] } });
      throw conflict();
    };
    renderAt("/w/mf/review/m_oee");
    await addWord("English", "overall effectiveness");
    await click(button("Save changes"));

    expect(
      screen.getByText(
        "Someone reviewed this entry first. You are now looking at the latest version." +
          " Your edits no longer applied and were discarded.",
      ),
    ).toBeTruthy();
    expect(chips("English")).toEqual(["OEE"]);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("names the edits a newer version overruled, and keeps the others", async () => {
    store.answer = async () => {
      store.put({ ...OEE, version: 4, label: "Theirs" });
      throw conflict();
    };
    renderAt("/w/mf/review/m_oee");
    const notices = screen.getAllByRole("status")[0];
    await type(labelBox(), "Mine");
    await addWord("English", "kwh per part");
    await click(button("Save changes"));

    // Said in the live region that was there before.
    expect(notices?.textContent).toBe(
      "Someone reviewed this entry first. You are now looking at the latest version." +
        " Some of your edits no longer applied and were discarded: the label." +
        " The others still apply and are not saved yet.",
    );
    expect(labelBox().value).toBe("Theirs");
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness", "kwh per part"]);
    expect(button("Save changes")).toBeTruthy();
  });

  it("says when someone else's version overruled an edit while it was being made", async () => {
    renderAt("/w/mf/review/m_oee");
    await click(button("Remove “GAE”"));
    await type(labelBox(), "OEE, overall");
    await act(async () => store.put({ ...OEE, version: 4, words: { ...OEE.words, de: ["GAE"] }, reviewed_by: "Bea" }));

    expect(
      screen.getByText(
        "This entry changed while you were editing it." +
          " Some of your edits no longer applied and were discarded: the German words." +
          " The others still apply and are not saved yet.",
      ),
    ).toBeTruthy();
    expect(chips("German")).toEqual(["GAE"]);
    expect(labelBox().value).toBe("OEE, overall");
  });

  it("keeps the edits when an older version lands late", async () => {
    renderAt("/w/mf/review/m_oee");
    await addWord("English", "overall effectiveness");
    await act(async () => store.put({ ...OEE, version: 2, words: { en: ["OEE"] } }));
    expect(chips("English")).toEqual(["OEE", "equipment effectiveness", "overall effectiveness"]);
    expect(screen.getAllByRole("status")[0]?.textContent).toBe("");

    await click(button("Save changes"));
    expect(store.reviews[0]?.body.version).toBe(3);
  });

  it("shows a word collision beside the word it is about", async () => {
    store.answer = async () => {
      throw new ApiError("A word already names another term", 422, null, [
        {
          loc: ["body", "changes", "words", "de", 2],
          msg: "word already names another term",
          type: "word_collision",
          ctx: { word: "Anlageneffektivität", collides_with: "Availability" },
        },
      ]);
    };
    renderAt("/w/mf/review/m_oee");
    await addWord("German", "Anlageneffektivität");
    await click(button("Save changes"));

    const message = "“Anlageneffektivität” already names Availability.";
    const chip = screen.getByText("Anlageneffektivität", { selector: ".rv-word__text" });
    const item = chip.closest("li") as HTMLElement;
    expect(within(item).getByText(message)).toBeTruthy();
    expect(chip.closest(".rv-word")?.classList.contains("rv-word--clash")).toBe(true);
    const remove = button("Remove “Anlageneffektivität”");
    expect(document.getElementById(remove.getAttribute("aria-describedby") ?? "")?.textContent).toBe(message);
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "A word already names another term. Change or remove it, then save again.",
    );
    // No banner besides: the message sits where the word is.
    expect(screen.queryByText("A word already names another term")).toBeNull();

    await click(remove);
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the entry is gone, in place of the review, with the way back to the list", async () => {
    store.answer = async () => {
      throw new ApiError("No registry entry m_oee in mf.", 404, "no_entry");
    };
    const router = renderAt("/w/mf/review/m_oee?kind=measure");
    await addWord("English", "overall effectiveness");
    button("Approve").focus();
    await click(button("Approve"));
    expect(store.reviews).toHaveLength(1);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("This entry does not exist (any more).")).toBeTruthy();
    const back = within(alert).getByRole("link", { name: "Back to all entries" });
    expect(back.getAttribute("href")).toBe("/w/mf/review?kind=measure");
    // As on opening an entry that is gone: nothing left to review, save or send again.
    expect(screen.queryByRole("article")).toBeNull();
    for (const name of ["Approve", "Reject", "Reopen", "Save changes", "Discard"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("textbox", { name: "Label" })).toBeNull();
    // The button pressed went with the form: the way back takes focus.
    expect(document.activeElement).toBe(back);
    await click(back);
    expect(router.state.location.pathname).toBe("/w/mf/review");
    expect(screen.getByText("Pick an entry to review it.")).toBeTruthy();
  });

  it("shows any other failure in a banner", async () => {
    store.answer = async () => {
      throw new ApiError("The registry is read-only right now.", 503);
    };
    renderAt("/w/mf/review/m_oee");
    await click(button("Approve"));
    expect(screen.getByRole("alert").textContent).toBe("The registry is read-only right now.");
    expect(button("Approve").disabled).toBe(false);
  });
});

describe("an entry that cannot be loaded", () => {
  it("says an entry that is gone does not exist, with a link back to the list", async () => {
    store.failures = { m_gone: new ApiError("No registry entry m_gone in mf.", 404, "no_entry") };
    const router = renderAt("/w/mf/review/m_gone?kind=measure&q=oee");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("This entry does not exist (any more).")).toBeTruthy();
    const back = within(alert).getByRole("link", { name: "Back to all entries" });
    expect(back.getAttribute("href")).toBe("/w/mf/review?kind=measure&q=oee");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await click(back);
    expect(router.state.location.pathname).toBe("/w/mf/review");
    expect(router.state.location.search).toBe("?kind=measure&q=oee");
  });

  it("says it is gone even with an older copy of it at hand", () => {
    // A refetch found it gone: the copy loaded before is still in the cache, beside the 404.
    store.failures = { m_oee: new ApiError("No registry entry m_oee in mf.", 404, "no_entry") };
    renderAt("/w/mf/review/m_oee");
    expect(within(screen.getByRole("alert")).getByText("This entry does not exist (any more).")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("offers a retry for any other failure", () => {
    store.failures = { m_down: new ApiError("The registry is down.", 503) };
    renderAt("/w/mf/review/m_down");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Could not load the entry.")).toBeTruthy();
    expect(within(alert).getByText("The registry is down.")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps the copy at hand when a refetch fails for another reason", () => {
    store.failures = { m_oee: new ApiError("The registry is down.", 503) };
    renderAt("/w/mf/review/m_oee");
    expect(screen.getByRole("article", { name: "OEE" })).toBeTruthy();
    expect(screen.queryByText("Could not load the entry.")).toBeNull();
  });
});

describe("what an entry shows for its kind", () => {
  it("shows what users picked for a learned default, marking the option it chooses", () => {
    renderAt("/w/mf/review/d_best");
    expect(screen.getByText("OEE", { selector: "strong" }).parentElement?.textContent).toBe("Means: OEE");
    const picked = screen.getByRole("region", { name: "What users picked" });
    const rows = within(picked).getAllByRole("listitem");
    expect(rows.map((item) => item.querySelector(".rv-bars__label")?.textContent)).toEqual([
      "Overall equipment effectiveness, the default",
      "Output",
    ]);
    expect(rows.map((item) => item.querySelector(".rv-bars__count")?.textContent)).toEqual(["9 picks", "3 picks"]);
    const bars = rows.map((item) => (item.querySelector(".rv-bars__bar") as HTMLElement).style.width);
    expect(bars[0]).toBe("100%");
    expect(Number.parseFloat(bars[1] ?? "")).toBeCloseTo(33.33, 1);
    expect(screen.getByText("Learned from users' answers on the card.")).toBeTruthy();
  });

  it("marks no option when the default chooses none of them", () => {
    store.entries = [{ ...BEST, chosen_option: "uptime" }];
    renderAt("/w/mf/review/d_best");
    const picked = screen.getByRole("region", { name: "What users picked" });
    expect(within(picked).queryByText("the default")).toBeNull();
  });

  it("lists what a gap lacks and what would need recording", () => {
    renderAt("/w/mf/review/g_scrap");
    expect(screen.getByText("Data gap", { selector: ".rv-detail__titles .rv-chip" })).toBeTruthy();
    const lacks = screen.getByRole("list", { name: "The data lacks:" });
    expect(within(lacks).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "a cost per scrapped unit",
    ]);
    const record = screen.getByRole("list", { name: "Would need recorded:" });
    expect(within(record).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "the material cost of each scrapped part",
    ]);
    expect(screen.getByText("Drafted by sightline.")).toBeTruthy();
    expect(screen.queryByText(/^Defined as/)).toBeNull();
  });
});
