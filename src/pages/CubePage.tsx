import { useEffect, useState } from "react";
import { WorkingCube, type CubeState } from "../components/working/WorkingCube";
import { StatusLine } from "../components/working/StatusLine";
import { useTheme } from "../theme";
import "./CubePage.css";

// Stage timings of a real run (manufacturing 20261024T190840-c39a9a, "What was the OEE
// of each line last week?"), read from its artifact write times. Phases follow the
// backend's draft map; the live app takes both from the run events.
const RUN: { stage: string; phase: string; ms: number }[] = [
  { stage: "situate", phase: "understand", ms: 295 },
  { stage: "recall", phase: "understand", ms: 19 },
  { stage: "define", phase: "understand", ms: 16 },
  { stage: "ground", phase: "understand", ms: 98 },
  { stage: "abstract", phase: "understand", ms: 97412 },
  { stage: "bind", phase: "understand", ms: 14 },
  { stage: "enrich", phase: "analyse", ms: 3 },
  { stage: "derive", phase: "analyse", ms: 7 },
  { stage: "query", phase: "analyse", ms: 6 },
  { stage: "idiom", phase: "present", ms: 284 },
  { stage: "render", phase: "present", ms: 14 },
  { stage: "perceive", phase: "present", ms: 29427 },
  { stage: "validate", phase: "present", ms: 828 },
];

const SPEEDS = [1, 4, 16];
const STATES: CubeState[] = ["working", "asking", "failed", "idle"];
const SIZES = [16, 24, 48, 96];
type Motion = "system" | "reduced" | "full";

/** A dev page for signing off the working cue before it is wired to runs. */
export function CubePage() {
  const [theme, nextTheme] = useTheme();
  const [speed, setSpeed] = useState(4);
  const [motion, setMotion] = useState<Motion>("system");
  const [index, setIndex] = useState(0);
  const [since, setSince] = useState(() => Date.now());
  const [state, setState] = useState<CubeState>("working");
  const reducedMotion = motion === "system" ? undefined : motion === "reduced";
  const step = RUN[index];

  useEffect(() => {
    if (state !== "working" || !step) return;
    const timer = setTimeout(() => {
      if (index + 1 < RUN.length) setIndex(index + 1);
      else setState("idle");
    }, Math.max(step.ms / speed, 60));
    return () => clearTimeout(timer);
  }, [index, speed, state, step]);

  const restart = () => {
    setIndex(0);
    setSince(Date.now());
    setState("working");
  };

  return (
    <main className="cubepage">
      <header>
        <p className="eyebrow">Working cue</p>
        <h1>The working cube</h1>
        <p className="muted">
          The Pattern Perspectives logo as a solid cube under a fixed light. While sightline works it spins about its
          vertical axis at one steady speed, a whole turn every 3.6 seconds; it eases into the spin when work starts
          and, when work stops, turns on and brakes onto the next quarter turn, so it rests as the logo. Asking rests
          in amber; a failed run rests red.
        </p>
      </header>

      <section className="cubepage__card">
        <div className="cubepage__bar">
          <span className="eyebrow">Status line</span>
          <span className="muted">a real run's stage timings, at {speed}× speed</span>
        </div>
        <div className="cubepage__status">
          <StatusLine
            state={state}
            stage={state === "idle" ? null : (step?.stage ?? null)}
            phase={state === "idle" ? null : (step?.phase ?? null)}
            since={since}
            onStop={() => setState("idle")}
            reducedMotion={reducedMotion}
          />
          {state === "idle" && <span className="muted">Stopped. Restart to watch again.</span>}
        </div>
        <ol className="cubepage__stages">
          {RUN.map((s, i) => (
            <li key={s.stage} className={i < index ? "done" : i === index && state !== "idle" ? "now" : ""}>
              {s.stage}
            </li>
          ))}
        </ol>
        <div className="cubepage__controls">
          <button type="button" className="pill" onClick={restart}>
            Restart
          </button>
          <button type="button" className="pill" onClick={() => setIndex((i) => Math.min(i + 1, RUN.length - 1))}>
            Next stage
          </button>
          <button type="button" className="pill" onClick={() => setState("asking")}>
            Ask
          </button>
          <button type="button" className="pill" onClick={() => setState("failed")}>
            Fail
          </button>
          <span className="cubepage__group" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" className="pill" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </span>
          <span className="cubepage__group" role="group" aria-label="Motion">
            {(["system", "full", "reduced"] as Motion[]).map((m) => (
              <button key={m} type="button" className="pill" aria-pressed={motion === m} onClick={() => setMotion(m)}>
                {m === "system" ? "motion: system" : m}
              </button>
            ))}
          </span>
          <button type="button" className="pill" onClick={nextTheme}>
            theme: {theme}
          </button>
        </div>
      </section>

      <section className="cubepage__card">
        <div className="cubepage__bar">
          <span className="eyebrow">States and sizes</span>
        </div>
        <table className="cubepage__grid">
          <thead>
            <tr>
              <th />
              {SIZES.map((size) => (
                <th key={size}>{size}px</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STATES.map((s) => (
              <tr key={s}>
                <th>{s}</th>
                {SIZES.map((size) => (
                  <td key={size}>
                    <WorkingCube state={s} size={size} reducedMotion={reducedMotion} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
