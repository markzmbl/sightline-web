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
export type ErrorItem = Schemas["ErrorItem"];

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
