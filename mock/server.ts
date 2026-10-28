// The mock backend: contract v0.2.1 (../backend/contract/openapi.json) served from
// real sightline runs replayed as live ones, and a key-user registry seeded from
// them, while sightline-backend's routes are stubs. No auth, as in v1.
//   node mock/server.ts      (PORT, MOCK_SPEED, MOCK_MIN_STAGE_MS, MOCK_RESTART_EVERY,
//                             MOCK_ANALYSIS, MOCK_MAX_ACTIVE)
// MOCK_ANALYSIS=0 serves the answers as the backend sends them until the core's analysis
// runs (no storyline, supports, steps or follow-ups); by default the mock serves its
// made-up analysis (mock/showcase.ts) so the UI can show what answers will look like.
// Runs on Node's own type stripping, so only erasable TypeScript here, and node:http only.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { components, paths } from "../src/api/schema.d.ts";
import type { Answers, FollowRequest, Rating, Revise } from "../src/api/types.ts";
import { createEngine, HttpError, invalid, MAX_ACTIVE, type Engine, type Frame } from "./engine.ts";
import { loadFixtures, type FixtureIndex } from "./fixture.ts";
import { STOPS } from "./fold.ts";
import { createRegistry, KINDS, readEnum, readInt, readReview, SORTS, STATUSES, type Registry } from "./registry.ts";

export interface MockOptions {
  port?: number;
  host?: string;
  /** Real stage times are divided by this. */
  speed?: number;
  /** No stage or step is shorter than this, in wall-clock ms, so quick ones still show. */
  minStageMs?: number;
  /** Start with finished threads in every workspace. */
  seed?: boolean;
  /** Every nth new run is restarted once by its worker (run.status queued after running); 0, never. */
  restartEvery?: number;
  /** Serve the made-up analysis (default true); false answers as the backend does today. */
  analysis?: boolean;
  /** Runs a workspace may have queued, running or asking at once (default 3). */
  maxActive?: number;
  /** No request log on stdout. */
  quiet?: boolean;
  fixtures?: FixtureIndex;
}

export interface MockServer {
  url: string;
  close(): Promise<void>;
}

// --- typing the routes against the contract ----------------------------------------

type Method = "get" | "post" | "delete";
type Operation<P extends keyof paths, M extends Method> = NonNullable<paths[P][M]>;
type Responses<P extends keyof paths, M extends Method> = Operation<P, M> extends { responses: infer R } ? R : never;
type JsonOf<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** What a route may answer: one of its operation's success responses, with that response's body. */
type Reply<P extends keyof paths, M extends Method> = {
  [S in keyof Responses<P, M>]: S extends 200 | 202
    ? { status: S; body: JsonOf<Responses<P, M>[S]> }
    : S extends 204
      ? { status: S }
      : never;
}[keyof Responses<P, M>];

interface Context {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handle: (ctx: Context) => { status: number; body?: unknown };
}

function route<P extends keyof paths, M extends Method>(path: P, method: M, handle: (ctx: Context) => Reply<P, M>): Route {
  const names: string[] = [];
  const source = path.replace(/\{(\w+)\}/g, (_, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { method: method.toUpperCase(), pattern: new RegExp(`^${source}$`), names, handle };
}

// --- reading requests ------------------------------------------------------------------

type Schemas = components["schemas"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Every 422 is a Problem whose errors are FastAPI's {loc, msg, type}, in its words.

function object(body: unknown, loc: (string | number)[] = ["body"]): Record<string, unknown> {
  if (!isRecord(body)) throw invalid(loc, "Input should be a valid dictionary or object to extract fields from", "model_attributes_type");
  return body;
}

/** A required string field, not blank. */
function text(body: unknown, field: string, at: (string | number)[] = ["body"]): string {
  const value = object(body, at)[field];
  const loc = [...at, field];
  if (value === undefined) throw invalid(loc, "Field required", "missing");
  if (typeof value !== "string") throw invalid(loc, "Input should be a valid string", "string_type");
  if (!value.trim()) throw invalid(loc, "String should have at least 1 character", "string_too_short", { min_length: 1 });
  return value.trim();
}

/** An optional enum field: absent or null is none, anything else one of `values`. */
function choice<T extends string>(body: Record<string, unknown>, field: string, values: readonly T[]): T | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    const expected = values.map((v) => `'${v}'`).join(", ").replace(/, ([^,]*)$/, " or $1");
    throw invalid(["body", field], `Input should be ${expected}`, "enum", { expected });
  }
  return value as T;
}

function readCreate(body: unknown): { question: string; ask: Schemas["AskPolicy"] | undefined } {
  const question = text(body, "question");
  return { question, ask: choice(object(body), "ask", ["never", "unsure", "always"] as const) };
}

/** A revision: its message, and either the follow-up it sends or where it came from, never both. */
function readRevise(body: unknown): Revise {
  const raw = object(body);
  const message = text(body, "message");
  let follows: FollowRequest | undefined;
  if (raw.follows !== undefined && raw.follows !== null) {
    const at = ["body", "follows"];
    follows = { run_id: text(object(raw.follows, at), "run_id", at), follow_up_id: text(object(raw.follows, at), "follow_up_id", at) };
  }
  const via = choice(raw, "via", ["composer", "nearest"] as const);
  if (follows && via !== undefined) {
    throw invalid(["body", "via"], "via is never sent with follows: a follow-up says where it came from", "via_with_follows");
  }
  return { message, ...(follows ? { follows } : {}), ...(via ? { via } : {}) };
}

function readAnswers(body: unknown): Answers {
  const raw = object(body);
  if (raw.answers === undefined) throw invalid(["body", "answers"], "Field required", "missing");
  if (!isRecord(raw.answers)) throw invalid(["body", "answers"], "Input should be a valid dictionary", "dict_type");
  const answers: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(raw.answers)) {
    if (value !== null && typeof value !== "string") throw invalid(["body", "answers", id], "Input should be a valid string", "string_type");
    answers[id] = value;
  }
  const free = raw.text;
  if (free !== undefined && free !== null && typeof free !== "string") throw invalid(["body", "text"], "Input should be a valid string", "string_type");
  return { answers, text: free ?? null };
}

