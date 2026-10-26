// Exports real sightline runs into the mock backend's fixtures:
//   ../runs/<workspace>/<run id>/  ->  mock/fixtures/<workspace>/<slug>.json
// The runs folder can be moved with SIGHTLINE_RUNS. The output conforms to the
// Fixture type in mock/fixture.ts; the mock server replays it as a live run.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = resolve(process.env.SIGHTLINE_RUNS ?? join(root, "../runs"));
const outDir = join(root, "mock/fixtures");

/** [workspace, slug, run dir, continuation slug] */
const FIXTURES = [
  ["manufacturing", "oee-line", "manufacturing/20261024T190840-c39a9a", null],
  ["manufacturing", "aeq-weekly", "manufacturing/20261024T190841-5ce1ff", null],
  ["manufacturing", "energy", "manufacturing/20261024T145631-c23ab8", null],
  ["manufacturing", "scrap", "manufacturing/20261024T145631-739d23", null],
  ["manufacturing", "aeq-clarify", "manufacturing/20261024T190843-6c1a27", null],
  // The data-gap ending: gross profit margin is not possible yet (no cost of goods sold).
  ["restaurant", "margin-gap", "restaurant/20261024T190005-95ae29", null],
  ["restaurant", "revenue-ask", "restaurant/20260928T142453-1dbee9", "delivery-monthly"],
  ["restaurant", "delivery-monthly", "restaurant/20261024T145625-98d72b", null],
  ["restaurant", "tips", "restaurant/20261024T145707-cde58a", null],
  ["restaurant", "city-channel", "restaurant/20261024T145628-c54538", null],
];

// The core owns this map; the mock hardcodes it until the backend sends phases itself.
const PHASES = {
  understand: ["situate", "recall", "define", "ground", "abstract", "bind", "clarify"],
  analyse: ["enrich", "derive", "query"],
  present: ["idiom", "render", "perceive", "validate"],
};
const phaseOf = (stage) => Object.keys(PHASES).find((p) => PHASES[p].includes(stage)) ?? "understand";

const MAX_ROWS = 200;
const MIN_STAGE_MS = 5;
const STATUSES = ["complete", "clarify", "asking"];

const readJson = (dir, name) => {
  const path = join(dir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};
const mtime = (dir, name) => {
  const path = join(dir, name);
  return existsSync(path) ? statSync(path).mtimeMs : null;
};
const humanise = (id) => id.replace(/[_.-]+/g, " ").trim();
const orNull = (value) => (value === undefined || value === "" ? null : value);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const DECIDED_BY = ["rules", "s1", "s2", "user"];

/** Per stage, the time since the previous stage's file was written. */
function stageTimings(dir, stages) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let previous = mtime(dir, "answers.json") ?? Math.min(...files.map((f) => mtime(dir, f)));
  return stages.map((stage) => {
    const at = mtime(dir, `${stage}.json`);
    const ms = at === null ? MIN_STAGE_MS : Math.max(MIN_STAGE_MS, Math.round(at - previous));
    if (at !== null) previous = at;
    return { phase: phaseOf(stage), stage, ms };
  });
}

/**
 * A core decision point as the contract's DecisionPoint: `by` is required (rules when the
 * core left it out), why and option hints are "" when empty, open and stage default to
 * false and "", and chosen, default and confidence are null when missing.
 */
function toPoint(p) {
  return {
    id: String(p.id),
    step: String(p.step ?? "meaning"),
    question: String(p.question ?? ""),
    options: (p.options ?? []).map((o) => ({ id: String(o.id), label: String(o.label ?? o.id), hint: String(o.hint ?? "") })),
    chosen: orNull(p.chosen) ?? null,
    default: orNull(p.default) ?? null,
    by: DECIDED_BY.includes(p.by) ? p.by : "rules",
    confidence: typeof p.confidence === "number" ? p.confidence : null,
    why: String(p.why ?? ""),
    open: p.open === true,
    stage: String(p.stage ?? ""),
  };
}

/**
 * The points beside a finished chart: every point nobody was sure of (open), then the
 * least sure others with a choice to make, up to two in all, in the core's order.
 */
function sideCard(abstract, idiom) {
  const points = [...(abstract?.points ?? []), ...(idiom?.points ?? [])].map((p, order) => ({ p, order }));
  const open = points.filter(({ p }) => p.open === true);
  const unsure = points
    .filter(({ p }) => p.open !== true && (p.options ?? []).length >= 2 && typeof p.confidence === "number" && p.confidence < 0.75)
    .sort((a, b) => a.p.confidence - b.p.confidence)
    .slice(0, Math.max(0, 2 - open.length));
  const picked = [...open, ...unsure].sort((a, b) => a.order - b.order);
  return picked.length ? { blocking: false, points: picked.map(({ p }) => toPoint(p)) } : null;
}

/**
 * The chart classes idiom offered, in the switcher's words: the label is the form point's
 * name for it (else the humanised class), the hint what it lets you read (the candidate's
 * `reads`, else the form option's hint, else null).
 */
function chartWords(idiom) {
  const form = (idiom?.points ?? []).find((p) => p.step === "form");
  const labels = new Map();
  for (const o of form?.options ?? []) labels.set(o.id, { label: String(o.label ?? humanise(o.id)), hint: orNull(o.hint) ?? null });
  const reads = new Map();
  for (const c of idiom?.candidates ?? []) if (c?.chart && typeof c.reads === "string" && c.reads) reads.set(c.chart, c.reads);
  return (chart) => {
    const named = labels.get(chart);
    return { chart, label: named?.label ?? humanise(chart), hint: reads.get(chart) ?? named?.hint ?? null };
  };
}

