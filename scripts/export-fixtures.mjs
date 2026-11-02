// Exports real sightline runs into the mock backend's fixtures, in contract v0.2.1's shapes:
//   ../runs/<workspace>/<run id>/  ->  mock/fixtures/<workspace>/<slug>.json
// The runs folder can be moved with SIGHTLINE_RUNS. The output conforms to the Fixture
// type in mock/fixture.ts; the mock server replays it as a live run. What the core does
// not make yet (the analysis) comes from mock/showcase.ts, marked synthetic; a few parts
// the runs lack (definitions the core did not word, one restatement) are listed in each
// fixture's made_up. The output is deterministic: the same runs give the same files.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { showcase } from "../mock/showcase.ts";

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

// The core owns this map (the contract lists it); the mock hardcodes it until the backend sends phases itself.
const PHASES = {
  understand: ["situate", "recall", "define", "ground", "abstract", "plan", "bind", "clarify", "reconsider", "repair"],
  analyse: ["enrich", "derive", "query", "analyse", "gather"],
  present: ["idiom", "render", "perceive", "validate", "restore"],
};
const phaseOf = (stage) => Object.keys(PHASES).find((p) => PHASES[p].includes(stage)) ?? "understand";

const MAX_ROWS = 200;
const MIN_STAGE_MS = 5;
const MAX_WARNINGS = 5;
const STATUSES = ["complete", "clarify", "asking"];
/** The answer step's id: Result.step_id, with the analysis or without it. */
const ANSWER_STEP = "st1";

const KPI_LIBRARY = (standard) => ({ kind: "library", text: `from sightline's KPI library (${standard})` });
const DRAFTED = { kind: "drafted", text: "drafted by sightline" };
const FROM_QUESTION = { kind: "question", text: "as the question states it" };

/**
 * Definitions the runs used that the core did not word in a "Defined as" clause (its
 * older runs left it out). The words are the registry seed's (mock/registry.ts); a status
 * is read from the registry when a run starts, so these say only proposed.
 */
const MADE_UP_DEFINITIONS = {
  // "Energy per 1,000 good units" says what it divides and by how much: the question's own definition.
  energy: [
    {
      name: "energy per good unit",
      label: "Energy per 1,000 good units",
      definition: "1,000 times the energy used (energy kWh) over the good quantity (good units)",
      entry_id: "measure-energy-per-good-unit",
      source: FROM_QUESTION,
      status: "proposed",
    },
  ],
  // The question names the term without defining it: sightline drafted it, and the key user
  // rejected the entry, so a run leaves it out while the entry stays rejected.
  scrap: [
    {
      name: "scrap against plan",
      label: "Scrap against plan",
      definition: "scrap quantity over planned scrap quantity",
      entry_id: "measure-scrap-against-plan",
      source: DRAFTED,
      status: "proposed",
    },
  ],
  tips: [
    {
      name: "average tip",
      label: "Average tip",
      definition: "the mean tip amount per payment",
      entry_id: "measure-average-tip",
      source: DRAFTED,
      status: "proposed",
    },
  ],
  "delivery-monthly": [
    {
      name: "delivery revenue",
      label: "Delivery revenue",
      definition: "line revenue of the order lines sold through the delivery channel",
      entry_id: "measure-delivery-revenue",
      source: DRAFTED,
      status: "proposed",
    },
  ],
};

/** A restatement the run got past bind without: borrowed from the same question's complete run. */
const MADE_UP_RESTATEMENTS = {
  "aeq-clarify":
    "You want to see how availability, effectiveness and quality ratio developed per week, from 1 Oct 2025 to 31 Dec 2025.",
};

/** The fixture that answers a clarify run's nearest question. */
const NEAREST_ANSWERED_BY = { "What is the revenue per branch?": "city-channel" };

const readJson = (dir, name) => {
  const path = join(dir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};
const mtime = (dir, name) => {
  const path = join(dir, name);
  return existsSync(path) ? statSync(path).mtimeMs : null;
};
const humanise = (id) => id.replace(/[_.-]+/g, " ").trim();
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const orNull = (value) => (value === undefined || value === "" ? null : value);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const slugify = (term) =>
  term
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
const DECIDED_BY = ["rules", "s1", "s2", "user", "default"];

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
 * false and "", chosen, default and confidence are null when missing, and entry_id is the
 * approved default's entry where the core names one (none of the exported runs does).
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
    entry_id: typeof p.entry_id === "string" && p.entry_id ? p.entry_id : null,
  };
}

