import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema";
import type { ErrorItem, Problem, ProblemCode } from "./types";

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
 * `code` names the error (Problem.code), e.g. a 409's not_latest, not_answerable,
 * stale_run, version_conflict or not_allowed; null on a 422 and without a Problem body.
 * `errors` are FastAPI-shaped items, e.g. a word_collision with loc and ctx, or a
 * stale_run whose ctx carries the prompt to ask again with.
 * `retryAfter` is a 429's Retry-After in seconds (too_many_active); null otherwise.
 * Status 0: no response to read (offline, refused, a body that is not JSON).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ProblemCode | null;
  readonly errors: ErrorItem[];
  readonly retryAfter: number | null;

  constructor(
    message: string,
    status: number,
    code: ProblemCode | null = null,
    errors: ErrorItem[] = [],
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.retryAfter = retryAfter;
  }
}

/** The data of an openapi-fetch result, or an ApiError when the response failed. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  const { response } = result;
  if (!response.ok) {
    const problem = problemOf(result.error);
    const retryAfter = response.status === 429 ? retryAfterOf(response.headers.get("Retry-After")) : null;
    throw new ApiError(
      problem.detail ?? `HTTP ${response.status}`,
      response.status,
      problem.code,
      problem.errors,
      retryAfter,
    );
  }
  return result.data as T;
}

/** Any failure as an ApiError, so callers can read status, code and errors without checking: a thrown fetch is status 0. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(error instanceof Error ? error.message : String(error), 0);
}

function problemOf(error: unknown): { detail: string | null; code: ProblemCode | null; errors: ErrorItem[] } {
  if (typeof error !== "object" || error === null) return { detail: null, code: null, errors: [] };
  const body = error as Partial<Problem> & { detail?: unknown; code?: unknown };
  // FastAPI's own 422 puts the items in detail; the contract's Problem moves them to errors.
  if (Array.isArray(body.detail) && !Array.isArray(body.errors)) {
    const errors = body.detail as ErrorItem[];
    const first = errors[0]?.msg;
    return { detail: typeof first === "string" ? first : null, code: null, errors };
  }
  return {
    detail: typeof body.detail === "string" ? body.detail : null,
    // A code this client does not know yet still names the error; callers compare it to the ones they handle.
    code: typeof body.code === "string" ? (body.code as ProblemCode) : null,
    errors: Array.isArray(body.errors) ? body.errors : [],
  };
}

/** Retry-After as whole seconds: the contract sends seconds; an HTTP date counts down from now. */
function retryAfterOf(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
