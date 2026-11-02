// The mock's state: threads, runs and their event logs, and the replays that
// write those logs. HTTP lives in server.ts; this module knows nothing of it.
//
// Each run answers a reading: an anchor (the thread's question, or the latest
// follow-up or nearest question sent) plus the revisions typed after it. The
// fixture a run replays is the one that reading matches (match.ts), or the one a
// follow-up names; a take-back re-runs an earlier revision's reading and fixture.
import { randomBytes } from "node:crypto";
import type {
  Card,
  DecisionPoint,
  Definition,
  EntryRun,
  ErrorItem,
  FollowRef,
  Me,
  ProblemCode,
  Rating,
  Revise,
  RunCreated,
  RunEvent,
  RunOrigin,
  RunStatus,
  RunSummary,
  RunView,
  SchemaInfo,
  StepResult,
  Thread,
  ThreadPage,
  ThreadSummary,
  Workspace,
} from "../src/api/types.ts";
import { humanise, passStages, type Fixture, type FixtureIndex } from "./fixture.ts";
import { fold, isOpen, newRunView } from "./fold.ts";
import { bestMatch, MIN_SCORE } from "./match.ts";
import { chartOptions, chartView, followUpsOf, plan, presentStages, restarted, stagesAfter, type Beat } from "./plan.ts";

/**
 * Example questions for the empty page. Manufacturing's come from the industry question
 * bank (kb/benchmarks/industry-questions.yaml: mfg-29, mfg-30, mfg-36) and one fixture;
 * restaurant's from its pack's golden questions (datasets/restaurant/golden.yaml) and the
 * fixture that asks back.
 */
export const STARTERS: Readonly<Record<string, string[]>> = {
  manufacturing: [
    "What was the overall equipment effectiveness (OEE) of each line last week?",
    "How did availability, effectiveness and quality ratio develop per week over the last quarter?",
    "Which production orders had the most scrap against plan?",
    "Which lines use the most energy per 1,000 good units?",
  ],
  restaurant: [
    "How did delivery revenue develop per month over the last year?",
    "Revenue by city and channel",
    "What is the average tip by payment method?",
    "How much revenue did we make per month in 2025?",
  ],
};

export const WORKSPACES: Workspace[] = [
  { id: "manufacturing", name: "Manufacturing (demo)", pack: "manufacturing", role: "key_user", starters: [...(STARTERS.manufacturing ?? [])] },
  { id: "restaurant", name: "Restaurant (demo)", pack: "restaurant", role: "key_user", starters: [...(STARTERS.restaurant ?? [])] },
];

export const DEV_USER: Me["user"] = { id: "dev", name: "Dev user", email: null };

/** How many runs a workspace may have queued, running or asking at once. */
export const MAX_ACTIVE = 3;
/** What a 429 tells the client to wait, in seconds. */
export const RETRY_AFTER_S = 5;
/** A seeded run older than this was made by an earlier version of sightline: it can't be changed any more. */
const STALE_AFTER_MS = 7 * 86_400_000;
/** The agreed words for a stale run (contract v0.2.1's stale_run). */
export const STALE_RUN =
  "This answer was made by an earlier version of sightline and can't be changed any more. Ask the question again for a fresh answer.";

/** The parts of a Problem besides its detail: its code, a 422's FastAPI-shaped errors, a 429's headers. */
export interface ProblemParts {
  code?: ProblemCode;
  errors?: ErrorItem[];
  headers?: Record<string, string>;
}

/** A failure the HTTP layer answers as a Problem {detail, code?, errors?} with this status. */
export class HttpError extends Error {
  status: number;
  code: ProblemCode | undefined;
  errors: ErrorItem[] | undefined;
  headers: Record<string, string>;
  constructor(status: number, detail: string, parts: ProblemParts = {}) {
    super(detail);
    this.status = status;
    this.code = parts.code;
    this.errors = parts.errors;
    this.headers = parts.headers ?? {};
  }
}

/** A 422 for one field, worded the way FastAPI words it; loc starts at "body", "query" or "path". */
export function invalid(loc: (string | number)[], msg: string, type: string, ctx?: Record<string, unknown>): HttpError {
  const item: ErrorItem = ctx ? { loc, msg, type, ctx } : { loc, msg, type };
  return new HttpError(422, `${loc.join(".")}: ${msg}`, { errors: [item] });
}

const notFound = (code: ProblemCode, detail: string): HttpError => new HttpError(404, detail, { code });

export interface Frame {
  id: number;
  event: RunEvent;
}

/** What a run answers: its anchor, the fixture the anchor names (a follow-up's), and the revisions typed after it. */
interface Reading {
  anchor: string;
  target: string | null;
  typed: string[];
}

