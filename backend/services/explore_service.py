"""
Explore service — recommends new media per medium and decides the ordering of
the aggregate "All" view.

Model
─────
- Recommendations are **per medium**. Each medium has its own cached row in the
  ``explore_cache`` table, its own reroll, and its own failed-reroll state.
- A **reroll** (``reroll_medium``) is the only thing that hits providers: it
  fans out to that medium's discovery endpoints, drops library titles, and ranks
  by ``popularity + genre/origin bias + seeded jitter``. On failure it keeps the
  previous cached items and records a provider-specific message
  (``reroll_failed`` / ``reroll_error``).
- A plain **read** (``read_medium``) returns the cached row and its failed state;
  it never hits providers.
- The **"All" view** (``read_all``) is a pure aggregate: it concatenates every
  medium's cached set and orders it deterministically by the full bias
  (genre + origin + medium-consumption), so the user's most-consumed mediums
  float up and the order is stable across reloads until something is rerolled.
- Personalisation only *orders* results; ``personalize=False`` makes ordering
  neutral (popularity only).

Each item is tagged with up to a few ``matches`` — overlaps with the user's
most-consumed genres / origins / mediums — used by the UI for a subtle hint.

Discovery providers live inline below — they hit known popular/trending
endpoints rather than reusing the title-search code paths.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from collections import Counter
from typing import Optional

import httpx
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from models import Entry, ExploreCache
from schemas import ExploreItem, ExploreResponse, AffinitySnapshot
from services.search_providers.utils import TIMEOUT
from services.search_providers.anilist import _discover_anilist
from services.search_providers.comicvine import _discover_comicvine
from services.search_providers.google_books import _discover_google_books
from services.search_providers.goodreads import _discover_goodreads
from services.search_providers.igdb import _discover_igdb
from services.search_providers.mal import _discover_mal
from services.search_providers.novelupdates import _discover_novelupdates
from services.search_providers.rawg import _discover_rawg
from services.search_providers.tmdb import _discover_tmdb
from services.search_providers.imdb import _discover_imdb
from services.search_providers.vndb import _discover_vndb

logger = logging.getLogger(__name__)


_MIN_RECOMMENDATIONS_PER_MEDIUM = 30
_MAX_DISCOVERY_PAGES_PER_PROVIDER = 10

# Display names for the discovery sources, used to build provider-specific
# reroll error messages (mirrors the frontend SOURCE_LABEL map).
_SOURCE_LABEL: dict[str, str] = {
    "tmdb": "TMDB", "imdb": "IMDb", "mal": "MyAnimeList", "anilist": "AniList",
    "novelupdates": "NovelUpdates", "comicvine": "ComicVine",
    "google_books": "Google Books", "goodreads": "Goodreads", "rawg": "RAWG",
    "igdb": "IGDB", "vndb": "VNDB",
}
_MAL_DOWN_MSG = "The MyAnimeList API is down. Try again later."


# ── Consumption profile ───────────────────────────────────────────────────────

# Cache the per-user counts briefly to avoid re-querying on every page change
# during a single browsing session. Tiny TTL — fresh after edits.
_PROFILE_TTL_S = 60
_profile_cache: dict[str, tuple[float, "ConsumptionProfile"]] = {}


class ConsumptionProfile:
    """Counts of genres / origins / mediums across the user's entries."""

    __slots__ = (
        "genres", "origins", "mediums", "sample_size",
        "_g_top", "_o_top", "_m_top",
    )

    def __init__(
        self,
        genres:  Counter[str],
        origins: Counter[str],
        mediums: Counter[str],
        sample:  int,
    ) -> None:
        self.genres      = genres
        self.origins     = origins
        self.mediums     = mediums
        self.sample_size = sample
        # Pre-compute the top items in each dimension for the "matches" hint.
        self._g_top = {g for g, _ in genres.most_common(8)}
        self._o_top = {o for o, _ in origins.most_common(3)}
        self._m_top = {m for m, _ in mediums.most_common(3)}

    def snapshot(self) -> AffinitySnapshot:
        return AffinitySnapshot(
            sample_size = self.sample_size,
            top_genres  = [g for g, _ in self.genres.most_common(5)],
            top_origins = [o for o, _ in self.origins.most_common(3)],
            top_mediums = [m for m, _ in self.mediums.most_common(3)],
        )

    def matches(self, item: ExploreItem) -> list[str]:
        """Mixed list of genres / origin / medium that overlap with the user's
        most-consumed values across all three dimensions."""
        out: list[str] = []
        if item.genres and self._g_top:
            for g in (g.strip() for g in item.genres.split(",") if g.strip()):
                if g in self._g_top and g not in out:
                    out.append(g)
        if item.origin and item.origin in self._o_top and item.origin not in out:
            out.append(item.origin)
        if item.medium and item.medium in self._m_top and item.medium not in out:
            out.append(item.medium)
        return out[:4]


