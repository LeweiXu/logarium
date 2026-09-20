"""URL-based single-page scrapers / API resolvers for media sites.

Each module exposes ``async def fetch(client, url) -> SearchResult | None``.
``DOMAIN_SCRAPERS`` maps a domain substring to its resolver; the import service
picks the first entry whose key matches the pasted URL's host. To add a site,
drop in a module and register its domain(s) here.

The no-API sites (novelupdates, jjwxc, qidian, imdb) scrape HTML/app endpoints;
the rest resolve the pasted URL's id against the same provider APIs used for
keyword search.
"""
from __future__ import annotations

from . import (
    novelupdates, jjwxc, qidian, imdb, goodreads,
    tmdb, anilist, mal, kitsu, mangadex, mangaupdates,
    igdb, rawg, google_books, open_library, comicvine, vndb,
)

DOMAIN_SCRAPERS = {
    # No-API sites (HTML / app-endpoint scraping)
    "novelupdates.com": novelupdates.fetch,
    "jjwxc.net":        jjwxc.fetch,
    "qidian.com":       qidian.fetch,
    "imdb.com":         imdb.fetch,
    "goodreads.com":    goodreads.fetch,   # book page → 1 result; series → many
    # API-backed sources
    "themoviedb.org":   tmdb.fetch,
    "anilist.co":       anilist.fetch,
    "myanimelist.net":  mal.fetch,
    "kitsu.io":         kitsu.fetch,
    "kitsu.app":        kitsu.fetch,
    "mangadex.org":     mangadex.fetch,
    "mangaupdates.com": mangaupdates.fetch,
    "baka-updates.com": mangaupdates.fetch,
    "igdb.com":         igdb.fetch,
    "rawg.io":          rawg.fetch,
    "books.google.com": google_books.fetch,
    "play.google.com":  google_books.fetch,
    "openlibrary.org":  open_library.fetch,
    "comicvine.gamespot.com": comicvine.fetch,
    "vndb.org":         vndb.fetch,
}

__all__ = ["DOMAIN_SCRAPERS"]