interface RunRecord {
  view: RunView;
  log: Frame[];
  workspace: string;
  /** The fixture the run follows now (an answered card moves it to the continuation). */
  fixture: Fixture;
  reading: Reading;
  /** The chart class presented, when the user picked one. */
  chart: string | null;
  /** Made by an earlier version of sightline: its card and chart can't be changed. */
  stale: boolean;
  /** When the step under way started (wall clock), for the elapsed time of a step the run's end cuts off. */
  stepAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<(frame: Frame) => void>;
}

interface ThreadRecord {
  id: string;
  workspace: string;
  question: string;
  created_at: string;
  updated_at: string;
  runs: RunRecord[];
  /** The revisions taken back, which can't be taken back again. */
  takenBack: Set<number>;
}

export interface EngineOptions {
  /** Real stage times are divided by this. */
  speed: number;
  /** No stage or step is shorter than this, in wall-clock ms; a worker picks up a queued run after as long. */
  minStageMs: number;
  /** Every nth new run is restarted once by its worker (queued after running); 0, never. */
  restartEvery?: number;
  /** Serve the made-up analysis (storyline, supports, steps, follow-ups); false serves what the backend sends today. */
  analysis?: boolean;
  /** Runs queued, running or asking a workspace may have at once. */
  maxActive?: number;
  /** Called when a run ends complete or clarify, with the fixture it followed last (the registry's demand). */
  onEnded?: (workspace: string, slug: string, run: RunView) => void;
  /** The definitions a run uses, with their statuses as the registry has them when the run starts. */
  definitions?: (workspace: string, definitions: Definition[]) => Definition[];
}

interface Signal {
  kind: string;
  thread_id: string;
  at: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How long ago the seeded threads were last updated, so the sidebar's date groups fill. */
const SEED_AGES = [2 * HOUR, DAY, 3 * DAY, 12 * DAY];
/** The ratings users gave some seeded runs, so the registry's runs carry them. */
const SEED_RATINGS: Readonly<Record<string, Rating>> = {
  "oee-line": "up",
  "aeq-weekly": "up",
  scrap: "down",
  "delivery-monthly": "up",
  tips: "up",
};
/** A restarted run's first worker stops after this many stages. */
const RESTART_AFTER = 2;
/** The steps of DecisionPoint.step in the order a run decides them. */
const STEP_ORDER: readonly string[] = ["meaning", "terms", "form", "point", "detail"];

const iso = (ms: number): string => new Date(ms).toISOString();
const newId = (prefix: string): string => `${prefix}_${randomBytes(5).toString("hex")}`;
const textOf = (reading: Reading): string => [reading.anchor, ...reading.typed].join(" ");

interface Start {
  prompt: string;
  origin: RunOrigin;
  takes_back?: number | null;
  follows?: FollowRef | null;
  reading: Reading;
}

export function createEngine(fixtures: FixtureIndex, options: EngineOptions) {
  const threads = new Map<string, ThreadRecord>();
  const runs = new Map<string, RunRecord>();
  const turns = new Map<string, number>(); // round-robin position per workspace
  const signals: Signal[] = [];
  const analysis = options.analysis ?? true;
  const maxActive = options.maxActive ?? MAX_ACTIVE;
  let lastWorkspace: string | null = null;
  let started = 0; // new runs so far, for restartEvery

  // --- lookups ---------------------------------------------------------------

  function workspaceFixtures(ws: string): Fixture[] {
    if (!WORKSPACES.some((w) => w.id === ws)) throw notFound("no_workspace", `No workspace ${ws}.`);
    return fixtures.get(ws) ?? [];
  }

  function thread(ws: string, id: string): ThreadRecord {
    workspaceFixtures(ws);
    const found = threads.get(id);
    if (!found || found.workspace !== ws) throw notFound("no_thread", `No thread ${id} in ${ws}.`);
    return found;
  }

  function run(ws: string, id: string): RunRecord {
    workspaceFixtures(ws);
    const found = runs.get(id);
    if (!found || found.workspace !== ws) throw notFound("no_run", `No run ${id} in ${ws}.`);
    return found;
  }

  /** The run's thread; 409 not_latest when a newer revision has followed the run. */
  function latestOwner(record: RunRecord, what: string): ThreadRecord {
    const owner = thread(record.workspace, record.view.thread_id);
    const latest = owner.runs.at(-1);
    if (latest !== record) {
      throw new HttpError(
        409,
        `Run ${record.view.id} is revision ${record.view.revision}, not the thread's latest (${latest?.view.id ?? "none"}); ${what}.`,
        { code: "not_latest" },
      );
    }
    return owner;
  }

  /** 409 stale_run for a run an earlier version of sightline made, with its prompt to ask again with. */
  function fresh(record: RunRecord): void {
    if (!record.stale) return;
    throw new HttpError(409, STALE_RUN, {
      code: "stale_run",
      errors: [{ loc: ["path", "run_id"], msg: STALE_RUN, type: "stale_run", ctx: { prompt: record.view.prompt } }],
    });
  }

  /** 429 too_many_active when the workspace would have more runs open than it allows; `leaving` end first. */
  function room(ws: string, leaving: readonly RunRecord[] = []): void {
    const open = [...runs.values()].filter((r) => r.workspace === ws && isOpen(r.view.status) && !leaving.includes(r)).length;
    if (open < maxActive) return;
    throw new HttpError(
      429,
      `The workspace has ${open} runs on their way, as many as it allows; try again in ${RETRY_AFTER_S} seconds.`,
      { code: "too_many_active", headers: { "Retry-After": String(RETRY_AFTER_S) } },
    );
  }

  /**
   * The fixture for a reading: the one a follow-up names (until a revision is typed after
   * it), else the best match of its words, else the next complete one in turn.
   */
  function choose(ws: string, reading: Reading, avoid?: string): Fixture {
    const all = workspaceFixtures(ws);
    if (reading.target && reading.typed.length === 0) {
      const named = all.find((f) => f.slug === reading.target);
      if (named) return named;
    }
    const match = bestMatch(all, textOf(reading), avoid);
    if (match && match.score >= MIN_SCORE) return match.fixture;
    const complete = all.filter((f) => f.final_status === "complete" && f.slug !== avoid);
    const pool = complete.length ? complete : all;
    const turn = turns.get(ws) ?? 0;
    turns.set(ws, turn + 1);
    const fixture = pool[turn % pool.length];
    if (!fixture) throw new HttpError(422, `The mock has no fixtures for ${ws}.`);
    return fixture;
  }

  /** The fixture's definitions with their statuses now; a rejected entry never answers. */
  const definitionsOf = (ws: string, fixture: Fixture): Definition[] =>
    options.definitions ? options.definitions(ws, fixture.definitions) : fixture.definitions;

  // --- the event log -----------------------------------------------------------

  function emit(record: RunRecord, event: RunEvent, at: string = iso(Date.now())): void {
    const frame: Frame = { id: record.log.length + 1, event };
    record.log.push(frame);
    record.view = fold(record.view, event, frame.id, at);
    if (event.type === "run.status") {
      // A thread moves when a run is created or changes status, never on feedback or signals.
      const owner = threads.get(record.view.thread_id);
      if (owner && at > owner.updated_at) owner.updated_at = at;
      if (event.status === "complete" || event.status === "clarify") {
        options.onEnded?.(record.workspace, record.fixture.slug, record.view);
      }
    }
    for (const listener of [...record.listeners]) listener(frame);
  }

  /** A change the contract carries on no event (definitions, follow-ups): beside the log. */
  function patch(record: RunRecord, change: Partial<RunView>): void {
    record.view = { ...record.view, ...change };
  }

  function halt(record: RunRecord): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
  }