def _build_profile(db: Session, username: str) -> ConsumptionProfile:
    """Count each dimension across all of the user's entries (no rating filter)."""
    rows = db.execute(
        select(Entry.genres, Entry.origin, Entry.medium)
        .where(Entry.username == username)
    ).all()

    genre_counts:  Counter[str] = Counter()
    origin_counts: Counter[str] = Counter()
    medium_counts: Counter[str] = Counter()

    for genres, origin, medium in rows:
        if genres:
            for g in (g.strip() for g in genres.split(",")):
                if g:
                    genre_counts[g] += 1
        if origin:
            origin_counts[origin] += 1
        if medium:
            medium_counts[medium] += 1

    return ConsumptionProfile(
        genres=genre_counts, origins=origin_counts,
        mediums=medium_counts, sample=len(rows),
    )


def _get_profile(db: Session, username: str) -> ConsumptionProfile:
    import time
    now = time.monotonic()
    cached = _profile_cache.get(username)
    if cached and (now - cached[0]) < _PROFILE_TTL_S:
        return cached[1]
    profile = _build_profile(db, username)
    _profile_cache[username] = (now, profile)
    return profile


def _normalised_weights(counter: Counter[str], top_n: int = 10) -> dict[str, float]:
    """Return a dict mapping the top-N keys to a 0..1 weight (max-normalised)."""
    if not counter:
        return {}
    top = counter.most_common(top_n)
    max_count = top[0][1] or 1
    return {k: c / max_count for k, c in top}


# ── Discovery providers ───────────────────────────────────────────────────────
# Provider implementations live in services/search_providers/*.py. The Explore
# service only owns provider ordering, fallback, cache, filtering, and ranking.

_PROVIDER_FNS_BY_MEDIUM: dict[str, list] = {
    "Film":         [_discover_imdb, _discover_tmdb],
    "TV Show":      [_discover_imdb, _discover_tmdb],
    "Anime":        [_discover_mal, _discover_anilist],
    "Manga":        [_discover_mal, _discover_anilist],
    "Light Novel":  [_discover_mal, _discover_anilist],
    "Web Novel":    [_discover_novelupdates],    # scrapes NU rankings
    "Comic":        [_discover_comicvine],
    "Book":         [_discover_goodreads, _discover_google_books],  # genre-aware; need top_genres
    "Game":         [_discover_rawg, _discover_igdb],
    "Visual Novel": [_discover_vndb],
}

# Source value (matching the frontend SEARCH_SOURCES values) each discover
# function emits. The helper can restrict provider lists, but normal Explore
# caching now fetches the full provider pool and applies source availability as
# a response filter so source settings don't create new cache identities.
_DISCOVER_SOURCE: dict = {
    _discover_tmdb:         "tmdb",
    _discover_imdb:         "imdb",
    _discover_mal:          "mal",
    _discover_anilist:      "anilist",
    _discover_novelupdates: "novelupdates",
    _discover_comicvine:    "comicvine",
    _discover_google_books: "google_books",
    _discover_goodreads:    "goodreads",
    _discover_rawg:         "rawg",
    _discover_igdb:         "igdb",
    _discover_vndb:         "vndb",
}


