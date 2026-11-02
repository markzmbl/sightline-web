// The analysis showcase: what the core's analysis (plan, analyse, gather) will add to
// an answer, made up from a real run's own rows until the core makes it. The export
// (scripts/export-fixtures.mjs) writes it into each complete fixture under `analysis`,
// marked synthetic; the mock serves it unless MOCK_ANALYSIS=0. Every number in the words
// is computed from the run's rows, every small chart drawn from them, every step's SQL is
// the run's own or wraps it; the wording and the follow-ups are the mock's.
import type { Cell, ChartView, Column, KeyPoint, StepRole, StepVerdict, Support, SupportDrawn, SupportRole } from "../src/api/types.ts";
import type { Fixture, FixtureAnalysis, FixtureFollowUp, FixtureStage, FixtureStep, VegaLiteSpec } from "./fixture.ts";

export const ABOUT =
  "Synthetic: made up by mock/showcase.ts from the run's own rows, to show what the core's analysis " +
  "(plan, analyse, gather) will add to the answer; the core does not make it yet.";

/** A small chart's height, and the width below which it needs a row of its own. */
const SMALL_HEIGHT = 160;
const MIN_WIDTH = 260;
const PRIMARY = "#1227FD";
const NEGATIVE = "#E23B4A";

// --- words and numbers ----------------------------------------------------------------------

