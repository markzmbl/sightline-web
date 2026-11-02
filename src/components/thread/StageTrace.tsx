import { useEffect, useId, useState } from "react";
import { isOpen, isWorking, type Result, type RunView, type StageTiming, type StepRecord } from "../../api/types";
import { WorkingCube } from "../working/WorkingCube";
import { formatElapsed, stageLabel, WAITING } from "../working/stageLabels";
import { counted, formatCount, formatPhaseMs, formatStageMs } from "./format";
import { Chevron } from "./icons";
import { phaseLabel } from "./phaseLabels";
import { RowsBlock } from "./RowsBlock";
import { SqlBlock } from "./SqlBlock";
import { LOUD_VERDICTS, STEP_ROLE, STEP_VERDICT } from "./words";

/** One segment of the trace: consecutive stages of the same phase. */
export interface PhaseGroup {
  /** Unique within the run: the segment's place and its phase. */
  key: string;
  phase: string;
  stages: StageTiming[];
  /** The index in run.timings of the segment's first stage. */
  start: number;
  running: boolean;
  /** The sum of the finished stages' times. */
  elapsedMs: number;
}

/**
 * The run's timings as segments, in timing order: a new segment starts whenever
 * the phase changes. Stages are not monotonic, so a reconsider loop after
 * validate shows a second understand segment after present. Side states
 * (clarify, ask, reconsider, restore) sit in the segment of the phase they came with.
 */
export function groupPhases(run: RunView): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  for (const [index, timing] of run.timings.entries()) {
    let group = groups.at(-1);
    if (group?.phase !== timing.phase) {
      group = {
        key: `${groups.length}:${timing.phase}`,
        phase: timing.phase,
        stages: [],
        start: index,
        running: false,
        elapsedMs: 0,
      };
      groups.push(group);
    }
    group.stages.push(timing);
    group.elapsedMs += timing.elapsed_ms ?? 0;
  }
  // Only the last segment can be under way: the pipeline has moved on from the others,
  // even where a stage of theirs never reported its time. Between two of its stages
  // nothing runs, but the segment is still under way. Not so for a queued run: its
  // phase may be the one an earlier end left (complete, then queued again by an answer
  // or a chart switch), and nothing has started yet.
  const last = groups.at(-1);
  if (
    last &&
    isOpen(run.status) &&
    (last.stages.some((timing) => timing.elapsed_ms === null) || (run.status === "running" && last.phase === run.phase))
  ) {
    last.running = true;
  }
  return groups;
}

/**
 * The run's analysis steps by the stage line they ran under, one list per timing: a
 * step goes to the last run of its stage that had started by the step's start (the hole
 * loop runs analyse again), else to its stage's last run. A step whose stage has no
 * timing goes to the last analyse stage line, if there is one.
 */
export function placeSteps(run: RunView): StepRecord[][] {
  const placed = run.timings.map((): StepRecord[] => []);
  const fallback = run.timings.findLastIndex((timing) => timing.phase === "analyse");
  for (const step of run.steps) {
    const at = Date.parse(step.started_at);
    let index = -1;
    for (let i = run.timings.length - 1; i >= 0; i -= 1) {
      const timing = run.timings[i];
      if (timing?.stage !== step.stage) continue;
      if (index === -1) index = i;
      if (Date.parse(timing.started_at) <= at) {
        index = i;
        break;
      }
    }
    placed[index === -1 ? fallback : index]?.push(step);
  }
  return placed;
}

/** A step that ran a query: one finished with rows or its SQL, or one whose rows came from the cache. */
const queried = (step: StepRecord): boolean => step.row_count !== null || step.sql !== null || step.cached;

/** "9 queries, 4 cached"; while no step has its query back yet, how many steps there are. */
function queryCount(steps: StepRecord[]): string {
  const queries = steps.filter(queried);
  if (queries.length === 0) return counted(steps.length, "step");
  const cached = queries.filter((step) => step.cached).length;
  const told = counted(queries.length, "query", "queries");
  return cached > 0 ? `${told}, ${formatCount(cached)} cached` : told;
}

