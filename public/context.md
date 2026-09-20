# LOGARIUM Project Context

Last refreshed from the current repository and recent git history on 2026-06-26.

Use this file as the long-form handoff for future LLM sessions. Also provide
`AGENTS.md` and any files directly involved in the task. For frontend styling
work, include `frontend/styles.css` plus the relevant files under
`frontend/styles/`.

---

## 1. What Logarium Is

Logarium is a full-stack personal media tracker. It tracks one unified library
across:

- Film
- TV Show
- Anime
- Book
- Manga
- Light Novel
- Web Novel
- Comic
- Game
- Visual Novel

The application is multi-user. Users register/login, receive a JWT bearer token,
and all library data is scoped server-side by `username`.

The current product shape:

- React 18 + Vite frontend.
- FastAPI backend.
- PostgreSQL with SQLAlchemy 2 ORM and Alembic migrations.
- Plain CSS, now split into purpose-specific files under `frontend/styles/`.
- Browser extension for source-page capture and first-party cover uploads.
- Search aggregation across multiple external providers.
- Explore/recommendation page based on library affinity and available sources.
- Import/export, duplicate finding, custom lists, cover caching, and optional
  email backup tools in Console.

---

## 2. Recent Git History Snapshot

The recent history explains why the repo currently looks the way it does:

- `f0109f3 refactor frontend`
  - Split the large `frontend/styles.css` into `frontend/styles/*.css`.
  - Kept `frontend/styles.css` as the import entrypoint.
  - Moved static inline styles out of Library/Dashboard/component code.
  - Moved `context.md` to `public/context.md`.
  - Removed `ARCHITECTURE.md`; this context file now carries the living
    architecture notes.
- `b45ff5e revert Dashboard and Library pages to deployed version`
  - Restored Dashboard/Library behavior before the final CSS refactor.
- `231d88b rework table column sizing into standard + fixed modes`
  - Important for table layout: Library has normal and fixed-title table modes.
  - Be careful not to regress column sizing or title-cell behavior.
- `dc91738 move inline styles to CSS and document target architecture`
  - Initial pass extracting inline styles and documenting the intended CSS
    direction.
- `0f902ce redesign console tools page, fix Explore reroll bug`
  - Console tools were redesigned into inline/collapsible tool sections.
  - Added `NumberStepper`.
  - Improved Explore refresh/reroll behavior.
- `6155c46 improve Explore page behaviour`
  - Added/improved Explore preference behavior, including `combine_all`.
- `2fcbcb0 allow specific source selection sitewide`
  - Added sitewide available-source selection via `searchSources.js`.
- `c102ec2 add console page`
  - Settings merged into Console.
  - Former modal tools were converted into inline `*Panel` components.

When investigating behavior, prefer the current code over older context. Recent
frontend commits moved quickly and some older docs may be stale.

---

## 3. Repository Layout