/** A rating, or null to clear it. */
function readRating(body: unknown): Rating | null {
  const raw = object(body);
  if (!("rating" in raw)) throw invalid(["body", "rating"], "Field required", "missing");
  const rating = raw.rating;
  if (rating === null) return null;
  if (rating !== "up" && rating !== "down") throw invalid(["body", "rating"], "Input should be 'up' or 'down'", "enum", { expected: "'up' or 'down'" });
  return rating;
}

function readSignal(body: unknown): { kind: "thread_opened"; thread_id: string } {
  const raw = object(body);
  if (raw.kind === undefined) throw invalid(["body", "kind"], "Field required", "missing");
  if (raw.kind !== "thread_opened") {
    throw invalid(["body", "kind"], "Input should be 'thread_opened'", "literal_error", { expected: "'thread_opened'" });
  }
  return { kind: "thread_opened", thread_id: text(body, "thread_id") };
}

/** An optional date-time query parameter, as FastAPI parses one. */
function readTime(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw invalid(["query", name], "Input should be a valid datetime or date, invalid character in year", "datetime_from_date_parsing");
  }
  return raw;
}

// --- the routes --------------------------------------------------------------------------

function routes(engine: Engine, registry: Registry): Route[] {
  const created = (body: Schemas["RunCreated"]) => ({ status: 202 as const, body });
  const runsOf = (ws: string) => (runId: string) => engine.entryRun(ws, runId);
  return [
    route("/healthz", "get", () => ({ status: 200, body: { ok: true, version: "mock" } })),
    route("/api/v1/me", "get", () => ({ status: 200, body: engine.me() })),
    route("/api/v1/workspaces/{ws}/threads", "get", ({ params, query }) => {
      const page = {
        q: query.get("q") ?? undefined,
        updatedSince: readTime(query, "updated_since"),
        cursor: query.get("cursor"),
        limit: readInt(query, "limit", 50, 1, 200),
      };
      return { status: 200, body: engine.listThreads(params.ws ?? "", page) };
    }),
    route("/api/v1/workspaces/{ws}/threads", "post", ({ params, body }) => created(engine.createThread(params.ws ?? "", readCreate(body).question))),
    route("/api/v1/workspaces/{ws}/threads/{thread_id}", "get", ({ params }) => ({
      status: 200,
      body: engine.getThread(params.ws ?? "", params.thread_id ?? ""),
    })),
    route("/api/v1/workspaces/{ws}/threads/{thread_id}/revisions", "post", ({ params, body }) =>
      created(engine.revise(params.ws ?? "", params.thread_id ?? "", readRevise(body))),
    ),
    route("/api/v1/workspaces/{ws}/threads/{thread_id}/revisions/{n}", "delete", ({ params }) => {
      const n = Number(params.n);
      if (!/^-?\d+$/.test(params.n ?? "") || !Number.isInteger(n)) {
        throw invalid(["path", "n"], "Input should be a valid integer, unable to parse string as an integer", "int_parsing");
      }
      if (n < 1) throw invalid(["path", "n"], "Input should be greater than or equal to 1", "greater_than_equal", { ge: 1 });
      return created(engine.takeBack(params.ws ?? "", params.thread_id ?? "", n));
    }),
    route("/api/v1/workspaces/{ws}/runs/{run_id}", "get", ({ params }) => ({
      status: 200,
      body: engine.getRun(params.ws ?? "", params.run_id ?? ""),
    })),
    route("/api/v1/workspaces/{ws}/runs/{run_id}/steps/{step_id}", "get", ({ params }) => ({
      status: 200,
      body: engine.getStep(params.ws ?? "", params.run_id ?? "", params.step_id ?? ""),
    })),
    route("/api/v1/workspaces/{ws}/runs/{run_id}/answers", "post", ({ params, body }) => {
      const { answers, text: free } = readAnswers(body);
      return created(engine.answer(params.ws ?? "", params.run_id ?? "", answers, free ?? null));
    }),
    route("/api/v1/workspaces/{ws}/runs/{run_id}/cancel", "post", ({ params }) => created(engine.cancel(params.ws ?? "", params.run_id ?? ""))),
    route("/api/v1/workspaces/{ws}/runs/{run_id}/chart", "post", ({ params, body }) =>
      created(engine.pickChart(params.ws ?? "", params.run_id ?? "", text(body, "chart"))),
    ),
    route("/api/v1/workspaces/{ws}/runs/{run_id}/feedback", "post", ({ params, body }) => {
      engine.feedback(params.ws ?? "", params.run_id ?? "", readRating(body));
      return { status: 204 };
    }),
    route("/api/v1/workspaces/{ws}/signals", "post", ({ params, body }) => {
      const signal = readSignal(body);
      engine.signal(params.ws ?? "", signal.kind, signal.thread_id);
      return { status: 204 };
    }),
    route("/api/v1/workspaces/{ws}/schema", "get", ({ params }) => ({ status: 200, body: engine.schema(params.ws ?? "") })),
    route("/api/v1/workspaces/{ws}/registry/entries", "get", ({ params, query }) => {
      const filters = {
        kind: readEnum(query, "kind", KINDS),
        status: readEnum(query, "status", STATUSES),
        q: query.get("q") ?? undefined,
        sort: readEnum(query, "sort", SORTS) ?? "last_asked",
      };
      const limit = readInt(query, "limit", 50, 1, 200);
      return { status: 200, body: registry.list(params.ws ?? "", filters, query.get("cursor"), limit) };
    }),
    route("/api/v1/workspaces/{ws}/registry/entries/{entry_id}", "get", ({ params }) => {
      const ws = params.ws ?? "";
      return { status: 200, body: registry.get(ws, params.entry_id ?? "", runsOf(ws)) };
    }),
    route("/api/v1/workspaces/{ws}/registry/entries/{entry_id}/review", "post", ({ params, body }) => {
      const ws = params.ws ?? "";
      return { status: 200, body: registry.review(ws, params.entry_id ?? "", readReview(body), runsOf(ws)) };
    }),
  ];
}

