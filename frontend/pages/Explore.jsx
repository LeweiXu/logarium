import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  exploreCoverUrl, getExplore, prefetchCoverImages, restoreExplore, writeExploreCache,
} from '../api.jsx';
import { MEDIUMS, statusLabel, onCoverErrorPlaceholder, visibleMediumsFromPrefs } from '../utils.jsx';
import { useQueryClient } from '@tanstack/react-query';
import { queryClient } from '../data/client.jsx';
import { readSessionCache, writeSessionCache } from '../data/sessionCache.js';
import { loadAvailableSources } from './components/searchSources.js';
import { SkeletonExploreGrid } from './components/Skeletons.jsx';
import AddEntryModal from './components/AddEntryModal.jsx';
import AddEntryPanel from './components/AddEntryPanel.jsx';
import EntryDetailModal from './components/EntryDetailModal.jsx';
import { useExtensionPresent, extensionGoodreadsExplore, extensionNuExplore, mergeResults } from '../extensionBridge.js';
import { usePreferences, DEFAULT_UI } from '../preferences.jsx';
import { useShare } from '../share.jsx';

// 32-bit unsigned integer; backend re-seeds Python's RNG with it on a reroll.
const newSeed = () => Math.floor(Math.random() * 0xffffffff);

// Stable identity for an explore item (mirrors the backend's de-dupe key) —
// used for the React list key and to key per-card UI state (add/added/error)
// instead of array index, which isn't safe once a reroll swaps a medium's set.
const itemKey = (item) => `${(item.title || '').toLowerCase().trim()}|${item.medium || ''}`;

// Fetch a large candidate pool so source filtering still fills the grid; the
// page paginates client-side.
const EXPLORE_FETCH_LIMIT = 120;
const REC_PAGE_SIZE = 30;
const EXPLORE_CACHE_AREA = 'explore';

async function readExplorePage({ medium, offset = 0, sources }) {
  const sourceList = Array.isArray(sources) ? sources : [...(sources || [])];
  const data = await getExplore({ medium, limit: REC_PAGE_SIZE, offset, sources: sourceList });
  if (Number.isFinite(data.total)) return data;

  // During a staggered deployment, the previous backend ignores `offset` and
  // has no total. Keep pagination working until the new API reaches production.
  const legacy = await getExplore({ medium, limit: EXPLORE_FETCH_LIMIT, sources: sourceList });
  const items = legacy.items || [];
  return {
    ...legacy,
    items: items.slice(offset, offset + REC_PAGE_SIZE),
    total: items.length,
    offset,
    limit: REC_PAGE_SIZE,
  };
}

// Cover URLs for a medium's first recommendation page — mirrors the page's
// visibleItems filter + first-page slice, so a hover-prefetch bundles the exact
// same cover set the page will request (matching React Query key).
function firstPageCovers(items, availableSet, visibleMediumSet) {
  return items
    .filter(item => availableSet.has(item.source) && (!item.medium || visibleMediumSet.has(item.medium)))
    .slice(0, REC_PAGE_SIZE)
    .map(item => item.cover_url)
    .filter(Boolean);
}

// Recommendation pages survive navigation and hard reloads within this browser
// session. The owner is checked before every access so cached data cannot cross
// accounts when somebody logs out and signs in as another user.
const exploreCache = {};
let exploreCacheOwner = null;

window.addEventListener('logarium-session-cache-clear', event => {
  if (event.detail?.username !== exploreCacheOwner) return;
  for (const key of Object.keys(exploreCache)) delete exploreCache[key];
  exploreCacheOwner = null;
});

const pageOffset = page => (page - 1) * REC_PAGE_SIZE;
const viewKey = (medium, offset = 0) => `${medium}\u0000${offset}`;

function currentUsername() {
  try { return localStorage.getItem('auth_username') || ''; }
  catch { return ''; }
}

function ensureExploreCacheOwner() {
  const username = currentUsername();
  if (username === exploreCacheOwner) return username;
  for (const key of Object.keys(exploreCache)) delete exploreCache[key];
  exploreCacheOwner = username;
  const restored = readSessionCache(EXPLORE_CACHE_AREA, username) || {};
  for (const [key, entry] of Object.entries(restored)) {
    exploreCache[key] = { ...entry, needsRevalidation: true };
  }
  return username;
}

function persistExploreCache() {
  const username = ensureExploreCacheOwner();
  if (!username) return;
  const serializable = Object.fromEntries(
    Object.entries(exploreCache).map(([key, entry]) => {
      const { needsRevalidation: _ignored, ...stored } = entry;
      return [key, stored];
    }),
  );
  writeSessionCache(EXPLORE_CACHE_AREA, username, serializable);
}

function cachedExplore(medium, offset = 0) {
  ensureExploreCacheOwner();
  return exploreCache[viewKey(medium, offset)];
}

function storeExplore(medium, offset, entry, persist = true) {
  ensureExploreCacheOwner();
  exploreCache[viewKey(medium, offset)] = { ...entry, needsRevalidation: false };
  if (persist) persistExploreCache();
  return exploreCache[viewKey(medium, offset)];
}