/** The steps a card beside the chart asks about: what the drawing decided. */
const SIDE_STEPS = ["form", "point", "detail"];

/**
 * The card beside a finished chart, by the contract's Card rule: the points of the form,
 * point and detail steps nobody was sure of (open), and the points an approved default
 * settled (by default, with its entry), in the core's order; null when none is left.
 * Meaning and terms points never sit beside a chart: they block a run.
 */
function sideCard(abstract, idiom) {
  const points = [...(abstract?.points ?? []), ...(idiom?.points ?? [])].map(toPoint);
  const asked = points.filter((p) => (p.open && SIDE_STEPS.includes(p.step)) || (p.by === "default" && p.entry_id !== null));
  return asked.length ? { blocking: false, points: asked } : null;
}

/**
 * idiom's form point, the chart choice: the form point whose options are chart classes,
 * the drawn one among them. A chart pick sets it by the user, on the card or added to it.
 */
function formPoint(render, idiom) {
  const point = (idiom?.points ?? []).find((p) => p.step === "form" && (p.options ?? []).some((o) => o.id === render?.chart));
  return point ? toPoint(point) : null;
}

/**
 * Every chart class idiom offered, in the switcher's words and with its score: the label is
 * the form point's name for it (else the humanised class), the hint what it lets you read
 * (the candidate's `reads`, else the form option's hint, else null). By score, highest
 * first, then chart id; drawn is set per view.
 */
function chartOptions(render, idiom) {
  const form = (idiom?.points ?? []).find((p) => p.step === "form");
  const labels = new Map();
  for (const o of form?.options ?? []) labels.set(o.id, { label: String(o.label ?? humanise(o.id)), hint: orNull(o.hint) ?? null });
  const options = new Map();
  for (const c of idiom?.candidates ?? []) {
    if (!c?.chart || options.has(c.chart)) continue;
    const named = labels.get(c.chart);
    const reads = typeof c.reads === "string" && c.reads ? c.reads : null;
    options.set(c.chart, {
      chart: c.chart,
      label: named?.label ?? humanise(c.chart),
      hint: reads ?? named?.hint ?? null,
      score: typeof c.score === "number" ? c.score : 0,
      drawn: false,
    });
  }
  if (render?.chart && !options.has(render.chart)) {
    options.set(render.chart, { chart: render.chart, label: humanise(render.chart), hint: null, score: 0, drawn: false });
  }
  return [...options.values()].sort((a, b) => b.score - a.score || a.chart.localeCompare(b.chart));
}

/** The caveats idiom's plan put in the subtitle: the rows and the periods left out. */
function caveatsOf(idiom) {
  const plan = idiom?.plan ?? {};
  return [...strings(plan.exclusions), ...strings(plan.left_out), ...(plan.partial_note ? [plan.partial_note] : [])];
}

/** A caveat as a note: its own sentence, without the subtitle's asterisk. */
const asNote = (caveat) => capitalise(caveat.replace(/^\*\s*/, "").trim());

/** A spec whose subtitle holds only bases: every caveat line taken out (they are notes now). */
function basesOnly(spec, caveats) {
  if (!spec || typeof spec.title !== "object" || spec.title === null || Array.isArray(spec.title)) return spec;
  const lines = Array.isArray(spec.title.subtitle) ? spec.title.subtitle : spec.title.subtitle ? [spec.title.subtitle] : [];
  const kept = lines.filter((line) => !caveats.includes(line));
  const { subtitle: _gone, ...title } = spec.title;
  return { ...spec, title: kept.length ? { ...title, subtitle: kept } : title };
}

