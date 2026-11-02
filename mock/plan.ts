// A replay plan: the beats a fixture plays into a run's event log, in order.
// A stage beat becomes stage.started, a wait, and stage.finished; the analyse stage
// opens, plays its steps (step.started, a wait, step.finished each) and closes; an
// event beat is emitted as it stands; a set beat changes the run beside the log (what
// no event carries: the definitions, the follow-ups); a pause is a short wait (a worker
// picking up the job). The order of the events is the contract's (runEvents).
import type {
  Card,
  ChartOption,
  ChartView,
  Clarify,
  Definition,
  FollowUp,
  Result,
  RunEvent,
  RunStatus,
  RunView,
} from "../src/api/types.ts";
import { drawnByMock } from "./draw.ts";
import {
  humanise,
  passStages,
  type Fixture,
  type FixtureFollowUp,
  type FixtureStage,
  type FixtureStep,
  type VegaLiteSpec,
} from "./fixture.ts";

export type Beat =
  | ({ kind: "stage" } & FixtureStage)
  | { kind: "open"; phase: string; stage: string }
  | { kind: "close"; phase: string; stage: string; ms: number }
  | { kind: "step"; phase: string; step: FixtureStep }
  | { kind: "event"; make: (runId: string) => RunEvent }
  | { kind: "set"; patch: (view: RunView) => Partial<RunView> }
  | { kind: "pause" };

export interface PlanOptions {
  /** Serve the analysis (storyline, supports, steps, follow-ups) where the fixture has it. */
  analysis: boolean;
  /** The definitions the run uses, their statuses as the registry has them now. */
  definitions?: Definition[];
  /** The stages to play; all of the fixture's (with the analysis' when it is on) by default. */
  stages?: readonly FixtureStage[];
  /** The chart class to present; the fixture's own by default. */
  chart?: string | null;
  /**
   * The card a complete run tells after its charts, just before the result: the fixture's
   * side card when left out; the card as answered, or as a chart pick set it, when the run
   * presents again; null for none.
   */
  card?: Card | null;
  /** Emit the fixture's restatement and definitions (default true). */
  restate?: boolean;
}

const event = (make: (runId: string) => RunEvent): Beat => ({ kind: "event", make });
const status = (value: RunStatus): Beat => event((run_id) => ({ type: "run.status", run_id, status: value }));
const set = (patch: (view: RunView) => Partial<RunView>): Beat => ({ kind: "set", patch });
const PAUSE: Beat = { kind: "pause" };

/** A clarify with nothing to say, for a clarify fixture that carries none. */
const EMPTY_CLARIFY: Clarify = { gaps: [], missing: [], record: [], warnings: [], warnings_total: 0 };

/** A follow-up as the contract has it: without the fixture that answers it. */
export const asFollowUp = ({ fixture: _answeredBy, ...followUp }: FixtureFollowUp): FollowUp => followUp;

/** Every chart the switcher can offer: idiom's options and any other rendering, by score, then chart id. */
export function chartOptions(fixture: Fixture): ChartOption[] {
  const options = fixture.chart_options.map((o) => ({ ...o, drawn: false }));
  for (const chart of Object.keys(fixture.charts)) {
    if (!options.some((o) => o.chart === chart)) options.push({ chart, label: humanise(chart), hint: null, score: 0, drawn: false });
  }
  return options.sort((a, b) => b.score - a.score || a.chart.localeCompare(b.chart));
}

type Title = { text?: unknown; subtitle?: unknown; [key: string]: unknown };
const titleOf = (spec: VegaLiteSpec): Title | null =>
  typeof spec.title === "object" && spec.title !== null && !Array.isArray(spec.title) ? (spec.title as Title) : null;

/** The spec's title text, as ChartView.title has it. */
export function titleText(spec: VegaLiteSpec): string | null {
  const text = titleOf(spec)?.text ?? spec.title;
  return Array.isArray(text) ? text.join(" ") : typeof text === "string" ? text : null;
}

/** The spec's subtitle lines, as ChartView.subtitle has them. */
export function subtitleLines(spec: VegaLiteSpec): string[] {
  const subtitle = titleOf(spec)?.subtitle;
  return Array.isArray(subtitle) ? subtitle.map(String) : typeof subtitle === "string" ? [subtitle] : [];
}

