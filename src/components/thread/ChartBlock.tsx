import { useEffect, useMemo, useRef, useState } from "react";
import type { EmbedOptions, Result as Embedded, VisualizationSpec } from "vega-embed";
import type { ChartView } from "../../api/types";

type Spec = Record<string, unknown>;

const OPTIONS: EmbedOptions = {
  renderer: "svg",
  actions: { export: true, source: false, compiled: false, editor: false },
};

// Vega-Lite views that cannot take width "container".
const COMPOSITE = ["hconcat", "vconcat", "concat", "facet", "repeat"];

/** Fills the column unless the spec sets its own width. The theme stays the core's. */
function prepare(spec: Spec): Spec {
  if ("width" in spec || COMPOSITE.some((key) => key in spec)) return spec;
  return { ...spec, width: "container" };
}

/** The spec's own background, so the frame around the chart matches it. */
function paperOf(spec: Spec): string | undefined {
  const config = spec.config as Spec | undefined;
  const background = spec.background ?? config?.background;
  return typeof background === "string" ? background : undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// vega-embed brings Vega and Vega-Lite along: load it once, when the first chart shows,
// and try again on the next chart if loading failed.
let loading: Promise<typeof import("vega-embed")> | undefined;
const loadEmbed = () =>
  (loading ??= import("vega-embed").catch((error: unknown) => {
    loading = undefined;
    throw error;
  }));

/**
 * The run's chart, drawn by vega-embed on its own paper. The spec is compared by
 * value, so a refetched but unchanged run does not redraw.
 */
export function ChartBlock({ chart }: { chart: ChartView }) {
  const host = useRef<HTMLDivElement>(null);
  const json = useMemo(() => JSON.stringify(chart.spec), [chart.spec]);
  const [failure, setFailure] = useState<{ json: string; message: string } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Each embed gets its own node, so an embed that settles late can never draw twice.
    const target = document.createElement("div");
    el.appendChild(target);
    let gone = false;
    let embedded: Embedded | undefined;
    loadEmbed()
      .then(({ default: embed }) => embed(target, prepare(JSON.parse(json) as Spec) as VisualizationSpec, OPTIONS))
      .then((result) => {
        if (gone) result.finalize();
        else embedded = result;
      })
      .catch((error: unknown) => {
        if (!gone) setFailure({ json, message: messageOf(error) });
      });
    return () => {
      gone = true;
      embedded?.finalize();
      target.remove();
    };
  }, [json]);

  const error = failure?.json === json ? failure.message : null;
  return (
    <figure className="tx-chart" style={{ background: paperOf(chart.spec) }} aria-label={chart.label}>
      <div ref={host} className="tx-chart__canvas" hidden={error !== null} />
      {error !== null && (
        <div className="tx-chart__error">
          <p>The chart could not be drawn: {error}</p>
          <details>
            <summary>Spec</summary>
            <pre>{JSON.stringify(chart.spec, null, 2)}</pre>
          </details>
        </div>
      )}
    </figure>
  );
}
