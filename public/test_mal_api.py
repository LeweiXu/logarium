"""Check the official MyAnimeList API v2 against what Logarium needs from Jikan.

Every public MAL endpoint needs an API client ID (no anonymous access), so
register an app at https://myanimelist.net/apiconfig, then:

    MAL_CLIENT_ID=xxxx ~/venvs/LOG-venv/bin/python public/test_mal_api.py

It exercises the five call shapes the Jikan provider uses (title search for
anime and manga, by-id lookup for both, and the popularity rankings that feed
Explore), maps each response onto the SearchResult fields we actually store,
and reports which of them the official API fills in. The last section fires a
burst of requests to get a rough read on the rate limit, since MAL doesn't
document one.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.myanimelist.net/v2"
CLIENT_ID = os.environ.get("MAL_CLIENT_ID", "").strip()

# Everything we pull out of Jikan today, per medium.
ANIME_FIELDS = "id,title,alternative_titles,main_picture,start_date,synopsis,mean,genres,media_type,num_episodes,nsfw,status"
MANGA_FIELDS = "id,title,alternative_titles,main_picture,start_date,synopsis,mean,genres,media_type,num_volumes,num_chapters,nsfw,status"


def get(path: str, **params) -> tuple[int, dict]:
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"X-MAL-CLIENT-ID": CLIENT_ID})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        return e.code, {"error": body}
    except Exception as e:  # network, timeout, bad json
        return 0, {"error": str(e)}


def node_of(item: dict) -> dict:
    """List endpoints wrap each entry in {"node": {...}}; detail endpoints don't."""
    return item.get("node", item)


def to_entry(d: dict, kind: str) -> dict:
    """Map a MAL object onto the fields Logarium stores for an entry."""
    alt = d.get("alternative_titles") or {}
    media_type = (d.get("media_type") or "").lower()
    if kind == "anime":
        medium = "Anime"
        total = d.get("num_episodes")
    elif media_type in ("light_novel", "novel"):
        medium = "Light Novel"
        total = d.get("num_volumes")
    else:
        medium = "Manga"
        total = d.get("num_chapters")
    pic = d.get("main_picture") or {}
    start = d.get("start_date") or ""
    mean = d.get("mean")
    return {
        "title": alt.get("en") or d.get("title"),
        "medium": medium,
        "year": int(start[:4]) if start[:4].isdigit() else None,
        "cover_url": pic.get("large") or pic.get("medium"),
        "total": total,
        "external_id": str(d.get("id") or ""),
        "description": d.get("synopsis") or None,
        "genres": ", ".join(g["name"] for g in (d.get("genres") or [])[:5]) or None,
        "external_rating": round(float(mean), 1) if mean else None,
        "nsfw": d.get("nsfw"),
    }


def report(label: str, status: int, payload: dict, kind: str) -> None:
    if status != 200:
        print(f"  {label:<34} FAIL {status} {str(payload.get('error'))[:90]}")
        return
    items = payload.get("data") or []
    if not items:
        print(f"  {label:<34} OK   {status} but zero results")
        return
    first = to_entry(node_of(items[0]), kind)
    missing = [k for k, v in first.items() if v in (None, "")]
    print(f"  {label:<34} OK   {len(items):>3} results | first: {str(first['title'])[:38]!r}")
    print(f"  {'':<34}      medium={first['medium']} year={first['year']} total={first['total']} "
          f"score={first['external_rating']} nsfw={first['nsfw']}")
    if missing:
        print(f"  {'':<34}      empty fields: {', '.join(missing)}")


def main() -> int:
    if not CLIENT_ID:
        print("Set MAL_CLIENT_ID first (register at https://myanimelist.net/apiconfig).")
        return 2

    print("Search (replaces /v4/anime?q= and /v4/manga?q=)")
    report("anime?q=frieren", *get("/anime", q="frieren", limit=5, fields=ANIME_FIELDS), kind="anime")
    report("manga?q=berserk", *get("/manga", q="berserk", limit=5, fields=MANGA_FIELDS), kind="manga")
    report("manga?q=overlord (LN check)", *get("/manga", q="overlord", limit=5, fields=MANGA_FIELDS), kind="manga")

    print("\nBy id (replaces /v4/{anime,manga}/{id}: MAL import + URL scraper)")
    s, p = get("/anime/52991", fields=ANIME_FIELDS)
    report("anime/52991", s, {"data": [p]} if s == 200 else p, kind="anime")
    s, p = get("/manga/2", fields=MANGA_FIELDS)
    report("manga/2", s, {"data": [p]} if s == 200 else p, kind="manga")

    print("\nRanking (replaces /v4/top/*: Explore discovery)")
    report("anime/ranking bypopularity", *get("/anime/ranking", ranking_type="bypopularity", limit=25, fields=ANIME_FIELDS), kind="anime")
    report("anime/ranking page 2 (offset)", *get("/anime/ranking", ranking_type="bypopularity", limit=25, offset=25, fields=ANIME_FIELDS), kind="anime")
    report("manga/ranking bypopularity", *get("/manga/ranking", ranking_type="bypopularity", limit=25, fields=MANGA_FIELDS), kind="manga")
    report("manga/ranking novels (LN)", *get("/manga/ranking", ranking_type="novels", limit=25, fields=MANGA_FIELDS), kind="manga")

    # How much of the "novels" ranking is actually light novels vs plain novels,
    # since that ranking mixes both and Explore wants only light novels.
    s, p = get("/manga/ranking", ranking_type="novels", limit=50, fields=MANGA_FIELDS)
    if s == 200:
        types: dict[str, int] = {}
        for item in p.get("data", []):
            t = (node_of(item).get("media_type") or "?").lower()
            types[t] = types.get(t, 0) + 1
        print(f"  {'novels ranking media_type mix':<34} {types}")

    print("\nNSFW leakage (Jikan had sfw=true; MAL has no such filter)")
    s, p = get("/anime", q="overflow", limit=10, fields=ANIME_FIELDS)
    if s == 200:
        flags: dict[str, int] = {}
        for item in p.get("data", []):
            f = str(node_of(item).get("nsfw"))
            flags[f] = flags.get(f, 0) + 1
        print(f"  {'nsfw flags in results':<34} {flags}  (white=safe, gray/black=not)")

    print("\nRate limit (20 requests as fast as possible)")
    t0 = time.monotonic()
    codes: dict[int, int] = {}
    for _ in range(20):
        s, _p = get("/anime", q="a", limit=1, fields="id,title")
        codes[s] = codes.get(s, 0) + 1
    elapsed = time.monotonic() - t0
    print(f"  20 requests in {elapsed:.1f}s ({20 / elapsed:.1f}/s) -> {codes}")
    if 429 in codes:
        print("  429s seen: keep a limiter (Jikan's was 2.5/s, 55/min).")
    else:
        print("  no 429s: the current Jikan limiter can probably be relaxed a lot.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