function clearMediumCache(medium, persist = true) {
  ensureExploreCacheOwner();
  const prefix = `${medium}\u0000`;
  for (const key of Object.keys(exploreCache)) {
    if (key.startsWith(prefix)) delete exploreCache[key];
  }
  if (persist) persistExploreCache();
}

const clearExploreCache = () => {
  ensureExploreCacheOwner();
  for (const key of Object.keys(exploreCache)) delete exploreCache[key];
  persistExploreCache();
};

// In-flight rerolls (the only provider-hitting path), tracked at module scope so
// a reroll started before navigating away (to another medium OR another page on
// the site) isn't dropped: the network request, the cache write, and the start
// time all live here, and a remount re-attaches to the same task to keep showing
// the "rerolling… Ns elapsed" state and apply the result when it lands.
const rerollTasks = {};       // medium -> Promise<entry>
const rerollStartedAt = {};   // medium -> ms (per-medium reroll start)
// Reroll All fans out across every visible medium; its own promise + start time
// so the aggregate view can reflect/rejoin it independently.
const rerollAllState = { promise: null, startedAt: 0 };

const cacheSignature = values => [...new Set(values || [])].sort().join('\u0000');

function cacheMatches(entry, want, personalize, visibleMediums) {
  return !!entry
    && entry.personalize === personalize
    && entry.sourceSignature === cacheSignature(want)
    && entry.visibleMediumSignature === cacheSignature(visibleMediums);
}

function cacheEntryFromData(data, want, personalize, visibleMediums) {
  return {
    items:        data.items || [],
    affinity:     data.affinity || null,
    personalised: !!data.personalised,
    rerollFailed: !!data.reroll_failed,
    rerollError:  data.reroll_error || '',
    total:        data.total ?? (data.items || []).length,
    sources:      want,
    sourceSignature: cacheSignature(want),
    visibleMediumSignature: cacheSignature(visibleMediums),
    personalize,
  };
}

function warmExploreCovers(_qc, items) {
  const cached = (items || []).filter(item => item.cover_cached && item.cover_url);
  prefetchCoverImages(cached, 'medium');
}

// Warm the default Explore view (aggregate "All") + its card covers, so hovering
// the Explore nav link makes the click paint instantly. Called from app.jsx's
// route prefetch — it lives here (not app.jsx) so it stays in the lazy Explore
// chunk, and it writes into the same module cache the page reads on mount.
export function prefetchExploreHome(prefs) {
  const medium = '';  // the default aggregate view (read-only, never rerolls)
  const offset = 0;
  const want = [...loadAvailableSources()];
  const personalize = (prefs?.explore || DEFAULT_UI.explore).personalize !== false;
  const visibleMediums = visibleMediumsFromPrefs(prefs);
  const warmCovers = (items) => {
    const visibleMediumSet = new Set(visibleMediums);
    const firstPageUrls = new Set(firstPageCovers(items || [], new Set(want), visibleMediumSet));
    warmExploreCovers(queryClient, (items || []).filter(item => firstPageUrls.has(item.cover_url)));
  };
  const cached = cachedExplore(medium, offset);
  const usableCached = cacheMatches(cached, want, personalize, visibleMediums);
  if (usableCached && !cached.needsRevalidation) {
    warmCovers(cached.items);
    return;
  }
  if (usableCached) warmCovers(cached.items);
  readExplorePage({ medium, offset, sources: want })
    .then(data => {
      // A speculative hover should never replace useful state with a transient
      // empty aggregate. The mounted page can still confirm and display a real
      // empty library if its own read also returns no recommendations.
      if (!(data.items || []).length) return;
      const entry = storeExplore(
        medium, offset, cacheEntryFromData(data, want, personalize, visibleMediums),
      );
      warmCovers(entry.items);
    })
    .catch(() => {});
}

