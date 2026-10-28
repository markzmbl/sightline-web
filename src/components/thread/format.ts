import { formatElapsed } from "../working/stageLabels";

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const COUNT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** A cell's number: grouped, at most four fraction digits. */
export const formatNumber = (value: number): string => NUMBER.format(value);

export const formatCount = (value: number): string => COUNT.format(value);

// The d3-format specifiers a Column carries, in a small subset: an optional "," for
// grouping, an optional ".N" precision, an optional "~" to trim zeros, and type f, d, %
// or s (or none). Anything else (fill, align, sign, width, other types) formats as a
// plain number.
const SPECIFIER = /^(,)?(?:\.(\d{1,2}))?(~)?([fd%s])?$/;
const SI = ["y", "z", "a", "f", "p", "n", "µ", "m", "", "k", "M", "G", "T", "P", "E", "Z", "Y"];

/** A number formatted by a Column's d3-format specifier, or as a plain number when it is none we read. */
export function formatBySpecifier(value: number, specifier: string | null): string {
  const match = specifier ? SPECIFIER.exec(specifier) : null;
  if (!match || !Number.isFinite(value)) return formatNumber(value);
  const [, comma, digits, trim, type] = match;
  const grouping = comma !== undefined;
  const precision = digits === undefined ? undefined : Number(digits);
  switch (type) {
    case "f":
    case "%": {
      const fraction = precision ?? 6;
      return new Intl.NumberFormat(undefined, {
        style: type === "%" ? "percent" : "decimal",
        useGrouping: grouping,
        minimumFractionDigits: trim ? 0 : fraction,
        maximumFractionDigits: fraction,
      }).format(value);
    }
    case "d":
      return new Intl.NumberFormat(undefined, { useGrouping: grouping, maximumFractionDigits: 0 }).format(value);
    case "s":
      return siFormat(value, precision ?? 6, trim !== undefined);
    default:
      return grouping ? NUMBER.format(value) : new Intl.NumberFormat(undefined, { useGrouping: false, maximumFractionDigits: 4 }).format(value);
  }
}

/** d3's "s": significant digits with an SI prefix, "1.20k"; trimmed, "1.2k". */
function siFormat(value: number, significant: number, trim: boolean): string {
  if (value === 0) return "0";
  const precision = Math.max(1, Math.min(21, significant));
  let exponent = Math.max(-8, Math.min(8, Math.floor(Math.log10(Math.abs(value)) / 3)));
  // Rounding can carry into the next prefix: 999.96 to three digits is 1.00k, not 1.00e+3.
  if (exponent < 8 && Math.abs(Number((value / 1000 ** exponent).toPrecision(precision))) >= 1000) exponent += 1;
  let digits = (value / 1000 ** exponent).toPrecision(precision);
  if (trim && digits.includes(".")) digits = digits.replace(/\.?0+$/, "");
  return `${digits}${SI[exponent + 8] ?? ""}`;
}

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
