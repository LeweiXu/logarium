"""
External media search service.

Strategy:
  - Route the query to the specified source provider, or fan out to all providers if no source given.
  - Results are normalised to SearchResult before being returned.
  - Any provider that fails is silently skipped so a partial result is always returned.
  - All providers are optional — if no API key is configured the provider is skipped.

Source → Provider mapping:
  imdb          → IMDb (Film & TV — default)
  tmdb          → TMDB (Film & TV)
  anilist       → AniList (Anime & Manga)
  mal           → MyAnimeList official API (Anime, Manga, Light Novel default)
  kitsu         → Kitsu (Anime & Manga)
  novelupdates  → NovelUpdates (Web Novel, Light Novel)
  mangadex      → MangaDex (Manga, Comic)
  igdb          → IGDB (Games)
  rawg          → RAWG (Games)
  goodreads     → Goodreads (Books)
  google_books  → Google Books
  open_library  → Open Library
  comicvine     → ComicVine (Comic)
  vndb          → VNDB (Visual Novels)

Keys required (all optional — provider is skipped if absent):
  TMDB_API_KEY
  IGDB_CLIENT_ID + IGDB_CLIENT_SECRET
  GOOGLE_BOOKS_API_KEY
  RAWG_API_KEY
  COMICVINE_API_KEY

No-key providers (always active):
  AniList, MyAnimeList, MangaDex, Kitsu, Open Library, VNDB, Goodreads
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

import httpx

from schemas import SearchResult
from services.search_providers import (
    search_tmdb,
    search_anilist,
    search_mal,
    search_kitsu,
    search_mangadex,
    search_igdb,
    search_rawg,
    search_google_books,
    search_open_library,
    search_comicvine,
    search_mangaupdates,
    search_novelupdates,
    search_vndb,
    search_goodreads,
    search_imdb,
)
from services.search_providers.utils import TIMEOUT

logger = logging.getLogger(__name__)

# ── Deduplication & ranking ───────────────────────────────────────────────────

# Provider preference order when two results look like duplicates.
# Lower index = higher trust for cover quality / metadata completeness.
_SOURCE_PRIORITY = [
    "mal",          # MAL data, preferred over AniList for anime & manga
    "novelupdates", # best web novel metadata, highly curated
    "vndb",         # best visual novel metadata, highly curated
    "imdb",         # best film/TV metadata + authoritative ratings
    "tmdb",         # film/TV fallback (covers, overviews)
    "igdb",         # best game metadata
    "anilist",      # good anime/manga, lower priority than MAL/MangaUpdates
    "kitsu",        # decent fallback for anime/manga
    "mangadex",     # great for manga, cover quality varies
    "mangaupdates", # best manga metadata, highly curated
    "goodreads",    # best book metadata + reliable ratings
    "google_books",
    "open_library",
    "comicvine",
    "rawg",
]


def _source_rank(source: str) -> int:
    try:
        return _SOURCE_PRIORITY.index(source)
    except ValueError:
        return len(_SOURCE_PRIORITY)


def _deduplicate_and_rank(
    combined: list[SearchResult], query: str
) -> list[SearchResult]:
    """
    1. Group near-duplicate titles (same normalised title + medium).
    2. Within each group keep the entry from the highest-priority source,
       but steal a better cover_url from a lower-priority source if the
       primary source has none.
    3. Sort final list: exact title matches first, then by source priority.
    """
    groups: dict[tuple[str, str], list[SearchResult]] = defaultdict(list)
    for r in combined:
        key = (r.title.lower().strip(), r.medium)
        groups[key].append(r)

    deduped: list[SearchResult] = []
    for items in groups.values():
        items.sort(key=lambda x: _source_rank(x.source))
        best = items[0]
        patch: dict = {}
        # Borrow cover_url and genres from lower-priority sources if missing
        need_cover  = not best.cover_url
        need_genres = not best.genres
        for fallback in items[1:]:
            if need_cover and fallback.cover_url:
                patch["cover_url"] = fallback.cover_url
                need_cover = False
            if need_genres and fallback.genres:
                patch["genres"] = fallback.genres
                need_genres = False
            if not need_cover and not need_genres:
                break
        if patch:
            best = SearchResult(**{**best.model_dump(), **patch})
        deduped.append(best)

    # Sort: exact title match first, then source priority
    q_lower = query.lower()
    deduped.sort(
        key=lambda r: (
            0 if r.title.lower() == q_lower else 1,
            _source_rank(r.source),
        )
    )
    return deduped


# ── Public interface ──────────────────────────────────────────────────────────

_ALL_PROVIDERS = [
    search_tmdb,
    search_imdb,
    search_anilist,
    search_mal,
    search_kitsu,
    search_novelupdates,
    search_mangaupdates,
    search_mangadex,
    search_igdb,
    search_rawg,
    search_goodreads,
    search_google_books,
    search_open_library,
    search_comicvine,
    search_vndb,
]

_SOURCE_TO_PROVIDER = {
    "tmdb":         search_tmdb,
    "imdb":         search_imdb,
    "anilist":      search_anilist,
    "mal":          search_mal,
    "kitsu":        search_kitsu,
    "novelupdates": search_novelupdates,
    "mangadex":     search_mangadex,
    "mangaupdates": search_mangaupdates,
    "igdb":         search_igdb,
    "rawg":         search_rawg,
    "goodreads":    search_goodreads,
    "google_books": search_google_books,
    "open_library": search_open_library,
    "comicvine":    search_comicvine,
    "vndb":         search_vndb,
}

# Medium → preferred providers for auto-import narrowing.
_MEDIUM_PROVIDERS: dict[str, list] = {
    "Film":         [search_imdb, search_tmdb],
    "TV Show":      [search_imdb, search_tmdb],
    "Anime":        [search_mal, search_anilist, search_kitsu],
    "Manga":        [search_mal, search_anilist, search_mangadex, search_mangaupdates],
    "Light Novel":  [search_mal, search_novelupdates, search_anilist, search_google_books, search_open_library],
    "Web Novel":    [search_novelupdates, search_google_books, search_open_library],
    "Book":         [search_goodreads, search_google_books, search_open_library],
    "Game":         [search_igdb, search_rawg],
    "Comic":        [search_comicvine, search_mangadex],
    "Visual Novel": [search_vndb],
}


async def search_media(
    title: str,
    source: str = "",
    medium: str = "",
    limit: int = 10,
) -> list[SearchResult]:
    """
    Fan-out search across all providers (or a single source/medium) in parallel.
    Results are de-duplicated, ranked, and capped at ``limit``.

    Priority: source > medium > all providers.
    """
    limit = max(1, min(limit, 50))
    if source:
        providers = [_SOURCE_TO_PROVIDER[source]] if source in _SOURCE_TO_PROVIDER else _ALL_PROVIDERS
    elif medium and medium in _MEDIUM_PROVIDERS:
        providers = _MEDIUM_PROVIDERS[medium]
    else:
        providers = _ALL_PROVIDERS

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        tasks = [p(client, title, limit=limit) for p in providers]
        groups = await asyncio.gather(*tasks, return_exceptions=True)

    combined: list[SearchResult] = []
    for group in groups:
        if isinstance(group, Exception):
            logger.warning("Search provider exception: %s", group)
            continue
        combined.extend(group)

    return _deduplicate_and_rank(combined, title)[:limit]


async def lookup_chapter_count(title: str) -> int | None:
    """Latest translated chapter count for a title via MangaUpdates.

    Used on demand (when a user adds an ongoing MAL manga that has no
    chapter total) rather than during every search, to avoid the extra API
    round-trips on results the user never adds.
    """
    from services.search_providers.mangaupdates import mangaupdates_chapter_count

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        return await mangaupdates_chapter_count(client, title)