```text
logarium/
├── AGENTS.md
├── README.md
├── CLOUDFLARE.md
├── dev.sh
├── public/
│   ├── context.md              # this file
│   └── test_novelupdates.py    # targeted scraper check
├── backend/
│   ├── main.py
│   ├── run.py
│   ├── config.py
│   ├── constants.py            # canonical status/medium/origin/source constants
│   ├── db.py
│   ├── models.py
│   ├── schemas.py              # Pydantic schemas + DEFAULT_UI
│   ├── routers.py              # single thin APIRouter
│   ├── requirements.txt
│   ├── README.md
│   ├── alembic.ini
│   ├── alembic/
│   │   └── versions/           # migrations are database history/source of truth
│   ├── scripts/
│   │   └── init_db.py
│   └── services/
│       ├── auth_service.py
│       ├── entry_service.py
│       ├── stats_service.py
│       ├── search_service.py
│       ├── explore_service.py
│       ├── import_service.py
│       ├── import_mal_service.py
│       ├── export_service.py
│       ├── url_import_service.py
│       ├── cover_cache_service.py
│       ├── backup_service.py
│       ├── email_service.py
│       ├── url_scrapers/
│       └── search_providers/
│           ├── __init__.py
│           ├── utils.py
│           ├── tmdb.py
│           ├── imdb.py
│           ├── anilist.py
│           ├── mal.py
│           ├── kitsu.py
│           ├── mangadex.py
│           ├── mangaupdates.py
│           ├── novelupdates.py
│           ├── igdb.py
│           ├── rawg.py
│           ├── google_books.py
│           ├── open_library.py
│           ├── comicvine.py
│           ├── goodreads.py
│           └── vndb.py
├── frontend/
│   ├── index.html
│   ├── index.jsx
│   ├── app.jsx                 # routes, topbar, auth shell, theme/accent
│   ├── api.jsx                 # all frontend API calls
│   ├── utils.jsx               # frontend enums/helpers mirrored with backend
│   ├── preferences.jsx         # PreferencesProvider + frontend DEFAULT_UI
│   ├── extensionBridge.js
│   ├── hooks.jsx
│   ├── design.css              # older design reference
│   ├── styles.css              # stable CSS import entrypoint
│   ├── styles/
│   │   ├── tokens.css
│   │   ├── base.css
│   │   ├── shell.css
│   │   ├── components.css
│   │   ├── library-dashboard.css
│   │   ├── statistics-explore.css
│   │   ├── responsive.css
│   │   ├── tools-add-custom.css
│   │   └── light.css
│   └── pages/
│       ├── Dashboard.jsx
│       ├── Library.jsx
│       ├── Explore.jsx
│       ├── Statistics.jsx
│       ├── Console.jsx
│       ├── LandingPage.jsx
│       └── components/
│           ├── AuthModal.jsx
│           ├── AddEntryModal.jsx
│           ├── AddEntryPanel.jsx
│           ├── QuickAddModal.jsx
│           ├── EntryForm.jsx
│           ├── EntryFormModal.jsx
│           ├── EntryDetailModal.jsx
│           ├── ConfirmEntryModal.jsx
│           ├── ListChips.jsx
│           ├── ListsPanel.jsx
│           ├── ListsModal.jsx
│           ├── InlineListSelect.jsx
│           ├── CustomListField.jsx
│           ├── DedupPanel.jsx
│           ├── CacheCoversPanel.jsx
│           ├── ResyncPanel.jsx
│           ├── ImportPanel.jsx
│           ├── ImportAutoPanel.jsx
│           ├── ImportMalPanel.jsx
│           ├── ExtensionInstallHint.jsx
│           ├── ExtensionDownloadSection.jsx
│           ├── ExtensionUpdateLink.jsx
│           ├── CustomSelect.jsx
│           ├── NumberStepper.jsx
│           ├── Skeletons.jsx
│           ├── terminal.jsx
│           └── searchSources.js
└── extension/
    ├── package.json
    ├── scripts/release.js
    ├── public/
    ├── src/
    ├── dist/
    └── dist-artifacts/
```

Notes:

- `context.md` intentionally lives under `public/` now.
- `ARCHITECTURE.md` was deleted in the current frontend refactor commit.
- `frontend/pages/components/*Panel.jsx` files are inline Console tool bodies,
  mostly extracted from older modal implementations.

---

## 4. Local Commands

Frontend:

```bash
cd frontend
npm install
npm start
npm run build
npm run preview
```

