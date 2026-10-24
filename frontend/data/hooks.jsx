import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getEntries, getEntryCounts, getCustomLists, getStats, getDashboardBootstrap,
  getLibraryBootstrap, getLibraryRevision,
  updateEntry, createEntry, deleteEntry, batchUpdateEntries, batchDeleteEntries,
  prefetchCoverImages,
} from '../api.jsx';
import { extractItems } from '../utils.jsx';
import {
  entriesKey, countsKey, countParams, listsKey, statsKey, dashboardBootstrapKey,
  libraryBootstrapKey, libraryRevisionKey,
} from './keys.js';
import { readShareToken } from './shareSession.js';

// Normalize /entries into the shape pages consume: { items, total, limit, offset }.
export function fetchEntriesPayload(params) {
  return getEntries(params).then(data => {
    const items = extractItems(data);
    return {
      items,
      total: data?.total ?? items.length,
      limit: data?.limit ?? params.limit,
      offset: data?.offset ?? params.offset,
    };
  });
}

function fetchLists() {
  return getCustomLists().then(data => (Array.isArray(data) ? data : []));
}

// ── Reads ──────────────────────────────────────────────────────────────────

export function useEntries(params, options = {}) {
  return useQuery({
    queryKey: entriesKey(params),
    queryFn: () => fetchEntriesPayload(params),
    ...options,
  });
}

export function useEntryCounts(params = {}, options = {}) {
  return useQuery({
    queryKey: countsKey(params),
    queryFn: () => getEntryCounts(params),
    ...options,
  });
}

export function useCustomLists(options = {}) {
  return useQuery({ queryKey: listsKey(), queryFn: fetchLists, ...options });
}

export function useStats(options = {}) {
  return useQuery({ queryKey: statsKey(), queryFn: getStats, ...options });
}

const DASHBOARD_GROUPS = [
  ['current',   { status: 'current',   limit: 20 }],
  ['completed', { status: 'completed', limit: 20, sort: 'completed_at', order: 'desc' }],
  ['on_hold',   { status: 'on_hold',   limit: 6,  sort: 'updated_at', order: 'desc' }],
  ['dropped',   { status: 'dropped',   limit: 6,  sort: 'updated_at', order: 'desc' }],
  ['planned',   { status: 'planned',   limit: 20, sort: 'updated_at', order: 'desc' }],
];

function seedDashboardEntryQueries(qc, data) {
  DASHBOARD_GROUPS.forEach(([name, params]) => {
    if (data?.[name]) qc.setQueryData(entriesKey(params), data[name]);
  });
  return data;
}

async function fetchDashboardPayload(qc) {
  try {
    return seedDashboardEntryQueries(qc, await getDashboardBootstrap());
  } catch (error) {
    if (!String(error?.message || '').startsWith('404 ')) throw error;
    // The frontend can be deployed before the home-server API. Use the old
    // fan-out until that server has pulled and restarted with the bootstrap.
    const [stats, ...groups] = await Promise.all([
      getStats(),
      ...DASHBOARD_GROUPS.map(([, params]) => fetchEntriesPayload(params)),
    ]);
    const fallback = { stats };
    DASHBOARD_GROUPS.forEach(([name], index) => { fallback[name] = groups[index]; });
    return seedDashboardEntryQueries(qc, fallback);
  }
}

export function useDashboardBootstrap(options = {}) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: dashboardBootstrapKey(),
    queryFn: () => fetchDashboardPayload(qc),
    ...options,
  });
}

function seedLibraryQueries(qc, params, data) {
  if (data?.entries) qc.setQueryData(entriesKey(params), data.entries);
  if (data?.counts) qc.setQueryData(countsKey(countParams(params)), data.counts);
  if (data?.custom_lists) qc.setQueryData(listsKey(), data.custom_lists);
  if (Number.isFinite(data?.revision)) {
    qc.setQueryData(libraryRevisionKey(), { revision: data.revision });
  }
  return data;
}

