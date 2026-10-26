// The key-user registry: what sightline proposes for review (measures, learned
// defaults, data gaps), one per workspace, seeded from the fixtures in the core's
// own words. An entry's demand grows as runs that follow its fixtures end; a review
// moves its status and version. HTTP lives in server.ts.
import type { components } from "../src/api/schema.d.ts";
import type {
  EntryChoice,
  EntryGap,
  EntryRun,
  EntrySource,
  ErrorItem,
  RegistryCounts,
  RegistryEntry,
  RegistryEntryDetail,
  RegistryKind,
  RegistryPage,
  RegistryStatus,
  Review,
  ReviewAction,
  RunView,
} from "../src/api/types.ts";
import { HttpError, invalid, WORKSPACES } from "./engine.ts";
import type { Fixture, FixtureIndex } from "./fixture.ts";

type ReviewChanges = components["schemas"]["ReviewChanges"];
type Words = RegistryEntry["words"];

export const KINDS: readonly RegistryKind[] = ["measure", "default", "gap"];
export const STATUSES: readonly RegistryStatus[] = ["proposed", "approved", "rejected"];
const ACTIONS: readonly ReviewAction[] = ["approve", "reject", "reopen", "edit"];
/** Who reviews: v1 has no auth, and the dev user is a key user everywhere. */
export const REVIEWER = "Dev user";

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

// --- the seed ------------------------------------------------------------------------------

interface Seed {
  kind: RegistryKind;
  term: string;
  label: string;
  source: EntrySource;
  status: RegistryStatus;
  words: Words;
  /** The formula or meaning in words; read from a fixture where the run says it. */
  definition: (fixtures: readonly Fixture[]) => string | null;
  note?: string;
  /** The fixtures whose runs ask for the entry: each one that ends counts as demand. */
  slugs: string[];
  /** Runs before the mock's own threads: how many, and how many days ago the first and the last were. */
  history: { runs: number; first: number; last: number };
  /** How many days ago the key user reviewed it; absent while it was never reviewed. */
  reviewed?: number;
  gap?: (fixtures: readonly Fixture[]) => EntryGap;
  choices?: (fixtures: readonly Fixture[]) => EntryChoice[];
}

const KPI_LIBRARY = (standard: string): EntrySource => ({ kind: "library", text: `from sightline's KPI library (${standard})` });
const DRAFTED: EntrySource = { kind: "drafted", text: "drafted by sightline" };
const LEARNED: EntrySource = { kind: "learned", text: "learned from the answers users gave on the card" };

const fixed = <T>(value: T) => (): T => value;

/** What a restatement says after "Defined as: ... not yet approved:", the definition in the core's words. */
function definedAs(slug: string, fallback: string) {
  return (fixtures: readonly Fixture[]): string => {
    const text = fixtures.find((f) => f.slug === slug)?.restatement ?? "";
    const match = /Defined as: .*?not yet approved: (.+?)\.?$/s.exec(text);
    return match?.[1]?.trim() || fallback;
  };
}

/** The not-possible-yet ending of a clarify fixture, as the gap entry keeps it. */
function gapOf(slug: string, fallback: EntryGap) {
  return (fixtures: readonly Fixture[]): EntryGap => {
    const clarify = fixtures.find((f) => f.slug === slug)?.clarify;
    return clarify && (clarify.missing.length || clarify.record.length)
      ? { missing: [...clarify.missing], record: [...clarify.record] }
      : fallback;
  };
}

/** What users picked on a card point, labelled as the fixture's point (if any) labels its options. */
function picks(slug: string | null, point: string, counts: [option: string, label: string, count: number][]) {
  return (fixtures: readonly Fixture[]): EntryChoice[] => {
    const options = fixtures.find((f) => f.slug === slug)?.card?.points.find((p) => p.id === point)?.options ?? [];
    return counts.map(([option, label, count]) => ({
      option,
      label: options.find((o) => o.id === option)?.label ?? label,
      count,
    }));
  };
}

const ISO_22400 = KPI_LIBRARY("ISO 22400-2");
const AEQ = ["aeq-weekly", "aeq-clarify"];

