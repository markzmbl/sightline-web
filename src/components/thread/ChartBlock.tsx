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
function prepare(spec: Spec, untitled: boolean): Spec {
  const shown = untitled ? untitle(spec) : spec;
  if ("width" in shown || COMPOSITE.some((key) => key in shown)) return shown;
  return { ...shown, width: "container" };
}

const isObject = (value: unknown): value is Spec => typeof value === "object" && value !== null && !Array.isArray(value);

// A title's subtitle style and the plain title property it becomes.
const SUBTITLE_STYLE: [string, string][] = [
  ["subtitleFont", "font"],
  ["subtitleFontSize", "fontSize"],
  ["subtitleFontStyle", "fontStyle"],
  ["subtitleFontWeight", "fontWeight"],
  ["subtitleColor", "color"],
  ["subtitleLineHeight", "lineHeight"],
];

/**
 * The spec without its title text, which the transcript says above the chart instead
 * (storyline.top); the subtitle, which holds the bases, stays on the paper in its own
 * type as the title's only text. Vega-Lite drops a title whose text is empty, subtitle
 * and all, so the subtitle lines become the text.
 */
function untitle(spec: Spec): Spec {
  if (spec.title === undefined) return spec;
  const rest = Object.fromEntries(Object.entries(spec).filter(([key]) => key !== "title"));
  const title = isObject(spec.title) ? spec.title : null;
  const subtitle = title?.subtitle;
  const lines = Array.isArray(subtitle) ? subtitle.map(String) : typeof subtitle === "string" ? [subtitle] : [];
  if (!title || lines.length === 0) return rest;
  const config = isObject(spec.config) && isObject(spec.config.title) ? spec.config.title : {};
  // Vega's own subtitle look, where neither the title nor the theme gives one.
  const style: Spec = { fontSize: 12, fontWeight: "normal" };
  for (const [from, to] of SUBTITLE_STYLE) {
    const value = title[from] ?? config[from];
    if (value !== undefined) style[to] = value;
  }
  const kept = Object.fromEntries(Object.entries(title).filter(([key]) => key !== "text" && !key.startsWith("subtitle")));
  return { ...rest, title: { ...kept, ...style, text: lines } };
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

interface Props {
  chart: ChartView;
  /** The transcript says the title above the chart: draw it without its title text, keeping the subtitle. */
  untitled?: boolean;
  /** A support's small chart, on smaller paper. */
  small?: boolean;
}

/**
 * A chart, drawn by vega-embed on its own paper: the run's main chart or a support's
 * small one. The spec is compared by value, so a refetched but unchanged run does not redraw.
 */
export function ChartBlock({ chart, untitled = false, small = false }: Props) {
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
      .then(({ default: embed }) => embed(target, prepare(JSON.parse(json) as Spec, untitled) as VisualizationSpec, OPTIONS))
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
  }, [json, untitled]);

  const error = failure?.json === json ? failure.message : null;
  return (
    <figure
      className={small ? "tx-chart tx-chart--small" : "tx-chart"}
      style={{ background: paperOf(chart.spec) }}
      aria-label={chart.label}
    >
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
