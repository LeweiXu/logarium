from __future__ import annotations

import logging

import httpx

from config import get_settings
from schemas import ExploreItem, SearchResult

logger = logging.getLogger(__name__)

BASE = "https://api.myanimelist.net/v2"

# MAL rejects a search of fewer than 3 characters with 400 "invalid q", so short
# queries skip this provider entirely rather than burning a request on a 400.
MIN_QUERY_LEN = 3

# Only what we store. Asking for everything makes the payload several times
# bigger for fields we throw away.
ANIME_FIELDS = (
    "id,title,alternative_titles,main_picture,start_date,synopsis,mean,"
    "genres,media_type,num_episodes,nsfw"
)
MANGA_FIELDS = (
    "id,title,alternative_titles,main_picture,start_date,synopsis,mean,"
    "genres,media_type,num_volumes,num_chapters,nsfw"
)

# MAL tags each entry white (safe) / gray (suggestive) / black (explicit). The
# search endpoint already hides the latter two, but the ranking endpoints don't,
# so Explore filters them out here (Jikan did it with sfw=true).
SAFE_NSFW = "white"

# manga media_type values that are novels rather than comics. MAL splits these
# into "novel" (literary) and "light_novel"; we show both as Light Novel, which
# is how the Jikan provider behaved.
NOVEL_TYPES = {"novel", "light_novel"}

# Per-medium ranking config for Explore: (path, ranking_type, rows per page).
# Anime and Manga have a popularity ranking of their own. Light novels do not:
# ranking_type=novels returns only media_type "novel" (no light novels at all),
# so we pull the general ranking and filter, which yields roughly 15% novels,
# hence the much larger page.
_RANKINGS: dict[str, tuple[str, str, int]] = {
    "Anime":       ("/anime/ranking", "bypopularity", 50),
    "Manga":       ("/manga/ranking", "bypopularity", 50),
    "Light Novel": ("/manga/ranking", "all",         300),
}


def _headers() -> dict[str, str] | None:
    """Auth header, or None when no client ID is configured.

    A client ID is required for every endpoint, even public ones. Without it
    the provider stays quiet and the other providers cover, matching how every
    other optional provider here degrades.
    """
    client_id = (get_settings().MAL_CLIENT_ID or "").strip()
    return {"X-MAL-CLIENT-ID": client_id} if client_id else None


def _node(item: dict) -> dict:
    """List endpoints wrap entries in {"node": {...}}; detail endpoints don't."""
    return item.get("node") or item


def _medium_of(kind: str, media_type: str) -> str:
    if kind == "anime":
        return "Anime"
    return "Light Novel" if media_type in NOVEL_TYPES else "Manga"


def _total_of(medium: str, data: dict) -> int | None:
    """Episode / volume / chapter count, with MAL's 0-means-unknown mapped away.

    Ongoing series report 0 rather than null, and storing that would show a
    finished-looking "x / 0" on the entry.
    """
    if medium == "Anime":
        total = data.get("num_episodes")
    elif medium == "Light Novel":
        total = data.get("num_volumes")
    else:
        total = data.get("num_chapters")
    return total or None


def _year_of(data: dict) -> int | None:
    start = (data.get("start_date") or "")[:4]
    return int(start) if start.isdigit() else None


def _fields_of(data: dict, kind: str) -> dict:
    """Shared mapping from a MAL object to our result fields."""
    media_type = (data.get("media_type") or "").lower()
    medium = _medium_of(kind, media_type)
    alt = data.get("alternative_titles") or {}
    picture = data.get("main_picture") or {}
    mean = data.get("mean")
    mal_id = str(data.get("id") or "")
    return {
        "title": alt.get("en") or data.get("title") or "",
        "medium": medium,
        "origin": "Japanese",
        "year": _year_of(data),
        "cover_url": picture.get("large") or picture.get("medium"),
        "total": _total_of(medium, data),
        "external_id": mal_id,
        "source": "mal",
        "description": data.get("synopsis") or None,
        "external_url": f"https://myanimelist.net/{kind}/{mal_id}",
        "genres": ", ".join(
            g["name"] for g in (data.get("genres") or [])[:5] if g.get("name")
        ) or None,
        "external_rating": round(float(mean), 1) if mean else None,
    }


def to_search_result(data: dict, kind: str) -> SearchResult:
    """Public so the URL scraper and the MAL importer share one mapping."""
    return SearchResult(**_fields_of(data, kind))


async def search_mal(
    client: httpx.AsyncClient, title: str, limit: int = 10
) -> list[SearchResult]:
    """Title search against the official MyAnimeList API.

    https://myanimelist.net/apiconfig/references/api/v2
    Replaced the Jikan proxy, which MAL cut off from its search and ranking
    pages. Needs MAL_CLIENT_ID (register an app at myanimelist.net/apiconfig).
    """
    headers = _headers()
    query = (title or "").strip()
    if not headers or len(query) < MIN_QUERY_LEN:
        return []

    per_endpoint = max(1, min(limit, 100))
    results: list[SearchResult] = []

    for path, kind, fields in (
        ("/anime", "anime", ANIME_FIELDS),
        ("/manga", "manga", MANGA_FIELDS),
    ):
        try:
            r = await client.get(
                f"{BASE}{path}",
                params={"q": query, "limit": per_endpoint, "fields": fields},
                headers=headers,
            )
            r.raise_for_status()
            for item in r.json().get("data", []):
                results.append(to_search_result(_node(item), kind))
        except Exception as exc:
            logger.warning("MAL search error: %s", exc)

    return results


async def _discover_mal(
    client: httpx.AsyncClient, medium: str, page: int = 1
) -> list[ExploreItem]:
    """Top anime / manga / light novels for Explore."""
    ranking = _RANKINGS.get(medium)
    headers = _headers()
    if ranking is None or not headers:
        return []
    path, ranking_type, per_page = ranking
    kind = "anime" if medium == "Anime" else "manga"
    fields = ANIME_FIELDS if kind == "anime" else MANGA_FIELDS

    try:
        r = await client.get(
            f"{BASE}{path}",
            params={
                "ranking_type": ranking_type,
                "limit": per_page,
                "offset": (page - 1) * per_page,
                "fields": fields,
            },
            headers=headers,
        )
        r.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # A real outage (5xx) propagates so Explore can say MyAnimeList is down;
        # 4xx stays graceful so a fallback provider can fill in.
        if exc.response.status_code >= 500:
            raise
        logger.warning("MAL ranking error: %s", exc)
        return []
    except Exception as exc:
        logger.warning("MAL ranking error: %s", exc)
        return []

    out: list[ExploreItem] = []
    for item in r.json().get("data", []):
        data = _node(item)
        if (data.get("nsfw") or SAFE_NSFW) != SAFE_NSFW:
            continue
        media_type = (data.get("media_type") or "").lower()
        # The manga and light-novel tabs draw from the same rankings, so each
        # keeps only its own side of the novel split.
        if medium == "Manga" and media_type in NOVEL_TYPES:
            continue
        if medium == "Light Novel" and media_type not in NOVEL_TYPES:
            continue
        out.append(ExploreItem(**_fields_of(data, kind)))
    return out
