// A chart the run offered but never drew, drawn by the mock: a plain Vega-Lite
// spec over the result's own rows, in the drawn chart's theme config, so every
// chart the switcher offers can be switched to against the mock. The backend
// draws these with the core's forms; the mock's only stand in for them.
import type { Cell, Column, Result } from "../src/api/types.ts";
import { humanise, type VegaLiteSpec } from "./fixture.ts";

type Datum = Record<string, Cell>;
type Encoding = Record<string, unknown>;

/** At most this many rows go into a drawn table, as a table view would page the rest. */
const TABLE_ROWS = 50;
const NUMBER = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

/** How a column is drawn: along time, as a category, or as a measure. */
function roleOf(column: Column, index: number, rows: readonly Cell[][]): "temporal" | "nominal" | "quantitative" {
  if (column.type === "temporal") return "temporal";
  if (column.type?.startsWith("q")) return "quantitative";
  if (column.type === null && rows.every((row) => row[index] === null || typeof row[index] === "number")) return "quantitative";
  return "nominal";
}

/**
 * The result in long form, one datum per row and measure: __x the axis the marks sit
 * along (the time column, else the first category), __series what tells them apart
 * (a second category, or the measure when there are several), __value the measure.
 */
function longForm(result: Result) {
  const roles = result.columns.map((column, i) => ({ column, i, role: roleOf(column, i, result.rows) }));
  const x = roles.find((r) => r.role === "temporal") ?? roles.find((r) => r.role === "nominal") ?? null;
  const measures = roles.filter((r) => r.role === "quantitative");
  const category = roles.find((r) => r.role === "nominal" && r !== x) ?? null;
  const byMeasure = measures.length > 1;
  const series = byMeasure ? "measure" : category ? humanise(category.column.name) : null;
  const values: Datum[] = result.rows.flatMap((row) =>
    (byMeasure ? measures : measures.slice(0, 1)).map((m): Datum => {
      const datum: Datum = { __x: x ? (row[x.i] ?? null) : "", __value: row[m.i] ?? null };
      if (byMeasure) datum.__series = humanise(m.column.name);
      else if (category) datum.__series = row[category.i] ?? null;
      return datum;
    }),
  );
  const firstOfMonth = x?.role === "temporal" && values.every((d) => typeof d.__x === "string" && /^\d{4}-\d{2}-01/.test(d.__x));
  return {
    values,
    hasMeasure: measures.length > 0,
    x: x && { title: humanise(x.column.name), temporal: x.role === "temporal", format: firstOfMonth ? "%b %Y" : "%d %b" },
    series,
    value: byMeasure ? "value" : humanise(measures[0]?.column.name ?? "value"),
  };
}

type Long = ReturnType<typeof longForm>;

/** The axis the marks sit along as bands: categories, or the periods in their order; labels upright. */
function band(long: Long, sort: string | null, axis: Encoding = {}): Encoding {
  const x = long.x;
  if (x?.temporal) {
    return { field: "__x", type: "ordinal", timeUnit: "yearmonthdate", title: x.title, axis: { format: x.format, labelAngle: 0, ...axis } };
  }
  return { field: "__x", type: "nominal", title: x?.title ?? null, axis: { labelAngle: 0, ...axis }, ...(sort ? { sort } : {}) };
}

/** The same axis as a continuous one where it is time (lines and areas), else as bands. */
function along(long: Long): Encoding {
  const x = long.x;
  return x?.temporal ? { field: "__x", type: "temporal", title: x.title, axis: { format: x.format } } : band(long, null);
}

const value = (long: Long, extra: Encoding = {}): Encoding => ({ field: "__value", type: "quantitative", title: long.value, ...extra });
const series = (long: Long): Encoding | null => (long.series ? { field: "__series", type: "nominal", title: long.series } : null);

function tooltip(long: Long): Encoding[] {
  const fields: Encoding[] = [];
  if (long.x) fields.push(long.x.temporal ? { field: "__x", type: "temporal", title: long.x.title } : { field: "__x", title: long.x.title });
  if (long.series) fields.push({ field: "__series", title: long.series });
  fields.push({ field: "__value", type: "quantitative", title: long.value, format: ",.4~g" });
  return fields;
}

/** Every column of the first rows as text, in the result's own order. */
function table(result: Result): VegaLiteSpec {
  const titles = result.columns.map((c) => humanise(c.name));
  const text = (cell: Cell): string =>
    cell === null ? "–" : typeof cell === "number" ? NUMBER.format(cell) : typeof cell === "string" ? cell.replace(/T00:00:00$/, "") : String(cell);
  const values: Datum[] = result.rows.slice(0, TABLE_ROWS).flatMap((row, r) =>
    titles.map((title, c): Datum => ({ __row: r, __column: title, __text: text(row[c] ?? null) })),
  );
  return {
    data: { values },
    height: { step: 24 },
    mark: { type: "text", align: "center", baseline: "middle" },
    encoding: {
      y: { field: "__row", type: "ordinal", axis: null },
      x: { field: "__column", type: "nominal", sort: titles, title: null, axis: { orient: "top", labelAngle: 0, domain: false, ticks: false } },
      text: { field: "__text", type: "nominal" },
    },
  };
}

