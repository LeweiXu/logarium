"""Resolve a MyAnimeList URL into a SearchResult via the official MAL API."""
from __future__ import annotations

import re
from typing import Optional

from schemas import SearchResult
from services.search_providers.mal import (
    ANIME_FIELDS, BASE, MANGA_FIELDS, _headers, to_search_result,
)


async def fetch(client, url: str) -> Optional[SearchResult]:
    # myanimelist.net/anime/1535  or  /manga/13/...  (trailing slug ignored)
    m = re.search(r"myanimelist\.net/(anime|manga)/(\d+)", url)
    headers = _headers()
    if not m or not headers:
        return None
    kind, mal_id = m.group(1), m.group(2)
    fields = ANIME_FIELDS if kind == "anime" else MANGA_FIELDS

    try:
        r = await client.get(
            f"{BASE}/{kind}/{mal_id}", params={"fields": fields}, headers=headers
        )
        r.raise_for_status()
        data = r.json() or {}
    except Exception:
        return None
    if not data.get("id"):
        return None

    result = to_search_result(data, kind)
    return result if result.title else None