// The event stream is the one route that is not JSON.
const EVENTS = /^\/api\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/events$/;
const HEARTBEAT_MS = 15_000;
const RETRY_MS = 3_000;

const frameText = (frame: Frame): string =>
  `id: ${frame.id}\nevent: ${frame.event.type}\ndata: ${JSON.stringify(frame.event)}\n\n`;

const stops = (frame: Frame): boolean => frame.event.type === "run.status" && STOPS.includes(frame.event.status);

/** Where a stream resumes: Last-Event-ID, else ?last_event_id (a malformed one is a 422), else the start. */
function resumeAfter(req: IncomingMessage, query: URLSearchParams): number {
  const header = req.headers["last-event-id"];
  const said = Array.isArray(header) ? header[0] : header;
  if (said !== undefined && said !== "") return Math.max(0, Number.parseInt(said, 10) || 0);
  const raw = query.get("last_event_id");
  if (raw === null || raw === "") return 0;
  if (!/^-?\d+$/.test(raw)) {
    throw invalid(["query", "last_event_id"], "Input should be a valid integer, unable to parse string as an integer", "int_parsing");
  }
  const after = Number(raw);
  if (after < 0) throw invalid(["query", "last_event_id"], "Input should be greater than or equal to 0", "greater_than_equal", { ge: 0 });
  return after;
}

// --- the server ------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(invalid(["body", 0], `JSON decode error: ${error instanceof Error ? error.message : "not JSON"}`, "json_invalid"));
      }
    });
  });
}

const envNumber = (name: string): number | undefined => {
  const value = process.env[name];
  return value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
};