function summary(group: PhaseGroup, steps: StepRecord[], result: Result | null, withResult: boolean): string {
  const parts = [counted(group.stages.length, "stage"), formatPhaseMs(group.elapsedMs)];
  if (steps.length > 0) parts.push(queryCount(steps));
  else if (withResult && result?.sql) parts.push("SQL", counted(result.row_count, "row"));
  return parts.join(" · ");
}

/** The run's pipeline as Claude-style tool rows: one foldable row per segment. */
export function StageTrace({ run }: { run: RunView }) {
  const groups = groupPhases(run);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (groups.length === 0) return null;
  // The run keeps one result: its SQL and rows belong to the latest analyse segment that
  // has finished. One under way in a reconsider loop has no result of its own yet: the one
  // the run holds is the earlier loop's. On the first pass there is no earlier one.
  const finished = groups.findLastIndex((group) => group.phase === "analyse" && !group.running);
  const analysed = finished !== -1 ? finished : groups.findLastIndex((group) => group.phase === "analyse");
  const steps = placeSteps(run);
  return (
    <div className="tx-trace">
      {groups.map((group, index) => (
        <PhaseRow
          key={group.key}
          run={run}
          group={group}
          steps={steps.slice(group.start, group.start + group.stages.length)}
          withResult={index === analysed}
          open={open[group.key] ?? false}
          onToggle={() => setOpen((current) => ({ ...current, [group.key]: !current[group.key] }))}
        />
      ))}
    </div>
  );
}

interface RowProps {
  run: RunView;
  group: PhaseGroup;
  /** The analysis steps under each of the segment's stages, in the same order. */
  steps: StepRecord[][];
  /** This segment carries the run's SQL and rows. */
  withResult: boolean;
  open: boolean;
  onToggle(): void;
}

function PhaseRow({ run, group, steps, withResult, open, onToggle }: RowProps) {
  const bodyId = useId();
  const result = run.result;
  const live = isWorking(run.status);
  return (
    <div className={`tx-trace__phase${group.running ? " tx-trace__phase--running" : ""}`}>
      <button
        type="button"
        className="tx-trace__row"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
      >
        <Chevron />
        <span className="tx-trace__label">{phaseLabel(group.phase, group.running)}</span>
        <span className="tx-trace__summary">· {summary(group, steps.flat(), result, withResult)}</span>
        {/* One cube per segment, not per stage: stages last milliseconds, and a cube
            remounted on each new stage line would restart from rest every time. */}
        {group.running && (
          <span className="tx-trace__mark" aria-hidden="true">
            <WorkingCube state={run.status === "asking" ? "asking" : "working"} size={12} />
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="tx-trace__body">
          <ol className="tx-trace__stages">
            {group.stages.map((timing, index) => (
              <StageLine
                key={`${index}:${timing.stage}`}
                timing={timing}
                running={group.running && timing.elapsed_ms === null}
                asking={run.status === "asking"}
                steps={steps[index] ?? []}
                live={live}
              />
            ))}
          </ol>
          {withResult && result?.sql && <SqlBlock sql={result.sql} />}
          {withResult && result && result.columns.length > 0 && <RowsBlock result={result} />}
        </div>
      )}
    </div>
  );
}

interface StageProps {
  timing: StageTiming;
  /** The stage has no time yet and its segment is under way. */
  running: boolean;
  asking: boolean;
  /** The analysis steps that ran under this stage line. */
  steps: StepRecord[];
  /** The run is working: a step with no time yet is under way. */
  live: boolean;
}

function StageLine({ timing, running, asking, steps, live }: StageProps) {
  return (
    <li className="tx-trace__stage-item">
      <div className={`tx-trace__stage${running ? " tx-trace__stage--running" : ""}`}>
        <span className="tx-trace__name" title={stageLabel(timing.stage).replace(/…$/, "")}>
          {timing.stage}
        </span>
        {running && <span className="tx-trace__verb">{asking ? WAITING : stageLabel(timing.stage)}</span>}
        <span className="tx-trace__time">
          {timing.elapsed_ms !== null ? (
            formatStageMs(timing.elapsed_ms)
          ) : running && !asking ? (
            <Clock since={timing.started_at} />
          ) : (
            "–"
          )}
        </span>
      </div>
      {steps.length > 0 && <Steps steps={steps} live={live} />}
    </li>
  );
}