const format = (digits: number) => new Intl.NumberFormat("en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fixed = (value: number, digits = 1): string => format(digits).format(value);
const pct = (value: number): string => `${fixed(value, 1)}%`;
const points = (value: number): string => `${fixed(value, 1)} points`;
const kwh = (value: number): string => `${format(0).format(value)} kWh`;
const euro = (value: number): string =>
  value >= 1e6 ? `€${fixed(value / 1e6, 2)}m` : value >= 1e3 ? `€${format(0).format(value / 1e3)}k` : `€${fixed(value, 2)}`;
const COUNTS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number): string => COUNTS[n] ?? String(n);
const Count = (n: number): string => {
  const word = count(n);
  return word.charAt(0).toUpperCase() + word.slice(1);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** "2025-08-01T00:00:00" as "August"; with the day, "3 Nov". */
const monthName = (iso: string): string => MONTH_NAMES[Number(iso.slice(5, 7)) - 1] ?? iso.slice(0, 7);
const day = (iso: string): string => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""}`;

const num = (cell: Cell | undefined): number => (typeof cell === "number" ? cell : Number(cell ?? 0));
const str = (cell: Cell | undefined): string => String(cell ?? "");
const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
const round = (value: number, digits = 6): number => Number(value.toFixed(digits));

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`showcase: no ${what}`);
  return value;
}

// --- the parts ---------------------------------------------------------------------------------

interface Context {
  slug: string;
  sql: string;
  columns: Column[];
  rows: Cell[][];
  /** The main chart's theme config, which every small chart carries. */
  config: unknown;
}

interface Parts {
  top: string;
  key_line: string[];
  supports: Omit<Support, "id">[];
  notes: string[];
  steps: Omit<FixtureStep, "id" | "stage" | "truncated">[];
  follow_ups: Omit<FixtureFollowUp, "id">[];
}

const column = (ctx: Context, name: string): Column => need(ctx.columns.find((c) => c.name === name), `column ${name}`);

/** The SQL of a step that reads the answer's own rows again. */
const over = (ctx: Context, select: string, tail = ""): string =>
  `SELECT ${select}\nFROM (\n  ${ctx.sql.replace(/\n/g, "\n  ")}\n) AS "answer"${tail}`;

function answerStep(ctx: Context, label: string): Parts["steps"][number] {
  return {
    label,
    role: "answer",
    ms: 140,
    verdict: null,
    // The query stage ran it; the analysis reads its rows from the cache.
    cached: true,
    sql: ctx.sql,
    columns: ctx.columns,
    rows: ctx.rows,
    row_count: ctx.rows.length,
  };
}

function step(
  label: string,
  role: StepRole,
  ms: number,
  verdict: StepVerdict | null,
  query: { sql: string; columns: Column[]; rows: Cell[][]; cached?: boolean } | null,
): Parts["steps"][number] {
  return {
    label,
    role,
    ms,
    verdict,
    cached: query?.cached ?? false,
    sql: query?.sql ?? null,
    columns: query?.columns ?? [],
    rows: query?.rows ?? [],
    row_count: query ? query.rows.length : null,
  };
}

function support(
  role: SupportRole,
  point: number | null,
  drawn: SupportDrawn,
  text: string,
  extra: { chart?: ChartView; layer?: string; note?: string } = {},
): Omit<Support, "id"> {
  return {
    role,
    point: point === null ? null : `k${point}`,
    text,
    drawn,
    chart: drawn === "small" ? need(extra.chart, "small chart") : null,
    layer: drawn === "main" ? (extra.layer ?? "answer") : null,
    note: drawn === "dropped" ? need(extra.note, "note") : null,
  };
}

// --- small charts ------------------------------------------------------------------------------

interface SmallBody {
  description: string;
  values: Record<string, Cell>[];
  mark: Record<string, unknown>;
  encoding: Record<string, unknown>;
}

/** A support's small chart: one view, no top-level width, a small height, no title or subtitle. */
function small(ctx: Context, chart: string, label: string, body: SmallBody): ChartView {
  const spec: VegaLiteSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: body.description,
    data: { values: body.values },
    height: SMALL_HEIGHT,
    mark: body.mark,
    encoding: body.encoding,
    usermeta: { theme: "pattern-perspectives", drawn_by: "mock", synthetic: true },
    ...(ctx.config === undefined ? {} : { config: ctx.config }),
  };
  return { chart, label, title: null, subtitle: [], hint: null, score: null, spec, png_url: null, min_width: MIN_WIDTH, options: [] };
}

/** Horizontal bars, one per member, longest first; signed ones coloured by their sign. */
function ranked(
  ctx: Context,
  description: string,
  values: { member: string; value: number }[],
  axis: { title: string; format: string; signed?: boolean },
): ChartView {
  return small(ctx, "horizontal_bar", "ranked bars", {
    description,
    values: values.map((v) => ({ member: v.member, value: round(v.value) })),
    mark: { type: "bar", cornerRadiusEnd: 3 },
    encoding: {
      y: { field: "member", type: "nominal", sort: "-x", title: null, axis: { labelLimit: 160 } },
      x: { field: "value", type: "quantitative", title: axis.title, axis: { format: axis.format, tickCount: 4 } },
      color: axis.signed
        ? { condition: { test: "datum.value < 0", value: NEGATIVE }, value: PRIMARY }
        : { value: PRIMARY },
      tooltip: [
        { field: "member", title: "" },
        { field: "value", type: "quantitative", title: axis.title, format: axis.format },
      ],
    },
  });
}

/** Columns for a few labelled parts, in their order. */
function columns(
  ctx: Context,
  description: string,
  values: { part: string; value: number }[],
  axis: { title: string; format: string; signed?: boolean },
): ChartView {
  return small(ctx, "bar", "columns", {
    description,
    values: values.map((v) => ({ part: v.part, value: round(v.value) })),
    mark: { type: "bar", cornerRadiusEnd: 3 },
    encoding: {
      x: { field: "part", type: "ordinal", sort: null, title: null, axis: { labelAngle: 0 } },
      y: { field: "value", type: "quantitative", title: axis.title, axis: { format: axis.format, tickCount: 4 } },
      color: axis.signed
        ? { condition: { test: "datum.value < 0", value: NEGATIVE }, value: PRIMARY }
        : { value: PRIMARY },
      tooltip: [
        { field: "part", title: "" },
        { field: "value", type: "quantitative", title: axis.title, format: axis.format },
      ],
    },
  });
}

/** One measure over time on its own scale, as a sparkline. */
function sparkline(ctx: Context, description: string, values: { at: string; value: number }[], axis: { title: string; format: string }): ChartView {
  return small(ctx, "line", "lines", {
    description,
    values: values.map((v) => ({ at: v.at, value: round(v.value) })),
    mark: { type: "line", point: { filled: true, size: 28 }, strokeWidth: 2, color: PRIMARY },
    encoding: {
      x: { field: "at", type: "temporal", title: null, axis: { format: "%d %b", tickCount: 4, grid: false } },
      y: { field: "value", type: "quantitative", title: axis.title, scale: { zero: false }, axis: { format: axis.format, tickCount: 3 } },
      tooltip: [
        { field: "at", type: "temporal", title: "week of", format: "%d %b %Y" },
        { field: "value", type: "quantitative", title: axis.title, format: axis.format },
      ],
    },
  });
}

// --- the fixtures ----------------------------------------------------------------------------

/** Members and their values, highest first, from a result of one category and one measure. */
function members(ctx: Context): { name: string; value: number }[] {
  return ctx.rows.map((row) => ({ name: str(row[0]), value: num(row[1]) })).sort((a, b) => b.value - a.value);
}

/** The average over the members, and the members drawn against it. */
function againstAverage(ctx: Context, measure: string, plural: string) {
  const all = members(ctx);
  const average = mean(all.map((m) => m.value));
  const avgStep = step(`the average over all ${plural}`, "comparison", 1900, "as_expected", {
    sql: over(ctx, `AVG("${measure}") AS "${measure}"`),
    columns: [column(ctx, measure)],
    rows: [[round(average)]],
  });
  const leadStep = step("the lead over the runner-up", "check", 1600, "as_expected", {
    sql: over(ctx, `*`, `\nORDER BY "${measure}" DESC\nLIMIT 2`),
    columns: ctx.columns,
    rows: ctx.rows.slice(0, 2),
  });
  return { all, average, avgStep, leadStep };
}

const RECIPES: Record<string, (ctx: Context) => Parts> = {
  "oee-line": (ctx) => {
    const { all, average, avgStep, leadStep } = againstAverage(ctx, "oee", "lines");
    const first = need(all[0], "leader");
    const second = need(all[1], "runner-up");
    const last = need(all.at(-1), "last line");
    const near = all.filter((m) => Math.abs(m.value - average) <= 2.5).length;
    const above = all.filter((m) => m.value > average).length;
    return {
      top: `${first.name} led the lines on OEE last week, at ${pct(first.value)}`,
      key_line: [
        `${first.name} reached ${pct(first.value)}, ${points(first.value - second.value)} ahead of ${second.name}`,
        `${last.name} came last at ${pct(last.value)}, ${points(first.value - last.value)} behind the leader`,
        `${Count(near)} of the ${count(all.length)} lines sat within 2.5 points of the average of ${pct(average)}`,
      ],
      supports: [
        support("answer", 1, "main", "The OEE of each line last week, highest first"),
        support("comparison", 3, "small", `Each line against the average of ${pct(average)}, in points`, {
          chart: ranked(
            ctx,
            "Bars: each line's OEE last week minus the average over the lines, in points; above the average to the right",
            all.map((m) => ({ member: m.name, value: m.value - average })),
            { title: "points from the average", format: "+.1f", signed: true },
          ),
        }),
        support("context", null, "none", `${Count(above)} lines were above the average and ${count(all.length - above)} below it`),
      ],
      notes: [
        `The average of ${pct(average)} is the plain mean of the ${count(all.length)} lines, not weighted by their planned busy time`,
        // A data edge: what "last week" could mean in this warehouse.
        "The warehouse holds no full week after 28 Dec 2025, so last week is the week before it",
      ],
      steps: [answerStep(ctx, "OEE per line last week"), avgStep, leadStep],
      follow_ups: [
        {
          kind: "breakdown",
          question: "How did availability, effectiveness and quality ratio develop per week in Q4 2025?",
          fixture: "aeq-weekly",
        },
        { kind: "next_level", question: `What was the OEE of each machine on ${first.name} last week?`, fixture: null },
      ],
    };
  },

  energy: (ctx) => {
    const measure = "energy_per_thousand_good_units";
    const { all, average, avgStep, leadStep } = againstAverage(ctx, measure, "lines");
    const first = need(all[0], "leader");
    const second = need(all[1], "runner-up");
    const last = need(all.at(-1), "last line");
    const nextToLast = need(all.at(-2), "next to last line");
    const below = all.filter((m) => m.value < average).length;
    return {
      top: `${first.name} used the most energy per 1,000 good units, ${kwh(first.value)}`,
      key_line: [
        `${first.name} used ${kwh(first.value)} per 1,000 good units, ${fixed(first.value / second.value, 1)} times ${second.name}`,
        `${nextToLast.name} and ${last.name} used the least, ${kwh(nextToLast.value)} and ${kwh(last.value)}`,
        `${Count(below)} of the ${count(all.length)} lines used less than the average of ${kwh(average)}`,
      ],
      supports: [
        support("answer", 1, "main", "kWh per 1,000 good units for each line, highest first"),
        support("comparison", 3, "small", `Each line against the average of ${kwh(average)}`, {
          chart: ranked(
            ctx,
            "Bars: each line's kWh per 1,000 good units minus the average over the lines; above the average to the right",
            all.map((m) => ({ member: m.name, value: m.value - average })),
            { title: "kWh from the average", format: "+,.0f", signed: true },
          ),
        }),
        support(
          "context",
          null,
          "none",
          `${first.name} used ${fixed(first.value / last.value, 0)} times as much energy per good unit as ${last.name}`,
        ),
      ],
      notes: [`The average of ${kwh(average)} is the plain mean of the ${count(all.length)} lines, not weighted by their output`],
      steps: [answerStep(ctx, "kWh per 1,000 good units per line"), avgStep, leadStep],
      follow_ups: [
        { kind: "check", question: "What was the OEE of each line last week?", fixture: "oee-line" },
        { kind: "next_level", question: `Which machines on ${first.name} use the most energy per 1,000 good units?`, fixture: null },
      ],
    };
  },

  scrap: (ctx) => {
    const measure = "actual_to_planned_scrap";
    const all = members(ctx);
    const first = need(all[0], "leader");
    const second = need(all[1], "runner-up");
    const last = need(all.at(-1), "tenth order");
    return {
      top: `${first.name} had the most scrap against plan in 2025, ${fixed(first.value, 1)} times its allowance`,
      key_line: [
        `${first.name} scrapped ${fixed(first.value, 1)} times the scrap it allowed, ${fixed(first.value - second.value, 1)} more than ${second.name}`,
        `All ${count(all.length)} orders scrapped at least ${fixed(last.value, 1)} times their allowance`,
      ],
      supports: [
        support("answer", 1, "main", `The ${count(all.length)} orders with the most scrap against plan`),
        support("reference", 2, "small", "How far each order went over its allowance, in multiples of it", {
          chart: ranked(
            ctx,
            "Bars: each order's scrap against plan minus 1, the plan; every order is above it",
            all.map((m) => ({ member: m.name, value: m.value - 1 })),
            { title: "times over the allowance", format: "+.1f" },
          ),
        }),
        support(
          "context",
          null,
          "none",
          `On average the ${count(all.length)} orders scrapped ${fixed(mean(all.map((m) => m.value)), 1)} times their allowance`,
        ),
      ],
      notes: ["Whether these orders allowed unusually little scrap was not settled: a small allowance alone makes the ratio large"],
      steps: [
        answerStep(ctx, "scrap against plan per order"),
        step("the spread of the top ten", "comparison", 1400, "as_expected", {
          sql: over(ctx, `MIN("${measure}") AS "lowest", MAX("${measure}") AS "highest"`),
          columns: [
            { ...column(ctx, measure), name: "lowest", label: "lowest" },
            { ...column(ctx, measure), name: "highest", label: "highest" },
          ],
          rows: [[round(last.value), round(first.value)]],
        }),
        step("a small allowance behind the ratio", "denominator", 2100, "inconclusive", null),
      ],
      follow_ups: [
        {
          kind: "breakdown",
          question: "How did availability, effectiveness and quality ratio develop per week in Q4 2025?",
          fixture: "aeq-weekly",
        },
        { kind: "next_level", question: "Which products had the most scrap against plan in 2025?", fixture: null },
      ],
    };
  },

  "aeq-weekly": (ctx) => {
    const weeks = ctx.rows.map((row) => ({
      at: str(row[0]),
      availability: num(row[1]),
      quality: num(row[2]),
      effectiveness: num(row[3]),
    }));
    const cut = "2025-11-03";
    const before = weeks.filter((w) => w.at < cut);
    const after = weeks.filter((w) => w.at >= cut);
    const was = mean(before.map((w) => w.availability));
    const is = mean(after.map((w) => w.availability));
    const span = (values: number[]) => ({ low: Math.min(...values), high: Math.max(...values) });
    const quality = span(weeks.map((w) => w.quality));
    const effectiveness = span(weeks.map((w) => w.effectiveness));
    const lastBefore = need(before.at(-1), "week before the rise");
    return {
      top: `Availability rose ${points(is - was)} from November, while quality ratio and effectiveness held steady`,
      key_line: [
        `Availability averaged ${pct(was)} in the ${count(before.length)} weeks to ${day(lastBefore.at)} and ${pct(is)} in the ${count(after.length)} weeks after`,
        `Quality ratio stayed between ${pct(quality.low)} and ${pct(quality.high)} every week`,
        `Effectiveness stayed between ${pct(effectiveness.low)} and ${pct(effectiveness.high)} every week`,
      ],
      supports: [
        support("answer", 1, "main", "Availability, quality ratio and effectiveness per week"),
        support("comparison", 1, "small", `Availability alone, on its own scale: the step up comes in the week of ${day(cut)}`, {
          chart: sparkline(
            ctx,
            "Line: availability per week on its own scale, Q4 2025",
            weeks.map((w) => ({ at: w.at, value: w.availability })),
            { title: "availability (%)", format: ".0f" },
          ),
        }),
        support("routine_band", 2, "small", `Quality ratio on its own scale: it never left a band of ${points(quality.high - quality.low)}`, {
          chart: sparkline(
            ctx,
            "Line: quality ratio per week on its own scale, Q4 2025",
            weeks.map((w) => ({ at: w.at, value: w.quality })),
            { title: "quality ratio (%)", format: ".1f" },
          ),
        }),
        support("context", 3, "none", `Effectiveness moved less than ${effectiveness.high - effectiveness.low < 1 ? "a point" : "two points"} over the quarter`),
      ],
      notes: ["Where the rise in availability came from was not broken down by line or plant"],
      steps: [
        answerStep(ctx, "the three ratios per week"),
        step(`availability before and after ${day(cut)}`, "comparison", 2300, "as_expected", {
          sql: over(
            ctx,
            `CASE WHEN "week" < CAST('${cut}' AS DATE) THEN 'before' ELSE 'after' END AS "period", AVG("availability") AS "availability"`,
            `\nGROUP BY 1\nORDER BY MIN("week")`,
          ),
          columns: [
            { name: "period", label: "period", type: "nominal", role: "dimension", unit: null, format: null, description: null },
            column(ctx, "availability"),
          ],
          rows: [
            ["before", round(was)],
            ["after", round(is)],
          ],
        }),
        step("the routine band of quality ratio", "check", 1700, "routine", {
          sql: over(ctx, `MIN("quality_ratio") AS "lowest", MAX("quality_ratio") AS "highest"`),
          columns: [
            { ...column(ctx, "quality_ratio"), name: "lowest", label: "lowest" },
            { ...column(ctx, "quality_ratio"), name: "highest", label: "highest" },
          ],
          rows: [[round(quality.low), round(quality.high)]],
          cached: true,
        }),
      ],
      follow_ups: [
        { kind: "next_level", question: "What was the OEE of each line last week?", fixture: "oee-line" },
        { kind: "check", question: "Which production orders had the most scrap against plan in 2025?", fixture: "scrap" },
      ],
    };
  },

  "delivery-monthly": (ctx) => {
    const months = ctx.rows.map((row) => ({ at: str(row[0]), value: num(row[1]) }));
    const peak = need([...months].sort((a, b) => b.value - a.value)[0], "peak");
    const low = need([...months].sort((a, b) => a.value - b.value)[0], "low");
    const first = mean(months.slice(0, 6).map((m) => m.value));
    const second = mean(months.slice(6).map((m) => m.value));
    const changes = months.slice(1).map((m, i) => ({ part: MONTHS[Number(m.at.slice(5, 7)) - 1] ?? m.at, value: m.value - (months[i]?.value ?? 0) }));
    const rises = changes.filter((c) => c.value > 0).length;
    return {
      // The core's own title already states the effect: it is the top.
      top: "",
      key_line: [
        `Revenue peaked in ${monthName(peak.at)} at ${euro(peak.value)}`,
        `The second half averaged ${euro(second)} a month, against ${euro(first)} in the first`,
        `${monthName(low.at)} was the low point at ${euro(low.value)}`,
      ],
      supports: [
        support("answer", 1, "main", "Delivery revenue per month in 2025"),
        support("comparison", 2, "small", "The average month of each half of 2025", {
          chart: columns(
            ctx,
            "Columns: the average monthly delivery revenue of the first and of the second half of 2025",
            [
              { part: "Jan–Jun", value: first },
              { part: "Jul–Dec", value: second },
            ],
            { title: "revenue per month (EUR)", format: "~s" },
          ),
        }),
        support("decomposition", 3, "small", "Each month against the one before", {
          chart: columns(
            ctx,
            "Columns: each month's delivery revenue minus the month before's; falls in red",
            changes,
            { title: "change (EUR)", format: "+~s", signed: true },
          ),
        }),
        support("context", null, "none", `Revenue rose from one month to the next ${count(rises)} times out of ${count(changes.length)}`),
      ],
      notes: ["Line revenue is net of discounts; tips and service charges are not in it"],
      steps: [
        answerStep(ctx, "delivery revenue per month"),
        step("the first half against the second", "comparison", 2000, "as_expected", {
          sql: over(
            ctx,
            `CASE WHEN "month" < CAST('2025-07-01' AS DATE) THEN 'Jan–Jun' ELSE 'Jul–Dec' END AS "half", AVG("line_revenue") AS "line_revenue"`,
            `\nGROUP BY 1\nORDER BY 1`,
          ),
          columns: [
            { name: "half", label: "half", type: "ordinal", role: "dimension", unit: null, format: null, description: null },
            column(ctx, "line_revenue"),
          ],
          rows: [
            ["Jan–Jun", round(first)],
            ["Jul–Dec", round(second)],
          ],
        }),
        step("a month left incomplete", "check", 900, "as_expected", null),
      ],
      follow_ups: [
        { kind: "breakdown", question: "What was the revenue by city and channel?", fixture: "city-channel" },
        { kind: "next_level", question: "How did delivery revenue develop per week over the last 90 days?", fixture: null },
      ],
    };
  },

  tips: (ctx) => {
    const all = members(ctx);
    const card = need(all.find((m) => m.name === "card"), "card");
    const total = all.reduce((sum, m) => sum + m.value, 0);
    return {
      top: `Card payments averaged ${euro(card.value)} in tips per payment`,
      // The check on cash limited the claim to card: that is a note, so the key line says
      // nothing of cash and is one point long.
      key_line: ["Card payments carry every tip the data records"],
      supports: [
        support("answer", 1, "main", "The average tip per payment, by payment method"),
        support("whole", 1, "small", "Each method's share of the recorded tips: card holds all of them", {
          chart: columns(
            ctx,
            "Columns: the share of the recorded tips by payment method",
            all.map((m) => ({ part: m.name, value: total > 0 ? m.value / total : 0 })),
            { title: "share of the recorded tips", format: ".0%" },
          ),
        }),
        support("exception", null, "dropped", "Cash tips over the year", {
          note: "A chart of cash tips would show only zeros: they are not recorded",
        }),
        support("context", null, "none", `Every 100 card payments brought ${euro(card.value * 100)} in tips`),
      ],
      notes: [
        "Cash tips are not recorded, so cash shows €0.00 whatever guests tipped; the comparison with card says nothing about cash guests",
        "The average is over payments, not bills: a split bill counts once for each of its payments",
      ],
      steps: [
        answerStep(ctx, "the average tip per payment method"),
        step("cash tips in the data", "check", 1500, "contradicts", {
          sql: `SELECT MAX("f"."tip_amount") AS "tip_amount"\nFROM "fact_payments" AS "f"\nWHERE "f"."payment_method" = 'cash'`,
          columns: [column(ctx, "tip_amount")],
          rows: [[0]],
        }),
        step("the contract on tip_amount", "lookup", 600, "as_expected", null),
      ],
      follow_ups: [
        { kind: "breakdown", question: "How did the average card tip develop per month in 2025?", fixture: null },
        { kind: "next_level", question: "What is the average card tip per branch?", fixture: null },
      ],
    };
  },

  "city-channel": (ctx) => {
    const rows = ctx.rows.map((row) => ({ city: str(row[0]), channel: str(row[1]), value: num(row[2]) }));
    const sum = (pick: (r: (typeof rows)[number]) => string) => {
      const totals = new Map<string, number>();
      for (const row of rows) totals.set(pick(row), (totals.get(pick(row)) ?? 0) + row.value);
      return [...totals.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    };
    const cities = sum((r) => r.city);
    const channels = sum((r) => r.channel);
    const all = cities.reduce((s, c) => s + c.value, 0);
    const topCity = need(cities[0], "top city");
    const lastCity = need(cities.at(-1), "last city");
    const topChannel = need(channels[0], "top channel");
    const words = (channel: string) => channel.replace("_", "-");
    const leadsEveryChannel = channels.every((ch) => {
      const best = rows.filter((r) => r.channel === ch.name).sort((a, b) => b.value - a.value)[0];
      return best?.city === topCity.name;
    });
    const channelLeadsEveryCity = cities.every((c) => {
      const best = rows.filter((r) => r.city === c.name).sort((a, b) => b.value - a.value)[0];
      return best?.channel === topChannel.name;
    });
    const shares = cities.map((c) => (rows.find((r) => r.city === c.name && r.channel === topChannel.name)?.value ?? 0) / c.value);
    const top =
      leadsEveryChannel && channelLeadsEveryCity
        ? `${topCity.name} made the most revenue in every channel, and ${words(topChannel.name)} led in every city`
        : `${topCity.name} made the most revenue, ${euro(topCity.value)}`;
    const SQL_SHARE = `SUM("line_revenue") / SUM(SUM("line_revenue")) OVER () AS "share"`;
    return {
      top,
      key_line: [
        `${topCity.name} made ${euro(topCity.value)}, the most of the ${count(cities.length)} cities`,
        `${words(topChannel.name).replace(/^./, (c) => c.toUpperCase())} brought ${euro(topChannel.value)}, ${fixed((topChannel.value / all) * 100, 0)}% of all revenue`,
        `${lastCity.name} made the least, ${euro(lastCity.value)}`,
      ],
      supports: [
        support("answer", 1, "main", "Line revenue by city and channel"),
        support("whole", 2, "small", "Each channel's share of all revenue", {
          chart: columns(
            ctx,
            "Columns: each sales channel's share of all line revenue",
            channels.map((c) => ({ part: words(c.name), value: c.value / all })),
            { title: "share of revenue", format: ".0%" },
          ),
        }),
        support("decomposition", 3, "small", "Revenue per city, all channels together", {
          chart: ranked(
            ctx,
            "Bars: each city's line revenue over all channels, highest first",
            cities.map((c) => ({ member: c.name, value: c.value })),
            { title: "revenue (EUR)", format: "~s" },
          ),
        }),
        support(
          "context",
          null,
          "none",
          `${words(topChannel.name).replace(/^./, (c) => c.toUpperCase())}'s share ranges only from ${pct(Math.min(...shares) * 100)} to ${pct(Math.max(...shares) * 100)} across the cities`,
        ),
      ],
      notes: ["The cities are compared as they stand, without regard to how many branches each has"],
      steps: [
        answerStep(ctx, "revenue per city and channel"),
        step("revenue per channel", "decomposition", 1800, "as_expected", {
          sql: over(ctx, `"channel_name", SUM("line_revenue") AS "line_revenue", ${SQL_SHARE}`, `\nGROUP BY "channel_name"\nORDER BY 2 DESC`),
          columns: [
            column(ctx, "channel_name"),
            column(ctx, "line_revenue"),
            { name: "share", label: "share", type: "q_ratio", role: "measure", unit: "%", format: ".1%", description: null },
          ],
          rows: channels.map((c) => [c.name, round(c.value, 2), round(c.value / all)]),
        }),
        step("revenue per city", "decomposition", 1700, "as_expected", {
          sql: over(ctx, `"city", SUM("line_revenue") AS "line_revenue"`, `\nGROUP BY "city"\nORDER BY 2 DESC`),
          columns: [column(ctx, "city"), column(ctx, "line_revenue")],
          rows: cities.map((c) => [c.name, round(c.value, 2)]),
        }),
        step("the channel mix per city", "check", 1300, "routine", null),
      ],
      follow_ups: [
        { kind: "next_level", question: "How did delivery revenue develop per month over the last year?", fixture: "delivery-monthly" },
        { kind: "breakdown", question: "How much delivery revenue did each city make per month in 2025?", fixture: null },
      ],
    };
  },
};