/** The marks and encodings of one chart class over the long form; any class it does not know is drawn as columns. */
function chartOf(long: Long, chart: string): VegaLiteSpec {
  const colour = series(long);
  const tip = tooltip(long);
  const data = { values: long.values };
  switch (chart) {
    case "horizontal_bar":
    case "point": {
      const dots = chart === "point";
      return {
        data,
        height: { step: colour && !dots ? 14 : 26 },
        mark: dots ? { type: "point", filled: true, size: 90, opacity: 1 } : { type: "bar", cornerRadiusEnd: 4 },
        encoding: {
          y: band(long, "-x", { labelLimit: 220 }),
          x: value(long, dots ? { scale: { zero: false } } : {}),
          ...(colour ? { color: colour, ...(dots ? {} : { yOffset: { field: "__series" } }) } : {}),
          tooltip: tip,
        },
      };
    }
    case "line":
    case "area": {
      const area = chart === "area";
      return {
        data,
        mark: area ? { type: "area", line: true, opacity: 0.35 } : { type: "line", point: true, strokeWidth: 2 },
        encoding: {
          x: along(long),
          // Several measures are not parts of a whole: their areas overlap rather than stack.
          y: value(long, area ? { stack: long.series === "measure" ? null : "zero" } : { scale: { zero: false } }),
          ...(colour ? { color: colour } : {}),
          tooltip: tip,
        },
      };
    }
    case "heatmap": {
      // Every value written in its cell, light on the darker half of the ramp.
      const numbers = long.values.map((d) => d.__value).filter((v): v is number => typeof v === "number");
      const middle = numbers.length ? (Math.min(...numbers) + Math.max(...numbers)) / 2 : 0;
      return {
        data,
        height: { step: 34 },
        encoding: {
          x: band(long, null, { grid: false, domain: false, ticks: false }),
          ...(colour ? { y: { ...colour, axis: { grid: false, domain: false, ticks: false } } } : {}),
        },
        layer: [
          { mark: { type: "rect", cornerRadius: 3 }, encoding: { color: value(long, { legend: null }), tooltip: tip } },
          {
            mark: { type: "text", fontSize: 11 },
            encoding: {
              text: { field: "__value", type: "quantitative", format: ".3~s" },
              color: { condition: { test: `datum.__value > ${middle}`, value: "#FFFFFF" }, value: "#191C1F" },
            },
          },
        ],
      };
    }
    case "stacked_bar":
      return {
        data,
        mark: { type: "bar", cornerRadiusEnd: 3 },
        encoding: { x: band(long, "-y"), y: value(long), ...(colour ? { color: colour } : {}), tooltip: tip },
      };
    default: // bar, grouped_bar: columns, side by side when a series tells them apart
      return {
        data,
        mark: { type: "bar", cornerRadiusEnd: 4 },
        encoding: {
          x: band(long, "-y"),
          y: value(long),
          ...(colour ? { color: colour, xOffset: { field: "__series" } } : {}),
          tooltip: tip,
        },
      };
  }
}

type Title = { text?: unknown; subtitle?: unknown };

/** The chart in plain words for screen readers: its name, its title and its bases. */
function describe(label: string, theme: VegaLiteSpec | null): string {
  const title: Title | null = typeof theme?.title === "object" && theme.title !== null && !Array.isArray(theme.title) ? (theme.title as Title) : null;
  const text = title ? title.text : theme?.title;
  const said = Array.isArray(text) ? text.join(" ") : typeof text === "string" ? text : "";
  const bases = Array.isArray(title?.subtitle) ? title.subtitle.map(String) : typeof title?.subtitle === "string" ? [title.subtitle] : [];
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return `${name}${said ? `: ${said}` : ""}${bases.length ? `, ${bases.join(", ")}` : ""}`;
}

/**
 * A spec for `chart` over the result's rows, carrying the theme config (and the title)
 * of the chart the run did draw, `theme`; a table when the result has no measure to draw.
 * Its description says it in plain words, with `label` as the chart's name; the drawn
 * chart's rule ids stay behind, since no rule drew this one.
 */
export function drawnByMock(result: Result, chart: string, theme: VegaLiteSpec | null, label: string = humanise(chart)): VegaLiteSpec {
  const long = longForm(result);
  const body = chart === "table" || !long.hasMeasure ? table(result) : chartOf(long, chart);
  const { rules: _rules, ...usermeta } =
    typeof theme?.usermeta === "object" && theme.usermeta !== null ? (theme.usermeta as Record<string, unknown>) : {};
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: describe(label, theme),
    ...(theme?.title === undefined ? {} : { title: theme.title }),
    ...body,
    usermeta: { ...usermeta, drawn_by: "mock" },
    ...(theme?.config === undefined ? {} : { config: theme.config }),
  };
}