  const stepStarted = (record: RunRecord, beat: Extract<Beat, { kind: "step" }>, at: string): RunEvent => ({
    type: "step.started",
    run_id: record.view.id,
    stage: beat.step.stage,
    step: { id: beat.step.id, label: beat.step.label },
    role: beat.step.role,
    at,
  });
  const stepFinished = (record: RunRecord, beat: Extract<Beat, { kind: "step" }>, at: string): RunEvent => ({
    type: "step.finished",
    run_id: record.view.id,
    stage: beat.step.stage,
    step: { id: beat.step.id, label: beat.step.label },
    role: beat.step.role,
    cached: beat.step.cached,
    at,
    elapsed_ms: beat.step.ms,
    verdict: beat.step.verdict,
    sql: beat.step.sql,
    row_count: beat.step.row_count,
  });

  /**
   * Plays beats into the run on timers. With `now`, the beats up to the first wait are
   * emitted before this returns, so a client that reads the run right after the 202
   * finds it queued with its first frame.
   */
  function play(record: RunRecord, beats: Beat[], now = true): void {
    halt(record);
    let next = 0;
    const wait = (ms: number, then: () => void) => {
      record.timer = setTimeout(then, Math.max(ms / options.speed, options.minStageMs));
    };
    const advance = (): void => {
      record.timer = null;
      while (next < beats.length) {
        const beat = beats[next++];
        if (!beat) break;
        const id = record.view.id;
        switch (beat.kind) {
          case "event":
            emit(record, beat.make(id));
            continue;
          case "set":
            patch(record, beat.patch(record.view));
            continue;
          case "open":
            emit(record, { type: "stage.started", run_id: id, phase: beat.phase, stage: beat.stage, at: iso(Date.now()) });
            continue;
          case "close":
            emit(record, { type: "stage.finished", run_id: id, phase: beat.phase, stage: beat.stage, at: iso(Date.now()), elapsed_ms: beat.ms });
            continue;
          case "pause":
            record.timer = setTimeout(advance, options.minStageMs);
            return;
          case "step":
            record.stepAt = Date.now();
            emit(record, stepStarted(record, beat, iso(record.stepAt)));
            wait(beat.step.ms, () => {
              record.stepAt = null;
              emit(record, stepFinished(record, beat, iso(Date.now())));
              advance();
            });
            return;
          case "stage": {
            const { phase, stage, ms } = beat;
            emit(record, { type: "stage.started", run_id: id, phase, stage, at: iso(Date.now()) });
            wait(ms, () => {
              emit(record, { type: "stage.finished", run_id: id, phase, stage, at: iso(Date.now()), elapsed_ms: ms });
              advance();
            });
            return;
          }
        }
      }
    };
    if (now) advance();
    else record.timer = setTimeout(advance, options.minStageMs);
  }