def _providers_for(medium: str, allowed: Optional[set[str]]) -> list:
    """Discovery providers for a medium, restricted to ``allowed`` sources
    (None = no restriction)."""
    fns = _PROVIDER_FNS_BY_MEDIUM.get(medium, [])
    if allowed is None:
        return fns
    return [fn for fn in fns if _DISCOVER_SOURCE.get(fn) in allowed]


async def _call_discover_provider(
    fn,
    client: httpx.AsyncClient,
    medium: str,
    top_genres: list[str],
    page: int,
    seed: Optional[int] = None,
    target_visible: int = _MIN_RECOMMENDATIONS_PER_MEDIUM,
) -> list[ExploreItem]:
    if fn is _discover_novelupdates:
        return await fn(client, medium, page, seed=seed, target=target_visible)
    if fn in (_discover_google_books, _discover_goodreads, _discover_imdb):
        return await fn(client, medium, top_genres, page)
    return await fn(client, medium, page)


def _item_key(item: ExploreItem) -> tuple[str, str]:
    return (item.title.lower().strip(), item.medium or "")


def _dedupe_best(items: list[ExploreItem]) -> list[ExploreItem]:
    """Deduplicate by (lowered title, medium), keeping the best-rated copy."""
    best: dict[tuple[str, str], ExploreItem] = {}
    for item in items:
        if not item.title:
            continue
        key = _item_key(item)
        cur = best.get(key)
        if cur is None or (item.external_rating or 0) > (cur.external_rating or 0):
            if cur is not None:
                if not item.cover_url and cur.cover_url:
                    item.cover_url = cur.cover_url
                if not item.genres and cur.genres:
                    item.genres = cur.genres
            best[key] = item
    return list(best.values())


def _visible_count(items: list[ExploreItem], owned: set[tuple[str, str]]) -> int:
    return sum(1 for item in _dedupe_best(items) if _item_key(item) not in owned)


def _down_message(source: str) -> str:
    """The 'provider is down' message for a source."""
    if source == "mal":
        return _MAL_DOWN_MSG
    label = _SOURCE_LABEL.get(source, "The source")
    return f"{label} is unavailable right now. Try again later."


def _provider_error_message(fn, exc: Exception) -> str:
    """A short, provider-specific message for a failed discovery call."""
    source = _DISCOVER_SOURCE.get(fn, "")
    label = _SOURCE_LABEL.get(source, "The source")
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if fn is _discover_mal and code in (502, 503, 504):
            return _MAL_DOWN_MSG
        return f"{label} returned an error ({code}). Try again later."
    return f"{label} is unavailable right now. Try again later."


# Base API endpoints used for a quick liveness check when a medium's reroll comes
# back empty — so "is the provider down?" is answered directly instead of guessed
# from whatever the discovery call happened to raise. A response (even 4xx) means
# up; a connection error / timeout / 5xx means down.
_PROVIDER_BASE_URL: dict[str, str] = {
    "mal":       "https://api.myanimelist.net/v2/",
    "anilist":   "https://graphql.anilist.co",
    "tmdb":      "https://api.themoviedb.org/3/",
    "rawg":      "https://api.rawg.io/api/",
    "igdb":      "https://api.igdb.com/v4/",
    "vndb":      "https://api.vndb.org/kana",
    "comicvine": "https://comicvine.gamespot.com/api/",
    "goodreads": "https://www.goodreads.com/",
    "novelupdates":  "https://www.novelupdates.com/",
    "google_books":  "https://www.googleapis.com/books/v1/",
}