const SEEDS: Record<string, Seed[]> = {
  manufacturing: [
    {
      kind: "measure",
      term: "oee",
      label: "OEE",
      source: ISO_22400,
      status: "proposed",
      words: { en: ["oee", "oee index", "overall equipment effectiveness"], de: ["gesamtanlageneffektivität", "gae"] },
      definition: definedAs(
        "oee-line",
        "availability (actual production time (run hours) over planned busy time (planned busy hours)) times effectiveness " +
          "(ideal production time (ideal hours) over actual production time (run hours)) times quality ratio " +
          "(good quantity over produced quantity)",
      ),
      slugs: ["oee-line"],
      history: { runs: 6, first: 26, last: 14 },
    },
    {
      kind: "measure",
      term: "availability",
      label: "Availability",
      source: ISO_22400,
      status: "approved",
      words: { en: ["availability", "availability rate"], de: ["verfügbarkeit"] },
      definition: fixed("actual production time (run hours) over planned busy time (planned busy hours)"),
      note: "Matches the plant controlling's definition.",
      slugs: AEQ,
      history: { runs: 3, first: 20, last: 15 },
      reviewed: 5,
    },
    {
      kind: "measure",
      term: "effectiveness",
      label: "Effectiveness",
      source: ISO_22400,
      status: "proposed",
      words: { en: ["effectiveness", "performance", "performance rate"], de: ["effektivität", "leistungsgrad"] },
      definition: fixed("ideal production time (ideal hours) over actual production time (run hours)"),
      slugs: AEQ,
      history: { runs: 2, first: 18, last: 15 },
    },
    {
      kind: "measure",
      term: "quality ratio",
      label: "Quality ratio",
      source: ISO_22400,
      status: "proposed",
      words: { en: ["quality ratio", "quality rate"], de: ["qualitätsrate", "qualitätsgrad"] },
      definition: fixed("good quantity over produced quantity"),
      slugs: AEQ,
      history: { runs: 2, first: 18, last: 15 },
    },
    {
      kind: "measure",
      term: "energy per good unit",
      label: "Energy per 1,000 good units",
      source: DRAFTED,
      status: "proposed",
      words: {
        en: ["energy per good unit", "energy per 1,000 good units", "energy intensity"],
        de: ["energie pro gutteil", "energieintensität"],
      },
      definition: fixed("1,000 times the energy used (energy kWh) over the good quantity (good units)"),
      slugs: ["energy"],
      history: { runs: 4, first: 21, last: 13 },
    },
    {
      kind: "measure",
      term: "scrap against plan",
      label: "Scrap against plan",
      source: DRAFTED,
      status: "rejected",
      words: { en: ["scrap against plan", "actual to planned scrap"], de: ["ausschuss gegen plan"] },
      definition: fixed("scrap quantity over planned scrap quantity"),
      note: "Planned scrap is an allowance, not a base to divide by; ask for the scrap rate instead.",
      slugs: ["scrap"],
      history: { runs: 1, first: 16, last: 16 },
      reviewed: 9,
    },
    {
      kind: "default",
      term: "best plant",
      label: "Best plant",
      source: LEARNED,
      status: "proposed",
      words: { en: ["best plant", "best performing plant", "top plant"], de: ["bestes werk", "bester standort"] },
      definition: fixed("OEE"),
      // The ranking questions where users picked the measure the card offered.
      slugs: ["oee-line", "energy"],
      history: { runs: 8, first: 19, last: 4 },
      choices: picks(null, "measure", [
        ["oee", "OEE", 7],
        ["availability", "availability", 2],
        ["scrap_rate", "scrap rate", 1],
      ]),
    },
    {
      kind: "gap",
      term: "energy cost",
      label: "Energy cost per good unit",
      source: DRAFTED,
      status: "proposed",
      words: { en: ["energy cost", "energy costs", "cost of energy"], de: ["energiekosten", "stromkosten"] },
      definition: fixed("the energy used (kWh) times the price per kWh, over the good quantity"),
      // Asked beside the energy-intensity question. No run of the core said this ending; it is
      // written in the core's words, as margin-gap's real one, for the mock alone.
      slugs: ["energy"],
      history: { runs: 2, first: 9, last: 4 },
      gap: fixed({
        missing: ["Energy cost per good unit is not possible yet: the warehouse holds no energy prices"],
        record: ["the price paid per kWh, by plant and month, from the energy contracts or the supplier invoices"],
      }),
    },
  ],
  restaurant: [
    {
      kind: "measure",
      term: "average tip",
      label: "Average tip",
      source: DRAFTED,
      status: "proposed",
      words: { en: ["average tip", "mean tip"], de: ["durchschnittliches trinkgeld"] },
      definition: fixed("the mean tip amount per payment"),
      slugs: ["tips"],
      history: { runs: 2, first: 20, last: 14 },
    },
    {
      kind: "measure",
      term: "delivery revenue",
      label: "Delivery revenue",
      source: DRAFTED,
      status: "approved",
      words: { en: ["delivery revenue", "delivery sales"], de: ["lieferumsatz"] },
      definition: fixed("line revenue of the order lines sold through the delivery channel"),
      note: "As in the monthly channel report.",
      slugs: ["delivery-monthly"],
      history: { runs: 3, first: 25, last: 15 },
      reviewed: 6,
    },
    {
      kind: "measure",
      term: "tip rate",
      label: "Tip rate",
      source: DRAFTED,
      status: "rejected",
      words: { en: ["tip rate", "tip percentage"], de: ["trinkgeldquote"] },
      definition: fixed("tip amount over payment amount"),
      note: "Tips are reported per payment, not as a share of the bill.",
      // Rejected after the tips run asked for it: that run stays its demand, later ones do not count.
      slugs: ["tips"],
      history: { runs: 1, first: 17, last: 11 },
      reviewed: 2,
    },
    {
      kind: "default",
      term: "revenue",
      label: "Revenue",
      source: LEARNED,
      status: "proposed",
      words: { en: ["revenue", "turnover"], de: ["umsatz"] },
      definition: fixed("line revenue"),
      // An answered revenue-ask run goes on as delivery-monthly, so that is the fixture it ends on.
      slugs: ["city-channel", "delivery-monthly"],
      history: { runs: 6, first: 27, last: 13 },
      choices: picks("revenue-ask", "measure", [
        ["fact_order_lines.line_revenue", "line revenue", 6],
        ["fact_payments.amount", "amount", 2],
        ["fact_order_lines.unit_price", "unit price", 1],
      ]),
    },
    {
      kind: "default",
      term: "best branch",
      label: "Best branch",
      source: LEARNED,
      status: "approved",
      words: { en: ["best branch", "top branch"], de: ["beste filiale"] },
      definition: fixed("line revenue"),
      note: "Revenue it is, until margins can be measured.",
      slugs: ["city-channel", "tips"],
      history: { runs: 4, first: 22, last: 5 },
      reviewed: 4,
      choices: picks("revenue-ask", "measure", [
        ["fact_order_lines.line_revenue", "line revenue", 4],
        ["fact_payments.tip_amount", "tip amount", 1],
        ["fact_reservations.party_size", "party size", 1],
      ]),
    },
    {
      kind: "gap",
      term: "profit margin",
      label: "Gross profit margin",
      source: KPI_LIBRARY("income statement ratios"),
      status: "proposed",
      words: { en: ["profit margin", "gross profit margin", "gross margin"], de: ["bruttomarge", "rohertragsmarge"] },
      definition: fixed("(revenue less cost of goods sold) over revenue"),
      slugs: ["margin-gap"],
      history: { runs: 2, first: 24, last: 13 },
      gap: gapOf("margin-gap", {
        missing: ["Gross profit margin is not possible yet: the warehouse holds no cost of goods sold"],
        record: ["the cost of the goods sold per sale or per period, from the costing or the general ledger"],
      }),
    },
    {
      kind: "gap",
      term: "labour cost per cover",
      label: "Labour cost per cover",
      source: DRAFTED,
      status: "rejected",
      words: { en: ["labour cost per cover", "staff cost per guest"], de: ["personalkosten pro gast"] },
      definition: fixed("staff cost over covers served"),
      note: "Payroll stays out of the warehouse.",
      // Asked beside the margin question: the staff side of its costs. Its ending, as energy
      // cost's, is written in the core's words for the mock alone.
      slugs: ["margin-gap"],
      history: { runs: 2, first: 15, last: 8 },
      reviewed: 7,
      gap: fixed({
        missing: ["Labour cost per cover is not possible yet: the warehouse holds no staff hours or wages"],
        record: ["the hours and the wages of each shift, from the rota or the payroll"],
      }),
    },
  ],
};