const isCheck = (step: StepRecord): boolean => step.role === "probe" || step.role === "check";

/** A step with no time yet while the run works: the one under way. */
const underWay = (step: StepRecord, live: boolean): boolean => live && step.elapsed_ms === null;

/**
 * A stage line's steps in the order they started. Probes and checks fold into one
 * "N checks" row where the first of them started: a check that held stays quiet
 * there, one that did not speaks up on the folded row.
 */
function Steps({ steps, live }: { steps: StepRecord[]; live: boolean }) {
  const checks = steps.filter(isCheck);
  const first = steps.findIndex(isCheck);
  return (
    <ol className="tx-trace__steps" aria-label="Steps">
      {steps.map((step, index) =>
        !isCheck(step) ? (
          <StepLine key={step.id} step={step} live={live} />
        ) : index === first ? (
          <Checks key={`checks:${step.id}`} checks={checks} live={live} />
        ) : null,
      )}
    </ol>
  );
}

function StepTime({ step, live }: { step: StepRecord; live: boolean }) {
  return (
    <span className="tx-trace__time">
      {step.elapsed_ms !== null ? (
        formatStageMs(step.elapsed_ms)
      ) : underWay(step, live) ? (
        <Clock since={step.started_at} />
      ) : (
        "–"
      )}
    </span>
  );
}

/** One step: what it looked at, its role, its verdict, whether its rows came from the cache, and its time. */
function StepLine({ step, live }: { step: StepRecord; live: boolean }) {
  const running = underWay(step, live);
  return (
    <li className={`tx-trace__step${running ? " tx-trace__step--running" : ""}`}>
      <span className="tx-trace__step-label">{step.label}</span>
      <span className="tx-trace__role">{STEP_ROLE[step.role]}</span>
      {step.verdict && (
        <span className={`tx-trace__verdict tx-trace__verdict--${step.verdict}`}>{STEP_VERDICT[step.verdict]}</span>
      )}
      {step.cached && <span className="tx-trace__cached">cached</span>}
      {running && <span className="tx-trace__verb">running…</span>}
      <StepTime step={step} live={live} />
    </li>
  );
}

/** The probes and checks as one row that unfolds; folded, it names only the checks that did not hold. */
function Checks({ checks, live }: { checks: StepRecord[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const running = checks.some((step) => underWay(step, live));
  const loud = LOUD_VERDICTS.flatMap((verdict) => {
    const n = checks.filter((step) => step.verdict === verdict).length;
    return n > 0 ? [`${formatCount(n)} ${STEP_VERDICT[verdict]}`] : [];
  });
  const elapsed = checks.reduce((sum, step) => sum + (step.elapsed_ms ?? 0), 0);
  return (
    <li className={`tx-trace__checks${running ? " tx-trace__checks--running" : ""}`}>
      <button
        type="button"
        className="tx-trace__step tx-trace__step--checks"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={[counted(checks.length, "check"), ...loud, ...(running ? ["running"] : [])].join(", ")}
        onClick={() => setOpen((current) => !current)}
      >
        <Chevron />
        <span className="tx-trace__step-label">{counted(checks.length, "check")}</span>
        {loud.map((word) => (
          <span key={word} className="tx-trace__verdict tx-trace__verdict--loud">
            {word}
          </span>
        ))}
        {running && <span className="tx-trace__verb">running…</span>}
        <span className="tx-trace__time">{elapsed > 0 ? formatStageMs(elapsed) : "–"}</span>
      </button>
      {open && (
        <ol id={listId} className="tx-trace__steps">
          {checks.map((step) => (
            <StepLine key={step.id} step={step} live={live} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Seconds since the stage started, ticking. */
function Clock({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Number.isNaN(start) ? null : <>{formatElapsed(now - start)}</>;
}
