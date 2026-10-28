// Display words for the core's pipeline stages, in place of Claude's "Combobulating…".
// The stage names and their phases come from the run events, never from a list here:
// a stage this map does not know still shows, as its own name.

const LABELS: Record<string, string> = {
  situate: "Situating",
  recall: "Recalling",
  define: "Defining",
  ground: "Grounding",
  abstract: "Abstracting",
  plan: "Planning the analysis",
  bind: "Binding",
  enrich: "Enriching",
  derive: "Deriving",
  query: "Querying",
  analyse: "Analysing",
  gather: "Weighing the evidence",
  idiom: "Choosing the idiom",
  render: "Rendering",
  perceive: "Perceiving",
  validate: "Validating",
  clarify: "Clarifying",
  reconsider: "Reconsidering",
  restore: "Restoring",
  // "Repairing" would suggest something broke; it reads the question again.
  repair: "Rereading the question",
  propose: "Noting definitions for review",
};

export const WAITING = "Waiting for you";

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "Starting…";
  if (stage === "ask") return WAITING;
  const known = LABELS[stage];
  if (known) return `${known}…`;
  const words = stage.replace(/[_.-]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}…`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}
