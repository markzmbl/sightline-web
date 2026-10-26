import { useEffect, useState } from "react";
import { WorkingCube, type CubeState } from "./WorkingCube";
import { formatElapsed, stageLabel, WAITING } from "./stageLabels";
import { useReducedMotion } from "./useReducedMotion";

interface Props {
  state: CubeState;
  stage: string | null;
  phase: string | null;
  /** When the run started (epoch ms); the clock counts from here. */
  since: number | null;
  onStop?: () => void;
  reducedMotion?: boolean;
}

/** The line under the transcript while sightline works: cube, stage, phase, clock. */
export function StatusLine({ state, stage, phase, since, onStop, reducedMotion }: Props) {
  const now = useNow(state === "working" ? 1000 : null);
  const reduced = useReducedMotion(reducedMotion);
  const working = state === "working";

  useEffect(() => {
    if (!working || !onStop) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, onStop]);

  const verb = state === "asking" ? WAITING : stageLabel(stage);
  return (
    <div className={`status status--${state}`} role="status" aria-live="polite">
      <WorkingCube state={state} size={16} reducedMotion={reducedMotion} />
      <span className={`status__verb${working && !reduced ? " status__verb--shine" : ""}`}>{verb}</span>
      <span className="status__meta">
        {phase && <span className="status__phase">{phase}</span>}
        {working && since !== null && <span>{formatElapsed(now - since)}</span>}
        {working && onStop && (
          <button type="button" className="status__stop" onClick={onStop}>
            <kbd>esc</kbd> to stop
          </button>
        )}
        {state === "asking" && <span>answer the card, or revise the question</span>}
      </span>
    </div>
  );
}

function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
