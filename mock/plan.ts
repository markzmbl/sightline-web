// A replay plan: the beats a fixture plays into a run's event log, in order.
// A stage beat becomes stage.started, a wait, and stage.finished; an event beat
// is emitted as it stands; a pause is a short wait (a worker picking up the job).
import type { Card, ChartOption, ChartView, Clarify, RunEvent, RunStatus } from "../src/api/types.ts";
import { drawnByMock } from "./draw.ts";
import { humanise, type Fixture, type FixtureStage } from "./fixture.ts";

export type Beat =
  | ({ kind: "stage" } & FixtureStage)
  | { kind: "event"; make: (runId: string) => RunEvent }
  | { kind: "pause" };

export interface PlanOptions {
  /** The stages to play; all of the fixture's by default. */
  stages?: readonly FixtureStage[];
  /** The chart class to present; the fixture's own by default. */
  chart?: string | null;
  /** A card emitted right after the run starts running (answers just given). */
  lead?: Card | null;
  /** Emit the fixture's side card before the result (default true). */
  sideCard?: boolean;
  /** Emit the fixture's restatement (default true). */
  restate?: boolean;
  /**
   * The run goes back to queued first, then a worker picks it up (a pause) and it runs:
   * the same run id again after an answer or a chart switch.
   */
  requeue?: boolean;
}

const event = (make: (runId: string) => RunEvent): Beat => ({ kind: "event", make });
const status = (value: RunStatus): Beat => event((run_id) => ({ type: "run.status", run_id, status: value }));
const PAUSE: Beat = { kind: "pause" };

/** A clarify with nothing to say, for a clarify fixture that carries none. */
const EMPTY_CLARIFY: Clarify = { gaps: [], missing: [], record: [], nearest: [], warnings: [] };

/** Every chart the switcher can offer for a fixture: idiom's options, then any other rendering. */
export function chartOptions(fixture: Fixture): ChartOption[] {
  const options = [...fixture.chart_options];
  for (const chart of Object.keys(fixture.charts)) {
    if (!options.some((o) => o.chart === chart)) options.push({ chart, label: humanise(chart), hint: null });
  }
  return options;
}

/**
 * The fixture's chart view for a chart class it offers: the run's own rendering where
 * it drew one, else the mock's drawing over the result's rows. Null for a chart it does
 * not offer, which the backend refuses too.
 */
export function chartView(fixture: Fixture, chart?: string | null): ChartView | null {
  const own = fixture.result?.chart ?? null;
  if (!chart || chart === own?.chart) return own;
  const options = chartOptions(fixture);
  const option = options.find((o) => o.chart === chart);
  if (!option || !fixture.result) return null;
  return {
    chart,
    label: option.label,
    spec: fixture.charts[chart] ?? drawnByMock(fixture.result, chart, own?.spec ?? null),
    png_url: null,
    alternatives: options.filter((o) => o.chart !== chart),
  };
}

/** Where the restatement comes: after bind, else after the last understand stage played. */
function restatedAfter(stages: readonly FixtureStage[]): string | null {
  if (stages.some((s) => s.stage === "bind")) return "bind";
  return stages.filter((s) => s.phase === "understand").at(-1)?.stage ?? null;
}

export function plan(fixture: Fixture, options: PlanOptions = {}): Beat[] {
  const stages = options.stages ?? fixture.stages;
  const beats: Beat[] = options.requeue ? [status("queued"), PAUSE, status("running")] : [status("running")];
  const lead = options.lead;
  if (lead) beats.push(event((run_id) => ({ type: "card", run_id, card: lead })));

  const restatement = options.restate === false ? null : fixture.restatement;
  const restateAt = restatement ? restatedAfter(stages) : null;
  const result = fixture.final_status === "complete" ? fixture.result : null;
  const chart = result ? chartView(fixture, options.chart) : null;
  const chartAt = chart && stages.some((s) => s.stage === "render") ? "render" : null;

  for (const stage of stages) {
    beats.push({ kind: "stage", ...stage });
    if (restatement && stage.stage === restateAt) {
      beats.push(event((run_id) => ({ type: "restatement", run_id, text: restatement })));
    }
    if (chart && stage.stage === chartAt) beats.push(event((run_id) => ({ type: "chart", run_id, chart })));
  }

  switch (fixture.final_status) {
    case "asking": {
      const card: Card = { blocking: true, points: fixture.card?.points ?? [] };
      beats.push(event((run_id) => ({ type: "card", run_id, card })), status("asking"));
      break;
    }
    case "clarify": {
      const clarify = fixture.clarify ?? EMPTY_CLARIFY;
      beats.push(event((run_id) => ({ type: "clarify", run_id, clarify })), status("clarify"));
      break;
    }
    case "complete": {
      if (result) {
        if (chart && !chartAt) beats.push(event((run_id) => ({ type: "chart", run_id, chart })));
        const side = options.sideCard === false ? null : fixture.card;
        if (side) beats.push(event((run_id) => ({ type: "card", run_id, card: side })));
        beats.push(event((run_id) => ({ type: "result", run_id, result: { ...result, chart } })));
      }
      beats.push(status("complete"));
      break;
    }
  }
  return beats;
}

/**
 * A worker restart: the beats up to the end of stage `after` (counted from 1), then
 * queued, a pause, and the whole plan again from its start, as a retried attempt redoes it.
 */
export function restarted(beats: readonly Beat[], after: number): Beat[] {
  let seen = 0;
  const cut = beats.findIndex((beat) => beat.kind === "stage" && ++seen === after);
  if (cut < 0) return [...beats];
  return [...beats.slice(0, cut + 1), status("queued"), PAUSE, ...beats];
}

/** The present-phase stages, which a re-presented run plays again. */
export const presentStages = (fixture: Fixture): FixtureStage[] => fixture.stages.filter((s) => s.phase === "present");

/** The stages of `next` that come after `last`: where a resumed run goes on. */
export function stagesAfter(next: Fixture, last: string | undefined): FixtureStage[] {
  const at = last ? next.stages.findIndex((s) => s.stage === last) : -1;
  return at >= 0 ? next.stages.slice(at + 1) : next.stages.filter((s) => s.phase !== "understand");
}
