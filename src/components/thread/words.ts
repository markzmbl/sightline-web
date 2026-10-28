// Display words the transcript gives the contract's enums. The contract sends names
// only; the words for them belong to the client.
import type { Definition, FollowUpKind, RunStatus, RunSummary, StepRole, StepVerdict } from "../../api/types";

/** A follow-up's kind, as its chip's tag. */
export const FOLLOW_UP_KIND: Record<FollowUpKind, string> = {
  breakdown: "Break down",
  next_level: "One level down",
  check: "Check",
  nearest: "Instead",
};

/** A run's status on its fold row; a complete run needs no word. */
export const STATUS_WORDS: Partial<Record<RunStatus, string>> = {
  queued: "Queued",
  running: "Working",
  asking: "Waiting for you",
  clarify: "Needs a revision",
  failed: "Failed",
  cancelled: "Stopped",
  superseded: "Replaced",
};

export const STEP_ROLE: Record<StepRole, string> = {
  answer: "answer",
  probe: "probe",
  reference: "reference",
  denominator: "denominator",
  comparison: "comparison",
  decomposition: "breakdown",
  check: "check",
  lookup: "lookup",
};

export const STEP_VERDICT: Record<StepVerdict, string> = {
  as_expected: "as expected",
  contradicts: "contradicts the expectation",
  routine: "within its routine range",
  inconclusive: "inconclusive",
  no_effect: "no effect",
  failed: "not checked",
};

/** Verdicts that say a check did not simply hold: these speak up even while the checks are folded. */
export const LOUD_VERDICTS: readonly StepVerdict[] = ["contradicts", "inconclusive", "failed"];

/**
 * What the user turn says above the prompt; null for the question. A take-back names
 * the revision it took back, its prompt being the text taken back.
 */
export function originLabel(summary: RunSummary): string | null {
  switch (summary.origin) {
    case "question":
      return null;
    case "follow_up":
      return summary.follows ? `Follow-up · ${FOLLOW_UP_KIND[summary.follows.kind]}` : "Follow-up";
    case "nearest":
      return "Instead";
    case "take_back":
      return summary.takes_back !== null ? `Took back revision ${summary.takes_back}` : "Took back a revision";
    case "revision":
      return `Revision ${summary.revision}`;
  }
}

/** "from sightline's KPI library (ISO 22400-2)" as a parenthesis' content: "from sightline's KPI library, ISO 22400-2". */
const unbracket = (text: string): string => text.replace(/\s*\(([^()]+)\)\s*$/, ", $1");

/**
 * A definition's line after its label, in the agreed wording: proposed, "proposed definition
 * from sightline's KPI library (ISO 22400-2), not yet approved"; approved, "approved by your
 * key user (from sightline's KPI library, ISO 22400-2)". One the question gives is "as your
 * question defines it", whatever the source's own text says.
 */
export function definitionWording(definition: Definition): string {
  const question = definition.source.kind === "question";
  const source = question ? "as your question defines it" : definition.source.text.trim();
  if (definition.status === "approved") return `approved by your key user (${unbracket(source)})`;
  return question ? `${source}, not yet approved` : `proposed definition ${source}, not yet approved`;
}