// --- the state -----------------------------------------------------------------------------

interface EntryRecord {
  entry: Omit<RegistryEntry, "demand">;
  slugs: ReadonlySet<string>;
  history: { runs: number; first: string | null; last: string | null };
  /** The runs the mock holds that asked for it, with when each ended. */
  uses: Map<string, string>;
}

const slugify = (term: string): string =>
  term
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

/** Words compare case-insensitively: "OEE" is "oee". */
const wordKey = (word: string): string => word.trim().toLocaleLowerCase();

function demandOf(record: EntryRecord): RegistryEntry["demand"] {
  const times = [...record.uses.values()];
  const { first, last } = record.history;
  const earliest = [first, ...times].filter((t): t is string => t !== null).sort()[0] ?? null;
  const latest = [last, ...times].filter((t): t is string => t !== null).sort().at(-1) ?? null;
  return { runs: record.history.runs + record.uses.size, first_asked: earliest, last_asked: latest };
}

const asEntry = (record: EntryRecord): RegistryEntry => ({ ...record.entry, demand: demandOf(record) });

/** The 422 for words that already name other entries; `remedy` says what to do about them. */
function collided(clashes: ErrorItem[], remedy?: string): HttpError {
  const said =
    clashes.length === 1 ? (clashes[0]?.msg ?? "A word already names another term.") : `${clashes.length} words already name other terms.`;
  return new HttpError(422, remedy ? `${said.replace(/\.$/, "")}: ${remedy}.` : said, { errors: clashes });
}

