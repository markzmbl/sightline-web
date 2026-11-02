import type { ChartView } from "../../api/types";

interface Props {
  chart: ChartView;
  disabled: boolean;
  onPick(chart: string): void;
}

/**
 * Every admissible chart in the server's order, which a switch does not change, the
 * drawn one pressed; picking another presents the run again.
 */
export function ChartSwitcher({ chart, disabled, onPick }: Props) {
  if (chart.options.length < 2) return null;
  return (
    <div className="tx-switcher" role="group" aria-label="Show it as">
      {chart.options.map((option) => (
        <button
          key={option.chart}
          type="button"
          className="pill"
          aria-pressed={option.drawn}
          title={option.hint ?? undefined}
          disabled={disabled}
          onClick={option.drawn ? undefined : () => onPick(option.chart)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