/** How long the analysis' stages take around its steps. */
const PLAN_MS = 2600;
const GATHER_MS = 1900;
const ANALYSE_OVERHEAD_MS = 80;

/**
 * The made-up analysis of a complete fixture as exported (its result, chart and theme in
 * place), or null for a fixture without a recipe or without a result.
 */
export function showcase(fixture: Fixture): FixtureAnalysis | null {
  const recipe = RECIPES[fixture.slug];
  const result = fixture.result;
  if (!recipe || !result || fixture.final_status !== "complete") return null;
  const spec = result.chart?.spec;
  const ctx: Context = { slug: fixture.slug, sql: result.sql ?? "", columns: result.columns, rows: result.rows, config: spec?.config };
  const parts = recipe(ctx);

  const key_line: KeyPoint[] = parts.key_line.map((text, i) => ({ id: `k${i + 1}`, text }));
  const supports: Support[] = parts.supports.map((s, i) => ({ id: `sp${i + 1}`, ...s }));
  const lead = need(supports.find((s) => s.drawn === "main"), "lead").id;
  const steps: FixtureStep[] = parts.steps.map((s, i) => ({ id: `st${i + 1}`, stage: "analyse", truncated: false, ...s }));
  const stages: FixtureStage[] = [
    { phase: "understand", stage: "plan", ms: PLAN_MS },
    { phase: "analyse", stage: "analyse", ms: steps.reduce((sum, s) => sum + s.ms, ANALYSE_OVERHEAD_MS) },
    { phase: "analyse", stage: "gather", ms: GATHER_MS },
  ];
  // Without a top of its own, the main chart's title (already a governing thought) is it.
  const title = result.chart?.title ?? "";
  return {
    synthetic: true,
    about: ABOUT,
    stages,
    storyline: { top: parts.top || title, key_line },
    lead,
    supports,
    notes: parts.notes,
    steps,
    follow_ups: parts.follow_ups.map((f, i) => ({ id: `fu${i + 1}`, ...f })),
  };
}
