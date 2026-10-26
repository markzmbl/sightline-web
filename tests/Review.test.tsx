import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { RegistryFilters } from "../src/api/registry";
import type { RegistryCounts, RegistryEntryDetail, Review } from "../src/api/types";
import { ReviewPage } from "../src/pages/ReviewPage";

// The registry hooks stand in as fakes over a little store: the lists filter it, the entry
// reads it, and a review answers with whatever the test puts in `answer`.
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let tick = 0;
  return {
    entries: [] as RegistryEntryDetail[],
    counts: { measure: 0, default: 0, gap: 0 } as RegistryCounts,
    hasNextPage: false,
    fetchNextPage: (): void => {},
    /** Every filter the list asked with, the latest last. */
    filters: [] as RegistryFilters[],
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
    /** A new version of an entry, as a refetch would bring it. */
    put(entry: RegistryEntryDetail) {
      store.entries = store.entries.map((existing) => (existing.id === entry.id ? entry : existing));
      tick += 1;
      for (const listener of listeners) listener();
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
  return {
    registryKeys: {},
    useRegistry: (_ws: string, filters: RegistryFilters) => {
      useStore();
      store.filters.push(filters);
      const items = store.entries.filter(
        (entry) =>
          (!filters.status || entry.status === filters.status) && (!filters.kind || entry.kind === filters.kind),
      );
      return {
        isPending: false,
        isError: false,
        error: null,
        data: { pages: [{ items, next_cursor: null, counts: store.counts }], pageParams: [null] },
        hasNextPage: store.hasNextPage,
        isFetchingNextPage: false,
        fetchNextPage: () => store.fetchNextPage(),
        refetch: () => {},
      };
    },
    useRegistryCounts: () => ({ data: store.counts, isPending: false, isError: false }),
    useRegistryEntry: (_ws: string, entryId: string | null) => {
      useStore();
      const data = store.entries.find((entry) => entry.id === entryId);
      return { data, isPending: data === undefined, isError: false, error: null, refetch: () => {} };
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
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function entry(over: Partial<RegistryEntryDetail> = {}): RegistryEntryDetail {
  return {
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
    gap: null,
    choices: null,
    runs: [
      { run_id: "r1", thread_id: "t1", question: "OEE by plant last week", rating: "up", at: ago(3 * HOUR) },
      { run_id: "r2", thread_id: "t2", question: "Which line had the best OEE?", rating: null, at: ago(5 * HOUR) },
    ],
    ...over,
  };
}

const OEE = entry();
const BEST = entry({
  id: "d_best",
  kind: "default",
  term: "best plant",
  label: "Best plant, by OEE",
  source: { kind: "learned", text: "learned from users' answers on the card" },
  definition: "OEE",
  words: { en: ["best plant"] },
  version: 1,
  choices: [
    { option: "output", label: "Output", count: 3 },
    { option: "oee", label: "OEE", count: 9 },
  ],
  runs: [],
});
const SCRAP = entry({
  id: "g_scrap",
  kind: "gap",
  term: "scrap cost",
  label: "Cost of scrap",
  source: { kind: "drafted", text: "drafted by sightline" },
  definition: null,
  words: { en: ["scrap cost"] },
  version: 1,
  gap: { missing: ["a cost per scrapped unit"], record: ["the material cost of each scrapped part"] },
  runs: [],
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
    updated_at: ago(0),
  };
}

const AVAILABILITY = entry({
  id: "m_avail",
  term: "Availability",
  label: "Run time over planned time",
  status: "approved",
  reviewed_by: "Ada",
  version: 2,
  words: { en: ["availability"] },
});

beforeEach(() => {
  store.entries = [OEE, BEST, SCRAP, AVAILABILITY];
  store.counts = { measure: 1, default: 1, gap: 1 };
  store.hasNextPage = false;
  store.fetchNextPage = () => {};
  store.filters = [];
  store.reviews = [];
  store.answer = null;
  store.settle = () => Promise.resolve();
});

afterEach(cleanup);

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
const click = (element: Element) => act(async () => void fireEvent.click(element));
const type = (element: Element, value: string) =>
  act(async () => void fireEvent.change(element, { target: { value } }));
const enter = (element: Element) => act(async () => void fireEvent.keyDown(element, { key: "Enter" }));
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
    renderAt("/w/mf/review?status=proposed&kind=gap");
    expect(lastFilters()).toEqual({ status: "proposed", kind: "gap" });
    expect(terms()).toEqual(["scrap cost"]);
    expect(button("Gaps 1 proposed").getAttribute("aria-pressed")).toBe("true");
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
    expect(within(detail).getByText("v3")).toBeTruthy();
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

  it("lists the runs that used it, with their ratings, linked to their threads", () => {
    renderAt("/w/mf/review/m_oee");
    expect(screen.getByRole("link", { name: "OEE by plant last week" }).getAttribute("href")).toBe("/w/mf/t/t1");
    expect(screen.getByRole("link", { name: "Which line had the best OEE?" }).getAttribute("href")).toBe("/w/mf/t/t2");
    expect(screen.getAllByRole("img", { name: /^Rated/ }).map((icon) => icon.getAttribute("aria-label"))).toEqual([
      "Rated good",
    ]);
  });

  it("approves with the version shown, then offers Reopen", async () => {
    store.answer = async () => ({ ...OEE, status: "approved", version: 4, reviewed_by: "Dev", updated_at: ago(0) });
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
    expect(screen.getByText("v4")).toBeTruthy();
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

  it("offers Reopen, and no Approve, for an approved entry", async () => {
    renderAt("/w/mf/review/m_avail?status=approved");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText(/reviewed by Ada · 2 h ago/)).toBeTruthy();
    await click(button("Reopen"));
    expect(store.reviews).toEqual([{ entryId: "m_avail", body: { action: "reopen", version: 2 } }]);
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
    expect(screen.getByText("v4")).toBeTruthy();
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
    expect(screen.getByText("v4")).toBeTruthy();
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
    expect(screen.getByText("v5")).toBeTruthy();
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
      store.put({ ...OEE, version: 4, label: "OEE (ISO 22400-2)", reviewed_by: "Bea" });
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
    expect(screen.getByText("v4")).toBeTruthy();
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

describe("what an entry shows for its kind", () => {
  it("shows what users picked for a learned default, the counts as text", () => {
    renderAt("/w/mf/review/d_best");
    expect(screen.getByText("OEE", { selector: "strong" }).parentElement?.textContent).toBe("Means: OEE");
    const picked = screen.getByRole("region", { name: "What users picked" });
    const rows = within(picked).getAllByRole("listitem");
    expect(rows.map((item) => item.querySelector(".rv-bars__label")?.textContent)).toEqual([
      "OEEthe default",
      "Output",
    ]);
    expect(rows.map((item) => item.querySelector(".rv-bars__count")?.textContent)).toEqual(["9 picks", "3 picks"]);
    const bars = rows.map((item) => (item.querySelector(".rv-bars__bar") as HTMLElement).style.width);
    expect(bars[0]).toBe("100%");
    expect(Number.parseFloat(bars[1] ?? "")).toBeCloseTo(33.33, 1);
    expect(screen.getByText("Learned from users' answers on the card.")).toBeTruthy();
  });

  it("lists what a gap lacks and what would need recording", () => {
    renderAt("/w/mf/review/g_scrap");
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
