import { useEffect } from 'react';
import {
  QueryClient, QueryClientProvider, dehydrate, hydrate,
} from '@tanstack/react-query';
import { readSessionCache, writeSessionCache } from './sessionCache.js';
import { getLibraryRevision } from '../api.jsx';
import { libraryRevisionKey } from './keys.js';

const QUERY_CACHE_AREA = 'queries';
const PERSISTED_QUERY_TYPES = new Set([
  'entries', 'entryCounts', 'customLists', 'stats', 'dashboardBootstrap',
  'libraryBootstrap', 'libraryRevision',
]);
const MAX_PERSISTED_ENTRY_QUERIES = 12;

function currentUsername() {
  try { return localStorage.getItem('auth_username') || ''; }
  catch { return ''; }
}

function isPersistedQuery(query) {
  return PERSISTED_QUERY_TYPES.has(query.queryKey?.[0]) && query.state.status === 'success';
}

function dehydrateUsefulQueries() {
  const queries = queryClient.getQueryCache().getAll();
  const entryQueries = queries
    .filter(query => query.queryKey?.[0] === 'entries' && query.state.status === 'success')
    .sort((a, b) => {
      const activeDiff = Number(b.getObserversCount() > 0) - Number(a.getObserversCount() > 0);
      return activeDiff || b.state.dataUpdatedAt - a.state.dataUpdatedAt;
    })
    .slice(0, MAX_PERSISTED_ENTRY_QUERIES);
  const allowedEntryHashes = new Set(entryQueries.map(query => query.queryHash));

  return dehydrate(queryClient, {
    shouldDehydrateQuery: query => (
      isPersistedQuery(query)
      && (query.queryKey[0] !== 'entries' || allowedEntryHashes.has(query.queryHash))
    ),
  });
}

// One QueryClient for the whole app. It lives at module scope so non-component
// code (auth login/logout in app.jsx) can reach it to clear cross-user cache.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Preload once per app session: a prefetched/loaded query is never refetched
      // just because time passed — only when something invalidates it. Library
      // mutations invalidate entries/counts/lists/stats (clearing the table
      // preloads), and useRevalidateOnFocus invalidates on tab refocus. This is
      // what makes "hover once, cached for the session" hold.
      staleTime: Infinity,
      gcTime: 30 * 60_000,
      // The app has its own focus handler (useRevalidateOnFocus) that also probes
      // the backend for offline recovery, so RQ's own focus refetch stays off to
      // avoid double-fetching.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const restoredUsername = currentUsername();
const restoredState = readSessionCache(QUERY_CACHE_AREA, restoredUsername);
if (restoredState) {
  hydrate(queryClient, restoredState);
  const dashboard = queryClient.getQueryData(['dashboardBootstrap']);
  if (dashboard && !Array.isArray(dashboard.activity)) {
    queryClient.invalidateQueries({ queryKey: ['dashboardBootstrap'] });
  }
}

export function DataProvider({ children }) {
  useEffect(() => {
    const username = currentUsername();
    if (!username || !restoredState) return;
    const previous = queryClient.getQueryData(libraryRevisionKey())?.revision;
    getLibraryRevision()
      .then(current => {
        queryClient.setQueryData(libraryRevisionKey(), current);
        if (previous == null || previous !== current?.revision) {
          queryClient.invalidateQueries({
            predicate: query => isPersistedQuery(query) && query.queryKey?.[0] !== 'libraryRevision',
          });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let timer;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const username = currentUsername();
        if (username) writeSessionCache(QUERY_CACHE_AREA, username, dehydrateUsefulQueries());
      }, 250);
    };
    const flush = () => {
      clearTimeout(timer);
      const username = currentUsername();
      if (username) writeSessionCache(QUERY_CACHE_AREA, username, dehydrateUsefulQueries());
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(save);
    window.addEventListener('pagehide', flush);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