type Layer = Record<string, unknown>;
const isLayer = (value: unknown): value is Layer => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The layer that draws the answer itself: the first that reads the chart's own data (no
 * data of its own) and encodes a quantity, else the first that reads the chart's data,
 * else the first. A backdrop or a label layer with its own values is never it.
 */
function answerLayer(layers: readonly Layer[]): number {
  const inherits = (layer: Layer) => !("data" in layer);
  const quantity = (layer: Layer) => JSON.stringify(layer.encoding ?? {}).includes('"type":"quantitative"');
  const drawn = layers.findIndex((l) => inherits(l) && quantity(l));
  if (drawn >= 0) return drawn;
  return Math.max(0, layers.findIndex(inherits));
}

/**
 * The spec with the answer's layer named `name`, as Support.layer names it: a single view
 * becomes a layered one of that view alone (its marks and encodings, everything else kept).
 */
function named(spec: VegaLiteSpec, name: string): VegaLiteSpec {
  if (Array.isArray(spec.layer)) {
    const layers = spec.layer.filter(isLayer);
    if (layers.length !== spec.layer.length || layers.length === 0) return spec;
    const at = answerLayer(layers);
    return { ...spec, layer: layers.map((l, i) => (i === at ? { ...l, name } : l)) };
  }
  if (spec.mark === undefined) return spec;
  const { mark, encoding, ...rest } = spec;
  return { ...rest, layer: [{ name, mark, ...(encoding === undefined ? {} : { encoding }) }] };
}

/** The main chart with the storyline's top as its title, and the lead's layer named on it. */
function dressed(spec: VegaLiteSpec, top: string, layer: string | null): VegaLiteSpec {
  const title = titleOf(spec);
  const titled = { ...spec, title: title ? { ...title, text: top } : { text: top } };
  return layer ? named(titled, layer) : titled;
}

/**
 * The fixture's main chart view for a chart class it offers: the run's own rendering where
 * it drew one, else the mock's drawing over the result's rows; with the analysis, titled
 * with the storyline's top. Null for a chart it does not offer, which the backend refuses too.
 */
export function chartView(fixture: Fixture, chart: string | null | undefined, analysis: boolean): ChartView | null {
  const result = fixture.result;
  const own = result?.chart ?? null;
  if (!result || !own) return null;
  const pick = chart ?? own.chart;
  const options = chartOptions(fixture);
  const option = options.find((o) => o.chart === pick);
  if (!option) return null;
  const story = analysis ? fixture.analysis : null;
  const drawn = pick === own.chart ? own.spec : (fixture.charts[pick] ?? drawnByMock(result, pick, own.spec, option.label));
  const lead = story?.supports.find((s) => s.id === story.lead);
  const spec = story ? dressed(drawn, story.storyline.top, lead?.layer ?? null) : drawn;
  return {
    chart: pick,
    label: option.label,
    title: titleText(spec),
    subtitle: subtitleLines(spec),
    hint: option.hint,
    score: option.score,
    spec,
    png_url: null,
    min_width: null,
    options: options.map((o) => ({ ...o, drawn: o.chart === pick })),
  };
}

/** The answer as the run tells it: the fixture's result with this chart, and the analysis when it is on. */
export function resultOf(fixture: Fixture, chart: ChartView | null, analysis: boolean): Result | null {
  const result = fixture.result;
  if (!result) return null;
  const story = analysis ? fixture.analysis : null;
  if (!story) return { ...result, chart };
  return {
    ...result,
    chart,
    step_id: story.steps.find((s) => s.role === "answer")?.id ?? result.step_id,
    // One home per text: with a storyline, the key line and the supports carry the findings.
    findings: [],
    notes: [...result.notes, ...story.notes],
    storyline: story.storyline,
    lead: story.lead,
    supports: story.supports,
  };
}

/** The follow-ups a run of the fixture offers once it ends: a clarify run's nearest questions, else the analysis'. */
export function followUpsOf(fixture: Fixture, analysis: boolean): FixtureFollowUp[] {
  if (fixture.final_status === "clarify") return fixture.follow_ups;
  return analysis ? (fixture.analysis?.follow_ups ?? []) : [];
}

/** The beats of the main chart and, with the analysis, each small chart after it. */
function chartBeats(result: Result): Beat[] {
  const main = result.chart;
  if (!main) return [];
  const beats: Beat[] = [event((run_id) => ({ type: "chart", run_id, support_id: null, chart: main }))];
  for (const support of result.supports) {
    const small = support.chart;
    if (support.drawn === "small" && small) {
      beats.push(event((run_id) => ({ type: "chart", run_id, support_id: support.id, chart: small })));
    }
  }
  return beats;
}

