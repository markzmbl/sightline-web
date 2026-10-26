// The mock's state: threads, runs and their event logs, and the replays that
// write those logs. HTTP lives in server.ts; this module knows nothing of it.
import { randomBytes } from "node:crypto";
import type {
  Card,
  EntryRun,
  ErrorItem,
  Rating,
  RunCreated,
  RunEvent,
  RunStatus,
  RunView,
  Thread,
  ThreadPage,
  ThreadSummary,
  Workspace,
} from "../src/api/types.ts";
import type { Fixture, FixtureIndex } from "./fixture.ts";
import { fold, isOpen, newRunView } from "./fold.ts";
import { bestMatch, MIN_SCORE } from "./match.ts";
import { chartOptions, chartView, plan, presentStages, restarted, stagesAfter, type Beat } from "./plan.ts";

export const WORKSPACES: Workspace[] = [
  { id: "manufacturing", name: "Manufacturing (demo)", pack: "manufacturing" },
  { id: "restaurant", name: "Restaurant (demo)", pack: "restaurant" },
];

/** The parts of a Problem besides its detail: a 409's code, a 422's FastAPI-shaped errors. */
export interface ProblemParts {
  code?: string;
  errors?: ErrorItem[];
}

/** A failure the HTTP layer answers as a Problem {detail, code?, errors?} with this status. */
export class HttpError extends Error {
  status: number;
  code: string | undefined;
  errors: ErrorItem[] | undefined;
  constructor(status: number, detail: string, parts: ProblemParts = {}) {
    super(detail);
    this.status = status;
    this.code = parts.code;
    this.errors = parts.errors;
  }
}

/** A 422 for one field, worded the way FastAPI words it; loc starts at "body", "query" or "path". */
export function invalid(loc: (string | number)[], msg: string, type: string, ctx?: Record<string, unknown>): HttpError {
  const item: ErrorItem = ctx ? { loc, msg, type, ctx } : { loc, msg, type };
  return new HttpError(422, `${loc.join(".")}: ${msg}`, { errors: [item] });
}

export interface Frame {
  id: number;
  event: RunEvent;
}

interface RunRecord {
  view: RunView;
  log: Frame[];
  workspace: string;
  /** The fixture the run follows now (an answered card moves it to the continuation). */
  fixture: Fixture;
  /** The chart class presented, when the user picked one. */
  chart: string | null;
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
}