export async function startMockServer(options: MockOptions = {}): Promise<MockServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? envNumber("PORT") ?? 8000;
  const speed = options.speed ?? envNumber("MOCK_SPEED") ?? 8;
  const minStageMs = options.minStageMs ?? envNumber("MOCK_MIN_STAGE_MS") ?? 120;
  const restartEvery = options.restartEvery ?? envNumber("MOCK_RESTART_EVERY") ?? 0;
  const analysis = options.analysis ?? process.env.MOCK_ANALYSIS !== "0";
  const maxActive = options.maxActive ?? envNumber("MOCK_MAX_ACTIVE") ?? MAX_ACTIVE;
  const log = options.quiet ? () => {} : (line: string) => console.log(line);

  const fixtures = options.fixtures ?? loadFixtures();
  const registry = createRegistry();
  const engine = createEngine(fixtures, {
    speed: Math.max(speed, 0.001),
    minStageMs,
    restartEvery: Math.max(0, Math.floor(restartEvery)),
    analysis,
    maxActive: Math.max(1, Math.floor(maxActive)),
    onEnded: registry.use,
    definitions: registry.definitionsFor,
  });
  // The registry first: the seeded runs that end count as its entries' demand.
  const now = Date.now();
  registry.seed(fixtures, now);
  if (options.seed ?? true) engine.seed(now);
  const table = routes(engine, registry);
  const streams = new Set<ServerResponse>();

  function send(req: IncomingMessage, res: ServerResponse, path: string, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    if (body === undefined) res.writeHead(status, headers).end();
    else res.writeHead(status, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(body));
    log(`${req.method} ${path} ${status}`);
  }

  function stream(req: IncomingMessage, res: ServerResponse, path: string, ws: string, runId: string, query: URLSearchParams) {
    const after = resumeAfter(req, query);
    let ended = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const finish = () => {
      if (ended) return;
      ended = true;
      follow.stop();
      if (heartbeat) clearInterval(heartbeat);
      streams.delete(res);
      res.end();
    };
    const follow = engine.follow(ws, runId, after, (frame) => {
      if (ended) return;
      res.write(frameText(frame));
      if (stops(frame)) finish();
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    log(`${req.method} ${path} 200 (stream after ${after})`);
    streams.add(res);
    res.write(`retry: ${RETRY_MS}\n\n`);
    for (const frame of follow.backlog) res.write(frameText(frame));
    // A stop frame in the backlog ends the stream only when the run still stands there.
    if (STOPS.includes(follow.status())) return finish();
    heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", finish);
    res.on("close", finish);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    try {
      const events = EVENTS.exec(path);
      if (events) {
        if (req.method !== "GET") throw new HttpError(405, `${req.method} is not allowed on ${path}.`);
        return stream(req, res, path, decodeURIComponent(events[1] ?? ""), decodeURIComponent(events[2] ?? ""), url.searchParams);
      }
      const matches = table.filter((r) => r.pattern.test(path));
      if (matches.length === 0) throw new HttpError(404, `No route ${path}.`);
      const found = matches.find((r) => r.method === req.method);
      if (!found) throw new HttpError(405, `${req.method} is not allowed on ${path}.`);
      const groups = found.pattern.exec(path) ?? [];
      const params = Object.fromEntries(found.names.map((name, i) => [name, decodeURIComponent(groups[i + 1] ?? "")]));
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const reply = found.handle({ params, query: url.searchParams, body });
      send(req, res, path, reply.status, reply.body);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const detail = error instanceof Error ? error.message : String(error);
      if (status === 500) console.error(error);
      const problem: Schemas["Problem"] = { detail };
      if (error instanceof HttpError && error.code) problem.code = error.code;
      if (error instanceof HttpError && error.errors) problem.errors = error.errors;
      if (!res.headersSent) send(req, res, path, status, problem, error instanceof HttpError ? error.headers : {});
      else res.end();
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        engine.close();
        for (const res of streams) res.end();
        streams.clear();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

// Started directly (node mock/server.ts), not imported by a test.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const mock = await startMockServer().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") throw error;
    console.error(`The port is taken (${error.message}); set PORT to another one.`);
    process.exit(1);
  });
  const restarts = envNumber("MOCK_RESTART_EVERY") ? `, a worker restart every ${envNumber("MOCK_RESTART_EVERY")} runs` : "";
  const analysis = process.env.MOCK_ANALYSIS === "0" ? ", no analysis" : ", with the made-up analysis";
  console.log(`sightline mock backend on ${mock.url} (speed ${process.env.MOCK_SPEED ?? 8}x${restarts}${analysis}); Ctrl+C stops it`);
  const stop = () => void mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