async function fetchLibraryBootstrapPayload(qc, params) {
  try {
    return seedLibraryQueries(qc, params, await getLibraryBootstrap(params));
  } catch (error) {
    if (!String(error?.message || '').startsWith('404 ')) throw error;
    const [entries, counts, customLists, revision] = await Promise.all([
      fetchEntriesPayload(params), getEntryCounts(countParams(params)), fetchLists(), getLibraryRevision(),
    ]);
    return seedLibraryQueries(qc, params, {
      entries, counts, custom_lists: customLists, revision: revision?.revision,
    });
  }
}

export function useLibraryBootstrap(params, options = {}) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: libraryBootstrapKey(params),
    queryFn: () => fetchLibraryBootstrapPayload(qc, params),
    ...options,
  });
}

export function prefetchLibraryBootstrap(qc, params) {
  return qc.fetchQuery({
    queryKey: libraryBootstrapKey(params),
    queryFn: () => fetchLibraryBootstrapPayload(qc, params),
  }).then(data => prefetchCoverImages(data?.entries?.items || [], 'thumb'))
    .catch(() => {});
}

export function prefetchDashboard(qc) {
  return qc.fetchQuery({
    queryKey: dashboardBootstrapKey(),
    queryFn: () => fetchDashboardPayload(qc),
  }).then(data => prefetchCoverImages([
    ...(data.current?.items || []),
    ...(data.planned?.items || []),
    ...(data.completed?.items || []),
  ], 'thumb'));
}

// Prefetch an entries page AND its covers, so a hover warms the rows and their
// images together. fetchQuery resolves the page so we know which covers to bundle.
export function prefetchEntriesWithCovers(qc, params, size = 'thumb') {
  return qc.fetchQuery({ queryKey: entriesKey(params), queryFn: () => fetchEntriesPayload(params) })
    .then(data => prefetchCoverImages(data?.items || [], size))
    .catch(() => {});
}

// Some pages render several entry queries through one shared cover bundle. Warm
// that exact combined URL set, since separate per-query bundles have different
// React Query keys and cannot satisfy the mounted page's bundle request.
export function prefetchEntryGroupsWithCovers(qc, paramGroups, size = 'thumb') {
  return Promise.all(paramGroups.map(params =>
    qc.fetchQuery({ queryKey: entriesKey(params), queryFn: () => fetchEntriesPayload(params) })
  ))
    .then(groups => prefetchCoverImages(
      groups.flatMap(data => data?.items || []), size,
    ))
    .catch(() => {});
}

// ── Prefetch (hover preloading) ──────────────────────────────────────────────
// Fire-and-forget; React Query swallows failures, so a missed prefetch just means
// the click fetches normally.

export function prefetchEntries(qc, params) {
  qc.prefetchQuery({ queryKey: entriesKey(params), queryFn: () => fetchEntriesPayload(params) });
}
export function prefetchCounts(qc, params = {}) {
  qc.prefetchQuery({ queryKey: countsKey(params), queryFn: () => getEntryCounts(params) });
}
export function prefetchLists(qc) {
  qc.prefetchQuery({ queryKey: listsKey(), queryFn: fetchLists });
}
export function prefetchStats(qc) {
  qc.prefetchQuery({ queryKey: statsKey(), queryFn: getStats });
}

// ── The shared mutation contract ─────────────────────────────────────────────
// Every entry mutation: optimistically patch the row in all cached entries
// queries (instant feedback), roll back on error, and on settle invalidate
// entries/counts/lists/stats. Invalidation refetches the *active* view with its
// current sort/filter params, so the row moves / drops out correctly — that is
// the whole fix for "an edit doesn't reorder or disappear under a sort/filter".

function patchEntryEverywhere(qc, id, patch) {
  qc.setQueriesData({ queryKey: ['entries'] }, old => {
    if (!old?.items || !old.items.some(e => e.id === id)) return old;
    return { ...old, items: old.items.map(e => (e.id === id ? { ...e, ...patch } : e)) };
  });
}