const titleText = (spec) => {
  const title = spec?.title;
  const text = typeof title === "object" && title !== null && !Array.isArray(title) ? title.text : title;
  return Array.isArray(text) ? text.join(" ") : typeof text === "string" ? text : null;
};
const subtitleLines = (spec) => {
  const sub = typeof spec?.title === "object" && spec.title !== null ? spec.title.subtitle : undefined;
  return Array.isArray(sub) ? sub.map(String) : typeof sub === "string" ? [sub] : [];
};

function chartView(chart, spec, options) {
  const own = options.find((o) => o.chart === chart);
  return {
    chart,
    label: own?.label ?? humanise(chart),
    title: titleText(spec),
    subtitle: subtitleLines(spec),
    hint: own?.hint ?? null,
    score: own?.score ?? null,
    spec,
    png_url: null,
    min_width: null,
    options: options.map((o) => ({ ...o, drawn: o.chart === chart })),
  };
}

/**
 * A spec as the contract has it read: spec.description in plain language for screen
 * readers (the chart's name, its title and its bases), the rule ids in usermeta.rules.
 */
function described(spec, label, ruleIds) {
  if (!spec || typeof spec !== "object") return spec;
  const said = typeof spec.description === "string" ? /rules: (.+)$/.exec(spec.description)?.[1] : undefined;
  const rules = Array.isArray(ruleIds) && ruleIds.length ? ruleIds.map(String) : (said?.split(/,\s*/) ?? []);
  const title = titleText(spec);
  const bases = subtitleLines(spec);
  const description = `${capitalise(label)}${title ? `: ${title}` : ""}${bases.length ? `, ${bases.join(", ")}` : ""}`;
  const usermeta = typeof spec.usermeta === "object" && spec.usermeta !== null ? spec.usermeta : {};
  return { ...spec, description, usermeta: { ...usermeta, ...(rules.length ? { rules } : {}) } };
}

function renderings(dir, render, caveats, options) {
  const labelOf = (chart) => options.find((o) => o.chart === chart)?.label ?? humanise(chart);
  const charts = {};
  if (render?.chart && render.spec) {
    charts[render.chart] = described(basesOnly(render.spec, caveats), labelOf(render.chart), render.rule_ids);
  }
  for (const file of readdirSync(dir)) {
    const match = /^render\.(.+)\.json$/.exec(file);
    if (!match) continue;
    const other = readJson(dir, file);
    const chart = other?.chart ?? match[1];
    charts[chart] = described(basesOnly(other?.spec ?? {}, caveats), labelOf(chart), other?.rule_ids);
  }
  return charts;
}

// --- columns, as enrich describes them -------------------------------------------------------

/** Enrich's column description without its approval status, which lives in definitions[]. */
const describe = (text) => orNull(String(text ?? "").replace(/\s*\((proposed|approved) definition\)\s*$/, "").trim());
const roleOf = (column) => (column?.attribute_type === "temporal" ? "time" : (orNull(column?.role) ?? null));

/** A d3-format for a measure's values, by their size: integers from a thousand up. */
function formatOf(rows, index) {
  const values = rows.map((row) => row[index]).filter((v) => typeof v === "number");
  if (values.length === 0) return null;
  const top = Math.max(...values.map(Math.abs));
  return top >= 1000 ? ",.0f" : top >= 10 ? ",.1f" : ",.2f";
}

function columnsOf(query, enrich) {
  const bySource = new Map((enrich?.columns ?? []).map((c) => [`${c.ref?.table}.${c.ref?.column}`, c]));
  const rows = query.rows ?? [];
  return (query.columns ?? []).map((c, i) => {
    const name = String(c.name);
    const known = bySource.get(c.source) ?? null;
    const role = roleOf(known ?? c);
    // A time column cut to a grain (a week, a month) is no longer the column enrich describes.
    const same = known && known.ref?.column === name;
    return {
      name,
      label: (same && orNull(known.label)) || humanise(name),
      type: c.attribute_type ?? known?.attribute_type ?? null,
      role,
      unit: known?.unit ?? null,
      format: role === "measure" ? formatOf(rows, i) : null,
      description: same ? describe(known.description) : null,
    };
  });
}