async def _provider_is_up(client: httpx.AsyncClient, url: str) -> bool:
    """True if the base API responds at all (any status < 500)."""
    try:
        r = await client.get(url, timeout=8.0)
        return r.status_code < 500
    except Exception:
        return False


async def _provider_down_message(client: httpx.AsyncClient, medium: str) -> Optional[str]:
    """If the medium's primary provider's base API is unreachable, return its
    'down' message; otherwise None (so the caller keeps its own error)."""
    providers = _providers_for(medium, None)
    if not providers:
        return None
    source = _DISCOVER_SOURCE.get(providers[0])
    base = _PROVIDER_BASE_URL.get(source or "")
    if not base:
        return None
    if not await _provider_is_up(client, base):
        return _down_message(source)
    return None


async def _discover_medium_capturing(
    client: httpx.AsyncClient,
    medium: str,
    top_genres: list[str],
    rng: random.Random,
    target_visible: int,
    owned: set[tuple[str, str]],
    allowed_sources: Optional[set[str]] = None,
) -> tuple[list[ExploreItem], Optional[str]]:
    """Try providers by priority, returning ``(items, error)``.

    A fallback provider is only used when the higher-priority provider returns
    nothing useful or cannot fill the remaining visible recommendations after
    several pages. ``error`` is a provider-specific message when nothing usable
    came back (every provider errored or returned empty); ``None`` on success.
    """
    combined: list[ExploreItem] = []
    # Keep the first provider's error: providers are tried in priority order, so
    # the primary source's message (e.g. the MAL-down message for Anime) wins
    # over a fallback provider's later failure.
    first_error: Optional[str] = None
    for fn in _providers_for(medium, allowed_sources):
        pages = list(range(1, _MAX_DISCOVERY_PAGES_PER_PROVIDER + 1))
        rng.shuffle(pages)

        for page in pages:
            try:
                items = await _call_discover_provider(
                    fn, client, medium, top_genres, page,
                    seed=rng.getrandbits(32), target_visible=target_visible,
                )
            except Exception as exc:
                logger.warning("Explore provider exception for %s: %s", medium, exc)
                if first_error is None:
                    first_error = _provider_error_message(fn, exc)
                break

            if not items:
                continue

            combined.extend(items)

            if _visible_count(combined, owned) >= target_visible:
                return _dedupe_best(combined), None

    deduped = _dedupe_best(combined)
    if deduped:
        return deduped, None
    return [], first_error or "No new recommendations found. Try again later."


# ── Bias scoring ──────────────────────────────────────────────────────────────
#
# Personalisation only *orders* results; it never changes which titles get
# fetched. The ranking formula is:  popularity_centered + bias_amount + jitter.
#
# Popularity is centered around 5.0 so it spans ~[-5, +5]. Genre/origin bias is
# intentionally gentle (it just nudges); jitter is wider than it so a popular
# unrelated title can still beat a low-popularity match, keeping per-medium
# rerolls feeling exploratory. The aggregate "All" view adds a much stronger
# medium-consumption bias so the user's most-consumed mediums clearly lead the
# mixed feed (larger than the jitter amplitude on purpose).

_BIAS_CAP_GENRE  = 0.35
_BIAS_CAP_ORIGIN = 0.25
_BIAS_CAP_MEDIUM = 3.0    # only used by the aggregate "All" view
_JITTER_AMPLITUDE    = 2.4
_BIAS_MATCH_THRESHOLD = 0.25


def _genre_bias(item: ExploreItem, weights: dict[str, float], cap: float) -> float:
    if not item.genres or not weights:
        return 0.0
    cg = [g.strip() for g in item.genres.split(",") if g.strip()]
    if not cg:
        return 0.0
    score = sum(weights.get(g, 0.0) for g in cg) / len(cg)
    return score * cap


def _scalar_bias(value: Optional[str], weights: dict[str, float], cap: float) -> float:
    if not value or not weights:
        return 0.0
    return weights.get(value, 0.0) * cap