  /** Writes beats into the log at once, on a clock starting at `start`; returns the end time. */
  function synthesize(record: RunRecord, beats: Beat[], start: number): number {
    let t = start;
    let opened = start;
    for (const beat of beats) {
      const id = record.view.id;
      switch (beat.kind) {
        case "pause":
          break;
        case "event":
          emit(record, beat.make(id), iso(t));
          break;
        case "set":
          patch(record, beat.patch(record.view));
          break;
        case "open":
          opened = t;
          emit(record, { type: "stage.started", run_id: id, phase: beat.phase, stage: beat.stage, at: iso(t) }, iso(t));
          break;
        case "close":
          t = Math.max(t, opened + beat.ms);
          emit(record, { type: "stage.finished", run_id: id, phase: beat.phase, stage: beat.stage, at: iso(t), elapsed_ms: beat.ms }, iso(t));
          break;
        case "step":
          emit(record, stepStarted(record, beat, iso(t)), iso(t));
          t += beat.step.ms;
          emit(record, stepFinished(record, beat, iso(t)), iso(t));
          break;
        case "stage": {
          const { phase, stage, ms } = beat;
          emit(record, { type: "stage.started", run_id: id, phase, stage, at: iso(t) }, iso(t));
          t += ms;
          emit(record, { type: "stage.finished", run_id: id, phase, stage, at: iso(t), elapsed_ms: ms }, iso(t));
          break;
        }
      }
    }
    return t;
  }

  // --- threads and runs ----------------------------------------------------------

  function addRun(owner: ThreadRecord, fixture: Fixture, start: Start, id = newId("run")): RunRecord {
    const revision = owner.runs.reduce((max, r) => Math.max(max, r.view.revision + 1), 0);
    const record: RunRecord = {
      view: newRunView(id, owner.id, revision, start.prompt, {
        origin: start.origin,
        takes_back: start.takes_back ?? null,
        follows: start.follows ?? null,
      }),
      log: [],
      workspace: owner.workspace,
      fixture,
      reading: start.reading,
      chart: null,
      stale: false,
      stepAt: null,
      timer: null,
      listeners: new Set(),
    };
    owner.runs.push(record);
    runs.set(id, record);
    owner.updated_at = iso(Date.now());
    return record;
  }

  /**
   * Ends an open run at once: cancelled by Stop, superseded by a newer revision. Its worker
   * drops what it would still have said, so the terminal run.status is the only frame it
   * writes. A step under way stays in steps with the time until the end and no verdict
   * (beside the log: no step.finished comes for it). An asking run keeps its card as it
   * stood, blocking: the record of what sightline asked, which nobody answered.
   */
  function end(record: RunRecord, status: "cancelled" | "superseded"): void {
    if (!isOpen(record.view.status)) return;
    halt(record);
    const under = record.view.step;
    if (under) {
      const elapsed = Math.max(0, Date.now() - (record.stepAt ?? Date.now()));
      patch(record, {
        steps: record.view.steps.map((s) =>
          s.id === under.id ? { ...s, elapsed_ms: elapsed, verdict: null, sql: null, row_count: null, cached: false } : s,
        ),
      });
      record.stepAt = null;
    }
    emit(record, { type: "run.status", run_id: record.view.id, status });
  }

  /** A new run of the thread that replays `fixture`; a run of the thread still open is superseded. */
  function startRun(owner: ThreadRecord, fixture: Fixture, start: Start): RunCreated {
    for (const open of owner.runs) end(open, "superseded");
    const record = addRun(owner, fixture, start);
    started += 1;
    lastWorkspace = owner.workspace;
    const every = options.restartEvery ?? 0;
    const beats = plan(fixture, { analysis, definitions: definitionsOf(owner.workspace, fixture) });
    play(record, every > 0 && started % every === 0 ? restarted(beats, RESTART_AFTER) : beats);
    return { thread_id: owner.id, run_id: record.view.id };
  }

  /**
   * The same run presents again from its own fixture, as a worker picks it up anew:
   * queued, running, the present stages, the charts, `card` (as answered, or as the
   * chart pick set it), result, complete.
   */
  function represent(record: RunRecord, card: Card | null): void {
    const fixture = record.fixture;
    play(record, plan(fixture, { analysis, stages: presentStages(fixture), chart: record.chart, card, restate: false }));
  }