// Reroll one medium: fetch a fresh set, run the Goodreads/NovelUpdates extension
// fallback when relevant, then write the per-medium cache and invalidate the
// aggregate "All" cache. Returns the resulting cache entry. Deduped per medium
// and run at module scope so it survives a remount. `extPresent` is captured at
// kick-off (it can't change mid-reroll in a way that matters here).
function rerollMediumTask(targetMedium, want, personalize, visibleMediums, extPresent) {
  if (rerollTasks[targetMedium]) return rerollTasks[targetMedium];
  rerollStartedAt[targetMedium] = Date.now();
  const task = (async () => {
    const seed = newSeed();
    const data = await getExplore({
      medium: targetMedium, limit: EXPLORE_FETCH_LIMIT, seed, refresh: true, sources: want,
    });
    let entry = cacheEntryFromData(data, want, personalize, visibleMediums);
    // Cloudflare/WAF-blocked sources can come back empty server-side; if the
    // extension is present, fetch first-party and merge the results in. This is
    // the only place extension fallback runs — never on a plain page load.
    if (extPresent) {
      const recs = data.items || [];
      let extra = [];
      if (targetMedium === 'Book' && want.includes('goodreads')
          && !data.reroll_failed && !recs.some(it => it.source === 'goodreads')) {
        const genre = (data.affinity?.top_genres || [])[0] || '';
        extra = await extensionGoodreadsExplore(genre);
        if (extra.length) entry = { ...entry, items: mergeResults(entry.items, extra) };
      } else if (targetMedium === 'Web Novel' && want.includes('novelupdates')) {
        const nuMissing = !recs.some(it => it.source === 'novelupdates');
        if (data.reroll_failed || nuMissing) {
          extra = await extensionNuExplore({ seed, limit: EXPLORE_FETCH_LIMIT });
          if (extra.length) {
            const items = data.reroll_failed ? extra : mergeResults(entry.items, extra);
            try {
              const persisted = await writeExploreCache({
                medium: targetMedium,
                items,
                sources: want,
                limit: EXPLORE_FETCH_LIMIT,
              });
              entry = cacheEntryFromData(persisted, want, personalize, visibleMediums);
            } catch (persistErr) {
              console.warn('Failed to persist NovelUpdates extension Explore results', persistErr);
              entry = { ...entry, items, rerollFailed: false, rerollError: '' };
            }
          }
        }
      }
    }
    clearMediumCache(targetMedium, false);
    storeExplore(targetMedium, 0, {
      ...entry,
      items: entry.items.slice(0, REC_PAGE_SIZE),
    }, false);
    clearMediumCache('', false);
    persistExploreCache();
    return entry;
  })().finally(() => {
    if (rerollTasks[targetMedium] === task) {
      delete rerollTasks[targetMedium];
      delete rerollStartedAt[targetMedium];
    }
  });
  rerollTasks[targetMedium] = task;
  return task;
}

