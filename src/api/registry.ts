// The key-user registry: what sightline proposes (measures, learned defaults, data gaps)
// and the review actions on it.
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { api, ApiError, toApiError, unwrap } from "./client";
import type { operations } from "./schema";
import type {
  KindInfo,
  RegistryCounts,
  RegistryEntryDetail,
  RegistryKind,
  RegistryPage,
  RegistryStatus,
  Review,
} from "./types";

/** The order of a list: last_asked (most recently asked first), demand (most runs first), updated (most recently changed first). */
export type RegistrySort = NonNullable<NonNullable<operations["listRegistryEntries"]["parameters"]["query"]>["sort"]>;

export interface RegistryFilters {
  kind?: RegistryKind;
  status?: RegistryStatus;
  /** A text search over the terms, labels and words, done by the server; blank searches nothing. */
  q?: string;
  /** The server's own order when left out. */
  sort?: RegistrySort;
}

/** What every page carries besides its entries: the proposed counts per kind, whatever the filters, and the kinds' display words. */
export interface RegistryOverview {
  counts: RegistryCounts;
  kinds: KindInfo[];
}

export const registryKeys = {
  all: (ws: string) => ["registry", ws] as const,
  list: (ws: string, filters: RegistryFilters) => ["registry", ws, "list", filters] as const,
  /** The RegistryOverview behind useRegistryCounts and useRegistryKinds. */
  overview: (ws: string) => ["registry", ws, "overview"] as const,
  entry: (ws: string, entryId: string) => ["registry", ws, "entry", entryId] as const,
};

const PAGE_SIZE = 50;
const COUNTS_EVERY_MS = 60_000;

// Every failure rejects as an ApiError, a dropped connection too (status 0), so the
// review view can read status, code and errors without checking what it caught.
const asApiError = (error: unknown): never => {
  throw toApiError(error);
};

/** The filters as one key: a blank search is no search, and what is left out is not in it. */
function normalized({ kind, status, q, sort }: RegistryFilters): RegistryFilters {
  const search = q?.trim();
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(search ? { q: search } : {}),
    ...(sort !== undefined ? { sort } : {}),
  };
}