  /** A typed revision (the composer, or the card's free text): the latest run's reading plus the message. */
  function typed(owner: ThreadRecord, message: string): RunCreated {
    const latest = owner.runs.at(-1);
    const reading: Reading = latest
      ? { anchor: latest.reading.anchor, target: latest.reading.target, typed: [...latest.reading.typed, message] }
      : { anchor: owner.question, target: null, typed: [message] };
    room(owner.workspace, owner.runs);
    const fixture = choose(owner.workspace, reading, latest?.fixture.slug);
    return startRun(owner, fixture, { prompt: message, origin: "revision", reading });
  }

  /**
   * The card with the answers applied. A null answer ("decide for me") keeps the chosen
   * option and who chose it; an answered point is no longer open either way.
   */
  function answered(card: Card, answers: Record<string, string | null>): Card {
    return {
      blocking: false,
      points: card.points.map((point) => {
        if (!(point.id in answers)) return point;
        const answer = answers[point.id];
        return answer == null ? { ...point, open: false } : { ...point, chosen: answer, by: "user", open: false };
      }),
    };
  }

  /** The chart an answered card's form point chose, when it is one the run offers. */
  function chartOf(card: Card, fixture: Fixture): string | null {
    const offered = new Set(chartOptions(fixture).map((o) => o.chart));
    const form = card.points.find((p) => p.step === "form" && p.chosen !== null && offered.has(p.chosen));
    return form?.chosen ?? null;
  }

  /**
   * The card after a chart pick: the form point that offers the chart, chosen by the user.
   * A card that did not ask it (nobody was unsure of it) gets the fixture's form point,
   * after the points of the steps before form and before those after it; a run without a
   * card gets one beside the chart that holds the point alone.
   */
  function picked(card: Card | null, chart: string, fixture: Fixture): Card | null {
    const choose = (point: DecisionPoint): DecisionPoint => ({ ...point, chosen: chart, by: "user", open: false });
    const offers = (point: DecisionPoint) => point.step === "form" && point.options.some((o) => o.id === chart);
    if (card?.points.some(offers)) return { ...card, points: card.points.map((p) => (offers(p) ? choose(p) : p)) };
    const form = fixture.form_point;
    if (!form || !offers(form)) return card;
    const points = card?.points ?? [];
    const after = points.findIndex((p) => STEP_ORDER.indexOf(p.step) > STEP_ORDER.indexOf("form"));
    const at = after < 0 ? points.length : after;
    return { blocking: false, points: [...points.slice(0, at), choose(form), ...points.slice(at)] };
  }

  function summary(owner: ThreadRecord): ThreadSummary {
    const latest = owner.runs.at(-1);
    const status: RunStatus = latest?.view.status ?? "queued";
    return {
      id: owner.id,
      question: owner.question,
      restatement: latest?.view.restatement ?? null,
      status,
      active_run_id: owner.runs.findLast((r) => isOpen(r.view.status))?.view.id ?? null,
      revisions: Math.max(0, owner.runs.length - 1),
      updated_at: owner.updated_at,
    };
  }

  function runSummary({ view }: RunRecord): RunSummary {
    const chart = view.result?.chart ?? null;
    return {
      id: view.id,
      revision: view.revision,
      prompt: view.prompt,
      origin: view.origin,
      takes_back: view.takes_back,
      follows: view.follows,
      status: view.status,
      restatement: view.restatement,
      top: view.result?.storyline?.top ?? null,
      chart: chart ? { chart: chart.chart, label: chart.label } : null,
      started_at: view.started_at,
      finished_at: view.finished_at,
      feedback: view.feedback,
    };
  }

  /** Every text of a thread a search reads: its question, and each run's prompt and restatement. */
  const searchable = (owner: ThreadRecord): string =>
    [owner.question, ...owner.runs.flatMap((r) => [r.view.prompt, r.view.restatement ?? ""])].join("\n").toLowerCase();

  // --- the operations the server exposes -----------------------------------------------

