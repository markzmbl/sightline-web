// The key-user registry: what sightline proposes (measures, learned defaults, data gaps)
// and the review actions on it.
import {
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
import type { RegistryCounts, RegistryEntryDetail, RegistryKind, RegistryPage, RegistryStatus, Review } from "./types";

export interface RegistryFilters {
  kind?: RegistryKind;
  status?: RegistryStatus;
}

export const registryKeys = {
  all: (ws: string) => ["registry", ws] as const,
  list: (ws: string, filters: RegistryFilters) => ["registry", ws, "list", filters] as const,
  counts: (ws: string) => ["registry", ws, "counts"] as const,
  entry: (ws: string, entryId: string) => ["registry", ws, "entry", entryId] as const,
};

const PAGE_SIZE = 50;
const COUNTS_EVERY_MS = 60_000;

// Every failure rejects as an ApiError, a dropped connection too (status 0), so the
// review view can read status, code and errors without checking what it caught.
const asApiError = (error: unknown): never => {
  throw toApiError(error);
};

async function fetchPage(
  ws: string,
  filters: RegistryFilters,
  cursor: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<RegistryPage> {
  const { kind, status } = filters;
  return unwrap(
    await api
      .GET("/api/v1/workspaces/{ws}/registry/entries", {
        params: { path: { ws }, query: { kind, status, cursor: cursor ?? undefined, limit } },
        signal,
      })
      .catch(asApiError),
  );
}

/** Entries matching the filters, page by page (cursor paging); `pageParam` is the cursor. */
export function useRegistry(
  ws: string,
  filters: RegistryFilters,
): UseInfiniteQueryResult<InfiniteData<RegistryPage, string | null>, ApiError> {
  return useInfiniteQuery<
    RegistryPage,
    ApiError,
    InfiniteData<RegistryPage, string | null>,
    ReturnType<typeof registryKeys.list>,
    string | null
  >({
    queryKey: registryKeys.list(ws, filters),
    queryFn: async ({ client, pageParam, signal }) => {
      const page = await fetchPage(ws, filters, pageParam, PAGE_SIZE, signal);
      // Every page carries the counts too: the badge keeps up with what the key user sees.
      client.setQueryData<RegistryCounts>(registryKeys.counts(ws), page.counts);
      return page;
    },
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: ws !== "",
  });
}

/** Proposed entries per kind, for the sidebar badge; refetches on focus and every 60 s. */
export function useRegistryCounts(ws: string): UseQueryResult<RegistryCounts, ApiError> {
  return useQuery<RegistryCounts, ApiError>({
    queryKey: registryKeys.counts(ws),
    // The counts ride on any page, whatever its filters; one proposed entry is the least to ask for.
    queryFn: async ({ signal }) => (await fetchPage(ws, { status: "proposed" }, null, 1, signal)).counts,
    enabled: ws !== "",
    refetchInterval: COUNTS_EVERY_MS,
    refetchOnWindowFocus: true,
  });
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
 * Approve, reject, reopen or edit one entry. Rejects with an ApiError: status 409 and
 * code "version_conflict" when someone reviewed it first (the entry is refetched), or
 * status 422 with errors of type "word_collision" (loc ends at the locale and the word's
 * index; ctx {word, collides_with}). On success the entry, the lists and the counts update.
 */
export function useReview(ws: string, entryId: string): UseMutationResult<RegistryEntryDetail, ApiError, Review> {
  const queryClient = useQueryClient();
  const entryKey = registryKeys.entry(ws, entryId);
  // Every list, whatever its filters, and the counts: what a review of one entry moves.
  const listsAndCounts = () =>
    queryClient.invalidateQueries({
      queryKey: registryKeys.all(ws),
      predicate: ({ queryKey }) => queryKey[2] === "list" || queryKey[2] === "counts",
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
    // Someone reviewed it first: load the version they left (the view says so), and the
    // lists and counts their review moved. The error shows once that version is in.
    // Any other failure (a word collision, a dropped connection) changed nothing.
    onError: (error) => {
      if (error.status !== 409 || error.code !== "version_conflict") return;
      return Promise.all([queryClient.invalidateQueries({ queryKey: entryKey, exact: true }), listsAndCounts()]);
    },
  });
}
