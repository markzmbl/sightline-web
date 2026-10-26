import { formatElapsed } from "../working/stageLabels";

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const COUNT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** A cell's number: grouped, at most four fraction digits. */
export const formatNumber = (value: number): string => NUMBER.format(value);

export const formatCount = (value: number): string => COUNT.format(value);

/** "1 row", "1,234 rows". */
export function counted(value: number, one: string, many = `${one}s`): string {
  return `${formatCount(value)} ${value === 1 ? one : many}`;
}

/** A stage's duration: "12 ms", "1.4 s", then the status line's clock ("14s", "1:37"). */
export function formatStageMs(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded} ms`;
  if (ms < 9950) return `${(ms / 1000).toFixed(1)} s`;
  return formatElapsed(ms);
}

/** A phase's total in seconds ("0.4 s", "4.2 s", "1:37"); a few milliseconds stay in ms. */
export function formatPhaseMs(ms: number): string {
  if (ms < 100) return `${Math.round(ms)} ms`;
  if (ms < 9950) return `${(ms / 1000).toFixed(1)} s`;
  return formatElapsed(ms);
}

/** A confidence in [0, 1] as a whole percent. */
export function formatConfidence(confidence: number): string {
  const share = confidence > 1 ? confidence / 100 : confidence;
  return `${Math.round(share * 100)}%`;
}
