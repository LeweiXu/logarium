"""
Single source of truth for the canonical allowed values of constrained Entry fields.

Rules:
  - VALID_STATUSES  : allowed values for Entry.status
  - VALID_MEDIUMS   : allowed values for Entry.medium
  - VALID_ORIGINS   : allowed values for Entry.origin

Normalisation maps convert common aliases / wrong-case inputs to their canonical
form.  normalise_*() returns None unchanged so optional fields compose cleanly.
"""
from __future__ import annotations

# ── Statuses ──────────────────────────────────────────────────────────────────

VALID_STATUSES: frozenset[str] = frozenset({
    "current", "planned", "completed", "on_hold", "dropped",
})

# ── Mediums ───────────────────────────────────────────────────────────────────

VALID_MEDIUMS: frozenset[str] = frozenset({
    "Film", "TV Show", "Anime", "Book", "Manga",
    "Light Novel", "Web Novel", "Comic", "Game", "Visual Novel",
})

# Keys are lowercase aliases; values are canonical forms.
MEDIUM_NORMALISE_MAP: dict[str, str] = {
    # Web / light novel
    "web novel":   "Web Novel",
    "webnovel":    "Web Novel",
    "light novel": "Light Novel",
    # Anime / animation
    "anime":    "Anime",
    "donghua":  "Anime",   # Chinese animation
    # Manga variants
    "manga":    "Manga",
    "manhwa":   "Manga",   # Korean
    "manhua":   "Manga",   # Chinese
    # Film
    "film":  "Film",
    "movie": "Film",
    # TV
    "tv show": "TV Show",
    "tv":      "TV Show",
    # Visual novel
    "visual novel": "Visual Novel",
    "vn":           "Visual Novel",
    # Other
    "book":   "Book",
    "comics": "Comic",
    "comic":  "Comic",
    "game":   "Game",
}


def normalise_medium(raw: str | None) -> str | None:
    if raw is None:
        return None
    return MEDIUM_NORMALISE_MAP.get(raw.strip().lower(), raw.strip())


# ── Origins ───────────────────────────────────────────────────────────────────

VALID_ORIGINS: frozenset[str] = frozenset({
    "Japanese", "Korean", "Chinese", "Western", "Other", "",
})

ORIGIN_NORMALISE_MAP: dict[str, str] = {
    "japanese": "Japanese",
    "japan":    "Japanese",
    "jp":       "Japanese",
    "korean":   "Korean",
    "korea":    "Korean",
    "kr":       "Korean",
    "chinese":  "Chinese",
    "china":    "Chinese",
    "cn":       "Chinese",
    "western":  "Western",
    "american": "Western",
    "english":  "Western",
    "usa":      "Western",
    "us":       "Western",
    "uk":       "Western",
    "europe":   "Western",
    "eu":       "Western",
    "other":    "Other",
}


def normalise_origin(raw: str | None) -> str | None:
    if raw is None:
        return None
    return ORIGIN_NORMALISE_MAP.get(raw.strip().lower(), raw.strip())


# ── Source / URL ──────────────────────────────────────────────────────────────

# Maps a URL hostname fragment to its canonical source name.
SOURCE_URL_MAP: dict[str, str] = {
    "themoviedb.org":         "tmdb",
    "anilist.co":             "anilist",
    "myanimelist.net":        "mal",
    "kitsu.io":               "kitsu",
    "novelupdates.com":       "novelupdates",
    "mangadex.org":           "mangadex",
    "igdb.com":               "igdb",
    "rawg.io":                "rawg",
    "books.google.com":       "google_books",
    "openlibrary.org":        "open_library",
    "comicvine.gamespot.com": "comicvine",
    "mangaupdates.com":       "mangaupdates",
    "baka-updates.com":       "mangaupdates",
    "vndb.org":               "vndb",
}

# "jikan" is the retired name for the MyAnimeList source (the Jikan proxy MAL
# cut off). Entries saved before the switch still carry it, and so does the
# browser extension until its next release, so it stays valid here.
LEGACY_SOURCES: dict[str, str] = {"jikan": "mal"}

VALID_SOURCES: frozenset[str] = frozenset(SOURCE_URL_MAP.values()) | frozenset(LEGACY_SOURCES)


def infer_source_from_url(url: str | None) -> str | None:
    """Return the canonical source name for a URL, or None if unrecognised."""
    if not url:
        return None
    url_lower = url.lower()
    for domain, source in SOURCE_URL_MAP.items():
        if domain in url_lower:
            return source
    return None