/** The warehouse columns the run read, for getSchema. */
function refsOf(enrich) {
  return (enrich?.columns ?? [])
    .filter((c) => c.ref?.table && c.ref?.column)
    .map((c) => ({
      table: String(c.ref.table),
      column: String(c.ref.column),
      label: orNull(c.label) ?? humanise(c.ref.column),
      type: c.attribute_type ?? null,
      role: roleOf(c),
      unit: c.unit ?? null,
      description: describe(c.description),
      metric: c.kind === "metric",
    }));
}

// --- what sightline understood -----------------------------------------------------------------

const DEFINED_AS = / Defined as: (.+?) is a proposed definition from sightline's KPI library \((ISO [\d-]+)[^)]*\)[^:]*?, not yet approved: (.+?)\.(?= Defined as:|$)/gs;

/**
 * The run's restatement without its "Defined as" clauses (those are definitions[] now),
 * and the definitions they held; a label the core lowercased ("oEE") is given back its case.
 */
function understood(dir, enrich, slug) {
  const validate = readJson(dir, "validate.json");
  const shown = (validate?.decisions ?? []).map((d) => d?.request?.state?.shown).find((s) => typeof s === "string");
  const raw = validate?.restatement ?? shown ?? MADE_UP_RESTATEMENTS[slug] ?? null;
  if (raw === null) return { restatement: null, definitions: [], madeUp: [] };
  const labels = (enrich?.columns ?? []).map((c) => c.label).filter((l) => typeof l === "string" && /[A-Z].*[A-Z]/.test(l));
  const cased = (text) => labels.reduce((t, l) => t.replaceAll(l.charAt(0).toLowerCase() + l.slice(1), l), text);
  const definitions = [...raw.matchAll(DEFINED_AS)].map(([, term, standard, words]) => {
    const name = cased(term).toLowerCase();
    const label = labels.find((l) => l.toLowerCase() === name) ?? capitalise(cased(term));
    return {
      name,
      label,
      definition: words.trim(),
      entry_id: `measure-${slugify(name)}`,
      source: KPI_LIBRARY(standard),
      status: "proposed",
    };
  });
  const restatement = cased(raw.replace(/ Defined as: .*$/s, "").trim());
  const madeUp = [];
  if (!validate?.restatement && !shown) madeUp.push("restatement");
  if (definitions.length === 0 && MADE_UP_DEFINITIONS[slug]) madeUp.push("definitions");
  return { restatement, definitions: definitions.length ? definitions : (MADE_UP_DEFINITIONS[slug] ?? []), madeUp };
}

/** validate's verdict, and its failed checks in words (empty on pass). */
function verdictOf(validate) {
  const verdict = ["pass", "warn", "fail"].includes(validate?.verdict) ? validate.verdict : "pass";
  if (verdict === "pass") return { verdict, concerns: [] };
  const concerns = (validate?.checks ?? [])
    .filter((c) => c.passed === false)
    .map((c) => {
      if (c.by === "s1" || c.by === "s2") {
        // The check's own question, without the parenthesised definition, first sentence only.
        const said = (
          String(c.detail ?? "")
            .replace(/\s*\(.*\)\.?$/s, "")
            .split(/(?<=[.?])\s/)[0] ?? ""
        ).replace(/[.?]$/, "");
        const chance = typeof c.probability === "number" ? ` (P ${c.probability.toFixed(2)})` : "";
        return `System ${c.by === "s1" ? 1 : 2} doubts that ${said.charAt(0).toLowerCase()}${said.slice(1)}${chance}`;
      }
      return `${capitalise(humanise(String(c.name)))}: ${c.detail}`;
    });
  return { verdict, concerns };
}

function result(dir, render, idiom, enrich, options, charts) {
  const query = readJson(dir, "query.json");
  if (!query) return null;
  const derive = readJson(dir, "derive.json");
  // The analysis' findings in words: plan.findings[].text.
  const findings = (idiom?.plan?.findings ?? [])
    .map((f) => (typeof f === "string" ? f : f?.text))
    .filter((text) => typeof text === "string" && text.length > 0);
  const rows = query.rows ?? [];
  const { verdict, concerns } = verdictOf(readJson(dir, "validate.json"));
  return {
    sql: derive?.sql ?? null,
    step_id: ANSWER_STEP,
    columns: columnsOf(query, enrich),
    rows: rows.slice(0, MAX_ROWS),
    row_count: query.row_count ?? rows.length,
    truncated: Boolean(query.truncated) || rows.length > MAX_ROWS,
    chart: render?.chart ? chartView(render.chart, charts[render.chart] ?? {}, options) : null,
    findings,
    notes: caveatsOf(idiom).map(asNote),
    verdict,
    concerns,
    storyline: null,
    lead: null,
    supports: [],
  };
}