/** Every chart class idiom offered, in its order, with the label and hint the switcher shows. */
function chartOptions(render, idiom) {
  const word = chartWords(idiom);
  const charts = (idiom?.candidates ?? []).map((c) => c.chart).filter(Boolean);
  if (render?.chart) charts.unshift(render.chart);
  return [...new Set(charts)].map(word);
}

function chartView(render, options) {
  if (!render?.chart) return null;
  const own = options.find((o) => o.chart === render.chart);
  return {
    chart: render.chart,
    label: own?.label ?? humanise(render.chart),
    spec: render.spec ?? {},
    png_url: null,
    alternatives: options.filter((o) => o.chart !== render.chart),
  };
}

function renderings(dir, render) {
  const charts = {};
  if (render?.chart && render.spec) charts[render.chart] = render.spec;
  for (const file of readdirSync(dir)) {
    const match = /^render\.(.+)\.json$/.exec(file);
    if (!match) continue;
    const other = readJson(dir, file);
    charts[other?.chart ?? match[1]] = other?.spec ?? {};
  }
  return charts;
}

function result(dir, render, idiom, options) {
  const query = readJson(dir, "query.json");
  if (!query) return null;
  const derive = readJson(dir, "derive.json");
  // The analysis' findings in words: plan.findings[].text.
  const findings = (idiom?.plan?.findings ?? [])
    .map((f) => (typeof f === "string" ? f : f?.text))
    .filter((text) => typeof text === "string" && text.length > 0);
  const rows = query.rows ?? [];
  return {
    sql: derive?.sql ?? null,
    columns: (query.columns ?? []).map((c) => ({ name: String(c.name), type: c.attribute_type ?? null })),
    rows: rows.slice(0, MAX_ROWS),
    row_count: query.row_count ?? rows.length,
    truncated: Boolean(query.truncated) || rows.length > MAX_ROWS,
    chart: chartView(render, options),
    findings,
  };
}

/**
 * The core's ClarificationReport as the contract's Clarify: gaps are terms that matched
 * nothing; missing, record and nearest are the not-possible-yet ending. Missing lists are [].
 */
function toClarify(clarify) {
  return {
    gaps: (clarify?.gaps ?? []).map((g) => ({
      slot: String(g.slot),
      requested: String(g.requested ?? ""),
      reason: String(g.reason ?? ""),
      suggestions: strings(g.suggestions),
    })),
    missing: strings(clarify?.missing),
    record: strings(clarify?.record),
    nearest: strings(clarify?.nearest),
    warnings: strings(clarify?.warnings),
  };
}

function exportFixture([workspace, slug, runPath, continuation]) {
  const dir = join(runsDir, runPath);
  const meta = readJson(dir, "meta.json");
  if (!meta) throw new Error(`${runPath}: no meta.json in ${dir}`);
  const status = STATUSES.includes(meta.status) ? meta.status : "complete";
  const render = readJson(dir, "render.json");
  const idiom = readJson(dir, "idiom.json");
  const abstract = readJson(dir, "abstract.json");
  const ask = readJson(dir, "ask.json");
  const clarify = readJson(dir, "clarify.json");

  const options = status === "complete" ? chartOptions(render, idiom) : [];
  let card = null;
  if (status === "asking") card = { blocking: true, points: (ask?.points ?? abstract?.points ?? []).map(toPoint) };
  else if (status === "complete") card = sideCard(abstract, idiom);

  const fixture = {
    slug,
    workspace,
    question: String(meta.question ?? ""),
    final_status: status,
    continuation,
    stages: stageTimings(dir, meta.stages ?? []),
    restatement: readJson(dir, "validate.json")?.restatement ?? null,
    card,
    clarify: status === "clarify" ? toClarify(clarify) : null,
    result: status === "complete" ? result(dir, render, idiom, options) : null,
    charts: status === "complete" ? renderings(dir, render) : {},
    chart_options: options,
  };

  mkdirSync(join(outDir, workspace), { recursive: true });
  writeFileSync(join(outDir, workspace, `${slug}.json`), `${JSON.stringify(fixture, null, 2)}\n`);

  const total = fixture.stages.reduce((sum, s) => sum + s.ms, 0);
  const chart = fixture.result?.chart?.chart ?? "-";
  const points = fixture.card ? `${fixture.card.points.length} point(s)${fixture.card.blocking ? " blocking" : ""}` : "no card";
  const notYet = fixture.clarify?.missing.length ? `, not possible yet (${fixture.clarify.nearest.length} nearest)` : "";
  console.log(
    `${workspace}/${slug}: ${status}, ${fixture.stages.length} stages in ${(total / 1000).toFixed(1)} s, chart ${chart}` +
      ` (${Object.keys(fixture.charts).length} rendered), ${fixture.result?.rows.length ?? 0} rows, ${points}` +
      `${fixture.restatement ? ", restated" : ""}${notYet}${continuation ? `, continues as ${continuation}` : ""}`,
  );
}

if (!existsSync(runsDir)) throw new Error(`no runs folder at ${runsDir}; set SIGHTLINE_RUNS`);
for (const entry of FIXTURES) exportFixture(entry);