# Every medium with a discovery provider. The aggregate "All" view reads the
# cached row of each; a per-medium reroll fetches exactly one.
ALL_MEDIUMS = [
    "Anime", "Manga", "Film", "TV Show", "Game", "Book",
    "Light Novel", "Web Novel", "Comic", "Visual Novel",
]


def _rank(
    items:   list[ExploreItem],
    profile: ConsumptionProfile,
    *,
    personalize: bool,
    include_medium_axis: bool,
    rng: Optional[random.Random],
) -> list[ExploreItem]:
    """Order ``items`` by popularity + genre/origin bias, plus an optional
    medium-consumption bias (the aggregate "All" view) and optional jitter.

    Pass ``rng`` for a fresh reroll (jittered, exploratory); pass ``None`` for
    the deterministic "All" aggregate so its order is stable across reloads
    until a medium is rerolled. Tags ``bias_matched`` for the "matches" hint.
    """
    biased = personalize and profile.sample_size > 0
    gcap = _BIAS_CAP_GENRE  if biased else 0.0
    ocap = _BIAS_CAP_ORIGIN if biased else 0.0
    mcap = _BIAS_CAP_MEDIUM if (biased and include_medium_axis) else 0.0

    genre_weights  = _normalised_weights(profile.genres)
    origin_weights = _normalised_weights(profile.origins)
    medium_weights = _normalised_weights(profile.mediums)

    def bias_value(item: ExploreItem) -> float:
        bias = 0.0
        if gcap:
            bias += _genre_bias(item, genre_weights, gcap)
        if ocap:
            bias += _scalar_bias(item.origin, origin_weights, ocap)
        if mcap:
            bias += _scalar_bias(item.medium, medium_weights, mcap)
        return bias

    for item in items:
        item.bias_matched = bias_value(item) >= _BIAS_MATCH_THRESHOLD

    def ranked_key(item: ExploreItem) -> float:
        # Center popularity around 5/10 so a 7-rated item gets +2 and an
        # unrated item is neutral.
        pop = (item.external_rating or 5.0) - 5.0
        jitter = rng.uniform(-_JITTER_AMPLITUDE, _JITTER_AMPLITUDE) if rng else 0.0
        return pop + bias_value(item) + jitter

    if rng:
        # Pre-shuffle so providers don't bias the jittered sort toward whichever
        # one returned its results first.
        rng.shuffle(items)
    items.sort(key=ranked_key, reverse=True)
    return items


# ── Per-(user, medium) result cache ───────────────────────────────────────────
#
# Stored in the ``explore_cache`` table, one row per real medium (the "All"
# view is computed live by aggregating these rows, never stored). Only a reroll
# of that medium writes a row; a failed reroll keeps the previous items and
# records ``reroll_failed``/``reroll_error``. Reads re-apply the live "in
# library" / source filters so adding an entry on one tab doesn't leave it
# visible on another.

def _read_row(db: Session, username: str, medium: str) -> Optional[ExploreCache]:
    return db.execute(
        select(ExploreCache).where(
            ExploreCache.username == username,
            ExploreCache.medium   == medium,
        )
    ).scalar_one_or_none()


def _parse_items(items_json: str) -> list[ExploreItem]:
    try:
        return [ExploreItem(**d) for d in json.loads(items_json)]
    except Exception as exc:
        logger.warning("Discarding malformed explore cache row: %s", exc)
        return []


def _write_success(db: Session, username: str, medium: str, items: list[ExploreItem]) -> None:
    """Store a fresh ranked set and clear any failed state."""
    payload = json.dumps([i.model_dump() for i in items])
    row = _read_row(db, username, medium)
    if row is None:
        db.add(ExploreCache(
            username=username, medium=medium, items_json=payload,
            reroll_failed=False, reroll_error=None,
        ))
    else:
        row.items_json   = payload
        row.reroll_failed = False
        row.reroll_error  = None
    db.commit()