Backend:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
python main.py
```

Useful checks:

```bash
cd frontend && npm run build
git diff --check
```

Default ports:

- Frontend dev server: `3000`
- Backend API: `6443`

---

## 5. Backend Architecture

The backend uses one central `APIRouter` in `backend/routers.py`. Route handlers
should stay thin. Business logic belongs in `backend/services/`.

Important service boundaries:

- `auth_service.py`: user lookup, password hashing, token creation, current-user
  dependency.
- `entry_service.py`: entry CRUD, filtering, sorting, duplicate checks, custom
  lists, batch updates/deletes.
- `search_service.py`: provider dispatch, fan-out/dedup/ranking for backend
  search.
- `explore_service.py`: recommendation generation, user affinity profile,
  library-title filtering, Explore cache reads/writes.
- `stats_service.py`: aggregate statistics for the Statistics page.
- `import_service.py`: CSV import preview/confirm and auto-search SSE import.
- `import_mal_service.py`: MAL XML import SSE and confirm flow.
- `export_service.py`: CSV export.
- `url_import_service.py` and `url_scrapers/`: add-by-URL support.
- `cover_cache_service.py`: cover upload/cache/full-cover serving.
- `backup_service.py` and `email_service.py`: optional SMTP email backup.

Backend scripts:

- `backend/scripts/demo_script.py` refreshes `demo_user` from `lingwei` for demo
  data. It preserves demo login credentials, resets demo settings to
  `schemas.DEFAULT_UI`/`backup_freq="never"`/`last_backup_at=None`, and copies
  entries plus Explore cache rows from the source account. The demo script does
  not copy the source user's settings.

### Data Models

`User`:

- `username`: primary key, indexed.
- `email`: unique, indexed.
- `hashed_password`.
- `backup_freq`: real backend column, used by backup scheduling/behavior.
- `last_backup_at`.
- `ui_preferences`: JSON document for all client-facing layout/preferences.
- `share_token`: nullable, unique, indexed. `NULL` = profile sharing off.
  Otherwise a `shr_`-prefixed opaque token that grants read-only access to this
  user's library (see Share Profile below).

`Entry`:

- Core fields: `id`, `title`, `medium`, `origin`, `year`, `status`, `rating`,
  `progress`, `total`, `notes`.
- External metadata: `cover_url`, `external_id`, `source`, `external_url`,
  `genres`, `external_rating`.
- Custom grouping: `custom_list`.
- Timestamps: `created_at`, `updated_at`, `completed_at`.
- Ownership: `username` FK to `users.username`.

`ExploreCache`:

- Per-`(username, medium)` cache.
- `medium` is `""` for the all-medium Explore tab.
- `items_json` stores already-ranked `ExploreItem` dicts.
- Refresh on the Explore page bypasses/overwrites the row.
- Library-title filtering is still applied live after cache read.
- Current DB constraint: `UniqueConstraint("username", "medium")`.

### Canonical Values

`backend/constants.py` is the backend source of truth:

- Status: `current`, `planned`, `completed`, `on_hold`, `dropped`
- Medium: `Film`, `TV Show`, `Anime`, `Book`, `Manga`, `Light Novel`,
  `Web Novel`, `Comic`, `Game`, `Visual Novel`
- Origin: `Japanese`, `Korean`, `Chinese`, `Western`, `Other`, `""`

Schemas normalize common aliases before validation:

- `movie` -> `Film`
- `tv` -> `TV Show`
- `vn` -> `Visual Novel`
- `manhwa`/`manhua` -> `Manga`
- origin aliases such as `jp`, `kr`, `cn`, `us`, `uk`, etc.

Keep frontend option lists in sync with these values.

---

## 6. Backend API Contract

Health and some cover serving are public. Most routes require:

```text
Authorization: Bearer <token>
```

### Health

- `GET /` -> health payload.

### Auth and Settings

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/demo` - mints a normal (writable) session for the public demo
  account named by `settings.DEMO_USERNAME`, no credentials required. Backs the
  frontend's `/demo` route. 404s when the setting is blank or the account does
  not exist. The account is public by design and `scripts/demo_script.py` wipes
  and re-seeds it every 24h.
- `POST /auth/change-password`
- `GET /auth/me/settings`
- `PUT /auth/me/settings`

Settings shape:

- Read response: `{ backup_freq, ui }`
- `ui` is default-merged server-side with `schemas.DEFAULT_UI`.
- PUT accepts partial patches.
- `backup_freq` remains a scalar backend column.
- `ui` patches are deep-merged into `User.ui_preferences`.
- `ui.mediums.visible` controls visible media types. Entries are not deleted
  when a medium is hidden; the backend applies this list to `/entries`,
  `/custom-lists`, and `/stats`, while frontend selectors/search results hide
  the same mediums.
- Console's settings import/export uses this API for `{ backup_freq, ui }` and
  also serializes `localStorage.available_sources`, the one settings value that
  is not server-backed.

### Share Profile

- `GET /share/session` - who the current bearer token belongs to, and whether it
  is read-only. The only share route a share token may call.
- `GET /share/link` - owner's link state, `{ enabled, token }`.
- `POST /share/link` - turn sharing on (keeps an existing token).
- `POST /share/link/regenerate` - issue a new token; the previous link dies.
- `DELETE /share/link` - turn sharing off.

How it works:

- A `shr_`-prefixed token is accepted anywhere a bearer token is and resolves to
  the owning user (`services/auth_service.get_current_user`), so every read
  endpoint serves that user's data unchanged.