// --- a clarify ending ----------------------------------------------------------------------------

/** The core's reason for a gap, in a user's words; anything it does not know stays the core's. */
function reasonOf(gap) {
  const [first, ...rest] = String(gap.reason ?? "").split("; ");
  const term = String(gap.requested ?? gap.slot);
  const said = /^no measure on this star matches this term$/.test(first ?? "")
    ? `No measure in the data matches "${term}"`
    : capitalise(first ?? "");
  const also = rest.map((part) => {
    const other = /^(\w+)\.(\w+) would match on the (\w+) star/.exec(part);
    if (!other) return part;
    // A dimension's table names it better than its column ("stop reason", not "reason").
    const what = humanise(other[1].replace(/^(fct|fact|dim|mart)_/, ""));
    const area = humanise(other[3].replace(/^(fct|fact|dim|mart)_/, ""));
    return `${what} would match in the ${area}, but one question reads one area of the data at a time`;
  });
  return [said, ...also].join("; ");
}

/** A gap's suggestion as a full revised question: the requested term replaced by the suggested one. */
function suggestionOf(question, gap, ref) {
  const label = humanise(String(ref).split(".").pop() ?? String(ref));
  const term = String(gap.requested ?? "");
  const at = term ? question.toLowerCase().indexOf(term.toLowerCase()) : -1;
  const revised = at >= 0 ? `${question.slice(0, at)}${label}${question.slice(at + term.length)}` : `${question.replace(/\?$/, "")}, by ${label}?`;
  return { id: String(ref), label, question: revised };
}

/**
 * The core's ClarificationReport as the contract's Clarify: gaps are terms that matched
 * nothing, with their suggestions as full questions; missing and record are the
 * not-possible-yet ending; warnings are deduplicated and capped. The nearest questions
 * are the run's follow-ups (kind nearest), not part of it.
 */
function toClarify(clarify, question) {
  const warnings = [...new Set(strings(clarify?.warnings))];
  return {
    gaps: (clarify?.gaps ?? []).map((g) => ({
      slot: String(g.slot),
      requested: String(g.requested ?? ""),
      reason: reasonOf(g),
      suggestions: strings(g.suggestions).map((ref) => suggestionOf(question, g, ref)),
    })),
    missing: strings(clarify?.missing),
    record: strings(clarify?.record),
    warnings: warnings.slice(0, MAX_WARNINGS),
    warnings_total: warnings.length,
  };
}

const nearestOf = (clarify) =>
  strings(clarify?.nearest).map((question, i) => ({
    id: `nq${i + 1}`,
    kind: "nearest",
    question,
    fixture: NEAREST_ANSWERED_BY[question] ?? null,
  }));

// --- the fixtures ----------------------------------------------------------------------------------