def _mark_failed(db: Session, username: str, medium: str, error: str) -> None:
    """Flag the last reroll as failed WITHOUT touching the cached items, so the
    previous recommendations stay available for ``clear_failed``/restore."""
    row = _read_row(db, username, medium)
    if row is None:
        db.add(ExploreCache(
            username=username, medium=medium, items_json="[]",
            reroll_failed=True, reroll_error=error,
        ))
    else:
        row.reroll_failed = True
        row.reroll_error  = error
    db.commit()


def _owned_entry_keys(db: Session, username: str) -> set[tuple[str, str]]:
    existing = db.execute(
        select(func.lower(Entry.title), Entry.medium)
        .where(Entry.username == username)
    ).all()
    return {(t, m or "") for t, m in existing}


# ── Public entry points ───────────────────────────────────────────────────────

async def reroll_medium(
    db: Session,
    *,
    username:    str,
    medium:      str,
    sources:     Optional[set[str]] = None,
    personalize: bool = True,
    limit:       int  = 40,
    offset:      int  = 0,
    visible_mediums: Optional[set[str]] = None,
    seed:        Optional[int] = None,
) -> ExploreResponse:
    """Fetch a fresh recommendation set for one medium (the only provider-hitting
    path). On success, store it and clear failure. On failure, keep the previous
    cached items and record a provider-specific error message."""
    profile = _get_profile(db, username)
    owned = _owned_entry_keys(db, username)
    target = max(limit, _MIN_RECOMMENDATIONS_PER_MEDIUM)
    rng = random.Random(seed) if seed is not None else random.Random()

    top_genres = [] if not personalize else [g for g, _ in profile.genres.most_common(5)]

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        items, error = await _discover_medium_capturing(
            client, medium, top_genres, rng, target, owned, None,
        )
        # Empty result: confirm with a base-API liveness check so a genuinely
        # down provider (timeout, connection drop, or 5xx that the provider
        # swallowed) reports the precise "… is down" message rather than a
        # vague "no recommendations" fallback.
        down_msg = None
        if not items:
            down_msg = await _provider_down_message(client, medium)

    if not items:
        msg = down_msg or error or "No new recommendations found. Try again later."
        _mark_failed(db, username, medium, msg)
        previous = _read_row(db, username, medium)
        prev_items = _parse_items(previous.items_json) if previous else []
        return _finalise(
            db, username, profile, prev_items, target, personalize, sources,
            offset=offset, visible_mediums=visible_mediums,
            reroll_failed=True, reroll_error=msg,
        )

    ranked = _rank(items, profile, personalize=personalize, include_medium_axis=False, rng=rng)
    # `matches`/`in_library` are re-applied live at read time, so strip them
    # before caching to keep the row small and avoid stale "in library" tags.
    to_cache = [i.model_copy(update={"matches": [], "in_library": False}) for i in ranked]
    _write_success(db, username, medium, to_cache)
    return _finalise(
        db, username, profile, ranked, target, personalize, sources,
        offset=offset, visible_mediums=visible_mediums,
    )


def read_medium(
    db: Session,
    *,
    username:    str,
    medium:      str,
    sources:     Optional[set[str]] = None,
    personalize: bool = True,
    limit:       int  = 40,
    offset:      int  = 0,
    visible_mediums: Optional[set[str]] = None,
) -> ExploreResponse:
    """Return one medium's cached recommendations plus its failed-reroll state.
    Never hits providers — a missing row yields an empty, non-failed response."""
    profile = _get_profile(db, username)
    row = _read_row(db, username, medium)
    items = _parse_items(row.items_json) if row else []
    return _finalise(
        db, username, profile, items, limit, personalize, sources,
        offset=offset, visible_mediums=visible_mediums,
        reroll_failed=bool(row and row.reroll_failed),
        reroll_error=row.reroll_error if row else None,
    )