- Read-only is enforced by one chokepoint, the `share_link_guard` middleware in
  `main.py`: any method other than GET/HEAD/OPTIONS is 403, as are the GETs in
  `SHARE_BLOCKED_PATHS` (`/backup/status` carries the account email,
  `/entries/export` is a full library dump, `/search` and `/explore` spend the
  owner's API keys, `/share/link` is token management).
- The guard is registered before the CORS middleware so CORS stays outermost and
  a rejection reaches the browser as a real 403.
- `/explore` is readable on a shared profile (the owner's cached
  recommendations), but `?refresh=true` is refused: a reroll is a GET that
  spends the owner's provider API keys and overwrites their cached set.

### Entries

- `GET /entries`
  - Params: `status`, `medium`, `origin`, `title`, `custom_list`,
    `custom_list_empty`, `external_url`, `sort`, `order`, `limit`, `offset`.
  - Response: `{ items, total, limit, offset }`.
  - Applies `ui.mediums.visible` before counting and pagination.
- `GET /entries/{entry_id}`
- `POST /entries`
- `PUT /entries/{entry_id}`
- `DELETE /entries`
- `DELETE /entries/{entry_id}`

Batch/duplicate routes:

- `POST /entries/batch`
- `POST /entries/batch-delete`
- `GET /entries/duplicates`
- `POST /entries/check-duplicates`

Important: batch routes are POST routes, not PUT/DELETE.

### Custom Lists

- `GET /custom-lists`
- `PUT /custom-lists/{name:path}`
- `DELETE /custom-lists/{name:path}`

`name:path` allows list names that contain path-like characters. The frontend
uses `encodeURIComponent(name)`.

Custom-list summaries also apply `ui.mediums.visible`, so list counts only
reflect currently visible entries.

### Search

- `GET /search?title=&source=&limit=`
- `GET /search/from-url?url=`
- `GET /search/chapter-count?title=`
- `GET /search/imdb-detail?id=`

`/search` accepts one optional `source`. If `source` is omitted, the backend
searches its default/fan-out path. The frontend also supports multiple selected
sources by issuing parallel single-source requests and deduplicating/ranking
client-side in `frontend/api.jsx`.

`/search/from-url` supports direct source-page scraping. It usually returns one
result, but can return multiple results for some pages, such as a Goodreads
series URL.

### Explore

- `GET /explore?medium=&limit=&seed=&refresh=&sources=`

Behavior:

- Reads `ui.explore` from the authenticated user's settings.
- `sources` is a comma-separated available-source set from the frontend. It is
  applied as a response filter, not as part of the Explore cache key, so source
  setting changes should not force a provider reroll.
- `refresh=true` bypasses and overwrites the per-user/per-medium cache.
- Response: `{ items, affinity, personalised }`.

### Covers

- `POST /covers/upload`
- `GET /covers/full?url=`
- `POST /covers/cache-all`

`/covers/upload` is used by the browser extension. The extension fetches image
bytes first-party and uploads them so Cloudflare-gated covers can be cached.

`/covers/full` is public because image tags cannot send auth headers and cached
covers are not treated as sensitive.

`/covers/cache-all` is an authenticated SSE stream that server-side caches every
not-yet-cached cover it can fetch. Cloudflare-gated sources may fail server-side
and require the extension path.

### Stats

- `GET /stats`

Returns aggregate counts, ratings, medium/origin breakdowns, monthly activity,
completion rates, backlog age, rating comparisons, release-year stats, and
streak data. The aggregate is filtered by `ui.mediums.visible` server-side.

### Import/Export

- `GET /entries/export`
- `POST /entries/import/preview`
- `POST /entries/import/confirm`
- `POST /entries/import/auto`
- `POST /entries/import/mal`
- `POST /entries/import/mal/confirm`

Auto import and MAL import are SSE-style streaming endpoints.

### Backup

- `GET /backup/status`
- `POST /backup/run`

Backup requires SMTP config. If SMTP is not configured, the frontend should
disable or clearly gate backup actions.

---

## 7. Frontend Architecture

The frontend is a React 18 + Vite app.

### Routes

Routes live in `frontend/app.jsx`:

- `/`: logged-out landing page; authenticated users redirect to Dashboard.
- `/dashboard`
- `/library`
- `/explore`
- `/statistics`
- `/console`
- `/manage`: legacy bookmark route that renders Library in manage mode without
  exposing `?mode=manage`.
- `/settings`: redirects to `/console`.
- `*`: redirects based on auth state.

### Top-Level Pages

`Dashboard.jsx`:

- Shows current, planned, completed/recent, and activity views.
- Supports quick status/progress/rating interactions.
- Can send filters to Library through `onFilterChange`.
- Uses CSS variables for dynamic split and tiny chart/progress values.

`Library.jsx`:

- Main table for full library view.
- Supports filters, sorting, pagination, inline edits, quick actions, custom
  lists, and manage/multi-select mode.
- Manage mode replaces the old separate Manage page.
- Table formatting is sensitive. Preserve:
  - Fixed-title table mode is the default; Fluid Table is the opt-out mode.
  - Title-column sizing rules.
  - `library-table` and `is-fixed-title` class behavior.
  - `SortTh` active state and sort indicator behavior.
  - Pagination/action rows and manage/batch controls.

`Explore.jsx`:

- Recommendation surface.
- Uses available search sources and user Explore preferences.
- Supports personalized/neutral ranking behavior, hide-in-library behavior, and
  source restrictions.
- Hidden mediums are removed from the sidebar, recommendation cards, and
  affinity-medium tags client-side.
- `combine_all` determines whether all-medium recommendations are mixed from all
  medium-specific sets or fetched via legacy separate behavior.

`Statistics.jsx`:

- Recharts-based visualizations and summary cards.
- Section visibility and ranges are preference-driven.
- Uses CSS variables for dynamic tooltip/swatch/bar widths/colors/opacities.

`Console.jsx`:

- Merged settings and library tools page.
- Contains extension download/update UI, theme/accent controls, per-page layout
  settings, visible-medium selection, Explore settings, search-source
  availability, password change, backup controls, entry/settings import/export,
  custom lists, duplicates, cover caching, Quick Add, resync, rating
  definitions, share profile, and data wipe tools.
- Viewed through a share link the whole page renders greyed and inert (a
  `LockContext` every `Section`/`ToolCard` reads). Rating Definitions opts out
  with `unlocked` and auto-expands read-only; the extension cards and the Share
  Profile card are not rendered at all.
- Former modals are now mostly inline/collapsible `*Panel` components.

`LandingPage.jsx`:

- Logged-out marketing/login surface.
- The logged-out app shell is forced to dark/blue without overwriting the
  authenticated user's saved theme/accent.

### Auth and App State

- Token stored in `localStorage.auth_token`.
- Username stored in `localStorage.auth_username`.
- API base is `import.meta.env.VITE_API_BASE`.
- `app.jsx` performs a health check every 30 seconds.
- Theme is a root `light` class.
- Accent is `document.documentElement.dataset.accent`.
- Theme/accent are persisted only while authenticated, and never while viewing
  a shared profile (the owner's theme applies for the visit only).
- Shared-profile session lives in `sessionStorage` (`share_token`,
  `share_username`, see `frontend/data/shareSession.js`), so it is per-tab and
  ends with the tab. `api.jsx` prefers it over `auth_token`, which is what makes
  the whole app render the shared library. `frontend/share.jsx` exposes
  `useShare()` (`{ isShare, ownerUsername }`); pages use it to stop offering
  writes, and `useEntryMutations` throws for a share session as a backstop.
  `/s/:token` (`pages/ShareLanding.jsx`) resolves a link.
- `/demo` (`pages/DemoLanding.jsx`) signs the visitor into the demo account via
  `POST /auth/demo` and lands on the dashboard. It clears any share session in
  the tab first, since `api.jsx` would otherwise keep preferring that token. Explore stays browsable
  but inert: no search/add panel, no reroll, and the cards are not clickable.

### Preferences

Preferences are centralized in `frontend/preferences.jsx` and mirrored by
`backend/schemas.py` `DEFAULT_UI`.

Current `DEFAULT_UI` shape:

- `display`
  - `theme`
  - `accent`
- `rating_step`
- `rating_definitions` (map of rating value string to the user's own free-text
  definition; rows follow `rating_step`, except 0.1 which uses the 0.5 grid)
- `mediums`
  - `visible`
- `library`
  - `default_mode`
  - `default_sort`
  - `entries_per_page`
  - `fix_title`
  - `quick_actions`
  - `columns.view`
  - `columns.manage`
- `dashboard`
  - row counts
  - split percentage
  - fixed table toggles
  - columns for current/planned/completed tables
- `statistics`
  - ranges
  - section toggles
- `explore`
  - `default_medium`
  - `personalize`
  - `hide_in_library`
  - `by`
  - `combine_all`

Current default values:

- `display.theme`: `dark`
- `display.accent`: `blue`
- `rating_step`: `1.0`
- `mediums.visible`: `Film`, `TV Show`, `Anime`, `Book`, `Manga`,
  `Light Novel`, `Web Novel`, `Comic`, `Game`, `Visual Novel`
- `library.default_mode`: `view`
- `library.default_sort`: `updated_at`
- `library.entries_per_page`: `40`
- `library.fix_title`: `true` (fixed table by default)
- `library.quick_actions`: `false`
- `library.columns.view`: `medium`, `year`, `progress`, `status`, `rating`,
  `updated`, `completed`
- `library.columns.manage`: `status`, `medium`, `rating`, `progress`,
  `updated`, `custom_list`
- `dashboard.current_rows`: `5`
- `dashboard.planned_rows`: `5`
- `dashboard.completed_rows`: `20`
- `dashboard.split`: `60`
- `dashboard.fixed_tables.current`: `true`
- `dashboard.fixed_tables.planned`: `true`
- `dashboard.fixed_tables.completed`: `false` (fluid by default)
- `dashboard.columns.current`: `medium`, `progress`, `status`, `rating`
- `dashboard.columns.planned`: `medium`, `status`
- `dashboard.columns.completed`: `medium`, `progress`, `completed`, `status`,
  `rating`
- `statistics.consumed_range`: `12`
- `statistics.added_range`: `5`
- `statistics.sections`: all enabled
- `explore.default_medium`: `null`
- `explore.personalize`: `true`
- `explore.hide_in_library`: `true`
- `explore.by`: `all`
- `explore.combine_all`: `true`

Important behavior:

- The backend always returns a default-merged UI doc.
- Theme/accent live in `ui.display`; `localStorage.theme`/`localStorage.accent`
  are only a client-side cache so the app can paint immediately before settings
  finish loading.
- Frontend settings load uses retry/backoff so a cold backend does not look like
  a preference reset.
- Failed settings loads do not clear the current document.
- Settings self-heal on focus/online if a prior load failed.
- Avoid adding new localStorage preferences unless there is a strong reason.
- Deliberate exception: available search sources currently live in
  `localStorage.available_sources` via `searchSources.js`.

---

## 8. CSS Architecture

Plain CSS is the project convention. Do not add Tailwind, styled-components, or
CSS-in-JS without an intentional broader migration.

`frontend/styles.css` is now the stable import entrypoint:

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;1,300&display=swap');

@import './styles/tokens.css';
@import './styles/base.css';
@import './styles/shell.css';
@import './styles/components.css';
@import './styles/library-dashboard.css';
@import './styles/statistics-explore.css';
@import './styles/responsive.css';
@import './styles/tools-add-custom.css';
@import './styles/light.css';
```

Keep this import order unless there is a specific cascade reason to change it:

1. `tokens.css`
   - Theme, accent, chart, spacing, and color variables.
2. `base.css`
   - Reset, body, links, scrollbars.
3. `shell.css`
   - App shell, topbar, page layout, sidebars, buttons.
4. `components.css`
   - Shared primitives: tables, badges, progress/rating, cards, stats, logs,
     skeletons, modals, forms, chips, toggles.
5. `library-dashboard.css`
   - Library and Dashboard-specific helpers.
6. `statistics-explore.css`
   - Statistics, Explore, Landing, drawer preamble/comment styles.
7. `responsive.css`
   - Mobile, drawer, and responsive table behavior.
8. `tools-add-custom.css`
   - Console tools, add/custom/import panels, CustomSelect, batch edit.
9. `light.css`
   - Light theme overrides. Imported last intentionally.

Table/dropdown sizing contracts:

- `library-dashboard.css` owns Dashboard/Library table sizing. Library fixed
  tables cap inter-column padding at `96px`; Dashboard Current/Planned fixed
  tables cap it at `72px`; Dashboard Recently Completed fixed table caps it at
  `96px`. Dashboard fixed/fluid behavior is controlled per table via
  `ui.dashboard.fixed_tables`.
- `tools-add-custom.css` owns CustomSelect base sizing. Table status selects are
  explicitly `112px`; table custom-list selects are explicitly `224px`, truncate
  trigger text, and wrap long menu options. Settings row selects are explicitly
  `112px` via `.settings-row-select` so they remain the same width regardless of
  option text length.
- Custom list names are capped at 60 characters in frontend inputs and backend
  schema validation.

### CSS Variable Rules

Use CSS variables for:

- Theme/accent tokens.
- Shared dimensions, colors, borders, surfaces, and shadows.
- Dynamic values that must still be controlled by CSS selectors.

Allowed inline `style={{ ... }}` cases:

- Passing dynamic CSS custom properties, e.g.:
  - `--progress-pct`
  - `--completion-pct`
  - `--dash-current-fr`
  - `--dash-planned-fr`
  - `--bar-height`
  - `--tooltip-color`
  - `--pie-swatch`
  - `--bar-width`
  - `--bar-color`
  - `--bar-opacity`
  - `--rating-bar-width`
  - `--tool-progress-pct`
  - `--skeleton-width`
  - `--skeleton-height`
  - `--select-fit-width`
- Measured portal geometry in `CustomSelect.jsx` (`menuPosition`).

Avoid static inline CSS. Move static declarations into the appropriate CSS file.

### Table Formatting Warning

Library and Dashboard table styles are easy to regress. Before changing table
CSS, inspect:

- `Library.jsx`
- `Dashboard.jsx`
- `frontend/styles/components.css`
- `frontend/styles/library-dashboard.css`
- `frontend/styles/responsive.css`

Preserve:

- Header and body alignment.
- Fixed-title mode.
- Manage/multi-select table behavior.
- Inline editable cell hit areas.
- Compact progress/rating controls.
- Responsive behavior on narrow screens.

Run `npm run build` after table/UI work. If possible, also inspect in browser at
desktop and mobile widths.

---

## 9. Search Providers and Source Selection

Backend keyword-search providers currently registered in
`backend/services/search_providers/__init__.py`:

- `tmdb`
- `imdb`
- `anilist`
- `mal`
- `kitsu`
- `mangadex`
- `mangaupdates`
- `novelupdates`
- `igdb`
- `rawg`
- `google_books`
- `open_library`
- `comicvine`
- `goodreads`
- `vndb`

Frontend source metadata lives in
`frontend/pages/components/searchSources.js`.

`SEARCH_SOURCES` includes the keyword-searchable providers. `SOURCE_LABEL` also
includes URL-only labels:

- `jjwxc`
- `qidian`

Default available sources are curated to reduce overlapping duplicates:

- `imdb`
- `mal` (default for anime, manga, and light novels)
- `mangaupdates`
- `novelupdates` (default for web novels)
- `rawg`
- `vndb`
- `goodreads`
- `comicvine`

Available sources are stored in `localStorage.available_sources`. This is a
known exception to the otherwise server-backed UI preferences model. Console's
visible-medium toggles also update this local source set using
`SOURCE_MEDIUMS`/`DEFAULT_SOURCES_BY_MEDIUM`: disabling a medium removes a
source only when none of that source's supported mediums remain visible, while
re-enabling a medium restores that medium's default source(s).
Settings export/import includes this localStorage value alongside the backend
settings document so source-selection settings round-trip with the rest of the
Console settings.

Per-medium source defaults:

- Film and TV Show: `imdb`
- Anime: `mal`
- Manga: `mal`, with `mangaupdates` as a backup
- Light Novel: `mal`
- Web Novel: `novelupdates`
- Book: `goodreads`
- Comic: `comicvine`
- Game: `rawg`
- Visual Novel: `vndb`

### URL Source Inference

`backend/constants.py` maps URL host fragments to canonical sources. Current
recognized domains include:

- `themoviedb.org` -> `tmdb`
- `anilist.co` -> `anilist`
- `myanimelist.net` -> `mal` (the retired `jikan` value stays valid: entries
  saved before the switch carry it, and so does the browser extension until its
  next release; the frontend maps it through `canonicalSource()`)
- `kitsu.io` -> `kitsu`
- `novelupdates.com` -> `novelupdates`
- `mangadex.org` -> `mangadex`
- `igdb.com` -> `igdb`
- `rawg.io` -> `rawg`
- `books.google.com` -> `google_books`
- `openlibrary.org` -> `open_library`
- `comicvine.gamespot.com` -> `comicvine`
- `mangaupdates.com` / `baka-updates.com` -> `mangaupdates`
- `vndb.org` -> `vndb`

Some URL scrapers support sources beyond keyword search, notably `jjwxc` and
`qidian`.

---

## 10. Browser Extension

The `extension/` directory contains a Manifest V3 browser extension. It supports
Chrome/Chromium and Firefox packaging.

Important roles:

- Detect supported media pages.
- Bridge page/source data into Logarium.
- Fetch covers first-party and upload bytes to `/covers/upload`.
- Help with Cloudflare-gated covers that the backend cannot fetch directly.

Useful files:

- `extension/package.json`
- `extension/public/manifest.json`
- `extension/public/background.js`
- `extension/public/bridge.js`
- `extension/src/lib/site.js`
- `extension/src/lib/scrapers.js`
- `extension/scripts/release.js`

Release script behavior:

- Bumps extension version in manifest/package files.
- Builds browser artifacts.
- Removes/prunes old build files/artifacts.
- Strips `VITE_API_BASE` from the environment so `.env.production` wins.
- Reads AMO credentials from `.env` for Firefox signing when used.

---

## 11. Frontend Maintainability Rules

General:

- Keep React components in PascalCase files.
- Use camelCase for frontend functions and state.
- Preserve two-space indentation in JSX and CSS.
- Keep network calls centralized in `frontend/api.jsx`.
- Keep shared enums/helpers in `frontend/utils.jsx`.
- Keep reusable UI inside `frontend/pages/components/`.
- Prefer existing CSS classes and variables over new one-off styles.

Styling:

- Add new variables to `tokens.css` when they are reusable theme/design tokens.
- Add shared component rules to `components.css`.
- Add app-shell/page-frame/topbar/sidebar/button shell rules to `shell.css`.
- Add Library/Dashboard-specific rules to `library-dashboard.css`.
- Add Explore/Statistics/Landing-specific rules to `statistics-explore.css`.
- Add Console tools/add/import/custom-select rules to `tools-add-custom.css`.
- Add responsive overrides to `responsive.css`.
- Add light-mode-only overrides to `light.css`.
- Avoid static inline style props.
- Prefer CSS custom properties for dynamic numeric/color values.

Preferences:

- If adding a new persistent UI preference, update both:
  - `backend/schemas.py` `DEFAULT_UI`
  - `frontend/preferences.jsx` `DEFAULT_UI`
- Ensure the backend can deep-merge partial patches correctly.
- Avoid introducing a second preference storage location unless unavoidable.

Backend:

- Keep route handlers thin.
- Put reusable behavior in services.
- Preserve graceful fallback behavior for external providers.
- External APIs and scrapers can fail; frontend/backend should degrade cleanly.
- Validate/normalize constrained values through schemas/constants.

Data:

- Never bypass user scoping.
- Entry queries and mutations must be scoped to `current_user.username`.
- Be careful with destructive actions:
  - `DELETE /entries` wipes all entries for a user.
  - Console data-wipe UI should remain explicit and confirmation-gated.

---

## 12. Environment and Configuration

Frontend:

- `VITE_API_BASE` is required for API calls.

Backend:

- Database URL/config is handled through backend config/environment.
- JWT/auth settings live in backend config/environment.
- SMTP settings gate backup functionality.
- Provider API keys may be needed for some search providers.

Security rules:

- Do not commit secrets, API keys, SMTP credentials, auth secrets, or database
  URLs.
- Keep secrets in backend `.env` files and deployment variables.
- Preserve graceful behavior when optional providers or SMTP are not configured.

---

## 13. Testing and Verification

There is no formal test runner configured yet.

Recommended checks by change type:

- Frontend/CSS/React:
  - `cd frontend && npm run build`
  - `git diff --check`
  - Manual browser inspection for table/layout work.
- Backend:
  - Start the API.
  - Verify affected routes through `http://localhost:6443/docs`.
  - Run migrations with `alembic upgrade head` when DB schema changes.
- Scrapers:
  - Use targeted scripts such as `public/test_novelupdates.py` where relevant.
- Extension:
  - Use extension package scripts in `extension/package.json`.
  - Check generated artifacts only when release work is requested.

---

## 14. Known Gaps and Cautions

- No formal automated test suite exists yet.
- External search providers can break due to API changes, auth/rate limits, HTML
  changes, Cloudflare, or missing credentials.
- `frontend/design.css` is an older reference file, not the active style
  architecture.
- `frontend/styles.css` should stay as the CSS import entrypoint. Do not move
  rules back into it unless they are imports or truly global one-liners.
- Search-source availability is still localStorage-backed, unlike most UI
  preferences.
- `frontend/api.jsx` has a client-side source priority list for multi-source
  search dedup/ranking; if backend provider ranking changes, consider syncing it.
- Cover caching has two paths:
  - Server-side `/covers/cache-all`.
  - Extension upload `/covers/upload`.
  Keep both behavior paths in mind when debugging missing covers.
- Explore cache is keyed by user, medium, personalization mode, and combined-vs-
  legacy All mode. Source availability is intentionally response-only so source
  setting changes can reuse cached recommendations.
- Library/Dashboard table CSS is high risk for visual regressions. Treat table
  layout changes as UI-sensitive work.

---

## 15. Quick Source-of-Truth Pointers

- Routes/API: `backend/routers.py`
- Models: `backend/models.py`
- Pydantic schemas and UI defaults: `backend/schemas.py`
- Canonical values/source URL map: `backend/constants.py`
- Frontend API client: `frontend/api.jsx`
- Frontend app routes/theme shell: `frontend/app.jsx`
- Frontend UI preferences: `frontend/preferences.jsx`
- Search source list/defaults: `frontend/pages/components/searchSources.js`
- CSS entrypoint: `frontend/styles.css`
- CSS tokens: `frontend/styles/tokens.css`
- Shared components CSS: `frontend/styles/components.css`
- Library/Dashboard CSS: `frontend/styles/library-dashboard.css`
- Responsive CSS: `frontend/styles/responsive.css`
