import type { ChartView } from "../../api/types";

interface Props {
  chart: ChartView;
  disabled: boolean;
  onPick(chart: string): void;
}

/** The chart shown, then the other admissible charts; picking one presents the run again. */
export function ChartSwitcher({ chart, disabled, onPick }: Props) {
  if (chart.alternatives.length === 0) return null;
  return (
    <div className="tx-switcher" role="group" aria-label="Show it as">
      <button type="button" className="pill" aria-pressed="true" disabled={disabled}>
        {chart.label}
      </button>
      {chart.alternatives.map((option) => (
        <button
          key={option.chart}
          type="button"
          className="pill"
          aria-pressed="false"
          title={option.hint ?? undefined}
          disabled={disabled}
          onClick={() => onPick(option.chart)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
