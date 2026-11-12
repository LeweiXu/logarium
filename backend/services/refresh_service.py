"""Re-fetch entries from the source page they came from, in bulk.

The detail modal can refresh one entry at a time; this does a whole source at
once. Same idea either way: resolve the entry's external_url through its
provider and fill in what came back, without clobbering anything the user set.
"""
from __future__ import annotations

import asyncio
import logging

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from constants import LEGACY_SOURCES
from models import Entry
from schemas import EntryUpdate
from services import entry_service
from services.url_import_service import fetch_from_url

logger = logging.getLogger(__name__)

# What a refresh may touch at all: facts that belong to the source. Status,
# rating, progress, notes and list membership are the user's, so they stay put.
REFRESHABLE_FIELDS = (
    "title", "medium", "origin", "year", "total", "cover_url",
    "genres", "external_rating", "external_id",
)

# What it touches unless you say otherwise. `title`, `medium` and `origin` are
# left out on purpose: those are classifications people curate, and a provider
# will happily call a web novel a light novel or rename a series to its romaji
# title. The single-entry refresh shows you a diff before saving, a bulk run
# doesn't, so the default here only covers facts the source is actually better
# at than you are.
DEFAULT_FIELDS = ("year", "total", "cover_url", "genres", "external_rating", "external_id")

# Space out the per-entry fetches: this walks a whole source in one go and the
# providers are somebody else's servers.
REQUEST_DELAY_S = 0.2


def _with_legacy(sources) -> list[str]:
    """Include retired source names alongside their current one.

    Entries saved before a source was renamed still carry the old value (every
    pre-MAL-migration anime row says "jikan"), and they are exactly the rows a
    refresh is for, so asking for "mal" has to reach them too.
    """
    wanted = {s for s in sources if s}
    for old_name, current in LEGACY_SOURCES.items():
        if current in wanted:
            wanted.add(old_name)
    return sorted(wanted)


def _short(value, cap: int = 60) -> str | None:
    """Values go to the browser for the summary, so keep covers and synopses short."""
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= cap else text[:cap - 1] + "\u2026"


def _changes(entry: Entry, fetched, fields) -> dict:
    """Fields worth writing: requested, present in the result, actually different."""
    out = {}
    for field in fields:
        value = getattr(fetched, field, None)
        if value in (None, "") or value == getattr(entry, field):
            continue
        out[field] = value
    return out


async def refresh_entries(db: Session, username: str, sources: list[str], fields=None):
    """Yield SSE events while refreshing every entry from the given sources."""
    sources = _with_legacy(sources)
    fields = [f for f in (fields or DEFAULT_FIELDS) if f in REFRESHABLE_FIELDS]
    if not sources or not fields:
        yield {"type": "done", "total": 0, "updated": 0, "unchanged": 0,
               "failed": 0, "changes": []}
        return

    entries = db.execute(
        select(Entry).where(
            Entry.username == username,
            Entry.source.in_(sources),
            Entry.external_url.is_not(None),
            Entry.external_url != "",
        ).order_by(Entry.title)
    ).scalars().all()

    total = len(entries)
    yield {"type": "start", "total": total}

    updated = unchanged = failed = 0
    changes: list[dict] = []

    for index, entry in enumerate(entries, start=1):
        title = entry.title
        try:
            results = await fetch_from_url(entry.external_url)
            fetched = results[0] if results else None
            if fetched is None:
                failed += 1
                outcome = "failed"
            else:
                patch = _changes(entry, fetched, fields)
                if patch:
                    was = {f: getattr(entry, f) for f in patch}
                    entry_service.update_entry(db, entry, EntryUpdate(**patch))
                    updated += 1
                    outcome = "updated"
                    changes.append({
                        "title": title,
                        "fields": [
                            {"field": f, "from": _short(was[f]), "to": _short(patch[f])}
                            for f in sorted(patch)
                        ],
                    })
                else:
                    unchanged += 1
                    outcome = "unchanged"
        except Exception as exc:  # a dead page, a provider wobble, bad data
            db.rollback()
            failed += 1
            outcome = "failed"
            logger.info("refresh failed for %r: %s", title, exc)

        yield {
            "type": "progress", "processed": index, "total": total,
            "title": title, "outcome": outcome,
            "updated": updated, "unchanged": unchanged, "failed": failed,
        }
        if index < total:
            await asyncio.sleep(REQUEST_DELAY_S)

    yield {
        "type": "done", "total": total,
        "updated": updated, "unchanged": unchanged, "failed": failed,
        # Enough detail for the summary to say what actually changed, capped so
        # a thousand-entry run doesn't ship a thousand rows to the browser.
        "changes": changes[:50], "changes_truncated": max(0, len(changes) - 50),
    }


def refreshable_counts(db: Session, username: str) -> dict[str, int]:
    """How many entries each source could refresh, for the picker."""
    rows = db.execute(
        select(Entry.source, Entry.external_url).where(
            Entry.username == username,
            Entry.source.is_not(None),
            Entry.external_url.is_not(None),
            Entry.external_url != "",
        )
    ).all()
    counts: dict[str, int] = {}
    for source, _url in rows:
        # Report retired names under the source they became, so the picker shows
        # one row per source and its count covers the old entries too.
        key = LEGACY_SOURCES.get(source, source)
        counts[key] = counts.get(key, 0) + 1
    return counts