function write(fixture) {
  mkdirSync(join(outDir, fixture.workspace), { recursive: true });
  writeFileSync(join(outDir, fixture.workspace, `${fixture.slug}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}

function exportFixture([workspace, slug, runPath, continuation]) {
  const dir = join(runsDir, runPath);
  const meta = readJson(dir, "meta.json");
  if (!meta) throw new Error(`${runPath}: no meta.json in ${dir}`);
  const status = STATUSES.includes(meta.status) ? meta.status : "complete";
  const render = readJson(dir, "render.json");
  const idiom = readJson(dir, "idiom.json");
  const abstract = readJson(dir, "abstract.json");
  const enrich = readJson(dir, "enrich.json");
  const ask = readJson(dir, "ask.json");
  const clarify = readJson(dir, "clarify.json");
  const question = String(meta.question ?? "");
  const stages = stageTimings(dir, meta.stages ?? []);
  // Only a run that got past bind restates what it understood.
  const bound = stages.some((s) => s.stage === "bind");
  const { restatement, definitions, madeUp } = bound ? understood(dir, enrich, slug) : { restatement: null, definitions: [], madeUp: [] };

  const options = status === "complete" ? chartOptions(render, idiom) : [];
  const caveats = caveatsOf(idiom);
  const charts = status === "complete" ? renderings(dir, render, caveats, options) : {};
  let card = null;
  if (status === "asking") card = { blocking: true, points: (ask?.points ?? abstract?.points ?? []).map(toPoint) };
  else if (status === "complete") card = sideCard(abstract, idiom);

  const fixture = {
    slug,
    workspace,
    ...(madeUp.length ? { made_up: madeUp } : {}),
    question,
    final_status: status,
    continuation,
    stages,
    restatement,
    definitions,
    card,
    clarify: status === "clarify" ? toClarify(clarify, question) : null,
    follow_ups: status === "clarify" ? nearestOf(clarify) : [],
    error: null,
    result: status === "complete" ? result(dir, render, idiom, enrich, options, charts) : null,
    charts,
    chart_options: options,
    form_point: status === "complete" ? formPoint(render, idiom) : null,
    refs: refsOf(enrich),
    analysis: null,
  };
  fixture.analysis = showcase(fixture);
  write(fixture);

  const total = fixture.stages.reduce((sum, s) => sum + s.ms, 0);
  const chart = fixture.result?.chart?.chart ?? "-";
  const points = fixture.card ? `${fixture.card.points.length} point(s)${fixture.card.blocking ? " blocking" : ""}` : "no card";
  const notYet = fixture.clarify?.missing.length ? `, not possible yet (${fixture.follow_ups.length} nearest)` : "";
  const analysis = fixture.analysis
    ? `, analysis: ${fixture.analysis.steps.length} steps, ${fixture.analysis.supports.length} supports, ${fixture.analysis.follow_ups.length} follow-ups`
    : "";
  console.log(
    `${workspace}/${slug}: ${status}, ${fixture.stages.length} stages in ${(total / 1000).toFixed(1)} s, chart ${chart}` +
      ` (${Object.keys(fixture.charts).length} rendered), ${fixture.result?.rows.length ?? 0} rows, ${points}` +
      `${fixture.restatement ? ", restated" : ""}${fixture.definitions.length ? `, ${fixture.definitions.length} definition(s)` : ""}` +
      `${notYet}${analysis}${continuation ? `, continues as ${continuation}` : ""}${madeUp.length ? ` [made up: ${madeUp.join(", ")}]` : ""}`,
  );
  return fixture;
}

/**
 * The failed ending, which no exported run has: a made-up run that fails in query because
 * the warehouse did not answer. The error event comes just before run.status failed.
 */
function failedFixture() {
  const stages = [
    ["situate", 2100],
    ["abstract", 4300],
    ["bind", 1800],
    ["enrich", 900],
    ["derive", 2600],
    ["query", 6200],
  ].map(([stage, ms]) => ({ phase: phaseOf(stage), stage, ms }));
  return {
    slug: "downtime-failed",
    workspace: "manufacturing",
    synthetic: true,
    question: "Which machines had the most unplanned downtime yesterday?",
    final_status: "failed",
    continuation: null,
    stages,
    restatement: "You want to see the machines ranked by unplanned downtime minutes, on 31 Dec 2025.",
    definitions: [],
    card: null,
    clarify: null,
    follow_ups: [],
    error: {
      code: "warehouse_unavailable",
      message: "The warehouse did not answer in time, so the question could not be run. Asking again in a moment may work.",
      detail: "mock: a made-up failure in query (no warehouse behind the mock)",
      stage: "query",
      retryable: true,
    },
    result: null,
    charts: {},
    chart_options: [],
    form_point: null,
    refs: [],
    analysis: null,
  };
}

if (!existsSync(runsDir)) throw new Error(`no runs folder at ${runsDir}; set SIGHTLINE_RUNS`);
for (const entry of FIXTURES) exportFixture(entry);
const failed = failedFixture();
write(failed);
console.log(`${failed.workspace}/${failed.slug}: failed in ${failed.error.stage} (synthetic)`);
