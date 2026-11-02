// A fixture is one real sightline run, exported by scripts/export-fixtures.mjs,
// that the mock replays as a live run. Its parts are the contract's own shapes:
// decision points as the core has them (open, stage, by), a clarify with the
// not-possible-yet ending (missing, record), chart options with idiom's scores,
// columns as enrich describes them, every caveat in the result's notes.
//
// What the core does not make yet (the analysis: plan, analyse and gather, its
// steps, storyline, supports and follow-ups) sits apart in `analysis`, made up by
// mock/showcase.ts from the run's own rows and marked synthetic, so the mock can
// serve the answers with it or without it, as the backend does today.
import { readdirSync, readFileSync } from "node:fs";
import type {
  Card,
  Cell,
  ChartOption,
  ChartView,
  Clarify,
  Column,
  ColumnRole,
  DecisionPoint,
  Definition,
  FollowUp,
  Result,
  RunError,
  StepRole,
  StepVerdict,
  Storyline,
  Support,
} from "../src/api/types.ts";

export type FinalStatus = "complete" | "clarify" | "asking" | "failed";

export interface FixtureStage {
  phase: string;
  stage: string;
  /** How long the stage took in the real run. */
  ms: number;
}

export type VegaLiteSpec = ChartView["spec"];

/** A follow-up as a fixture offers it: the contract's FollowUp, and the fixture that answers it (null: matched by its words). */
export interface FixtureFollowUp extends FollowUp {
  fixture: string | null;
}

/** One step of the analysis, with what getRunStep serves for it. */
export interface FixtureStep {
  id: string;
  /** The stage it runs in: analyse. */
  stage: string;
  label: string;
  role: StepRole;
  ms: number;
  verdict: StepVerdict | null;
  cached: boolean;
  sql: string | null;
  columns: Column[];
  rows: Cell[][];
  /** Null when the step ran no query. */
  row_count: number | null;
  truncated: boolean;
}

/** The analysis the core does not make yet, made up from the run's own rows. */
export interface FixtureAnalysis {
  synthetic: true;
  /** Where it comes from, in words. */
  about: string;
  /** plan (understand), analyse and gather (analyse), with their times. */
  stages: FixtureStage[];
  storyline: Storyline;
  /** The support Result.chart draws. */
  lead: string;
  supports: Support[];
  /** The caveats the analysis adds, after the run's own in Result.notes. */
  notes: string[];
  /** The steps, the answer first; its rows are the result's. */
  steps: FixtureStep[];
  follow_ups: FixtureFollowUp[];
}

/** A column of the warehouse the run read, as the core's enrich stage describes it; getSchema is built from these. */
export interface FixtureRef {
  table: string;
  column: string;
  label: string;
  type: string | null;
  role: ColumnRole | null;
  unit: string | null;
  description: string | null;
  /** A governed metric of the contract, not a plain column. */
  metric: boolean;
}

export interface Fixture {
  slug: string;
  workspace: string;
  /** True for a fixture made up rather than exported from a real run; absent on real ones. */
  synthetic?: boolean;
  /** The fields of a real fixture that were made up rather than exported, e.g. ["restatement"]. */
  made_up?: string[];
  question: string;
  final_status: FinalStatus;
  /** The fixture an asking run goes on with once the card is answered. */
  continuation: string | null;
  stages: FixtureStage[];
  /** What sightline understood; null when the run ended before bind. Never a "Defined as" clause. */
  restatement: string | null;
  /** The definitions the run used; a registry entry's status is read from the registry when the run starts. */
  definitions: Definition[];
  card: Card | null;
  clarify: Clarify | null;
  /** A clarify run's nearest questions (kind nearest), sent with via nearest. */
  follow_ups: FixtureFollowUp[];
  /** Why a failed run failed. */
  error: RunError | null;
  /** The answer without the analysis: storyline null, supports empty, findings as the core has them. */
  result: Result | null;
  /** Every rendering the run drew, by chart class. */
  charts: Record<string, VegaLiteSpec>;
  /** Every chart class idiom offered, with its score; drawn is set per view. */
  chart_options: ChartOption[];
  /**
   * idiom's form point (the chart choice) as the core decided it, whether or not the side
   * card asks it: a chart pick sets it by the user, on the card or added to it.
   */
  form_point: DecisionPoint | null;
  refs: FixtureRef[];
  analysis: FixtureAnalysis | null;
}

/** The fixtures of each workspace, in file-name order. */
export type FixtureIndex = Map<string, Fixture[]>;

export const FIXTURES_DIR = new URL("./fixtures/", import.meta.url);

export function loadFixtures(dir: URL = FIXTURES_DIR): FixtureIndex {
  const index: FixtureIndex = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = new URL(`${entry.name}/`, dir);
    const fixtures = readdirSync(folder)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(new URL(file, folder), "utf8")) as Fixture);
    index.set(entry.name, fixtures);
  }
  return index;
}

export const humanise = (id: string): string => id.replace(/[_.-]+/g, " ").trim();

/** The order of the stages within one pass, as the contract lists them. */
export const PASS_ORDER: readonly string[] = [
  "situate", "recall", "define", "ground", "abstract", "plan", "bind",
  "enrich", "derive", "query", "analyse", "gather",
  "idiom", "render", "perceive", "validate",
];

/**
 * The stages a run of the fixture plays: its own, with the analysis' stages (plan,
 * analyse, gather) in their places when the analysis is on.
 */
export function passStages(fixture: Fixture, analysis: boolean): FixtureStage[] {
  const extra = analysis ? (fixture.analysis?.stages ?? []) : [];
  if (extra.length === 0) return fixture.stages;
  const rank = (stage: string): number => {
    const at = PASS_ORDER.indexOf(stage);
    return at < 0 ? PASS_ORDER.length : at;
  };
  const merged = [...fixture.stages];
  for (const stage of extra) {
    const at = merged.findIndex((s) => rank(s.stage) > rank(stage.stage));
    merged.splice(at < 0 ? merged.length : at, 0, stage);
  }
  return merged;
}
