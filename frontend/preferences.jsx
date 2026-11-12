import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getSettings, updateSettings } from './api.jsx';
import { readSessionCache, writeSessionCache } from './data/sessionCache.js';

const SETTINGS_CACHE_AREA = 'settings';

// Mirror of backend schemas.DEFAULT_UI — the canonical shape of the single
// UI-preferences document. The backend always returns a default-merged doc, so
// this is only a fallback before settings have loaded (or outside the provider).
export const DEFAULT_UI = {
  display: {
    theme: 'dark',
    accent: 'blue',
  },
  // Granularity for rating entry/editing across the app: the up/down step size
  // and the grid ratings snap to on save. One of 0.1, 0.5, 1.0.
  rating_step: 1.0,
  // What each rating means to this user — free text, purely a reference (shown
  // in Console, and on a shared profile). Keys are the rating value as a string
  // so half-step text survives a granularity change and back. Rows rendered
  // follow `rating_step`, except 0.1 which uses the 0.5 grid.
  rating_definitions: {
    '10': 'Perfect. Nothing I would change, and long enough to earn it. A lifetime favourite.',
    '9':  'Outstanding. A couple of trivial nitpicks at most. Recommend without reservation.',
    '8':  'Very good. Clearly flawed somewhere (pacing, an arc, the length) but the highs are high.',
    '7':  'Good. Enjoyed it. Worth recommending to people who like the genre, not to everyone.',
    '6':  'Decent. More good than bad. Worth the time if the premise appeals.',
    '5':  'Mixed. The good and the bad cancel out. Finished it without regret or enthusiasm.',
    '4':  'Weak. A few redeeming parts, but I would not tell anyone to bother.',
    '3':  'Bad. Occasional flashes of something, mostly a slog.',
    '2':  'Very bad. Finished out of stubbornness or morbid curiosity.',
    '1':  'Worthless. No redeeming qualities.',
  },
  mediums: {
    visible: [
      'Film', 'TV Show', 'Anime', 'Book', 'Manga',
      'Light Novel', 'Web Novel', 'Comic', 'Game', 'Visual Novel',
    ],
  },
  library: {
    default_mode: 'view',
    default_sort: 'completed_at',
    entries_per_page: 40,
    fix_title: true,
    quick_actions: false,
    sidebars: {
      left: false,
      right: false,
    },
    // Library table columns. Two ordered groups the user assigns by dragging:
    // `standard` (shown by default) and `additional` (extra, off by default,
    // toggleable from the library sidebar). `shown` is which columns actually
    // render; order within each group comes from these arrays, standard first.
    columns: {
      standard:   ['medium', 'status', 'rating', 'completed'],
      additional: ['year', 'progress', 'custom_list', 'updated'],
      shown:      ['medium', 'status', 'rating', 'completed'],
    },
  },
  dashboard: {
    current_rows: 5,
    planned_rows: 5,
    completed_rows: 20,
    // Statuses the "Recently Rated" table draws from. All of them by default:
    // a dropped or shelved entry you rated is just as recently consumed as one
    // you finished.
    rated_statuses: ['current', 'planned', 'completed', 'on_hold', 'dropped'],
    sidebars: {
      left: false,
      right: false,
    },
    split: 60,   // % width of the "currently consuming" column vs "planned" (manual mode only)
    // When false (default), the Current/Planned split is computed adaptively to
    // even out the whitespace after the longest title in each table. When true,
    // `split` above is used verbatim.
    manual_split: false,
    fixed_tables: {
      current: true,
      planned: true,
      completed: true,
    },
    columns: {
      current:   ['progress', 'status', 'rating'],
      planned:   ['medium', 'status'],
      completed: ['medium', 'completed', 'rating'],
    },
  },
  statistics: {
    consumed_range: 12,
    added_range: 5,
    sections: {
      summary: true,
      consumed: true,
      added: false,
      by_medium: true,
      completion: true,
      backlog: true,
      rating_distribution: true,
      rating_comparison: true,
      by_status: true,
      by_origin: true,
      release_years: true,
    },
  },
  explore: {
    default_medium: null,
    sidebars: {
      left: false,
      right: false,
    },
    personalize: true,
    hide_in_library: true,
  },
};

const PreferencesContext = createContext(null);

const FALLBACK = {
  settings: null,
  prefs: DEFAULT_UI,
  loaded: false,
  error: false,
  reload: async () => {},
  updateSettings: async () => {},
  updateUi: async () => {},
};

// Backoff schedule (ms) for retrying the initial settings fetch. A cold start
// (PC just booted, self-hosted backend not reachable yet) must not be mistaken
// for "no saved settings" — we retry before giving up.
const RETRY_DELAYS = [400, 800, 1600, 3200];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function PreferencesProvider({ authKey, children }) {
  const initialSettings = readSessionCache(SETTINGS_CACHE_AREA, authKey);
  const [settings, setSettings] = useState(initialSettings);
  const [loaded, setLoaded] = useState(Boolean(initialSettings));
  const [error, setError] = useState(false);
  // Generation counter so a slow/late load for a previous authKey can't clobber
  // the current user's state once it finally resolves.
  const genRef = useRef(0);

  const loadSettings = useCallback(async ({ retry = true } = {}) => {
    if (!authKey) return false;
    const gen = ++genRef.current;
    const attempts = retry ? RETRY_DELAYS.length + 1 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const s = await getSettings();
        if (genRef.current !== gen) return false;   // superseded by a newer load
        setSettings(s);
        writeSessionCache(SETTINGS_CACHE_AREA, authKey, s);
        setError(false);
        setLoaded(true);
        return true;
      } catch {
        if (genRef.current !== gen) return false;
        if (i < attempts - 1) await sleep(RETRY_DELAYS[i]);
      }
    }
    // Every attempt failed. Surface the error but DON'T null out a doc we may
    // already hold — a failed fetch must never masquerade as a settings reset.
    if (genRef.current === gen) { setError(true); setLoaded(true); }
    return false;
  }, [authKey]);

  // Initial load (and reset) whenever the signed-in user changes.
  useEffect(() => {
    genRef.current++;   // cancel any in-flight load
    if (!authKey) { setSettings(null); setLoaded(false); setError(false); return; }
    const cached = readSessionCache(SETTINGS_CACHE_AREA, authKey);
    setSettings(cached);
    setLoaded(Boolean(cached));
    setError(false);
    loadSettings();
  }, [authKey, loadSettings]);

  // Self-heal: if the session started without good settings (backend was down),
  // re-pull when the tab regains focus or the network comes back.
  useEffect(() => {
    if (!authKey) return undefined;
    const onWake = () => { if (error || !settings) loadSettings({ retry: false }); };
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [authKey, error, settings, loadSettings]);

  const update = useCallback(async (patch) => {
    const saved = await updateSettings(patch);
    setSettings(saved);
    writeSessionCache(SETTINGS_CACHE_AREA, authKey, saved);
    setError(false);
    return saved;
  }, [authKey]);

  const updateUi = useCallback((uiPatch) => update({ ui: uiPatch }), [update]);

  const value = {
    settings,
    prefs: settings?.ui || DEFAULT_UI,
    loaded,
    error,
    reload: () => loadSettings({ retry: false }),
    updateSettings: update,
    updateUi,
  };

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  return useContext(PreferencesContext) || FALLBACK;
}
