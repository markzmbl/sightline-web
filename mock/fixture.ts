// A fixture is one real sightline run, exported by scripts/export-fixtures.mjs,
// that the mock replays as a live run. Its parts are the contract's own shapes:
// decision points as the core has them (open, stage, by), a clarify with the
// not-possible-yet ending (missing, record, nearest), chart hints from idiom's reads.
import { readdirSync, readFileSync } from "node:fs";
import type { Card, ChartOption, ChartView, Clarify, Result } from "../src/api/types.ts";

export type FinalStatus = "complete" | "clarify" | "asking";

export interface FixtureStage {
  phase: string;
  stage: string;
  /** How long the stage took in the real run. */
  ms: number;
}

export type VegaLiteSpec = ChartView["spec"];

export interface Fixture {
  slug: string;
  workspace: string;
  /** True for a fixture made up rather than exported from a real run; absent on real ones. */
  synthetic?: boolean;
  question: string;
  final_status: FinalStatus;
  /** The fixture an asking run goes on with once the card is answered. */
  continuation: string | null;
  stages: FixtureStage[];
  restatement: string | null;
  card: Card | null;
  clarify: Clarify | null;
  result: Result | null;
  /** Every rendering the run drew, by chart class. */
  charts: Record<string, VegaLiteSpec>;
  /** Every chart class idiom offered, in its order, with the switcher's words for it. */
  chart_options: ChartOption[];
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