function removeEntryEverywhere(qc, id) {
  qc.setQueriesData({ queryKey: ['entries'] }, old => {
    if (!old?.items || !old.items.some(e => e.id === id)) return old;
    return {
      ...old,
      items: old.items.filter(e => e.id !== id),
      total: Math.max(0, (old.total ?? old.items.length) - 1),
    };
  });
}

function restoreSnapshot(qc, snapshot) {
  snapshot?.forEach(([key, data]) => qc.setQueryData(key, data));
}

export function invalidateEntryData(qc) {
  qc.invalidateQueries({ queryKey: ['entries'] });
  qc.invalidateQueries({ queryKey: ['entryCounts'] });
  qc.invalidateQueries({ queryKey: ['customLists'] });
  qc.invalidateQueries({ queryKey: ['stats'] });
  qc.invalidateQueries({ queryKey: ['dashboardBootstrap'] });
  qc.invalidateQueries({ queryKey: ['libraryBootstrap'] });
}

export async function revalidateLibraryRevision(qc) {
  const previous = qc.getQueryData(libraryRevisionKey())?.revision;
  const current = await getLibraryRevision();
  qc.setQueryData(libraryRevisionKey(), current);
  if (previous == null || previous !== current?.revision) invalidateEntryData(qc);
  return true;
}

// For the modal edit/delete path: EntryFormModal still writes through the API
// itself, then calls back with the saved entry / deleted id. These sync the cache
// the same way the mutations do (optimistic patch/remove, then invalidate) so the
// current view reconciles under any active sort/filter.
export function syncUpdatedEntry(qc, updated) {
  if (updated) patchEntryEverywhere(qc, updated.id, updated);
  invalidateEntryData(qc);
}
export function syncDeletedEntry(qc, id) {
  removeEntryEverywhere(qc, id);
  invalidateEntryData(qc);
}

// A shared profile is read-only server-side; refuse writes here too so a stray
// affordance can't fire a request that is only going to come back 403.
function denyWhenShared() {
  if (readShareToken()) throw new Error('This is a read-only shared profile.');
}

export function useEntryMutations() {
  const qc = useQueryClient();

  const update = useMutation({
    mutationFn: ({ id, patch }) => { denyWhenShared(); return updateEntry(id, patch); },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['entries'] });
      const snapshot = qc.getQueriesData({ queryKey: ['entries'] });
      patchEntryEverywhere(qc, id, patch);
      return { snapshot };
    },
    onError: (_e, _v, ctx) => restoreSnapshot(qc, ctx?.snapshot),
    onSuccess: (updated, { id }) => { if (updated) patchEntryEverywhere(qc, id, updated); },
    onSettled: () => invalidateEntryData(qc),
  });

  const create = useMutation({
    mutationFn: (data) => { denyWhenShared(); return createEntry(data); },
    onSettled: () => invalidateEntryData(qc),
  });

  const remove = useMutation({
    mutationFn: (id) => { denyWhenShared(); return deleteEntry(id); },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['entries'] });
      const snapshot = qc.getQueriesData({ queryKey: ['entries'] });
      removeEntryEverywhere(qc, id);
      return { snapshot };
    },
    onError: (_e, _v, ctx) => restoreSnapshot(qc, ctx?.snapshot),
    onSettled: () => invalidateEntryData(qc),
  });

  const batchUpdate = useMutation({
    mutationFn: ({ ids, patch }) => { denyWhenShared(); return batchUpdateEntries(ids, patch); },
    onSettled: () => invalidateEntryData(qc),
  });

  const batchDelete = useMutation({
    mutationFn: (ids) => { denyWhenShared(); return batchDeleteEntries(ids); },
    onSettled: () => invalidateEntryData(qc),
  });

  return { update, create, remove, batchUpdate, batchDelete };
}
