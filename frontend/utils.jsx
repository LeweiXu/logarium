import { BASE } from './api.jsx';

export const STATUSES = ['current', 'planned', 'completed', 'on_hold', 'dropped'];

export const MEDIUMS = [
  'Film', 'TV Show', 'Anime', 'Book', 'Manga',
  'Light Novel', 'Web Novel', 'Comic', 'Game', 'Visual Novel',
];

export function visibleMediumsFromPrefs(prefs) {
  const raw = prefs?.mediums?.visible;
  if (!Array.isArray(raw)) return MEDIUMS;
  const selected = new Set(raw);
  return MEDIUMS.filter(medium => selected.has(medium));
}

export function visibleMediumSetFromPrefs(prefs) {
  return new Set(visibleMediumsFromPrefs(prefs));
}

export function mediumIsVisible(medium, prefs) {
  if (!medium) return true;
  return visibleMediumSetFromPrefs(prefs).has(medium);
}

export const RATING_OPTIONS = Array.from({ length: 11 }, (_, i) => i);

// Snap a rating to the chosen granularity grid (0.1 / 0.5 / 1.0), clamped to 0-10.
// Passes through empty/blank so an unset rating stays unset.
export const roundToStep = (v, step) => {
  if (v === '' || v == null) return v;
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  const r = Math.round(n / step) * step;
  return Math.min(10, Math.max(0, parseFloat(r.toFixed(2))));
};

// The rating values a user can write a definition for, highest first. Follows
// the chosen granularity, except 0.1 (101 rows is not a usable form) which uses
// the 0.5 grid. 0 is skipped: an unrated entry has no rating at all.
export function ratingScale(step) {
  const grid = step === 0.5 || step === 0.1 ? 0.5 : 1;
  const out = [];
  for (let v = 10; v >= grid; v -= grid) out.push(parseFloat(v.toFixed(1)));
  return out;
}

// Key a rating value into the rating_definitions map ("8", "8.5").
export const ratingKey = (value) => String(parseFloat(Number(value).toFixed(1)));

export const ORIGINS = ['Japanese', 'Korean', 'Chinese', 'Western', 'Other'];

export const STATUS_LABELS = {
  current:   'Current',
  planned:   'Planned',
  completed: 'Completed',
  on_hold:   'On Hold',
  dropped:   'Dropped',
};

export const statusLabel   = (s) => STATUS_LABELS[s] ?? s;
export const badgeClass    = (s) => `badge badge-${s}`;

// ── Adaptive inter-column gap ────────────────────────────────────────────────
// The fixed-title tables (Library + Dashboard) space their data columns with a
// gap that grows as the table gets wider. How much room the data columns need
// depends on how many are shown and how wide each is, so we feed those two facts
// into CSS as `--col-count` / `--col-data` and let the clamp in
// library-dashboard.css do the rest (see the knobs documented there).
//
// Approximate per-column footprint (px). Mirrors the fixed-title min-widths in
// library-dashboard.css — keep roughly in sync if you change those. It only has
// to be close: the CSS `--col-gap-*` knobs absorb any slack.
export const TABLE_COL_WIDTH = {
  medium: 92, year: 66, progress: 112, status: 132, rating: 84,
  updated: 102, completed: 112, custom_list: 236,
};
export const TABLE_ACTION_WIDTH = 140;   // Quick-Actions column
export const TABLE_SELECT_WIDTH = 34;    // multi-select checkbox column

// Build the inline CSS vars a fixed-title table needs for its adaptive gaps.
// `cols` are the data columns (excluding the pinned Title). `actions` adds the
// Quick-Actions column (it takes a gap too); `select` adds the multi-select
// checkbox column (it does NOT take a gap, but still eats width).
export function tableGapVars(cols, { actions = false, select = false } = {}) {
  const gapCount = cols.length + (actions ? 1 : 0);
  let dataWidth = cols.reduce((sum, c) => sum + (TABLE_COL_WIDTH[c] ?? 90), 0);
  if (actions) dataWidth += TABLE_ACTION_WIDTH;
  if (select)  dataWidth += TABLE_SELECT_WIDTH;
  return { '--col-count': Math.max(gapCount, 1), '--col-data': `${dataWidth}px` };
}

