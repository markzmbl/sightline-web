import { useEffect, useId, useState } from "react";
import { isOpen, type Result, type RunView, type StageTiming } from "../../api/types";
import { WorkingCube } from "../working/WorkingCube";
import { formatElapsed, stageLabel, WAITING } from "../working/stageLabels";
import { counted, formatPhaseMs, formatStageMs } from "./format";
import { Chevron } from "./icons";
import { phaseLabel } from "./phaseLabels";
import { RowsBlock } from "./RowsBlock";
import { SqlBlock } from "./SqlBlock";

/** One segment of the trace: consecutive stages of the same phase. */
export interface PhaseGroup {
  /** Unique within the run: the segment's place and its phase. */
  key: string;
  phase: string;
  stages: StageTiming[];
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
  for (const timing of run.timings) {
    let group = groups.at(-1);
    if (group?.phase !== timing.phase) {
      group = { key: `${groups.length}:${timing.phase}`, phase: timing.phase, stages: [], running: false, elapsedMs: 0 };
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

function summary(group: PhaseGroup, result: Result | null, withResult: boolean): string {
  const parts = [counted(group.stages.length, "stage"), formatPhaseMs(group.elapsedMs)];
  if (withResult && result?.sql) parts.push("SQL", counted(result.row_count, "row"));
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
  return (
    <div className="tx-trace">
      {groups.map((group, index) => (
        <PhaseRow
          key={group.key}
          run={run}
          group={group}
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
  /** This segment carries the run's SQL and rows. */
  withResult: boolean;
  open: boolean;
  onToggle(): void;
}

function PhaseRow({ run, group, withResult, open, onToggle }: RowProps) {
  const bodyId = useId();
  const result = run.result;
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
        <span className="tx-trace__summary">· {summary(group, result, withResult)}</span>
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
}

function StageLine({ timing, running, asking }: StageProps) {
  return (
    <li className={`tx-trace__stage${running ? " tx-trace__stage--running" : ""}`}>
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
