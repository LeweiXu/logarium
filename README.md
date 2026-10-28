# LOGARIUM: Media Tracker

Logarium is a web app for keeping films, TV shows, anime, games, books, manga, novels, comics, and visual novels in one library. Track what you are watching, reading, or playing, find new titles from media sites, and see your habits across formats in one place.

Try the [public demo](https://logarium.vercel.app/demo), or [create an account](https://logarium.vercel.app). The demo library resets every 24 hours, so changes there are temporary.

## Features

- **Track ten media types:** Film, TV Show, Anime, Book, Manga, Light Novel, Web Novel, Comic, Game, and Visual Novel. Each entry can store a status (`current`, `planned`, `completed`, `on_hold`, or `dropped`), origin, progress and total, your 0 to 10 rating, release year, cover, genres, notes, and its metadata source. Completion dates are recorded when an entry moves to `completed`.
- **Manage one library:** Filter, sort, and page through entries; edit status and progress inline; create custom lists; make bulk edits; and find or merge duplicates. The Dashboard shows what is current, planned, and recently completed.
- **Add titles your way:** Search external sources for metadata, paste a supported title URL, or enter an item manually. Goodreads series URLs can return their numbered books as separate entries.
- **Explore and review:** Get recommendations from supported discovery sources, with optional ranking based on your library. Statistics cover media, origin, status, ratings, and activity over time.
- **Move and protect data:** Import or export CSV and JSON, import a MyAnimeList list, preview duplicates and conflicts before importing, and optionally receive scheduled email backups. Read-only share links let others view a profile.
- **Use the browser extension:** Add a supported page from Chrome or Firefox, and fetch covers or results from sites that block the server. The web app works without the extension for sources the server can reach.

## Supported Sources

Title search covers 15 providers. Choose which ones appear in the Add and Explore source pickers under **Console → Search Sources**. The default set is IMDb, MyAnimeList, MangaUpdates, NovelUpdates, RAWG, VNDB, Goodreads, and ComicVine. A missing key or failed provider is skipped, so other search results can still appear. Explore recommendations are available for a subset of the sources below.

| Source | Media | How it works | Requirement or limitation |
| --- | --- | --- | --- |
| IMDb | Film, TV Show | Public autocomplete for search; GraphQL for details and Explore | No key or extension needed |
| TMDB | Film, TV Show | REST API | `TMDB_API_KEY` |
| MyAnimeList | Anime, Manga, Light Novel | Official REST API | `MAL_CLIENT_ID` |
| AniList | Anime, Manga, Light Novel | GraphQL API | No key |
| Kitsu | Anime, Manga | JSON API | No key |
| MangaDex | Manga, Comic | REST API | No key |
| MangaUpdates | Manga | REST API | No key; also fills missing manga chapter totals when available |
| NovelUpdates | Light Novel, Web Novel | Server-side page scraping for search, title URLs, and Explore | Cloudflare may block the server; the extension can search and fetch covers from your browser |
| IGDB | Game | Twitch authenticated API | `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` |
| RAWG | Game | REST API | `RAWG_API_KEY` |
| Goodreads | Book | Autocomplete for search; page scraping for details and series; shelf pages for Explore | No key; the extension can fetch Explore results if the server is blocked |
| Google Books | Book, Light Novel, Web Novel | REST API | Keyless access works at a lower quota; `GOOGLE_BOOKS_API_KEY` is optional |
| Open Library | Book, Light Novel, Web Novel | REST API | No key |
| ComicVine | Comic | REST API | `COMICVINE_API_KEY` |
| VNDB | Visual Novel | Query API | No key |

**URL-only sites:** Paste a JJWXC or Qidian title URL to add a Chinese web novel. Their pages are scraped server-side; they do not offer title search in Logarium. Pasting a supported URL from any of the 15 searchable sources also opens a prefilled entry. The extension can add a page you are viewing and provides first-party access for NovelUpdates when server requests hit Cloudflare.

## Technical Details and Local Setup

The frontend is a React 18 and Vite app with React Router, TanStack Query, Recharts, and plain CSS. The backend uses Python 3.11+, FastAPI, SQLAlchemy, Alembic, and PostgreSQL 14+. The optional Chrome and Firefox extension uses Manifest V3. `frontend/`, `backend/`, and `extension/` hold those parts of the project.

A user owns many entries. An entry stores the common tracking fields listed above plus its source ID and URL. The backend keeps each user's library and preferences separate; Alembic migrations define database changes. Search providers live in `backend/services/search_providers/`, while pasted URL resolvers live in `backend/services/url_scrapers/`. More API detail is in [backend/README.md](backend/README.md).

To run the web app locally, install Python 3.11+, Node.js 18+, and PostgreSQL 14+, then create a database and user. For example, in `psql` as a PostgreSQL administrator:

```sql
CREATE USER log WITH PASSWORD 'choose-a-password';
CREATE DATABASE mediatracker OWNER log;
```

From the repository root, set up the backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env` with your database credentials and a new secret. Add source API keys from the table above only for providers you want to use:

```env
DATABASE_URL=postgresql://log:choose-a-password@localhost:5432/mediatracker
SECRET_KEY=replace-with-a-random-secret
CORS_ORIGINS=http://localhost:3000
```

Then apply migrations and start the API:

```bash
alembic upgrade head
python main.py
```

In another terminal, start the frontend:

```bash
cd frontend
npm install
printf 'VITE_API_BASE=http://localhost:6443\n' > .env
npm start
```

Open [http://localhost:3000](http://localhost:3000). The API docs are at [http://localhost:6443/docs](http://localhost:6443/docs). For extension development, set `VITE_API_BASE` in `extension/.env`, run `npm install` and `npm run build` from `extension/`, then load `extension/dist` as an unpacked extension. The extension is optional for local use.
