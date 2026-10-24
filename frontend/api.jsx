import { readShareToken } from './data/shareSession.js';

export const BASE = import.meta.env.VITE_API_BASE;

// A shared-profile token (per tab) wins over the signed-in account's token, so
// opening someone's share link renders their library without touching your login.
const getToken = () => readShareToken() || localStorage.getItem('auth_token');
const BACKEND_NETWORK_ERROR_KEY = 'logarium_backend_network_error';

export function markBackendNetworkError() {
  try { sessionStorage.setItem(BACKEND_NETWORK_ERROR_KEY, '1'); } catch { /* ignore */ }
}

export function clearBackendNetworkError() {
  try { sessionStorage.removeItem(BACKEND_NETWORK_ERROR_KEY); } catch { /* ignore */ }
}

export function hadBackendNetworkError() {
  try { return sessionStorage.getItem(BACKEND_NETWORK_ERROR_KEY) === '1'; }
  catch { return false; }
}

async function req(path, options = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      ...options,
    });
  } catch (err) {
    if (err?.name !== 'AbortError') markBackendNetworkError();
    throw err;
  }
  clearBackendNetworkError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  // 204 No Content has no body
  if (res.status === 204) return null;
  return res.json();
}

// ── Share profile ─────────────────────────────────────────────────────────────

// Who the current bearer token belongs to, and whether it can write. Used by
// the /s/<token> route to resolve a link (and to reject a dead one).
export const getShareSession   = ()  => req('/share/session');
export const getShareLink      = ()  => req('/share/link');
export const enableShareLink   = ()  => req('/share/link', { method: 'POST' });
export const regenerateShareLink = () => req('/share/link/regenerate', { method: 'POST' });
export const disableShareLink  = ()  => req('/share/link', { method: 'DELETE' });

// ── Auth ──────────────────────────────────────────────────────────────────────

// Start a session on the public demo account. Deliberately a bare fetch with no
// Authorization header: /demo must work while a share session (or another
// account's token) is live in the tab, and the share guard refuses POSTs.
export async function demoLogin() {
  const res = await fetch(`${BASE}/auth/demo`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json(); // { access_token, token_type, username }
}

export async function login(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json(); // { access_token, token_type }
}

export async function register(username, email, password) {
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json(); // { username, email }
}

export async function changePassword(currentPassword, newPassword) {
  return req('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

// ── Entries ───────────────────────────────────────────────────────────────────

export const getEntries = (params = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
  ).toString();
  return req(`/entries${qs ? '?' + qs : ''}`);
};

export const getEntryCounts = (params = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null)),
  ).toString();
  return req(`/entries/counts${qs ? '?' + qs : ''}`);
};

// Returns the user's existing entry whose source/external URL matches, or null.
export async function findEntryByUrl(externalUrl) {
  if (!externalUrl) return null;
  const data = await getEntries({ external_url: externalUrl, limit: 1 });
  const item = data?.items && data.items[0];
  // Guard: confirm the match (a backend that ignores the filter would otherwise
  // return an arbitrary first entry and cause a false positive).
  return item && item.external_url === externalUrl ? item : null;
}

export const getEntry    = (id)        => req(`/entries/${id}`);
export const createEntry = (data)      => req('/entries', { method: 'POST', body: JSON.stringify(data) });
export const updateEntry = (id, data)  => req(`/entries/${id}`, { method: 'PUT',  body: JSON.stringify(data) });
export const deleteEntry = (id)        => req(`/entries/${id}`, { method: 'DELETE' });

// Bulk operations — one atomic request each, scoped server-side to the user.
export const batchUpdateEntries = (ids, patch) =>
  req('/entries/batch', { method: 'POST', body: JSON.stringify({ ids, patch }) });
export const batchDeleteEntries = (ids) =>
  req('/entries/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
export const getDuplicateEntries = () => req('/entries/duplicates');

export const getCustomLists = () => req('/custom-lists');
export const renameCustomList = (name, newName) =>
  req(`/custom-lists/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ new_name: newName }),
  });
export const clearCustomList = (name) =>
  req(`/custom-lists/${encodeURIComponent(name)}`, { method: 'DELETE' });

export async function exportEntries() {
  const res = await fetch(`${BASE}/entries/export`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${res.statusText}`);
  return res.blob();
}

