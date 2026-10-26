// Display words for the pipeline's phases in the stage trace, past tense once a
// phase is done, a gerund while it runs. Like stageLabels.ts, the phases come from
// the run's timings; a phase this map does not know still shows, as its own name.

const DONE: Record<string, string> = {
  understand: "Understood",
  analyse: "Analysed",
  present: "Presented",
};

const DOING: Record<string, string> = {
  understand: "Understanding…",
  analyse: "Analysing…",
  present: "Presenting…",
};

export function phaseLabel(phase: string, running: boolean): string {
  const known = (running ? DOING : DONE)[phase];
  if (known) return known;
  const words = phase.replace(/[_.-]+/g, " ").trim();
  const name = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  return running ? `${name}…` : name;
}