export function plan(fixture: Fixture, options: PlanOptions): Beat[] {
  const { analysis } = options;
  const stages = options.stages ?? passStages(fixture, analysis);
  // Every pass starts queued: a new run, and the same run again after an answer or a chart switch.
  const beats: Beat[] = [status("queued"), PAUSE, status("running")];

  const restate = options.restate !== false;
  const restatement = restate ? fixture.restatement : null;
  const definitions = options.definitions ?? fixture.definitions;
  const result = fixture.final_status === "complete" ? resultOf(fixture, chartView(fixture, options.chart, analysis), analysis) : null;
  const charts = result ? chartBeats(result) : [];
  const drawsAt = charts.length > 0 && stages.some((s) => s.stage === "render") ? "render" : null;
  const steps = analysis ? (fixture.analysis?.steps ?? []) : [];

  for (const stage of stages) {
    if (stage.stage === "analyse" && steps.length > 0) {
      beats.push({ kind: "open", phase: stage.phase, stage: stage.stage });
      for (const step of steps) beats.push({ kind: "step", phase: stage.phase, step });
      beats.push({ kind: "close", phase: stage.phase, stage: stage.stage, ms: stage.ms });
    } else {
      beats.push({ kind: "stage", ...stage });
    }
    // Right after bind: what sightline understood, and the definitions it used (on no event).
    if (restatement && stage.stage === "bind") {
      beats.push(event((run_id) => ({ type: "restatement", run_id, text: restatement })));
      beats.push(set(() => ({ definitions })));
    }
    if (stage.stage === drawsAt) beats.push(...charts);
  }

  const followUps = followUpsOf(fixture, analysis).map(asFollowUp);
  switch (fixture.final_status) {
    case "asking": {
      const card: Card = { blocking: true, points: fixture.card?.points ?? [] };
      beats.push(event((run_id) => ({ type: "card", run_id, card })), status("asking"));
      break;
    }
    case "clarify": {
      const clarify = fixture.clarify ?? EMPTY_CLARIFY;
      beats.push(event((run_id) => ({ type: "clarify", run_id, clarify })));
      beats.push(set(() => ({ follow_ups: followUps })), status("clarify"));
      break;
    }
    case "failed": {
      const error = fixture.error ?? {
        code: "internal",
        message: "Something went wrong while answering the question.",
        detail: null,
        stage: stages.at(-1)?.stage ?? null,
        retryable: true,
      };
      beats.push(event((run_id) => ({ type: "error", run_id, ...error })), status("failed"));
      break;
    }
    case "complete": {
      if (result) {
        if (!drawsAt) beats.push(...charts);
        // Card when it applies, after the charts and just before the result, on every pass.
        const side = options.card === undefined ? fixture.card : options.card;
        if (side) beats.push(event((run_id) => ({ type: "card", run_id, card: side })));
        beats.push(event((run_id) => ({ type: "result", run_id, result })));
      }
      // The follow-ups ride on no event: getRun has them once the run is complete.
      beats.push(set(() => ({ follow_ups: followUps })), status("complete"));
      break;
    }
  }
  return beats;
}

/**
 * A worker restart: the beats up to the end of stage `after` (counted from 1, plain stages
 * only, so never inside the analyse stage), then the whole plan again from its queued: a
 * retried attempt redoes it.
 */
export function restarted(beats: readonly Beat[], after: number): Beat[] {
  let seen = 0;
  const cut = beats.findIndex((beat) => beat.kind === "stage" && ++seen === after);
  if (cut < 0) return [...beats];
  return [...beats.slice(0, cut + 1), ...beats];
}

/** The present-phase stages, which a re-presented run plays again. */
export const presentStages = (fixture: Fixture): FixtureStage[] => fixture.stages.filter((s) => s.phase === "present");

/** The stages of `next` that come after `last`: where a resumed run goes on. */
export function stagesAfter(next: Fixture, last: string | undefined, analysis: boolean): FixtureStage[] {
  const all = passStages(next, analysis);
  const at = last ? all.findIndex((s) => s.stage === last) : -1;
  return at >= 0 ? all.slice(at + 1) : all.filter((s) => s.phase !== "understand");
}