export async function previewImport(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/entries/import/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export async function confirmImport(payload) {
  const res = await fetch(`${BASE}/entries/import/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

/**
 * Start an auto-import SSE stream. Returns { reader, abort }.
 * - onEvent(event): called for each parsed SSE event object
 * - Call abort() to cancel mid-stream
 */
export async function startAutoImport(file, onEvent) {
  const controller = new AbortController();
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${BASE}/entries/import/auto`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
    signal: controller.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  async function pump() {
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();
        for (const chunk of chunks) {
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
          if (dataLine) {
            try {
              onEvent(JSON.parse(dataLine.slice(6)));
            } catch (_) { /* ignore malformed */ }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  }

  return { pump, abort: () => controller.abort() };
}

/**
 * Start a MAL XML import SSE stream. Returns { pump, abort }.
 * - onEvent(event): called for each parsed SSE event object
 * - Call abort() to cancel mid-stream
 */
export async function startMalImport(file, onEvent) {
  const controller = new AbortController();
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${BASE}/entries/import/mal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
    signal: controller.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  async function pump() {
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();
        for (const chunk of chunks) {
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
          if (dataLine) {
            try {
              onEvent(JSON.parse(dataLine.slice(6)));
            } catch (_) { /* ignore malformed */ }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  }

  return { pump, abort: () => controller.abort() };
}

export async function confirmMalImport(entries) {
  const res = await fetch(`${BASE}/entries/import/mal/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export const checkDuplicates = (items) =>
  req('/entries/check-duplicates', { method: 'POST', body: JSON.stringify({ items }) });

// Mirrors backend _SOURCE_PRIORITY — lower index = higher trust.
const _SOURCE_PRIORITY = [
  'novelupdates', 'vndb', 'mal', 'tmdb', 'igdb',
  'anilist', 'kitsu', 'mangadex', 'mangaupdates',
  'google_books', 'open_library', 'comicvine', 'rawg',
];
const _sourceRank = s => { const i = _SOURCE_PRIORITY.indexOf(s); return i === -1 ? _SOURCE_PRIORITY.length : i; };

export async function searchMedia(title, sources = [], extended = false) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : (sources ? [sources] : []);
  const limit = extended ? '50' : '10';
  if (list.length === 0) {
    return req(`/search?${new URLSearchParams({ title, limit })}`);
  }
  if (list.length === 1) {
    return req(`/search?${new URLSearchParams({ title, source: list[0], limit })}`);
  }
  // Multiple sources: fan out in parallel then deduplicate + rank client-side
  const groups = await Promise.all(
    list.map(source => req(`/search?${new URLSearchParams({ title, source, limit })}`).catch(() => []))
  );
  const combined = groups.flat();
  const seen = new Set();
  const deduped = combined.filter(r => {
    const key = `${r.title?.toLowerCase()?.trim()}|${r.medium}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => _sourceRank(a.source) - _sourceRank(b.source));
  return extended ? deduped : deduped.slice(0, 10);
}

/** Scrape a single supported media-page URL into a one-item result list. */
export const fetchByUrl = (url) =>
  req(`/search/from-url?${new URLSearchParams({ url })}`);

/** Look up a latest chapter total for a title via MangaUpdates → { total }. */
export const fetchChapterCount = (title) =>
  req(`/search/chapter-count?${new URLSearchParams({ title })}`);

/** Resolve IMDb detail (rating, episode count, …) for a tt id → SearchResult. */
export const fetchImdbDetail = (id) =>
  req(`/search/imdb-detail?${new URLSearchParams({ id })}`);

/**
 * Upload cover image bytes to the server cache, keyed by the original cover URL.
 * Used by the browser extension to cache covers it fetched first-party (e.g.
 * Cloudflare-protected NovelUpdates covers that can't be fetched server-side).
 * Multipart, so it bypasses the JSON `req()` helper.
 */
/** URL of one cached sized cover (thumb|medium|full), for direct <img src>. */
export const coverImgUrl = (coverUrl, size = 'full', coverKey = '') => {
  if (coverKey) return `${BASE}/covers/${size}/${coverKey}.jpg`;
  return coverUrl ? `${BASE}/covers/img?${new URLSearchParams({ url: coverUrl, size })}` : '';
};

/**
 * Cover src for an Explore card. Both cover endpoints serve from our cache only
 * and 404 on a miss, and Explore is the one page routinely showing covers the
 * server has never fetched, so an uncached item paints from the source URL for
 * this first render. The ingest that the same response kicked off fills the
 * cache, and every later render comes from us.
 */
export const exploreCoverUrl = (item, size = 'medium') => (
  item?.cover_cached
    ? coverImgUrl(item.cover_url, size, item.cover_key)
    : (item?.cover_url || '')
);

/**
 * Warm the browser cache for a cover's full size, so the detail modal image is
 * instant on click. It's a plain immutable GET, so the browser HTTP cache does
 * the work — no React Query needed. Best-effort; a 404 (uncached) is harmless.
 */
export function prefetchFullCover(coverUrl, coverKey = '') {
  if (!coverUrl) return Promise.resolve();
  return prefetchCoverImages([{ cover_url: coverUrl, cover_key: coverKey }], 'full');
}

const coverImagePrefetches = new Map();

/** Warm and decode cached cover files so a subsequent render can paint them. */
export function prefetchCoverImages(covers, size = 'medium') {
  const sources = [...new Set((covers || []).map(cover => (
    typeof cover === 'string'
      ? coverImgUrl(cover, size)
      : coverImgUrl(cover?.cover_url, size, cover?.cover_key)
  )).filter(Boolean))];
  return Promise.all(sources.map(src => {
    if (coverImagePrefetches.has(src)) return coverImagePrefetches.get(src);
    const task = new Promise(resolve => {
      const img = new Image();
      img.onload = async () => {
        try { await img.decode?.(); } catch { /* The downloaded image is still reusable. */ }
        resolve();
      };
      img.onerror = resolve;
      img.src = src;
    });
    coverImagePrefetches.set(src, task);
    return task;
  }));
}

export async function uploadCover(coverUrl, blob) {
  const body = new FormData();
  body.append('cover_url', coverUrl);
  body.append('image', blob, 'cover.jpg');
  const res = await fetch(`${BASE}/covers/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return null;
}

/**
 * Server-side cache all not-yet-cached covers. Returns { pump, abort } like the
 * import streams: `onEvent` receives { type: 'start'|'progress'|'done', … }.
 */
export async function startCoverCache(onEvent) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/covers/cache-all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    signal: controller.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  async function pump() {
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();
        for (const chunk of chunks) {
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
          if (dataLine) {
            try { onEvent(JSON.parse(dataLine.slice(6))); } catch (_) { /* ignore malformed */ }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  }

  return { pump, abort: () => controller.abort() };
}

export const getStats = () => req('/stats');
export const getDashboardBootstrap = () => req('/bootstrap/dashboard');
export const getLibraryBootstrap = (params = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value != null)),
  ).toString();
  return req(`/bootstrap/library${qs ? `?${qs}` : ''}`);
};
export const getLibraryRevision = () => req('/library/revision');

export const deleteAllEntries = () => req('/entries', { method: 'DELETE' });

// ── Settings ──────────────────────────────────────────────────────────────────

export const getSettings    = ()        => req('/auth/me/settings');
export const updateSettings = (patch)   => req('/auth/me/settings', { method: 'PUT', body: JSON.stringify(patch) });

// ── Backup ────────────────────────────────────────────────────────────────────

export const getBackupStatus = () => req('/backup/status');
export const runBackup       = () => req('/backup/run', { method: 'POST' });

// ── Explore ───────────────────────────────────────────────────────────────────

// "Personalize" is a server-side preference read from the user's settings — it
// is NOT passed as a query param from the page. Empty `medium` returns the
// aggregate "All" view; a medium with `refresh: true` rerolls just that medium
// (the only path that hits providers). Plain reads serve the cache.
export const getExplore = ({ medium, limit, offset, seed, refresh, sources } = {}) => {
  const params = { medium, limit, offset, seed };
  if (refresh) params.refresh = 'true';
  // Comma-separated list of sitewide-available sources; the backend applies it
  // as a response filter without making source selection part of cache identity.
  const sourceList = Array.isArray(sources) ? sources : [...(sources || [])];
  if (sourceList.length) params.sources = sourceList.join(',');
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== '' && v != null),
    ),
  ).toString();
  return req(`/explore${qs ? '?' + qs : ''}`);
};

// Clear a medium's failed-reroll state and return its previous cached set
// (the "display previous results" action). Does not reroll.
export const restoreExplore = (medium, sources) => {
  const params = { medium };
  if (Array.isArray(sources) && sources.length) params.sources = sources.join(',');
  const qs = new URLSearchParams(params).toString();
  return req(`/explore/restore?${qs}`, { method: 'POST' });
};

function cleanExploreItem(item) {
  const cleanInt = (value) => (value === '' || value == null ? null : Number.parseInt(value, 10));
  const cleanFloat = (value) => (value === '' || value == null ? null : Number.parseFloat(value));
  return {
    ...item,
    year: cleanInt(item?.year),
    total: cleanInt(item?.total),
    external_rating: cleanFloat(item?.external_rating),
  };
}

export const writeExploreCache = ({ medium, items, sources, limit } = {}) => {
  const params = {};
  if (Array.isArray(sources) && sources.length) params.sources = sources.join(',');
  if (limit) params.limit = String(limit);
  const qs = new URLSearchParams(params).toString();
  return req(`/explore/cache${qs ? '?' + qs : ''}`, {
    method: 'POST',
    body: JSON.stringify({
      medium,
      items: Array.isArray(items) ? items.map(cleanExploreItem) : [],
    }),
  });
};