async function fetchPage(
  ws: string,
  filters: RegistryFilters,
  cursor: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<RegistryPage> {
  const { kind, status, q, sort } = filters;
  return unwrap(
    await api
      .GET("/api/v1/workspaces/{ws}/registry/entries", {
        params: { path: { ws }, query: { kind, status, q, sort, cursor: cursor ?? undefined, limit } },
        signal,
      })
      .catch(asApiError),
  );
}

const overviewOf = (page: RegistryPage): RegistryOverview => ({ counts: page.counts, kinds: page.kinds });

/** Entries matching the filters, page by page (cursor paging); `pageParam` is the cursor. */
export function useRegistry(
  ws: string,
  filters: RegistryFilters,
): UseInfiniteQueryResult<InfiniteData<RegistryPage, string | null>, ApiError> {
  const key = normalized(filters);
  return useInfiniteQuery<
    RegistryPage,
    ApiError,
    InfiniteData<RegistryPage, string | null>,
    ReturnType<typeof registryKeys.list>,
    string | null
  >({
    queryKey: registryKeys.list(ws, key),
    queryFn: async ({ client, pageParam, signal }) => {
      const page = await fetchPage(ws, key, pageParam, PAGE_SIZE, signal);
      // Every page carries the counts and the kinds too: the badge keeps up with what the key user sees.
      client.setQueryData<RegistryOverview>(registryKeys.overview(ws), overviewOf(page));
      return page;
    },
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: ws !== "",
  });
}

/**
 * The one query behind the counts and the kinds: one request for both, refetched on
 * focus and every 60 s, and refreshed by every list page.
 */
function overviewOptions(ws: string) {
  return queryOptions<RegistryOverview, ApiError, RegistryOverview, ReturnType<typeof registryKeys.overview>>({
    queryKey: registryKeys.overview(ws),
    // The counts and kinds ride on any page, whatever its filters; one proposed entry is the least to ask for.
    queryFn: async ({ signal }) => overviewOf(await fetchPage(ws, { status: "proposed" }, null, 1, signal)),
    enabled: ws !== "",
    refetchInterval: COUNTS_EVERY_MS,
    refetchOnWindowFocus: true,
  });
}

// Module-level, so a select runs again only when the overview changes.
const countsOf = (overview: RegistryOverview): RegistryCounts => overview.counts;
const kindsOf = (overview: RegistryOverview): KindInfo[] => overview.kinds;

/** Proposed entries per kind, for the sidebar badge; refetches on focus and every 60 s. */
export function useRegistryCounts(ws: string): UseQueryResult<RegistryCounts, ApiError> {
  return useQuery({ ...overviewOptions(ws), select: countsOf });
}

/** The display words of every kind (label, plural), from the same request as the counts. */
export function useRegistryKinds(ws: string): UseQueryResult<KindInfo[], ApiError> {
  return useQuery({ ...overviewOptions(ws), select: kindsOf });
}

/** One entry with the runs that used it; idle while `entryId` is null. */
export function useRegistryEntry(ws: string, entryId: string | null): UseQueryResult<RegistryEntryDetail, ApiError> {
  return useQuery<RegistryEntryDetail, ApiError>({
    queryKey: registryKeys.entry(ws, entryId ?? ""),
    queryFn: async ({ signal }) =>
      unwrap(
        await api
          .GET("/api/v1/workspaces/{ws}/registry/entries/{entry_id}", {
            params: { path: { ws, entry_id: entryId ?? "" } },
            signal,
          })
          .catch(asApiError),
      ),
    enabled: ws !== "" && entryId !== null && entryId !== "",
  });
}

/**
 * Approve, reject, reopen or edit one entry. Rejects with an ApiError: status 409 with
 * code "version_conflict" when someone reviewed it first, or "not_allowed" when the
 * entry's status does not allow that move (either way the entry and the lists are
 * refetched), or status 422 with errors of type "word_collision" (loc ends at the
 * locale and the word's index; ctx {word, collides_with}). On success the entry, the
 * lists and the counts update.
 */
export function useReview(ws: string, entryId: string): UseMutationResult<RegistryEntryDetail, ApiError, Review> {
  const queryClient = useQueryClient();
  const entryKey = registryKeys.entry(ws, entryId);
  // Every list, whatever its filters, and the counts: what a review of one entry moves.
  const listsAndCounts = () =>
    queryClient.invalidateQueries({
      queryKey: registryKeys.all(ws),
      predicate: ({ queryKey }) => queryKey[2] === "list" || queryKey[2] === "overview",
    });

  return useMutation<RegistryEntryDetail, ApiError, Review>({
    // Keyed by the entry: when the hook moves to another entry while a review is pending,
    // the observer lets go of it instead of pointing it at the new entry. The pending
    // review keeps the options it started with, its URL and its cache writes among them.
    mutationKey: [...entryKey, "review"],
    mutationFn: async (review) =>
      unwrap(
        await api
          .POST("/api/v1/workspaces/{ws}/registry/entries/{entry_id}/review", {
            params: { path: { ws, entry_id: entryId } },
            body: review,
          })
          .catch(asApiError),
      ),
    // The answer is the entry at its new version: it shows at once, and the lists and
    // the counts it moved come back from the server. Pending until they are back.
    onSuccess: (detail) => {
      queryClient.setQueryData<RegistryEntryDetail>(registryKeys.entry(ws, detail.id), detail);
      return listsAndCounts();
    },
    // The entry is not as the key user saw it: someone reviewed it first, or its status
    // does not allow the move. Load it as it stands (the view says why), and the lists
    // and counts with it. The error shows once that version is in. Any other failure
    // (a word collision, a dropped connection) changed nothing.
    onError: (error) => {
      if (error.status !== 409 || (error.code !== "version_conflict" && error.code !== "not_allowed")) return;
      return Promise.all([queryClient.invalidateQueries({ queryKey: entryKey, exact: true }), listsAndCounts()]);
    },
  });
}