  return {
    /** One finished thread per complete or clarify fixture, spread over the last two weeks, some rated. */
    seed(now: number = Date.now()): void {
      let newest = "";
      for (const workspace of WORKSPACES) {
        // Complete runs first, so the newest thread in the sidebar shows a chart.
        const finished = (fixtures.get(workspace.id) ?? [])
          .filter((f) => f.final_status === "complete" || f.final_status === "clarify")
          .sort((a, b) => Number(a.final_status !== "complete") - Number(b.final_status !== "complete"));
        finished.forEach((fixture, i) => {
          const age = (SEED_AGES[i % SEED_AGES.length] ?? HOUR) + Math.floor(i / SEED_AGES.length) * 45 * 60_000;
          const end = now - age;
          const beats = plan(fixture, { analysis, definitions: definitionsOf(workspace.id, fixture) });
          const total = passStages(fixture, analysis).reduce((sum, s) => sum + s.ms, 0);
          const owner: ThreadRecord = {
            id: `th_seed_${fixture.slug}`,
            workspace: workspace.id,
            question: fixture.question,
            created_at: iso(end - total),
            updated_at: iso(end - total),
            runs: [],
            takenBack: new Set(),
          };
          threads.set(owner.id, owner);
          const reading: Reading = { anchor: fixture.question, target: null, typed: [] };
          const record = addRun(owner, fixture, { prompt: fixture.question, origin: "question", reading }, `run_seed_${fixture.slug}`);
          owner.updated_at = owner.created_at;
          synthesize(record, beats, end - total);
          record.stale = age > STALE_AFTER_MS;
          const rating = SEED_RATINGS[fixture.slug];
          if (rating) record.view = { ...record.view, feedback: rating };
          owner.updated_at = iso(end);
          if (owner.updated_at > newest) {
            newest = owner.updated_at;
            lastWorkspace = workspace.id;
          }
        });
      }
    },

    me(): Me {
      return { user: DEV_USER, workspaces: WORKSPACES, last_workspace: lastWorkspace };
    },

    listThreads(ws: string, query: { q?: string; updatedSince?: string; cursor: string | null; limit: number }): ThreadPage {
      workspaceFixtures(ws);
      const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
      const words = query.q?.trim().toLowerCase() ?? "";
      const since = query.updatedSince ? Date.parse(query.updatedSince) : null;
      const all = [...threads.values()]
        .filter((t) => t.workspace === ws)
        .filter((t) => !words || searchable(t).includes(words))
        .filter((t) => since === null || Date.parse(t.updated_at) >= since)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
      const end = offset + query.limit;
      return { items: all.slice(offset, end).map(summary), next_cursor: end < all.length ? String(end) : null };
    },

    getThread(ws: string, id: string): Thread {
      const owner = thread(ws, id);
      const latest = owner.runs.at(-1);
      if (!latest) throw notFound("no_thread", `Thread ${id} has no run.`);
      return {
        id: owner.id,
        question: owner.question,
        locale: null,
        created_at: owner.created_at,
        updated_at: owner.updated_at,
        latest: latest.view,
        runs: owner.runs.map(runSummary),
      };
    },

    getRun(ws: string, id: string): RunView {
      return run(ws, id).view;
    },

    /**
     * One step's SQL and rows: a step the run told, or the one its result names. A step
     * still under way, or cut off by the run's end, has none yet (its record says sql and
     * row_count null): no SQL and no rows, as the record has it.
     */
    getStep(ws: string, runId: string, stepId: string): StepResult {
      const record = run(ws, runId);
      const steps = record.fixture.analysis?.steps ?? [];
      const held = record.view.steps.find((s) => s.id === stepId);
      const told = held ? steps.find((s) => s.id === stepId) : undefined;
      if (held && told) {
        const ran = held.elapsed_ms !== null && (held.sql !== null || held.row_count !== null);
        return {
          step_id: told.id,
          label: told.label,
          sql: ran ? told.sql : null,
          columns: ran ? told.columns : [],
          rows: ran ? told.rows : [],
          row_count: ran ? (told.row_count ?? 0) : 0,
          truncated: ran && told.truncated,
        };
      }
      const result = record.view.result;
      if (result && result.step_id === stepId) {
        return {
          step_id: stepId,
          label: steps.find((s) => s.id === stepId)?.label ?? "the answer",
          sql: result.sql,
          columns: result.columns,
          rows: result.rows,
          row_count: result.row_count,
          truncated: result.truncated,
        };
      }
      throw notFound("no_step", `Run ${runId} has no step ${stepId}.`);
    },

    createThread(ws: string, question: string): RunCreated {
      const reading: Reading = { anchor: question, target: null, typed: [] };
      room(ws);
      const fixture = choose(ws, reading);
      const now = iso(Date.now());
      const owner: ThreadRecord = {
        id: newId("th"),
        workspace: ws,
        question,
        created_at: now,
        updated_at: now,
        runs: [],
        takenBack: new Set(),
      };
      threads.set(owner.id, owner);
      return startRun(owner, fixture, { prompt: question, origin: "question", reading });
    },

    /**
     * Revises the thread: a typed revision (the latest reading plus the message), a
     * follow-up of the latest complete run (its question the new anchor), or one of the
     * latest clarify run's nearest questions (via nearest, the new anchor too).
     */
    revise(ws: string, id: string, body: Revise): RunCreated {
      const owner = thread(ws, id);
      const latest = owner.runs.at(-1);
      if (body.follows) {
        const { run_id, follow_up_id } = body.follows;
        const offering = owner.runs.find((r) => r.view.id === run_id);
        if (!offering) throw notFound("no_run", `Thread ${id} has no run ${run_id}.`);
        if (offering !== latest) {
          throw new HttpError(409, `Run ${run_id} is not the thread's latest run; only the latest run's follow-ups can be sent.`, {
            code: "not_latest",
          });
        }
        const offered = offering.view.status === "complete" ? offering.view.follow_ups.find((f) => f.id === follow_up_id) : undefined;
        if (!offered) {
          throw new HttpError(
            409,
            offering.view.status === "complete"
              ? `Run ${run_id} offers no follow-up ${follow_up_id}.`
              : `Run ${run_id} is ${offering.view.status}; only a complete run's follow-ups go with follows.`,
            { code: "not_answerable" },
          );
        }
        if (body.message !== offered.question) {
          throw new HttpError(422, "The message is not the question of the follow-up it sends.", {
            errors: [
              {
                loc: ["body", "message"],
                msg: `The message must be the follow-up's question: "${offered.question}"`,
                type: "follow_up_mismatch",
                ctx: { question: offered.question },
              },
            ],
          });
        }
        const target = followUpsOf(offering.fixture, analysis).find((f) => f.id === offered.id)?.fixture ?? null;
        const reading: Reading = { anchor: offered.question, target, typed: [] };
        room(ws, owner.runs);
        const fixture = choose(ws, reading);
        const follows: FollowRef = { run_id, follow_up_id, kind: offered.kind };
        return startRun(owner, fixture, { prompt: offered.question, origin: "follow_up", follows, reading });
      }
      if (body.via === "nearest") {
        const nearest =
          latest?.view.status === "clarify"
            ? latest.view.follow_ups.find((f) => f.kind === "nearest" && f.question === body.message)
            : undefined;
        if (!latest || !nearest) {
          throw new HttpError(
            409,
            latest?.view.status === "clarify"
              ? "The message is none of the latest run's nearest questions."
              : `The thread's latest run is ${latest?.view.status ?? "missing"}; only a clarify run offers nearest questions.`,
            { code: "not_answerable" },
          );
        }
        const target = followUpsOf(latest.fixture, analysis).find((f) => f.id === nearest.id)?.fixture ?? null;
        const reading: Reading = { anchor: nearest.question, target, typed: [] };
        room(ws, owner.runs);
        const fixture = choose(ws, reading);
        return startRun(owner, fixture, { prompt: nearest.question, origin: "nearest", reading });
      }
      return typed(owner, body.message);
    },

    /** Re-runs revision n-1 with its reading (origin take_back); 404 no_revision for an n that names none. */
    takeBack(ws: string, id: string, n: number): RunCreated {
      const owner = thread(ws, id);
      const taken = owner.runs.find((r) => r.view.revision === n);
      const before = owner.runs.find((r) => r.view.revision === n - 1);
      if (!taken || !before || owner.takenBack.has(n)) {
        const why = !taken ? `has no revision ${n}` : `took revision ${n} back already`;
        throw notFound("no_revision", `Thread ${id} ${why}.`);
      }
      room(ws, owner.runs);
      owner.takenBack.add(n);
      return startRun(owner, before.fixture, {
        prompt: taken.view.prompt,
        origin: "take_back",
        takes_back: n,
        reading: before.reading,
      });
    },

    /**
     * Answers the card of the thread's latest run (409 not_latest otherwise) while it is
     * asking, or complete with a card that does not block; any other run is 409
     * not_answerable, free text included. Free text revises the thread instead. An asking
     * run resumes, a complete one presents again (with the chart its answered form point
     * chose), both under the same id; one an earlier version of sightline made is 409
     * stale_run.
     */
    answer(ws: string, id: string, answers: Record<string, string | null>, text: string | null): RunCreated {
      const record = run(ws, id);
      const owner = latestOwner(record, "only the latest run's card can be answered");
      const { status, card: asked } = record.view;
      if (status !== "asking" && !(status === "complete" && asked && !asked.blocking)) {
        throw new HttpError(
          409,
          status === "complete"
            ? "The run is complete and has no card to answer."
            : `The run is ${status}; only an asking run, or a complete one with its card, takes answers.`,
          { code: "not_answerable" },
        );
      }
      if (text && text.trim()) return typed(owner, text.trim());
      fresh(record);
      const card = asked ? answered(asked, answers) : null;
      if (status === "asking") {
        const all = workspaceFixtures(ws);
        const complete = all.filter((f) => f.final_status === "complete");
        const next =
          all.find((f) => f.slug === record.fixture.continuation) ?? bestMatch(complete, owner.question)?.fixture;
        if (!next) throw new HttpError(409, "The mock has no fixture to go on with.");
        const stages = stagesAfter(next, record.fixture.stages.at(-1)?.stage, analysis);
        record.fixture = next;
        record.chart = null;
        // The pass ends with the continuation's own side card, which replaces the blocking
        // one; only a continuation without one keeps the answered card, so that no
        // blocking card stays on a complete run.
        play(record, plan(next, { analysis, definitions: definitionsOf(ws, next), stages, card: next.card ?? card }));
      } else {
        room(ws);
        if (card) record.chart = chartOf(card, record.fixture) ?? record.chart;
        represent(record, card);
      }
      return { thread_id: owner.id, run_id: record.view.id };
    },

    /** Stops an open run (cancelled); on a run that has ended, the same 202 and nothing changes. */
    cancel(ws: string, id: string): RunCreated {
      const record = run(ws, id);
      end(record, "cancelled");
      return { thread_id: record.view.thread_id, run_id: record.view.id };
    },

    /**
     * Presents the thread's latest run again with another of its charts, any idiom
     * offered (drawn by the mock where the run never drew it), its form point set to the
     * chart by the user: 409 not_latest, not_answerable unless complete and the chart is
     * one of the run's, stale_run for a run an earlier version made.
     */
    pickChart(ws: string, id: string, chart: string): RunCreated {
      const record = run(ws, id);
      latestOwner(record, "only the latest run's chart can be switched");
      if (record.view.status !== "complete") {
        throw new HttpError(409, `The run is ${record.view.status}; only a complete run changes its chart.`, {
          code: "not_answerable",
        });
      }
      if (!chartView(record.fixture, chart, analysis)) {
        const offered = chartOptions(record.fixture).map((o) => o.chart);
        throw new HttpError(409, `The run offers no ${chart} chart; its charts are ${offered.join(", ") || "none"}.`, {
          code: "not_answerable",
        });
      }
      fresh(record);
      room(ws);
      record.chart = chart;
      represent(record, picked(record.view.card, chart, record.fixture));
      return { thread_id: record.view.thread_id, run_id: record.view.id };
    },

    /** Rates the run, or clears its rating; the thread does not move. */
    feedback(ws: string, id: string, rating: Rating | null): void {
      const record = run(ws, id);
      record.view = { ...record.view, feedback: rating };
    },

    /** A client beacon, kept raw; nothing reads it but the caller's last workspace. */
    signal(ws: string, kind: string, threadId: string): void {
      thread(ws, threadId);
      signals.push({ kind, thread_id: threadId, at: iso(Date.now()) });
      lastWorkspace = ws;
    },

    signals(): readonly Signal[] {
      return signals;
    },

    /** A run as the registry lists it: its thread's question, its rating, when it ended; null if unknown. */
    entryRun(ws: string, id: string): EntryRun | null {
      const record = runs.get(id);
      if (!record || record.workspace !== ws) return null;
      const { view } = record;
      const owner = threads.get(view.thread_id);
      return {
        run_id: view.id,
        thread_id: view.thread_id,
        revision: view.revision,
        question: owner?.question ?? view.prompt,
        prompt: view.prompt,
        rating: view.feedback,
        at: view.finished_at ?? view.started_at ?? owner?.updated_at ?? iso(Date.now()),
      };
    },

    /** The warehouse as the workspace's fixtures read it: their columns by table, and the governed metrics. */
    schema(ws: string): SchemaInfo {
      const tables = new Map<string, SchemaInfo["tables"][number]>();
      const measures = new Map<string, SchemaInfo["measures"][number]>();
      for (const fixture of workspaceFixtures(ws)) {
        for (const ref of fixture.refs) {
          if (ref.metric) {
            if (!measures.has(ref.column)) {
              measures.set(ref.column, { name: ref.column, label: ref.label, description: ref.description, unit: ref.unit });
            }
            continue;
          }
          const table = tables.get(ref.table) ?? {
            name: ref.table,
            label: humanise(ref.table.replace(/^(fct|fact|dim|mart)_/, "")),
            description: null,
            columns: [],
          };
          if (!table.columns.some((c) => c.name === ref.column)) {
            table.columns.push({ name: ref.column, label: ref.label, type: ref.type, role: ref.role, unit: ref.unit, description: ref.description });
          }
          tables.set(ref.table, table);
        }
      }
      const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
      return {
        tables: [...tables.values()].sort(byName).map((t) => ({ ...t, columns: [...t.columns].sort(byName) })),
        measures: [...measures.values()].sort(byName),
      };
    },

    /** The frames after `after`, and `listener` called with each one to come until `stop`. */
    follow(ws: string, id: string, after: number, listener: (frame: Frame) => void): Following {
      const record = run(ws, id);
      record.listeners.add(listener);
      return {
        backlog: record.log.filter((f) => f.id > after),
        status: () => record.view.status,
        stop: () => void record.listeners.delete(listener),
      };
    },

    close(): void {
      for (const record of runs.values()) {
        halt(record);
        record.listeners.clear();
      }
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;

export interface Following {
  backlog: Frame[];
  /** The run's status now. */
  status: () => RunStatus;
  stop: () => void;
}
