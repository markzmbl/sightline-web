import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema";
import type { ErrorItem, Problem } from "./types";

// v1 has no auth: calls are same-origin and carry no Authorization header. The
// token stays as a hook for a later sign-in; it is null until setToken sets one.
let token: string | null = null;

/** The typed API client (openapi-fetch), same-origin; it signs requests only once a token is set. */
export const api: Client<paths> = createClient<paths>({
  baseUrl: "",
  // Looked up on every call rather than captured once, so a test can stub fetch.
  fetch: (request) => globalThis.fetch(request),
});

api.use({
  onRequest({ request }) {
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
  },
});

/** Sets the bearer token used by `api` and by the event streams; null (the v1 default) sends none. */
export function setToken(next: string | null): void {
  token = next || null;
}

/** The headers every request carries: Authorization only when a token is set, else none. */
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * A response outside 2xx; `message` is the server's detail when it sent one.
 * `code` names a 409 (version_conflict, not_latest, not_answerable, stale_run);
 * `errors` are FastAPI-shaped items, e.g. a word_collision with loc and ctx.
 * Status 0: no response to read (offline, refused, a body that is not JSON).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly errors: ErrorItem[];

  constructor(message: string, status: number, code: string | null = null, errors: ErrorItem[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

/** The data of an openapi-fetch result, or an ApiError when the response failed. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  const { response } = result;
  if (!response.ok) {
    const problem = problemOf(result.error);
    throw new ApiError(problem.detail ?? `HTTP ${response.status}`, response.status, problem.code, problem.errors);
  }
  return result.data as T;
}

/** Any failure as an ApiError, so callers can read status, code and errors without checking: a thrown fetch is status 0. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(error instanceof Error ? error.message : String(error), 0);
}

function problemOf(error: unknown): { detail: string | null; code: string | null; errors: ErrorItem[] } {
  if (typeof error !== "object" || error === null) return { detail: null, code: null, errors: [] };
  const body = error as Partial<Problem> & { detail?: unknown };
  // FastAPI's own 422 puts the items in detail; the contract's Problem moves them to errors.
  if (Array.isArray(body.detail) && !Array.isArray(body.errors)) {
    const errors = body.detail as ErrorItem[];
    const first = errors[0]?.msg;
    return { detail: typeof first === "string" ? first : null, code: null, errors };
  }
  return {
    detail: typeof body.detail === "string" ? body.detail : null,
    code: typeof body.code === "string" ? body.code : null,
    errors: Array.isArray(body.errors) ? body.errors : [],
  };
}