/**
 * Generic fallback cover, used when a cover image fails to load (e.g. the many
 * NovelUpdates covers that 404/403 behind Cloudflare and can't be hotlinked).
 * It's an inline SVG data URI — no network request, no image hosted by us, and
 * nothing to rot. Transparent background so the cover container's themed
 * colour shows through and it reads correctly in both dark and light themes.
 */
const _COVER_PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 92 132" preserveAspectRatio="xMidYMid meet">' +
  '<g fill="none" stroke="#7a7d82" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">' +
  '<rect x="24" y="42" width="44" height="40"/>' +
  '<circle cx="37" cy="55" r="4.5"/>' +
  '<path d="M26 78 L44 62 L54 70 L66 56 L66 80 Z" fill="#7a7d82" fill-opacity="0.18"/>' +
  '</g>' +
  '<text x="46" y="100" font-family="monospace" font-size="9" letter-spacing="1.5" ' +
  'text-anchor="middle" fill="#7a7d82">NO COVER</text></svg>';

export const COVER_PLACEHOLDER =
  'data:image/svg+xml,' + encodeURIComponent(_COVER_PLACEHOLDER_SVG);

/** URL of the server-side cached copy of a cover (uploaded by the extension). */
export const cachedCoverUrl = (coverUrl) =>
  coverUrl ? `${BASE}/covers/img?${new URLSearchParams({ url: coverUrl, size: 'full' })}` : '';

/**
 * Shared <img onError> handler with a 3-stage fallback:
 *   original cover_url → server-side cached copy → generic placeholder.
 * The original (e.g. a Cloudflare-gated NovelUpdates cover) often 403s in the
 * browser; if the extension has cached it we serve that, otherwise the inline
 * "NO COVER" placeholder. Cached is fallback-only — never prioritised — so
 * working covers still load straight from source at full speed.
 */
export function onCoverError(e) {
  const img = e.currentTarget;
  const stage = img.dataset.coverStage;
  if (!stage) {
    // Original failed. At this point img.src is the resolved original URL.
    const cached = cachedCoverUrl(img.src);
    if (cached) {
      img.dataset.coverStage = 'cached';
      img.src = cached;
      return;
    }
    img.dataset.coverStage = 'placeholder';
    img.src = COVER_PLACEHOLDER;
    return;
  }
  if (stage === 'cached') {
    // No cached copy either → generic placeholder.
    img.dataset.coverStage = 'placeholder';
    img.src = COVER_PLACEHOLDER;
  }
  // stage === 'placeholder': data URI can't fail; nothing more to do.
}

/** Resolve an <img> src for a table/card cover: the cached bundle data URI, or
 *  the placeholder. We never hotlink the external URL — covers are served only
 *  from our cache (filled at ingest: entry add, extension upload, Explore reroll). */
/** onError for a cached-cover <img>: fall straight to the placeholder (used when
 *  a cover isn't cached yet, e.g. a Cloudflare/NU cover awaiting the extension). */
export function onCoverErrorPlaceholder(e) {
  const img = e.currentTarget;
  if (img.src === COVER_PLACEHOLDER) return;
  // Covers render from our cache, which is filled by a background task that
  // finishes after the page has painted. So a cover the server has only just
  // seen (an entry refreshed from its source, a new entry, a new Explore page)
  // is a 404 on this first render. Try the source URL once before giving up, so
  // it shows immediately and our cached copy takes over on the next render.
  const source = img.dataset.coverSrc;
  if (source && !img.dataset.coverTriedSource && img.src !== source) {
    img.dataset.coverTriedSource = '1';
    img.src = source;
    return;
  }
  img.src = COVER_PLACEHOLDER;
}