/** A run's EntryRun as the engine knows it, or null for a run it does not hold. */
export type RunLookup = (runId: string) => EntryRun | null;

export function createRegistry() {
  const books = new Map<string, Map<string, EntryRecord>>();

  function book(ws: string): Map<string, EntryRecord> {
    const found = books.get(ws);
    if (!found || !WORKSPACES.some((w) => w.id === ws)) throw new HttpError(404, `No workspace ${ws}.`);
    return found;
  }

  function record(ws: string, id: string): EntryRecord {
    const found = book(ws).get(id);
    if (!found) throw new HttpError(404, `No registry entry ${id} in ${ws}.`);
    return found;
  }

  function detail(record: EntryRecord, lookup: RunLookup): RegistryEntryDetail {
    // At: when the run asked for it, as its demand counts it, though the run may have ended again since.
    const runs = [...record.uses.entries()]
      .map(([runId, at]): EntryRun | null => {
        const run = lookup(runId);
        return run && { ...run, at };
      })
      .filter((run): run is EntryRun => run !== null)
      .sort((a, b) => b.at.localeCompare(a.at) || a.run_id.localeCompare(b.run_id));
    return { ...asEntry(record), runs };
  }

  /**
   * Every word of `words` that names another entry still in use (not rejected) in the same
   * locale, at its place in `words`. A rejected entry's words are free for others to take,
   * which is why reopening one checks its words again.
   */
  function collisions(ws: string, self: string, words: Words): ErrorItem[] {
    const others = [...book(ws).values()].filter((r) => r.entry.id !== self && r.entry.status !== "rejected");
    const errors: ErrorItem[] = [];
    for (const [locale, list] of Object.entries(words)) {
      list.forEach((word, index) => {
        const other = others.find((r) => (r.entry.words[locale] ?? []).some((w) => wordKey(w) === wordKey(word)));
        if (!other) return;
        errors.push({
          loc: ["body", "changes", "words", locale, index],
          msg: `"${word}" already names ${other.entry.term}.`,
          type: "word_collision",
          ctx: { word, collides_with: other.entry.term },
        });
      });
    }
    return errors;
  }

  return {
    /** The entries of every workspace, dated back from `now`; demand from the runs comes as they end. */
    seed(fixtures: FixtureIndex, now: number = Date.now()): void {
      for (const workspace of WORKSPACES) {
        const own = fixtures.get(workspace.id) ?? [];
        const entries = new Map<string, EntryRecord>();
        for (const seed of SEEDS[workspace.id] ?? []) {
          const id = `${seed.kind}-${slugify(seed.term)}`;
          const first = now - seed.history.first * DAY;
          const entry: Omit<RegistryEntry, "demand"> = {
            id,
            kind: seed.kind,
            term: seed.term,
            label: seed.label,
            source: seed.source,
            status: seed.status,
            words: Object.fromEntries(Object.entries(seed.words).map(([locale, list]): [string, string[]] => [locale, [...list]])),
            definition: seed.definition(own),
            note: seed.note ?? null,
            // A reviewed entry has had one review since it was proposed at version 1.
            version: seed.reviewed === undefined ? 1 : 2,
            updated_at: iso(seed.reviewed === undefined ? first : now - seed.reviewed * DAY),
            reviewed_by: seed.reviewed === undefined ? null : REVIEWER,
            gap: seed.gap ? seed.gap(own) : null,
            choices: seed.choices ? seed.choices(own) : null,
          };
          entries.set(id, {
            entry,
            slugs: new Set(seed.slugs),
            history: {
              runs: seed.history.runs,
              first: seed.history.runs > 0 ? iso(first) : null,
              last: seed.history.runs > 0 ? iso(now - seed.history.last * DAY) : null,
            },
            uses: new Map(),
          });
        }
        books.set(workspace.id, entries);
      }
    },

    /**
     * A run that followed `slug` ended: it counts as demand for the entries that fixture
     * asks for, once per run. A rejected entry is never proposed again, so a run after
     * its rejection does not count.
     */
    use(ws: string, slug: string, run: RunView): void {
      const at = run.finished_at ?? iso(Date.now());
      for (const record of books.get(ws)?.values() ?? []) {
        if (!record.slugs.has(slug) || record.uses.has(run.id)) continue;
        if (record.entry.status === "rejected" && at > record.entry.updated_at) continue;
        record.uses.set(run.id, at);
      }
    },

    /** Entries by kind and status, most recently asked first, `limit` from the offset `cursor`. */
    list(ws: string, filters: { kind?: RegistryKind; status?: RegistryStatus }, cursor: string | null, limit: number): RegistryPage {
      const all = [...book(ws).values()].map(asEntry);
      const counts: RegistryCounts = { measure: 0, default: 0, gap: 0 };
      for (const entry of all) if (entry.status === "proposed") counts[entry.kind] += 1;
      const matching = all
        .filter((e) => (!filters.kind || e.kind === filters.kind) && (!filters.status || e.status === filters.status))
        .sort(
          (a, b) =>
            (b.demand.last_asked ?? "").localeCompare(a.demand.last_asked ?? "") || a.id.localeCompare(b.id),
        );
      const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
      const end = offset + limit;
      return { items: matching.slice(offset, end), next_cursor: end < matching.length ? String(end) : null, counts };
    },

    get(ws: string, id: string, lookup: RunLookup): RegistryEntryDetail {
      return detail(record(ws, id), lookup);
    },

    /**
     * Applies a review the key user made on `review.version`. 409 version_conflict when
     * the entry moved on since; 409 not_latest for a move its status does not allow
     * (approve and reject from proposed, reopen from approved or rejected); 422
     * word_collision for an edit whose words name another entry, or a reopen whose words
     * another entry took while it was rejected. Edit changes the label and the words only.
     */
    review(ws: string, id: string, review: Review, lookup: RunLookup, now: number = Date.now()): RegistryEntryDetail {
      const found = record(ws, id);
      const { entry } = found;
      if (review.version !== entry.version) {
        throw new HttpError(
          409,
          `Someone reviewed "${entry.label}" first: it is at version ${entry.version} now, not ${review.version}.`,
          { code: "version_conflict" },
        );
      }
      let next: Omit<RegistryEntry, "demand"> = { ...entry };
      switch (review.action) {
        case "approve":
        case "reject": {
          if (entry.status !== "proposed") {
            throw new HttpError(409, `"${entry.label}" is ${entry.status} already; reopen it to review it again.`, {
              code: "not_latest",
            });
          }
          next.status = review.action === "approve" ? "approved" : "rejected";
          break;
        }
        case "reopen": {
          if (entry.status === "proposed") {
            throw new HttpError(409, `"${entry.label}" is proposed already; there is nothing to reopen.`, {
              code: "not_latest",
            });
          }
          // Its words were free while it was rejected: one another entry took since is
          // refused at its place in the entry's words, as the edit that takes it out sends them.
          const clashes = collisions(ws, entry.id, entry.words);
          if (clashes.length > 0) {
            throw collided(clashes, `take ${clashes.length === 1 ? "it" : "them"} out of "${entry.label}" to reopen it`);
          }
          next.status = "proposed";
          break;
        }
        case "edit": {
          const changes = review.changes ?? {};
          const clashes = changes.words ? collisions(ws, entry.id, changes.words) : [];
          if (clashes.length > 0) throw collided(clashes);
          // The words of each locale sent replace that locale's; the same word twice is one word.
          const words: Words = { ...entry.words };
          for (const [locale, list] of Object.entries(changes.words ?? {})) {
            words[locale] = list.filter((word, i) => list.findIndex((w) => wordKey(w) === wordKey(word)) === i);
          }
          next = { ...next, label: changes.label ?? entry.label, words };
          break;
        }
      }
      if (review.note !== undefined) next.note = review.note.trim() || null;
      next = { ...next, version: entry.version + 1, updated_at: iso(now), reviewed_by: REVIEWER };
      found.entry = next;
      return detail(found, lookup);
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;

// --- reading requests -----------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ").replace(/, ([^,]*)$/, " or $1");

/** A query enum filter: absent is no filter, anything else must be one of `values`. */
export function readEnum<T extends string>(query: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const value = query.get(name);
  if (value === null || value === "") return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw invalid(["query", name], `Input should be ${quoted(values)}`, "enum", { expected: quoted(values) });
  }
  return value as T;
}

/** An integer query parameter between `min` and `max`, `fallback` when absent. */
export function readInt(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw invalid(["query", name], "Input should be a valid integer, unable to parse string as an integer", "int_parsing");
  }
  if (value < min) throw invalid(["query", name], `Input should be greater than or equal to ${min}`, "greater_than_equal", { ge: min });
  if (value > max) throw invalid(["query", name], `Input should be less than or equal to ${max}`, "less_than_equal", { le: max });
  return value;
}

/** A review body, checked the way the backend's model checks it: every problem at once, as FastAPI lists them. */
export function readReview(body: unknown): Review {
  if (!isRecord(body)) throw invalid(["body"], "Input should be a valid dictionary or object to extract fields from", "model_attributes_type");
  const errors: ErrorItem[] = [];
  const fail = (loc: (string | number)[], msg: string, type: string) => errors.push({ loc: ["body", ...loc], msg, type });

  const action = body.action;
  if (action === undefined) fail(["action"], "Field required", "missing");
  else if (!ACTIONS.includes(action as ReviewAction)) fail(["action"], `Input should be ${quoted(ACTIONS)}`, "enum");

  const version = body.version;
  if (version === undefined) fail(["version"], "Field required", "missing");
  else if (typeof version !== "number" || !Number.isInteger(version)) fail(["version"], "Input should be a valid integer", "int_type");

  const note = body.note;
  if (note !== undefined && typeof note !== "string") fail(["note"], "Input should be a valid string", "string_type");

  let changes: ReviewChanges | undefined;
  if (body.changes !== undefined && body.changes !== null) {
    if (!isRecord(body.changes)) fail(["changes"], "Input should be a valid dictionary", "dict_type");
    else changes = readChanges(body.changes, fail);
  }
  if (action === "edit" && errors.length === 0 && changes?.label === undefined && changes?.words === undefined) {
    fail(["changes"], "An edit changes the label or the words", "missing");
  }

  if (errors.length > 0) {
    const first = errors[0];
    const detail = errors.length === 1 && first ? `${first.loc.join(".")}: ${first.msg}` : `${errors.length} fields are not valid.`;
    throw new HttpError(422, detail, { errors });
  }
  const review: Review = { action: action as ReviewAction, version: version as number };
  if (typeof note === "string") review.note = note;
  if (changes) review.changes = changes;
  return review;
}

/** The label (not empty) and the words per locale (trimmed, none empty), at the indices the key user sent them. */
function readChanges(
  raw: Record<string, unknown>,
  fail: (loc: (string | number)[], msg: string, type: string) => void,
): ReviewChanges {
  const changes: ReviewChanges = {};
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string") fail(["changes", "label"], "Input should be a valid string", "string_type");
    else if (!raw.label.trim()) fail(["changes", "label"], "String should have at least 1 character", "string_too_short");
    else changes.label = raw.label.trim();
  }
  if (raw.words !== undefined) {
    if (!isRecord(raw.words)) {
      fail(["changes", "words"], "Input should be a valid dictionary", "dict_type");
      return changes;
    }
    const words: Words = {};
    for (const [locale, list] of Object.entries(raw.words)) {
      if (!LOCALE.test(locale)) {
        fail(["changes", "words", locale], "Not a locale, e.g. en or de", "value_error");
        continue;
      }
      if (!Array.isArray(list)) {
        fail(["changes", "words", locale], "Input should be a valid list", "list_type");
        continue;
      }
      const kept: string[] = [];
      list.forEach((word: unknown, index) => {
        if (typeof word !== "string") return fail(["changes", "words", locale, index], "Input should be a valid string", "string_type");
        if (!word.trim()) return fail(["changes", "words", locale, index], "String should have at least 1 character", "string_too_short");
        kept.push(word.trim());
      });
      words[locale] = kept;
    }
    changes.words = words;
  }
  return changes;
}
