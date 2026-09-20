from __future__ import annotations

import asyncio
import logging
import re

import httpx

from schemas import SearchResult

logger = logging.getLogger(__name__)

_MANGAUPDATES_TYPE_TO_MEDIUM: dict[str, str] = {
    "Manga": "Manga",
    "Manhwa": "Comic",
    "Manhua": "Comic",
    "Novel": "Light Novel",
    "Light Novel": "Light Novel",
    "Doujinshi": "Manga",
    "OEL": "Comic",
    "Artbook": "Manga",
}


async def search_mangaupdates(
    client: httpx.AsyncClient, title: str, limit: int = 10
) -> list[SearchResult]:
    """
    MangaUpdates public API — no API key required.
    https://api.mangaupdates.com/
    Credit: MangaUpdates (per their acceptable use policy).
    """
    try:
        r = await client.post(
            "https://api.mangaupdates.com/v1/series/search",
            json={"search": title, "perpage": max(1, min(limit, 100))},
        )
        r.raise_for_status()
        results: list[SearchResult] = []
        for item in r.json().get("results", []):
            record = item.get("record", {})
            mu_id = str(record.get("series_id", ""))
            display_title = record.get("title", "")
            img = record.get("image", {})
            img_url = img.get("url", {})
            cover = (
                img_url.get("original")
                or img_url.get("thumb")
            )
            year_str = record.get("year") or ""
            try:
                year = int(str(year_str)[:4]) if year_str else None
            except (ValueError, TypeError):
                year = None
            mu_type = record.get("type") or ""
            med_resolved = _MANGAUPDATES_TYPE_TO_MEDIUM.get(mu_type, "Manga")
            if mu_type == "Manhwa":
                origin = "Korean"
            elif mu_type == "Manhua":
                origin = "Chinese"
            elif mu_type in ("OEL",):
                origin = "Western"
            else:
                origin = "Japanese"
            desc = record.get("description") or ""
            desc = re.sub(r"<[^>]+>", "", desc)
            mu_genres = record.get("genres") or []
            genres_str = ", ".join(
                g["genre"] for g in mu_genres[:5] if g.get("genre")
            ) or None
            bayesian = record.get("bayesian_rating")
            try:
                ext_rating = round(float(bayesian), 1) if bayesian else None
            except (ValueError, TypeError):
                ext_rating = None
            results.append(
                SearchResult(
                    title=display_title,
                    medium=med_resolved,
                    origin=origin,
                    year=year,
                    cover_url=cover,
                    external_id=mu_id,
                    source="mangaupdates",
                    description=desc or None,
                    external_url=record.get("url"),
                    genres=genres_str,
                    external_rating=ext_rating,
                )
            )

        # MangaUpdates has no "chapter total" field, so fill each result's total
        # with the latest translated chapter (from releases) concurrently.
        ids = [(i, r.external_id) for i, r in enumerate(results) if r.external_id]
        if ids:
            counts = await asyncio.gather(
                *(_latest_chapter(client, sid) for _, sid in ids)
            )
            for (i, _), count in zip(ids, counts):
                if count:
                    results[i].total = count

        return results
    except Exception as exc:
        logger.warning("MangaUpdates search error: %s", exc)
        return []


async def _latest_chapter(client: httpx.AsyncClient, series_id: str) -> int | None:
    """Latest translated chapter number for a MangaUpdates series.

    Prefers the series' ``latest_chapter`` field; if absent, derives it from the
    releases RSS feed (titles look like ``"One Piece c.1183"``). MangaUpdates
    doesn't expose a true chapter total, so this latest-release number is the
    closest available proxy.
    """
    try:
        d = await client.get(f"https://api.mangaupdates.com/v1/series/{series_id}")
        d.raise_for_status()
        latest = d.json().get("latest_chapter")
        if latest:
            return int(latest)
    except Exception as exc:
        logger.warning("MangaUpdates series detail error for %s: %s", series_id, exc)

    try:
        r = await client.get(f"https://api.mangaupdates.com/v1/series/{series_id}/rss")
        r.raise_for_status()
        chapters = [int(c) for c in re.findall(r"c\.(\d+)", r.text)]
        if chapters:
            return max(chapters)
    except Exception as exc:
        logger.warning("MangaUpdates releases RSS error for %s: %s", series_id, exc)

    return None


async def mangaupdates_chapter_count(
    client: httpx.AsyncClient, title: str
) -> int | None:
    """Best-match latest chapter number for ``title`` on MangaUpdates.

    Used as a fallback when MAL reports no chapter total for an ongoing
    series. Takes the top search hit, then reads the latest translated chapter.
    """
    try:
        r = await client.post(
            "https://api.mangaupdates.com/v1/series/search",
            json={"search": title, "perpage": 1},
        )
        r.raise_for_status()
        hits = r.json().get("results", [])
        if not hits:
            return None
        series_id = hits[0].get("record", {}).get("series_id")
        if not series_id:
            return None
    except Exception as exc:
        logger.warning("MangaUpdates chapter-count lookup error for %r: %s", title, exc)
        return None

    return await _latest_chapter(client, series_id)