def write_external_success(
    db: Session,
    *,
    username:    str,
    medium:      str,
    items:       list[ExploreItem],
    sources:     Optional[set[str]] = None,
    personalize: bool = True,
    limit:       int  = 40,
    offset:      int  = 0,
    visible_mediums: Optional[set[str]] = None,
) -> ExploreResponse:
    """Persist client/extension fallback recommendations as a successful reroll.

    Extension fallbacks fetch first-party results for providers blocked from the
    backend. Once those results arrive, they should replace the failed cache row
    and clear ``reroll_failed`` exactly like a backend-successful reroll.
    """
    profile = _get_profile(db, username)
    cleaned = [
        item.model_copy(update={"matches": [], "in_library": False})
        for item in _dedupe_best(items)
        if item.medium == medium and item.source
    ]
    _write_success(db, username, medium, cleaned)
    return _finalise(
        db, username, profile, cleaned, limit, personalize, sources,
        offset=offset, visible_mediums=visible_mediums,
    )


def read_all(
    db: Session,
    *,
    username:    str,
    sources:     Optional[set[str]] = None,
    personalize: bool = True,
    limit:       int  = 40,
    offset:      int  = 0,
    visible_mediums: Optional[set[str]] = None,
) -> ExploreResponse:
    """Aggregate every medium's cached set into the "All" view, ordered by the
    full bias (genre + origin + medium-consumption), deterministically so the
    order is stable across reloads. Never hits providers, never fails."""
    profile = _get_profile(db, username)
    combined: list[ExploreItem] = []
    for row in db.execute(
        select(ExploreCache.items_json).where(ExploreCache.username == username)
    ).all():
        combined.extend(_parse_items(row[0]))

    items = _dedupe_best(combined)
    ranked = _rank(items, profile, personalize=personalize, include_medium_axis=True, rng=None)
    return _finalise(
        db, username, profile, ranked, limit, personalize, sources,
        offset=offset, visible_mediums=visible_mediums,
    )


def clear_failed(
    db: Session,
    *,
    username:    str,
    medium:      str,
    sources:     Optional[set[str]] = None,
    personalize: bool = True,
    limit:       int  = 40,
    offset:      int  = 0,
    visible_mediums: Optional[set[str]] = None,
) -> ExploreResponse:
    """Restore previous results: clear the failed flag and return the cached
    items. Does not reroll."""
    row = _read_row(db, username, medium)
    if row is not None and row.reroll_failed:
        row.reroll_failed = False
        row.reroll_error  = None
        db.commit()
    return read_medium(
        db, username=username, medium=medium, sources=sources,
        personalize=personalize, limit=limit, offset=offset,
        visible_mediums=visible_mediums,
    )


def _finalise(
    db:          Session,
    username:    str,
    profile:     ConsumptionProfile,
    items:       list[ExploreItem],
    limit:       int,
    personalize: bool = True,
    sources:     Optional[set[str]] = None,
    *,
    offset:      int = 0,
    visible_mediums: Optional[set[str]] = None,
    reroll_failed: bool = False,
    reroll_error:  Optional[str] = None,
) -> ExploreResponse:
    """Apply live source/library filters, tag matches, and trim to ``limit``.

    Used by every read path so behaviour stays consistent.
    """
    owned = _owned_entry_keys(db, username)
    source_filter = sources or set()
    filtered = [
        i for i in items
        if _item_key(i) not in owned
        and (not source_filter or i.source in source_filter)
        and (visible_mediums is None or not i.medium or i.medium in visible_mediums)
    ]

    for i in filtered:
        i.matches = profile.matches(i) if i.bias_matched else []

    return ExploreResponse(
        items         = filtered[offset:offset + limit],
        affinity      = profile.snapshot(),
        personalised  = personalize and profile.sample_size > 0,
        total          = len(filtered),
        offset         = offset,
        limit          = limit,
        reroll_failed = reroll_failed,
        reroll_error  = reroll_error,
    )