export interface EngineOptions {
  /** Real stage times are divided by this. */
  speed: number;
  /** No stage is shorter than this, in wall-clock ms; a worker picks up a queued run after as long. */
  minStageMs: number;
  /** Every nth new run is restarted once by its worker (queued after running); 0, never. */
  restartEvery?: number;
  /** Called when a run ends complete or clarify, with the fixture it followed last (the registry's demand). */
  onEnded?: (workspace: string, slug: string, run: RunView) => void;
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

const iso = (ms: number): string => new Date(ms).toISOString();
const newId = (prefix: string): string => `${prefix}_${randomBytes(5).toString("hex")}`;

export function createEngine(fixtures: FixtureIndex, options: EngineOptions) {
  const threads = new Map<string, ThreadRecord>();
  const runs = new Map<string, RunRecord>();
  const turns = new Map<string, number>(); // round-robin position per workspace
  let started = 0; // new runs so far, for restartEvery

  // --- lookups ---------------------------------------------------------------

  function workspaceFixtures(ws: string): Fixture[] {
    if (!WORKSPACES.some((w) => w.id === ws)) throw new HttpError(404, `No workspace ${ws}.`);
    return fixtures.get(ws) ?? [];
  }

  function thread(ws: string, id: string): ThreadRecord {
    workspaceFixtures(ws);
    const found = threads.get(id);
    if (!found || found.workspace !== ws) throw new HttpError(404, `No thread ${id} in ${ws}.`);
    return found;
  }

  function run(ws: string, id: string): RunRecord {
    workspaceFixtures(ws);
    const found = runs.get(id);
    if (!found || found.workspace !== ws) throw new HttpError(404, `No run ${id} in ${ws}.`);
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

  /** The best-matching fixture, or the next complete one in turn when nothing matches. */
  function choose(ws: string, text: string, avoid?: string): Fixture {
    const all = workspaceFixtures(ws);
    const match = bestMatch(all, text, avoid);
    if (match && match.score >= MIN_SCORE) return match.fixture;
    const complete = all.filter((f) => f.final_status === "complete" && f.slug !== avoid);
    const pool = complete.length ? complete : all;
    const turn = turns.get(ws) ?? 0;
    turns.set(ws, turn + 1);
    const fixture = pool[turn % pool.length];
    if (!fixture) throw new HttpError(422, `The mock has no fixtures for ${ws}.`);
    return fixture;
  }

  // --- the event log -----------------------------------------------------------

  function emit(record: RunRecord, event: RunEvent, at: string = iso(Date.now())): void {
    const frame: Frame = { id: record.log.length + 1, event };
    record.log.push(frame);
    record.view = fold(record.view, event, frame.id, at);
    const owner = threads.get(record.view.thread_id);
    if (owner && at > owner.updated_at) owner.updated_at = at;
    if (event.type === "run.status" && (event.status === "complete" || event.status === "clarify")) {
      options.onEnded?.(record.workspace, record.fixture.slug, record.view);
    }
    for (const listener of [...record.listeners]) listener(frame);
  }

  function halt(record: RunRecord): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
  }

  /**
   * Plays beats into the run on timers. With `now`, the beats up to the first
   * stage are emitted before this returns, so a client that reconnects right
   * after the 202 never finds the run still at rest.
   */
  function play(record: RunRecord, beats: Beat[], now = false): void {
    halt(record);
    let next = 0;
    const advance = (): void => {
      record.timer = null;
      while (next < beats.length) {
        const beat = beats[next++];
        if (!beat) break;
        if (beat.kind === "event") {
          emit(record, beat.make(record.view.id));
          continue;
        }
        if (beat.kind === "pause") {
          record.timer = setTimeout(advance, options.minStageMs);
          return;
        }
        const { phase, stage, ms } = beat;
        emit(record, { type: "stage.started", run_id: record.view.id, phase, stage, at: iso(Date.now()) });
        record.timer = setTimeout(
          () => {
            emit(record, { type: "stage.finished", run_id: record.view.id, phase, stage, at: iso(Date.now()), elapsed_ms: ms });
            advance();
          },
          Math.max(ms / options.speed, options.minStageMs),
        );
        return;
      }
    };
    if (now) advance();
    else record.timer = setTimeout(advance, options.minStageMs);
  }

  /** Writes beats into the log at once, on a clock starting at `start`; returns the end time. */
  function synthesize(record: RunRecord, beats: Beat[], start: number): number {
    let t = start;
    for (const beat of beats) {
      if (beat.kind === "pause") continue;
      if (beat.kind === "event") {
        emit(record, beat.make(record.view.id), iso(t));
        continue;
      }
      const { phase, stage, ms } = beat;
      emit(record, { type: "stage.started", run_id: record.view.id, phase, stage, at: iso(t) }, iso(t));
      t += ms;
      emit(record, { type: "stage.finished", run_id: record.view.id, phase, stage, at: iso(t), elapsed_ms: ms }, iso(t));
    }
    return t;
  }

  // --- threads and runs ----------------------------------------------------------

  function addRun(owner: ThreadRecord, fixture: Fixture, prompt: string, id = newId("run")): RunRecord {
    const revision = owner.runs.reduce((max, r) => Math.max(max, r.view.revision + 1), 0);
    const record: RunRecord = {
      view: newRunView(id, owner.id, revision, prompt),
      log: [],
      workspace: owner.workspace,
      fixture,
      chart: null,
      timer: null,
      listeners: new Set(),
    };
    owner.runs.push(record);
    runs.set(id, record);
    owner.updated_at = iso(Date.now());
    return record;
  }

  /**
   * Ends an open run at once: cancelled by Stop, superseded by a newer revision. Its
   * worker drops what it would still have said, so the terminal run.status is the only
   * frame it writes, as the backend only sets the status. An asking run keeps its card
   * as it stood, blocking: the record of what sightline asked, which nobody answered.
   */
  function end(record: RunRecord, status: "cancelled" | "superseded"): void {
    if (!isOpen(record.view.status)) return;
    halt(record);
    emit(record, { type: "run.status", run_id: record.view.id, status });
  }

  /** A new run of the thread that replays `fixture`; a run of the thread still open is superseded. */
  function startRun(owner: ThreadRecord, fixture: Fixture, prompt: string): RunCreated {
    for (const open of owner.runs) end(open, "superseded");
    const record = addRun(owner, fixture, prompt);
    started += 1;
    const every = options.restartEvery ?? 0;
    const beats = plan(fixture);
    play(record, every > 0 && started % every === 0 ? restarted(beats, RESTART_AFTER) : beats);
    return { thread_id: owner.id, run_id: record.view.id };
  }

  /**
   * The same run presents again from its own fixture, as a worker picks it up anew:
   * queued, running, the present stages, then chart, result, complete.
   */
  function represent(record: RunRecord, lead: Card | null): void {
    const fixture = record.fixture;
    const stages = presentStages(fixture);
    play(record, plan(fixture, { stages, chart: record.chart, lead, sideCard: false, restate: false, requeue: true }), true);
  }

  function revise(owner: ThreadRecord, message: string): RunCreated {
    const previous = owner.runs.at(-1)?.fixture.slug;
    const fixture = choose(owner.workspace, `${owner.question} ${message}`, previous);
    return startRun(owner, fixture, message);
  }

  /**
   * The card with the answers applied; a null answer leaves the default, chosen for the
   * user. An answered point is no longer open: somebody is sure of it now.
   */
  function answered(card: Card, answers: Record<string, string | null>): Card {
    return {
      blocking: false,
      points: card.points.map((point) => {
        if (!(point.id in answers)) return point;
        const answer = answers[point.id];
        return answer == null
          ? { ...point, chosen: point.default ?? point.chosen, by: "s1", open: false }
          : { ...point, chosen: answer, by: "user", open: false };
      }),
    };
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

  // --- the operations the server exposes -----------------------------------------------

  return {
    /** One finished thread per complete or clarify fixture, spread over the last two weeks, some rated. */
    seed(now: number = Date.now()): void {
      for (const workspace of WORKSPACES) {
        // Complete runs first, so the newest thread in the sidebar shows a chart.
        const finished = (fixtures.get(workspace.id) ?? [])
          .filter((f) => f.final_status !== "asking")
          .sort((a, b) => Number(a.final_status !== "complete") - Number(b.final_status !== "complete"));
        finished.forEach((fixture, i) => {
          const age = (SEED_AGES[i % SEED_AGES.length] ?? HOUR) + Math.floor(i / SEED_AGES.length) * 45 * 60_000;
          const end = now - age;
          const beats = plan(fixture);
          const total = fixture.stages.reduce((sum, s) => sum + s.ms, 0);
          const owner: ThreadRecord = {
            id: `th_seed_${fixture.slug}`,
            workspace: workspace.id,
            question: fixture.question,
            created_at: iso(end - total),
            updated_at: iso(end - total),
            runs: [],
          };
          threads.set(owner.id, owner);
          const record = addRun(owner, fixture, fixture.question, `run_seed_${fixture.slug}`);
          owner.updated_at = owner.created_at;
          synthesize(record, beats, end - total);
          const rating = SEED_RATINGS[fixture.slug];
          if (rating) record.view = { ...record.view, feedback: rating };
          owner.updated_at = iso(end);
        });
      }
    },

    listThreads(ws: string, cursor: string | null, limit: number): ThreadPage {
      workspaceFixtures(ws);
      const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
      const size = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
      const all = [...threads.values()]
        .filter((t) => t.workspace === ws)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const end = offset + size;
      return { items: all.slice(offset, end).map(summary), next_cursor: end < all.length ? String(end) : null };
    },

    getThread(ws: string, id: string): Thread {
      const owner = thread(ws, id);
      return {
        id: owner.id,
        question: owner.question,
        created_at: owner.created_at,
        updated_at: owner.updated_at,
        runs: owner.runs.map((r) => r.view),
      };
    },

    getRun(ws: string, id: string): RunView {
      return run(ws, id).view;
    },

    createThread(ws: string, question: string): RunCreated {
      const fixture = choose(ws, question);
      const now = iso(Date.now());
      const owner: ThreadRecord = { id: newId("th"), workspace: ws, question, created_at: now, updated_at: now, runs: [] };
      threads.set(owner.id, owner);
      return startRun(owner, fixture, question);
    },

    revise(ws: string, id: string, message: string): RunCreated {
      return revise(thread(ws, id), message);
    },

    takeBack(ws: string, id: string, n: number): RunCreated {
      const owner = thread(ws, id);
      const before = owner.runs.find((r) => r.view.revision === n - 1);
      if (n < 1 || !before || !owner.runs.some((r) => r.view.revision === n)) {
        throw new HttpError(404, `Thread ${id} has no revision ${n}.`);
      }
      return startRun(owner, before.fixture, `Take back revision ${n}`);
    },

    /**
     * Answers the card of the thread's latest run (409 not_latest otherwise); free text
     * revises the thread instead. An asking run resumes, a complete one with a card
     * presents again, both under the same id; any other run is 409 not_answerable.
     */
    answer(ws: string, id: string, answers: Record<string, string | null>, text: string | null): RunCreated {
      const record = run(ws, id);
      const owner = latestOwner(record, "only the latest run's card can be answered");
      if (text && text.trim()) return revise(owner, text.trim());
      const { status } = record.view;
      if (status !== "asking" && !(status === "complete" && record.view.card)) {
        throw new HttpError(
          409,
          status === "complete"
            ? "The run is complete and has no card to answer."
            : `The run is ${status}; only an asking run, or a complete one with its card, takes answers.`,
          { code: "not_answerable" },
        );
      }
      const card = record.view.card ? answered(record.view.card, answers) : null;
      if (status === "asking") {
        const all = workspaceFixtures(ws);
        const complete = all.filter((f) => f.final_status === "complete");
        const next =
          all.find((f) => f.slug === record.fixture.continuation) ?? bestMatch(complete, owner.question)?.fixture;
        if (!next) throw new HttpError(409, "The mock has no fixture to go on with.");
        const stages = stagesAfter(next, record.fixture.stages.at(-1)?.stage);
        record.fixture = next;
        record.chart = null;
        play(record, plan(next, { stages, lead: card, sideCard: false, requeue: true }), true);
      } else {
        represent(record, card);
      }
      return { thread_id: owner.id, run_id: record.view.id };
    },

    cancel(ws: string, id: string): RunCreated {
      const record = run(ws, id);
      end(record, "cancelled");
      return { thread_id: record.view.thread_id, run_id: record.view.id };
    },

    /**
     * Presents the thread's latest run again with another of its charts, any idiom
     * offered (drawn by the mock where the run never drew it): 409 not_latest, or
     * not_answerable unless complete and the chart is one of the run's.
     */
    pickChart(ws: string, id: string, chart: string): RunCreated {
      const record = run(ws, id);
      latestOwner(record, "only the latest run's chart can be switched");
      if (record.view.status !== "complete") {
        throw new HttpError(409, `The run is ${record.view.status}; only a complete run changes its chart.`, {
          code: "not_answerable",
        });
      }
      if (!chartView(record.fixture, chart)) {
        const offered = chartOptions(record.fixture).map((o) => o.chart);
        throw new HttpError(409, `The run offers no ${chart} chart; its charts are ${offered.join(", ") || "none"}.`, {
          code: "not_answerable",
        });
      }
      record.chart = chart;
      represent(record, null);
      return { thread_id: record.view.thread_id, run_id: record.view.id };
    },

    feedback(ws: string, id: string, rating: Rating): void {
      const record = run(ws, id);
      record.view = { ...record.view, feedback: rating };
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
        question: owner?.question ?? view.prompt,
        rating: view.feedback,
        at: view.finished_at ?? view.started_at ?? owner?.updated_at ?? iso(Date.now()),
      };
    },

    /** A small summary of the columns the workspace's fixtures return; the real shape is not drafted. */
    schema(ws: string): Record<string, unknown> {
      const columns = new Map<string, { name: string; type: string | null; fixtures: string[] }>();
      for (const fixture of workspaceFixtures(ws)) {
        for (const column of fixture.result?.columns ?? []) {
          const known = columns.get(column.name) ?? { name: column.name, type: column.type, fixtures: [] };
          known.fixtures.push(fixture.slug);
          columns.set(column.name, known);
        }
      }
      return { tables: [], columns: [...columns.values()] };
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
