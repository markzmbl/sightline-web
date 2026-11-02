// Friendly names for the generated contract types. Never hand-write an API type:
// change the contract and run `npm run gen:api`.
import type { components } from "./schema";

type Schemas = components["schemas"];

export type Me = Schemas["Me"];
export type User = Schemas["User"];
export type Workspace = Schemas["Workspace"];
export type ThreadSummary = Schemas["ThreadSummary"];
export type ThreadPage = Schemas["ThreadPage"];
export type Thread = Schemas["Thread"];
export type RunView = Schemas["RunView"];
export type RunStatus = Schemas["RunStatus"];
export type StageTiming = Schemas["StageTiming"];
export type Card = Schemas["Card"];
export type DecisionPoint = Schemas["DecisionPoint"];
export type Option = Schemas["Option"];
export type Clarify = Schemas["Clarify"];
export type Gap = Schemas["Gap"];
export type Result = Schemas["Result"];
export type Column = Schemas["Column"];
export type Cell = Schemas["Cell"];
export type ChartView = Schemas["ChartView"];
export type ChartOption = Schemas["ChartOption"];
export type RunError = Schemas["RunError"];
export type Rating = Schemas["Rating"];
export type RunCreated = Schemas["RunCreated"];
export type CreateThread = Schemas["CreateThread"];
export type Answers = Schemas["Answers"];
export type RunEvent = Schemas["RunEvent"];
export type RunEventType = RunEvent["type"];
export type DecidedBy = Schemas["DecidedBy"];
export type Problem = Schemas["Problem"];
export type ProblemCode = Schemas["ProblemCode"];
export type ErrorItem = Schemas["ErrorItem"];
export type RunErrorCode = Schemas["RunErrorCode"];
export type RunSummary = Schemas["RunSummary"];
export type RunOrigin = Schemas["RunOrigin"];
export type Locale = Schemas["Locale"];
export type FollowUp = Schemas["FollowUp"];
export type FollowUpKind = Schemas["FollowUpKind"];
export type FollowRef = Schemas["FollowRef"];
export type FollowRequest = Schemas["FollowRequest"];
export type Revise = Schemas["Revise"];
export type Storyline = Schemas["Storyline"];
export type KeyPoint = Schemas["KeyPoint"];
export type Support = Schemas["Support"];
export type SupportRole = Schemas["SupportRole"];
export type SupportDrawn = Schemas["SupportDrawn"];
export type StepRecord = Schemas["StepRecord"];
export type StepRole = Schemas["StepRole"];
export type StepVerdict = Schemas["StepVerdict"];
export type AnalysisStep = Schemas["AnalysisStep"];
export type StepResult = Schemas["StepResult"];
export type ChartRef = Schemas["ChartRef"];
export type Definition = Schemas["Definition"];
export type GapSuggestion = Schemas["GapSuggestion"];
export type ResultVerdict = Schemas["ResultVerdict"];
export type ColumnRole = Schemas["ColumnRole"];
export type WorkspaceRole = Schemas["WorkspaceRole"];
export type SchemaInfo = Schemas["SchemaInfo"];

/**
 * One turn of a thread: what the user sent and what sightline made of it. The thread
 * carries every run as a summary and only its latest in full; an earlier run's full
 * view arrives when its turn is unfolded (getRun), and is null until then.
 */
export interface Turn {
  summary: RunSummary;
  run: RunView | null;
}

export type RegistryKind = Schemas["RegistryKind"];
export type RegistryStatus = Schemas["RegistryStatus"];
export type RegistryEntry = Schemas["RegistryEntry"];
export type RegistryEntryDetail = Schemas["RegistryEntryDetail"];
export type RegistryPage = Schemas["RegistryPage"];
export type RegistryCounts = Schemas["RegistryCounts"];
export type EntrySource = Schemas["EntrySource"];
export type EntryRun = Schemas["EntryRun"];
export type EntryGap = Schemas["EntryGap"];
export type EntryChoice = Schemas["EntryChoice"];
export type EntryChange = Schemas["EntryChange"];
export type KindInfo = Schemas["KindInfo"];
export type Demand = Schemas["Demand"];
export type Review = Schemas["Review"];
export type ReviewAction = Schemas["ReviewAction"];

/** A run still on its way: the status line shows and the composer offers Stop. */
export const WORKING: readonly RunStatus[] = ["queued", "running"];
/** A run that has not ended: working, or waiting on the choice card. */
export const OPEN: readonly RunStatus[] = ["queued", "running", "asking"];
/** A run that has ended; its event stream closes. Superseded: a newer revision replaced it. */
export const ENDED: readonly RunStatus[] = ["complete", "clarify", "failed", "cancelled", "superseded"];

export const isWorking = (status: RunStatus): boolean => WORKING.includes(status);
export const isOpen = (status: RunStatus): boolean => OPEN.includes(status);