export const logDotClass = (status) => ({
  current:   'log-dot blue',
  planned:   'log-dot purple',
  completed: 'log-dot',
  on_hold:   'log-dot amber',
  dropped:   'log-dot red',
}[status] ?? 'log-dot');

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs  = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5)  return `${weeks}w ago`;
  return fmtDate(iso);
}

export function progressPercent(entry) {
  if (!entry) return 0;
  const { progress, total } = entry;
  if (!total) return 0;
  return Math.min(100, Math.round((progress / total) * 100));
}

export function progressLabel(entry) {
  if (!entry) return '—';
  const { progress, total, medium } = entry;
  if (!progress && !total) return '—';
  const m = medium?.toLowerCase() ?? '';
  const unit = (m === 'book' || m === 'light novel') ? 'vol.'
             : (m === 'manga' || m === 'web novel' || m === 'comic' || m === 'visual novel') ? 'ch.'
             : m === 'game' ? 'hr.'
             : 'ep.';
  if (total) return `${progress ?? '?'} / ${total} ${unit}`;
  return `${progress} ${unit}`;
}

const _SOURCE_DOMAINS = {
  'themoviedb.org':         'tmdb',
  'anilist.co':             'anilist',
  'myanimelist.net':        'mal',
  'kitsu.io':               'kitsu',
  'kitsu.app':              'kitsu',
  'novelupdates.com':       'novelupdates',
  'mangadex.org':           'mangadex',
  'igdb.com':               'igdb',
  'rawg.io':                'rawg',
  'books.google.com':       'google_books',
  'play.google.com':        'google_books',
  'openlibrary.org':        'open_library',
  'comicvine.gamespot.com': 'comicvine',
  'mangaupdates.com':       'mangaupdates',
  'baka-updates.com':       'mangaupdates',
  'vndb.org':               'vndb',
  'jjwxc.net':              'jjwxc',
  'qidian.com':             'qidian',
  'imdb.com':               'imdb',
  'goodreads.com':          'goodreads',
};

/** Sources whose pages can be imported by pasting a URL (resolved backend-side). */
export const URL_SCRAPE_SOURCES = new Set([
  'novelupdates', 'jjwxc', 'qidian', 'imdb', 'goodreads',
  'tmdb', 'anilist', 'mal', 'kitsu', 'mangadex', 'mangaupdates',
  'igdb', 'rawg', 'google_books', 'open_library', 'comicvine', 'vndb',
]);

/** True if the string looks like a pasteable http(s) URL rather than a title. */
export function isUrl(s) {
  return /^https?:\/\//i.test((s || '').trim());
}

/** Infer the source name from a URL, or return '' if unrecognised. */
export function inferSourceFromUrl(url) {
  if (!url) return '';
  const lower = url.toLowerCase();
  for (const [domain, source] of Object.entries(_SOURCE_DOMAINS)) {
    if (lower.includes(domain)) return source;
  }
  return '';
}

/** Build a link to the entry's page on its external source database */
export function externalUrl(source, external_id, medium) {
  if (!source || !external_id) return null;
  switch (source) {
    case 'anilist': {
      const type = (medium === 'Anime') ? 'anime' : 'manga';
      return `https://anilist.co/${type}/${external_id}`;
    }
    case 'tmdb': {
      // Entries created from TV searches have medium "TV Show"
      const type = (medium === 'TV Show') ? 'tv' : 'movie';
      return `https://www.themoviedb.org/${type}/${external_id}`;
    }
    case 'google_books':
      return `https://books.google.com/books?id=${external_id}`;
    case 'goodreads':
      return `https://www.goodreads.com/book/show/${external_id}`;
    case 'imdb':
      return `https://www.imdb.com/title/${external_id}/`;
    default:
      return null;
  }
}

/** Normalise the varied shapes the backend might return for a list response */
export function extractItems(data) {
  if (Array.isArray(data)) return data;
  return data?.items ?? data?.entries ?? data?.results ?? [];
}