export default function Explore() {
  ensureExploreCacheOwner();
  // A shared profile can browse the owner's recommendations but not act on them:
  // no adding, no rerolling (a reroll spends their provider API keys), no search.
  const { isShare } = useShare();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Medium filter, restored from the URL on load. Resolve it before seeding the
  // recommendation state so a hover-prefetched cache entry can render on the
  // first frame instead of passing through the skeleton once.
  const initialUrlMedium = useRef(searchParams.get('medium') || '');
  const [medium, setMedium] = useState(
    () => (MEDIUMS.includes(initialUrlMedium.current) ? initialUrlMedium.current : ''),
  );
  const { prefs } = usePreferences();
  const expPrefs = prefs.explore || DEFAULT_UI.explore;
  const personalize = expPrefs.personalize !== false;
  const initialSourcesRef = useRef(loadAvailableSources());
  const visibleMediums = useMemo(() => visibleMediumsFromPrefs(prefs), [prefs]);
  const initialOffset = pageOffset(1);
  const initialCached = cachedExplore(medium, initialOffset);
  const initialEntryRef = useRef(cacheMatches(
    initialCached, initialSourcesRef.current, personalize, visibleMediums,
  ) ? initialCached : null);
  const initialEntry = initialEntryRef.current;

  const [items,        setItems]        = useState(() => initialEntry?.items || []);
  const [affinity,     setAffinity]     = useState(() => initialEntry?.affinity || null);
  const [personalised, setPersonalised] = useState(() => !!initialEntry?.personalised);
  const [loading,      setLoading]      = useState(() => !initialEntry);
  const [error,        setError]        = useState('');
  // Failed-reroll state for the *currently selected* medium (persisted in the DB
  // and mirrored in the per-medium cache, so it survives filter switches/reloads).
  const [rerollFailed, setRerollFailed] = useState(() => !!initialEntry?.rerollFailed);
  const [rerollError,  setRerollError]  = useState(() => initialEntry?.rerollError || '');
  const [totalSuggestions, setTotalSuggestions] = useState(() => initialEntry?.total ?? initialEntry?.items?.length ?? 0);
  const exploreRequestSeq = useRef(0);

  // Latest selected medium, readable inside async callbacks without going stale.
  const mediumRef = useRef(medium);
  useEffect(() => { mediumRef.current = medium; }, [medium]);

  // Per-card UI state — keyed by `itemKey()` (title+medium) since explore items
  // have no DB id until added. 'idle' | 'adding' | 'added:<status>' | 'error:<msg>'
  const [cardState, setCardState] = useState({});
  const [pendingAdd, setPendingAdd] = useState(null);
  // Entries created during this Explore session, keyed by `itemKey()` — lets the
  // user click an "added" card to inspect/edit/delete it via EntryDetailModal.
  const [addedEntries, setAddedEntries] = useState({});
  // Mediums currently being rerolled (a per-medium reroll, or each medium during
  // Reroll All) — several can run in parallel.
  const [rerollingMediums, setRerollingMediums] = useState(() => new Set());
  // True while a "Reroll All" is fanning out across every visible medium.
  const [rerollAllBusy, setRerollAllBusy] = useState(false);
  const [detailEntry,  setDetailEntry]  = useState(null);
  const [busySeconds,  setBusySeconds]  = useState(0);
  // Mobile drawer state — '', 'left', or 'right'.
  const [drawer, setDrawer] = useState('');
  // Selected search sources for the top search box only (in-memory, never
  // persisted, resets to all-available on reload).
  const initialUrlQuery = useRef(searchParams.get('q') || '');
  const [selectedSources, setSelectedSources] = useState(() => new Set());
  // True while the top search/add section is showing results or a URL preview;
  // when true we hide the recommendations and show the search output instead.
  const [searchActive, setSearchActive] = useState(false);
  const [recPage, setRecPage] = useState(1);
  // Confirm dialog before Reroll All (the slow every-medium scan).
  const [confirmReroll, setConfirmReroll] = useState(false);

  // Sitewide-available sources (Console setting) — limit which recommendations
  // are shown. Read once on mount.
  const availableSet = useMemo(() => initialSourcesRef.current, []);
  const extPresent = useExtensionPresent();

  const sidebarClass = `${expPrefs.sidebars?.left ? ' always-show-left' : ''}${expPrefs.sidebars?.right ? ' always-show-right' : ''}`;
  const visibleMediumSet = useMemo(() => new Set(visibleMediums), [visibleMediums]);

  const thisMediumRerolling = !!medium && rerollingMediums.has(medium);

  // ── Apply a cache entry / response into component state ──────────────────
  const applyEntry = useCallback((entry) => {
    setItems(entry.items || []);
    setAffinity(entry.affinity || null);
    setPersonalised(!!entry.personalised);
    setRerollFailed(!!entry.rerollFailed);
    setRerollError(entry.rerollError || '');
    setTotalSuggestions(entry.total ?? entry.items?.length ?? 0);
  }, []);

  // Tick an elapsed counter while a reroll affecting the current view runs. The
  // start time lives at module scope, so the count keeps going (rather than
  // restarting from 0) after navigating away and back mid-reroll.
  useEffect(() => {
    const isAll = medium === '' && rerollAllBusy;
    const active = thisMediumRerolling || isAll;
    if (!active) { setBusySeconds(0); return; }
    const startedAt = (isAll ? rerollAllState.startedAt : rerollStartedAt[medium]) || Date.now();
    const tick = () => setBusySeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [thisMediumRerolling, rerollAllBusy, medium]);

  // Keep the medium filter in the URL (?medium=) so a reload restores it.
  useEffect(() => {
    if (medium && !visibleMediumSet.has(medium)) { setMedium(''); return; }
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (medium) next.set('medium', medium); else next.delete('medium');
      return next;
    }, { replace: true });
  }, [medium, setSearchParams, visibleMediumSet]);

  const handlePanelSearch = useCallback((q) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (q) next.set('q', q); else next.delete('q');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // ── Read path — cache only, never hits providers ────────────────────────
  // Page load and filter switches land here. '' → aggregate "All"; a medium →
  // that medium's cached set plus its failed-reroll state. `force` re-reads from
  // the backend (used after an add so "in library" tags refresh).
  const fetchExplore = useCallback(async ({ force = false } = {}) => {
    // A reroll for this view is already in flight (e.g. started, then navigated
    // away and back) — don't paint stale cache underneath it; the rejoin effect
    // below shows the skeleton and applies the result when it lands.
    if (medium && rerollTasks[medium]) { setLoading(false); return; }
    if (!medium && rerollAllState.promise) { setLoading(false); return; }
    const offset = pageOffset(recPage);
    const cached = cachedExplore(medium, offset);
    const want = [...availableSet];
    const usableCached = cacheMatches(cached, want, personalize, visibleMediums);
    if (!force && usableCached) {
      setError('');
      setCardState({});
      applyEntry(cached);
      setLoading(false);
      if (!cached.needsRevalidation) return;
    }
    const seq = ++exploreRequestSeq.current;
    setLoading(!usableCached); setError(''); setCardState({});
    try {
      const data = await readExplorePage({ medium, offset, sources: want });
      if (seq !== exploreRequestSeq.current) return;
      const entry = storeExplore(
        medium, offset, cacheEntryFromData(data, want, personalize, visibleMediums),
      );
      applyEntry(entry);
    } catch (e) {
      if (seq !== exploreRequestSeq.current) return;
      setError(e.message);
    } finally {
      if (seq === exploreRequestSeq.current) setLoading(false);
    }
  }, [medium, recPage, availableSet, personalize, visibleMediums, applyEntry]);

  useEffect(() => { fetchExplore(); }, [fetchExplore]);

  // Warm a medium's recommendation set on hover, so switching the sidebar filter
  // paints instantly. Writes straight into the same module cache fetchExplore
  // reads from; skips anything already cached or mid-reroll. Best-effort.
  const prefetchMedium = useCallback((m) => {
    if (m === medium || rerollTasks[m]) return;
    // Warm the medium's first-page card covers (same set the page renders), even
    // when the recommendation data itself is already cached.
    const warmCovers = (entry) => warmExploreCovers(qc, entry.items || []);
    const cached = cachedExplore(m, 0);
    const want = [...availableSet];
    const usableCached = cacheMatches(cached, want, personalize, visibleMediums);
    if (usableCached && !cached.needsRevalidation) { warmCovers(cached); return; }
    if (usableCached) warmCovers(cached);
    readExplorePage({ medium: m, offset: 0, sources: want })
      .then(data => {
        const entry = storeExplore(
          m, 0, cacheEntryFromData(data, want, personalize, visibleMediums),
        );
        warmCovers(entry);
      })
      .catch(() => {});
  }, [medium, availableSet, personalize, visibleMediums, qc]);

  // Stable refs so the rejoin effect (run only on medium change/mount) can call
  // the latest fetch/apply without re-subscribing and double-joining.
  const fetchExploreRef = useRef(fetchExplore);
  useEffect(() => { fetchExploreRef.current = fetchExplore; }, [fetchExplore]);

  // ── Reroll one medium (provider-hitting) ────────────────────────────────
  // The actual work lives in the module-scope `rerollMediumTask` (survives a
  // remount); here we just reflect the busy state and apply the result if the
  // user is still viewing that medium.
  const doRerollMedium = useCallback(async (targetMedium) => {
    setRerollingMediums(prev => new Set(prev).add(targetMedium));
    try {
      const entry = await rerollMediumTask(
        targetMedium, [...availableSet], personalize, visibleMediums, extPresent,
      );
      if (mediumRef.current === targetMedium) {
        setRecPage(1);
        applyEntry({ ...entry, items: entry.items.slice(0, REC_PAGE_SIZE) });
      }
    } catch (e) {
      if (mediumRef.current === targetMedium) setError(e.message || String(e));
      throw e;
    } finally {
      setRerollingMediums(prev => { const n = new Set(prev); n.delete(targetMedium); return n; });
    }
  }, [availableSet, personalize, visibleMediums, extPresent, applyEntry]);

  // Reroll All — fan out across every visible medium independently, then refresh
  // the aggregate view. Tracked at module scope so it survives navigating away.
  const doRerollAll = useCallback(() => {
    if (!rerollAllState.promise) {
      rerollAllState.startedAt = Date.now();
      const want = [...availableSet];
      rerollAllState.promise = Promise.allSettled(
        visibleMediums.map(m => rerollMediumTask(m, want, personalize, visibleMediums, extPresent)),
      ).then(() => { clearMediumCache(''); })
        .finally(() => { rerollAllState.promise = null; rerollAllState.startedAt = 0; });
    }
    setError('');
    setRerollAllBusy(true);
    rerollAllState.promise
      .then(() => { if (mediumRef.current === '') fetchExploreRef.current({ force: true }); })
      .finally(() => setRerollAllBusy(false));
  }, [visibleMediums, availableSet, personalize, extPresent]);

  // Re-attach to an in-flight reroll after a remount (navigated to another page
  // and back, or switched mediums): show its busy state and apply the result.
  useEffect(() => {
    if (medium && rerollTasks[medium]) {
      const task = rerollTasks[medium];
      setRerollingMediums(prev => new Set(prev).add(medium));
      task.then(entry => {
        if (mediumRef.current === medium) {
          setRecPage(1);
          applyEntry({ ...entry, items: entry.items.slice(0, REC_PAGE_SIZE) });
        }
      })
        .catch(() => {})
        .finally(() => setRerollingMediums(prev => { const n = new Set(prev); n.delete(medium); return n; }));
    }
    if (!medium && rerollAllState.promise) {
      setRerollAllBusy(true);
      rerollAllState.promise
        .then(() => { if (mediumRef.current === '') fetchExploreRef.current({ force: true }); })
        .finally(() => setRerollAllBusy(false));
    }
  }, [medium, applyEntry]);

  // A specific medium reroll is fast (one medium); only Reroll All is gated
  // behind the "this may take a while" confirm.
  const handleReroll = () => {
    if (medium) doRerollMedium(medium).catch(() => {});
    else setConfirmReroll(true);
  };
  useEffect(() => { setConfirmReroll(false); }, [medium]);

  // Display previous results — clear the failed flag (persisted) and reveal the
  // medium's previous cached set. Does not reroll.
  const handleRestore = useCallback(async () => {
    try {
      const want = [...availableSet];
      const data = await restoreExplore(medium, want);
      const entry = cacheEntryFromData(data, want, personalize, visibleMediums);
      setRecPage(1);
      clearMediumCache(medium, false);
      storeExplore(medium, 0, entry);
      applyEntry(entry);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, [medium, availableSet, personalize, visibleMediums, applyEntry]);

  // After an add from the search panel, the new entry should drop out of recs —
  // clear the cache and re-read so "in library" filtering picks it up.
  const handleAddPanelCreated = () => { clearExploreCache(); fetchExplore({ force: true }); };

  const thisRerollBusy = medium ? thisMediumRerolling : rerollAllBusy;
  const rerollLabel = medium ? `Reroll ${medium}` : 'Reroll All';

  const rerollControl = isShare ? null : confirmReroll ? (
    <div className="explore-reroll-confirm">
      <span className="explore-reroll-confirm-msg">This may take a while.</span>
      <div className="explore-reroll-confirm-actions">
        <button type="button" className="btn"
          onClick={() => { setConfirmReroll(false); doRerollAll(); }}>Confirm</button>
        <button type="button" className="btn btn-outline"
          onClick={() => setConfirmReroll(false)}>Cancel</button>
      </div>
    </div>
  ) : (
    <button type="button" className="quickadd-open-btn explore-reroll-btn"
      onClick={handleReroll} disabled={thisRerollBusy}
      title={medium ? `Pull a fresh set of ${medium} suggestions` : 'Pull a fresh set of suggestions for every medium'}>
      {thisRerollBusy ? 'Rerolling…' : rerollLabel}
    </button>
  );

  // Recommendations are limited to the sitewide-available sources and the
  // currently-visible mediums. The backend already orders them.
  const visibleItems = useMemo(() => (
    items
      .map(item => ({ item, key: itemKey(item) }))
      .filter(({ item }) => (
        availableSet.has(item.source)
        && (!item.medium || visibleMediumSet.has(item.medium))
      ))
  ), [items, availableSet, visibleMediumSet]);

  useEffect(() => { setRecPage(1); }, [medium]);

  const recTotalPages = Math.max(1, Math.ceil(totalSuggestions / REC_PAGE_SIZE));
  const pagedItems = visibleItems;

  // Hovering pagination fetches that small metadata page and decodes its covers.
  const prefetchExplorePage = useCallback((targetPage) => {
    if (targetPage < 1 || targetPage > recTotalPages) return;
    const offset = pageOffset(targetPage);
    const warm = entry => warmExploreCovers(qc, entry.items || []);
    const cached = cachedExplore(medium, offset);
    const want = [...availableSet];
    const usableCached = cacheMatches(cached, want, personalize, visibleMediums);
    if (usableCached && !cached.needsRevalidation) { warm(cached); return; }
    if (usableCached) warm(cached);
    readExplorePage({ medium, offset, sources: want })
      .then(data => warm(storeExplore(
        medium, offset, cacheEntryFromData(data, want, personalize, visibleMediums),
      )))
      .catch(() => {});
  }, [medium, recTotalPages, availableSet, personalize, visibleMediums, qc]);

  // What the main recommendation area should render.
  const showRerollSkeleton = !error && !loading && (thisMediumRerolling || (medium === '' && rerollAllBusy));
  // Failed-reroll UI only ever appears for a specific failed medium, never "All".
  const showFailed = !error && !loading && !showRerollSkeleton && !!medium && rerollFailed;
  const showEmptyPrompt = !error && !loading && !showRerollSkeleton && !showFailed && visibleItems.length === 0;

  function entryFromExploreItem(item, statusValue) {
    return {
      title:           item.title           || '',
      medium:          item.medium          || '',
      origin:          item.origin          || '',
      status:          statusValue,
      year:            item.year            || '',
      rating:          '',
      progress:        statusValue === 'completed' && item.total ? item.total : '',
      total:           item.total           || '',
      cover_url:       item.cover_url       || '',
      notes:           '',
      external_id:     item.external_id     || '',
      source:          item.source          || '',
      external_url:    item.external_url    || '',
      genres:          item.genres          || '',
      external_rating: item.external_rating ?? '',
    };
  }

  function openAddModal(key, item, statusValue) {
    setPendingAdd({ key, status: statusValue, entry: entryFromExploreItem(item, statusValue) });
  }

  function handleCardClick(key, item, owned) {
    if (owned) {
      const added = addedEntries[key];
      if (added) setDetailEntry(added);
      return;
    }
    openAddModal(key, item, 'planned');
  }

  function handleCardKeyDown(e, key, item, owned) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (owned) {
      const added = addedEntries[key];
      if (added) { e.preventDefault(); setDetailEntry(added); }
      return;
    }
    e.preventDefault();
    openAddModal(key, item, 'planned');
  }

  function handleEntryCreated(created) {
    if (!pendingAdd) return;
    const key = pendingAdd.key;
    setCardState(s => ({ ...s, [key]: `added:${created?.status || pendingAdd.status}` }));
    if (created) setAddedEntries(prev => ({ ...prev, [key]: created }));
    // Keep the persisted cache in sync so the card stays "in library" on return.
    const cached = cachedExplore(medium, pageOffset(recPage));
    if (cached) {
      const target = cached.items.find(it => itemKey(it) === key);
      if (target) {
        target.in_library = true;
        persistExploreCache();
      }
    }
    setPendingAdd(null);
  }

  function handleDetailUpdated(updated) {
    setDetailEntry(updated);
    setAddedEntries(prev => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (next[k]?.id === updated.id) next[k] = updated;
      return next;
    });
  }
  function handleDetailDeleted(id) {
    const keysToClear = Object.keys(addedEntries).filter(k => addedEntries[k]?.id === id);
    setAddedEntries(prev => { const n = { ...prev }; for (const k of keysToClear) delete n[k]; return n; });
    setCardState(prev => { const n = { ...prev }; for (const k of keysToClear) delete n[k]; return n; });
    setDetailEntry(null);
  }

  return (
    <div className={`layout-3col explore-layout${sidebarClass}`} data-drawer={drawer}>
      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer('')} aria-hidden="true" />
      )}
      <div className="sidebar-hover-zone sidebar-hover-zone-left" aria-hidden="true">
        <span>medium</span>
      </div>
      {/* ── Left sidebar: medium filter ─────────────────────────────────── */}
      <aside className="sidebar-left">
        <div className="sidebar-section">
          <span className="sidebar-label">Medium</span>
          <div className={'sidebar-item' + (medium === '' ? ' active' : '')}
            onMouseEnter={() => prefetchMedium('')}
            onClick={() => { setRecPage(1); setMedium(''); }}>
            <span>All</span>
          </div>
          {visibleMediums.map(m => (
            <div key={m}
              className={'sidebar-item' + (medium === m ? ' active' : '')}
              onMouseEnter={() => prefetchMedium(m)}
              onClick={() => { setRecPage(1); setMedium(m); }}>
              <span>{m}</span>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main content: card grid ─────────────────────────────────────── */}
      <main className="main-content">
        <div className="page-head">
          <div className="page-head-left">
            <button type="button" className="drawer-toggle"
              onClick={() => setDrawer(d => d === 'left' ? '' : 'left')}
              aria-label="Toggle medium filter" title="Medium">☰ Medium</button>
            <span className="page-title">Explore</span>
            {!searchActive && (
              <span className="page-desc">
                {loading || showRerollSkeleton
                  ? <span className="loading-dots">scanning</span>
                  : `${totalSuggestions} suggestions`}
              </span>
            )}
          </div>
          <div className="page-head-mobile">
            <button type="button" className="drawer-toggle"
              onClick={() => setDrawer(d => d === 'right' ? '' : 'right')}
              aria-label="Toggle taste profile & actions" title="Taste & actions">⋯</button>
          </div>
        </div>

        {/* Always-on search / add section. Not offered on a shared profile. */}
        {!isShare && <AddEntryPanel
          onCreated={handleAddPanelCreated}
          medium={medium}
          selectedSources={selectedSources}
          setSelectedSources={setSelectedSources}
          onActiveChange={setSearchActive}
          initialQuery={initialUrlQuery.current}
          onSearch={handlePanelSearch}
        />}

        {/* Recommendations — hidden while a search/URL query is active. */}
        {!searchActive && (
        <div className="explore-recs">
          <div className="section-header explore-recs-title">Recommended for you</div>

        {error && (
          <div className="state-block">
            <div className="state-title">Error</div>
            <div className="state-detail">{error}</div>
            <button className="btn btn-outline state-retry-btn" onClick={() => fetchExplore({ force: true })}>Retry</button>
          </div>
        )}

        {!error && loading && (
          <div className="skeleton-page" aria-label="Loading explore">
            <SkeletonExploreGrid cards={9} />
          </div>
        )}

        {showRerollSkeleton && (
          <div className="skeleton-page" aria-label={`Rerolling ${medium || 'all'}`}>
            <div className="explore-loading-note">
              Rerolling {medium || 'every medium'}{busySeconds >= 2 ? ` · ${busySeconds}s elapsed` : ''} —
              querying external sources, this can take a while.
            </div>
            <SkeletonExploreGrid cards={6} />
          </div>
        )}

        {showFailed && (
          <div className="state-block">
            <div className="state-title">Recommendations unavailable.</div>
            <div className="state-detail">{rerollError || 'The reroll did not return any recommendations.'}</div>
            {items.length > 0 && !isShare && (
              <button className="btn btn-outline state-retry-btn" onClick={handleRestore}>
                Display previous results
              </button>
            )}
          </div>
        )}

        {showEmptyPrompt && (
          <div className="state-block">
            <div className="state-title">
              {medium ? `No ${medium} recommendations yet.` : 'No recommendations yet.'}
            </div>
            <div className="state-detail">
              {medium
                ? `Use the Reroll ${medium} button to fetch a fresh set of suggestions.`
                : 'Use the Reroll All button to fetch recommendations across every medium.'}
            </div>
          </div>
        )}

        {!error && !loading && !showRerollSkeleton && !showFailed && visibleItems.length > 0 && (
        <div className="explore-grid">
          {pagedItems.map(({ item, key }) => {
            const state = cardState[key] || 'idle';
            const isAdded = state.startsWith('added:');
            const isError = state.startsWith('error:');
            const errMsg  = isError ? state.slice('error:'.length) : '';
            const addedAs = isAdded ? state.slice('added:'.length) : '';
            const owned       = item.in_library || isAdded;
            const interactive = !isShare && (!owned || !!addedEntries[key]);
            const hasMatches  = personalised && item.matches && item.matches.length > 0;

            return (
              <article key={key}
                       className={'explore-card' + (owned ? ' is-owned' : '') + (interactive ? '' : ' not-interactive')}
                       role={interactive ? 'button' : undefined}
                       tabIndex={interactive ? 0 : undefined}
                       onClick={isShare ? undefined : () => handleCardClick(key, item, owned)}
                       onKeyDown={isShare ? undefined : e => handleCardKeyDown(e, key, item, owned)}>
                <div className="explore-cover">
                  {item.cover_url
                    ? <img
                        src={exploreCoverUrl(item, 'medium')}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={onCoverErrorPlaceholder}
                      />
                    : <div className="explore-cover-empty">—</div>}
                </div>

                <div className="explore-body">
                  <div className="explore-title-row">
                    {item.external_url
                      ? <a href={item.external_url} target="_blank" rel="noopener noreferrer"
                           onClick={e => e.stopPropagation()}
                           className="explore-title">{item.title}</a>
                      : <span className="explore-title">{item.title}</span>}
                  </div>

                  <div className="explore-meta">
                    {item.medium && <span>{item.medium}</span>}
                    {item.year   && <span> · {item.year}</span>}
                    {item.origin && <span> · {item.origin}</span>}
                    {item.external_rating != null && <span> · </span>}
                    {item.external_rating != null && (
                      <span className="explore-meta-rating">★ {item.external_rating.toFixed(1)}</span>
                    )}
                  </div>

                  {hasMatches && (
                    <div className="explore-match" title="Genres, origin, or medium you consume most in your library">
                      matches: {item.matches.join(', ')}
                    </div>
                  )}

                  {item.description && (
                    <p className={'explore-desc' + (!hasMatches ? ' no-match' : '')}>{item.description}</p>
                  )}

                  {isError && <div className="explore-err">{errMsg}</div>}
                </div>

                {owned && (
                  <div className={'explore-card-overlay explore-card-added-overlay' + (addedAs ? ` status-${addedAs}` : '')}>
                    <span>{addedAs ? `✓ added · ${statusLabel(addedAs)}` : '✓ in library'}</span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        )}

        {!error && !loading && !showRerollSkeleton && !showFailed && recTotalPages > 1 && (
          <div className="explore-pagination">
            {recPage > 1 && <button className="icon-btn" onMouseEnter={() => prefetchExplorePage(1)} onClick={() => setRecPage(1)}>« First</button>}
            <button className="icon-btn" disabled={recPage === 1} onMouseEnter={() => prefetchExplorePage(recPage - 1)} onClick={() => setRecPage(p => p - 1)}>← Prev</button>
            <span className="pagination-text">Page {recPage} of {recTotalPages}</span>
            <button className="icon-btn" disabled={recPage === recTotalPages} onMouseEnter={() => prefetchExplorePage(recPage + 1)} onClick={() => setRecPage(p => p + 1)}>Next →</button>
            {recPage < recTotalPages && <button className="icon-btn" onMouseEnter={() => prefetchExplorePage(recTotalPages)} onClick={() => setRecPage(recTotalPages)}>Last »</button>}
          </div>
        )}
        </div>
        )}
      </main>

      {/* ── Right sidebar: affinity snapshot + actions ────────────────────── */}
      <div className="sidebar-hover-zone sidebar-hover-zone-right" aria-hidden="true">
        <span>taste</span>
      </div>
      <aside className="sidebar-right">
        <div className="panel-title">Your library</div>
        {!affinity || affinity.sample_size === 0 ? (
          <p className="explore-affinity-empty">
            Add a few entries to your library to bias what shows up here.
          </p>
        ) : (
          <>
            <div className="explore-affinity-meta">
              {affinity.sample_size} entries · {personalised ? 'bias on' : 'bias off'}
            </div>

            {affinity.top_genres.length > 0 && (
              <div className="explore-affinity-block">
                <div className="explore-affinity-label">Top genres</div>
                <div className="explore-tag-list">
                  {affinity.top_genres.map(g => (<span key={g} className="explore-tag">{g}</span>))}
                </div>
              </div>
            )}

            {affinity.top_origins.length > 0 && (
              <div className="explore-affinity-block">
                <div className="explore-affinity-label">Top origins</div>
                <div className="explore-tag-list">
                  {affinity.top_origins.map(o => (<span key={o} className="explore-tag">{o}</span>))}
                </div>
              </div>
            )}

            {affinity.top_mediums.length > 0 && (
              <div className="explore-affinity-block">
                <div className="explore-affinity-label">Top mediums</div>
                <div className="explore-tag-list">
                  {affinity.top_mediums.filter(m => visibleMediumSet.has(m)).map(m => (
                    <span key={m} className="explore-tag">{m}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="explore-affinity-note">
              {personalised
                ? 'Ranking nudges results toward your most-consumed genres and origins; the All view also leads with your most-consumed mediums. Toggle Personalize in Console → Explore.'
                : 'Personalization is off — recommendations are neutral. Turn it on in Console → Explore to bias results toward your library.'}
            </div>
          </>
        )}
        {rerollControl && <div className="explore-reroll-wrap">{rerollControl}</div>}
      </aside>

      {pendingAdd && (
        <AddEntryModal
          initialTab="manual"
          initialEntry={pendingAdd.entry}
          hideTabs
          onClose={() => setPendingAdd(null)}
          onCreated={handleEntryCreated}
        />
      )}

      {detailEntry && (
        <EntryDetailModal
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onUpdated={handleDetailUpdated}
          onDeleted={handleDetailDeleted}
        />
      )}

    </div>
  );
}
