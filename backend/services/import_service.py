#!/usr/bin/env python3
"""
Import a CSV of personal media entries into the MediaTrack database.

Usage (run from the backend/ directory):
    python services/import_service.py [path/to/file.csv]

Defaults to ../../personal.csv relative to this script if no path is given.

CSV columns expected:
    Title, Type, Enjoyment, Objective, Date, Chapter/Episode, Notes

Column mapping:
    Title           → title
    Type            → medium  (normalised to app mediums)
    Objective       → rating
    Date            → completed_at  (DD/MM/YY)
    Chapter/Episode → progress / status
    Notes           → notes

For each row the script searches for the first result via search_media() to
auto-fill cover_url, year, origin, external_id, source, and total.
If search returns nothing, only CSV data is used.
"""
from __future__ import annotations

import asyncio
import csv
import io
import re
import sys
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

# ── Path fix so imports work when called from backend/ ────────────────────────
_BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_DIR))

from constants import (
    VALID_STATUSES as _VALID_STATUSES_SET,
    normalise_medium, normalise_origin,
)
from db import SessionLocal
from models import Entry
from services.search_service import search_media
from services.history_service import insert_entry, seed_history, parse_events, export_history


# ── Progress / status parsing ─────────────────────────────────────────────────

def _parse_progress(chap_ep: str) -> tuple[Optional[int], str]:
    """
    Returns (progress_or_None, status).

    "Completed"   → (None, "completed")
    "C325"        → (325, "current")
    "V2C29"       → (29, "current")   # chapter takes precedence
    "V12"         → (None, "current") # volume only, can't map to int progress
    "C45?"        → (45, "current")   # trailing ? stripped
    anything else → (None, "current")
    """
    val = chap_ep.strip()
    if val.lower() == "completed":
        return None, "completed"

    # Extract chapter number (C123 pattern)
    m = re.search(r'[Cc](\d+)', val)
    if m:
        return int(m.group(1)), "current"

    # Volume-only (V12) or unknown
    return None, "current"


# ── Date parsing ──────────────────────────────────────────────────────────────

def _parse_date(date_str: str) -> Optional[datetime]:
    for fmt in ("%d/%m/%y", "%d/%m/%Y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None

_VALID_STATUSES = _VALID_STATUSES_SET  # alias — canonical set lives in constants.py

# ── Export-format helpers (used by preview/confirm) ───────────────────────────

EXPORT_HEADERS = [
    "title", "medium", "origin", "year", "cover_url", "notes",
    "external_id", "source", "status", "rating", "progress", "total",
    "created_at", "updated_at", "completed_at",
    "external_url", "genres", "external_rating", "custom_list", "events",
]

PRE_HISTORY_HEADERS = [h for h in EXPORT_HEADERS if h != "events"]
LEGACY_EXPORT_HEADERS = [h for h in PRE_HISTORY_HEADERS if h != "custom_list"]

_COMPARE_FIELDS = [
    "title", "medium", "origin", "year", "cover_url", "notes",
    "external_id", "source", "status", "rating", "progress", "total",
    "created_at", "completed_at",
    "external_url", "genres", "external_rating", "custom_list",
]


def _csv_to_typed(row: dict) -> dict:
    """Convert a raw CSV row (all string values) to typed Python values."""
    def _int(v):
        s = (v or "").strip()
        if not s:
            return None
        try:
            return int(s)
        except (ValueError, TypeError):
            # Spreadsheets (Excel/Sheets) re-save integer columns as "6.0";
            # accept that rather than dropping the value (→ false conflicts).
            try:
                return int(float(s))
            except (ValueError, TypeError):
                return None

    def _float(v):
        try:
            s = (v or "").strip()
            return float(s) if s else None
        except (ValueError, TypeError):
            return None

    def _str(v):
        s = (v or "").strip()
        return s or None

    def _dt(v):
        s = (v or "").strip()
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return _parse_date(s)

    raw_status = _str(row.get("status")) or "planned"
    return {
        "title":           _str(row.get("title")),
        "medium":          normalise_medium(_str(row.get("medium"))),
        "origin":          normalise_origin(_str(row.get("origin"))),
        "year":            _int(row.get("year")),
        "cover_url":       _str(row.get("cover_url")),
        "notes":           row.get("notes") or None,
        "external_id":     _str(row.get("external_id")),
        "source":          _str(row.get("source")),
        "status":          raw_status if raw_status in _VALID_STATUSES else "planned",
        "rating":          _float(row.get("rating")),
        "progress":        _int(row.get("progress")),
        "total":           _int(row.get("total")),
        "created_at":      _dt(row.get("created_at")),
        "updated_at":      _dt(row.get("updated_at")),
        "completed_at":    _dt(row.get("completed_at")),
        "external_url":    _str(row.get("external_url")),
        "genres":          _str(row.get("genres")),
        "external_rating": _float(row.get("external_rating")),
        "custom_list":     _str(row.get("custom_list")),
        "events":          parse_events(row.get("events")),
    }


def _dt_equal(a: Optional[datetime], b: Optional[datetime]) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    a_u = a.astimezone(timezone.utc) if a.tzinfo else a.replace(tzinfo=timezone.utc)
    b_u = b.astimezone(timezone.utc) if b.tzinfo else b.replace(tzinfo=timezone.utc)
    return a_u.replace(microsecond=0) == b_u.replace(microsecond=0)


def _numeric_equal(a, b) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return Decimal(str(a)) == Decimal(str(b))
    except (InvalidOperation, ValueError, TypeError):
        return a == b


def _fields_equal(field: str, csv_val, db_val) -> bool:
    if field in {"created_at", "completed_at"}:
        return _dt_equal(csv_val, db_val)
    # Compare every numeric field by value so 6 and 6.0 match (avoids spurious
    # conflicts from int/float formatting, e.g. a spreadsheet-mangled re-export).
    if field in {"rating", "external_rating", "year", "progress", "total"}:
        return _numeric_equal(csv_val, db_val)
    return csv_val == db_val


def _entry_to_dict(entry: "Entry") -> dict:
    result = {"id": entry.id}
    for col in EXPORT_HEADERS:
        if col == "events":
            continue
        val = getattr(entry, col)
        if isinstance(val, datetime):
            val = val.isoformat()
        result[col] = val
    return result


def preview_import(db: Session, csv_content: str, username: str) -> dict:
    """
    Validate CSV headers and categorise each row as:
      - to_import:        no DB entry with same title+medium+year
      - exact_duplicates: identical to an existing entry in all compared fields
      - conflicts:        same title+medium+year but at least one differing field
    Returns a dict safe for JSON serialisation.
    """
    reader = csv.DictReader(io.StringIO(csv_content))
    fieldnames = list(reader.fieldnames or [])
    if fieldnames not in (EXPORT_HEADERS, PRE_HISTORY_HEADERS, LEGACY_EXPORT_HEADERS):
        return {
            "error": "Invalid CSV headers. This file must be exported from this app.",
            "to_import": [],
            "exact_duplicates": [],
            "conflicts": [],
        }

    rows = list(reader)
    db_entries = db.query(Entry).filter(Entry.username == username).all()

    to_import: list[dict] = []
    exact_duplicates: list[dict] = []
    conflicts: list[dict] = []

    histories = export_history(db, [e.id for e in db_entries])
    for row in rows:
        try:
            typed = _csv_to_typed(row)
        except ValueError as exc:
            return {"error": str(exc), "to_import": [], "exact_duplicates": [], "conflicts": []}
        title = typed.get("title")
        if not title:
            continue

        medium = typed.get("medium")
        year = typed.get("year")

        identity_matches = [
            e for e in db_entries
            if e.title == title and e.medium == medium and e.year == year
        ]

        if not identity_matches:
            to_import.append(row)
            continue

        # Check each match for exact equality
        exact_found = any(
            all(_fields_equal(f, typed.get(f), getattr(e, f)) for f in _COMPARE_FIELDS)
            and (typed["events"] is None or typed["events"] == parse_events(histories[e.id]))
            for e in identity_matches
        )

        if exact_found:
            exact_duplicates.append(row)
        else:
            for db_entry in identity_matches:
                conflicts.append({
                    "csv_row": row,
                    "db_entry": _entry_to_dict(db_entry),
                })

    return {
        "error": None,
        "to_import": to_import,
        "exact_duplicates": exact_duplicates,
        "conflicts": conflicts,
    }


def confirm_import(
    db: Session,
    to_create: list[dict],
    to_update: list[dict],
    username: str,
) -> dict:
    """
    Execute the import after the user has resolved conflicts.
    to_create: raw CSV row dicts to insert as new entries.
    to_update: list of {"db_id": int, "csv_row": {raw CSV row}} for updates.
    Returns {"created": N, "updated": N, "skipped": N}.
    """
    created = updated = skipped = 0

    for row in to_create:
        typed = _csv_to_typed(row)
        if not typed.get("title"):
            skipped += 1
            continue
        entry_data = dict(
            title=typed["title"],
            medium=typed.get("medium"),
            origin=typed.get("origin"),
            year=typed.get("year"),
            cover_url=typed.get("cover_url"),
            notes=typed.get("notes"),
            external_id=typed.get("external_id"),
            source=typed.get("source"),
            status=typed["status"],
            rating=typed.get("rating"),
            progress=typed.get("progress"),
            total=typed.get("total"),
            completed_at=typed.get("completed_at"),
            external_url=typed.get("external_url"),
            genres=typed.get("genres"),
            external_rating=typed.get("external_rating"),
            custom_list=typed.get("custom_list"),
            username=username,
        )
        if typed.get("created_at") is not None:
            entry_data["created_at"] = typed["created_at"]
        # Preserve the CSV's updated_at on insert. INSERT doesn't fire the
        # column's onupdate hook, so the explicit value sticks; only when the
        # CSV omits it does the server_default stamp "now".
        if typed.get("updated_at") is not None:
            entry_data["updated_at"] = typed["updated_at"]
        insert_entry(db, {**entry_data, "events": typed.get("events")}, source="csv")
        created += 1

    for item in to_update:
        entry = db.query(Entry).filter(
            Entry.id == item.get("db_id"),
            Entry.username == username,
        ).first()
        if not entry:
            skipped += 1
            continue
        typed = _csv_to_typed(item.get("csv_row", {}))
        if not typed.get("title"):
            skipped += 1
            continue
        entry.title           = typed["title"]
        entry.medium          = typed.get("medium")
        entry.origin          = typed.get("origin")
        entry.year            = typed.get("year")
        entry.cover_url       = typed.get("cover_url")
        entry.notes           = typed.get("notes")
        entry.external_id     = typed.get("external_id")
        entry.source          = typed.get("source")
        entry.status          = typed["status"]
        entry.rating          = typed.get("rating")
        entry.progress        = typed.get("progress")
        entry.total           = typed.get("total")
        entry.external_url    = typed.get("external_url")
        entry.genres          = typed.get("genres")
        entry.external_rating = typed.get("external_rating")
        entry.custom_list     = typed.get("custom_list")
        seed_history(db, entry, typed, source="csv", replace=True)
        updated += 1

    db.commit()
    return {"created": created, "updated": updated, "skipped": skipped}


def import_csv_for_user(db: Session, csv_content: str, username: str) -> dict:
    """
    Import entries from a CSV exported by this app (all DB columns).
    The `id` column is ignored. Valid CSV `created_at` / `updated_at` values are
    preserved; otherwise the database assigns the current timestamp.
    Returns {"created": N, "skipped": N}.
    """
    result = confirm_import(db, list(csv.DictReader(io.StringIO(csv_content))), [], username)
    return {"created": result["created"], "skipped": result["skipped"]}

SEARCH_DELAY = 0.4

_PUNCT_RE = re.compile(r"[^\w\s]")

def _titles_similar(csv_title: str, result_title: str, threshold: float = 0.4) -> bool:
    """
    Returns True if result_title is close enough to csv_title to replace it.
    Uses token-overlap: |shared| / max(|csv_tokens|, |result_tokens|) >= threshold.
    """
    def _tokens(s: str) -> set[str]:
        return set(_PUNCT_RE.sub(" ", s.lower()).split())

    csv_tokens    = _tokens(csv_title)
    result_tokens = _tokens(result_title)
    if not csv_tokens or not result_tokens:
        return False
    shared = csv_tokens & result_tokens
    return len(shared) / max(len(csv_tokens), len(result_tokens)) >= threshold

def _parse_auto_csv(csv_content: str) -> list[dict]:
    """
    Parse a CSV using EXPORT_HEADERS columns.
    Only 'title' is required; all other columns are optional — missing columns
    default to empty string (handled downstream as None).
    """
    reader = csv.DictReader(io.StringIO(csv_content))
    rows = []
    for row in reader:
        title = (row.get("title") or "").strip()
        if title:
            rows.append(row)
    return rows


async def auto_import_rows(csv_content: str, db: Session, username: str):
    """
    Async generator that yields event dicts for SSE streaming.

    For each CSV row (title required, all other EXPORT_HEADERS optional):
      - searches for metadata via search_media()
      - creates an Entry, overriding metadata fields with search results
      - yields {"type": "log", "message": "..."}

    Terminates with {"type": "done", "created": N, "skipped": N}.
    """
    rows = _parse_auto_csv(csv_content)
    total = len(rows)

    if total == 0:
        yield {"type": "done", "created": 0, "skipped": 0}
        return

    created = skipped = 0

    for i, row in enumerate(rows, start=1):
        typed = _csv_to_typed(row)
        title = typed.get("title")

        if not title:
            skipped += 1
            yield {"type": "log", "message": f"[{i}/{total}] SKIP — empty title"}
            continue

        medium = typed.get("medium") or ""

        # ── Search for metadata ───────────────────────────────────────────────
        # Initialise from CSV; None means the column was absent/empty.
        cover_url       = typed.get("cover_url")
        year            = typed.get("year")
        origin          = typed.get("origin")
        external_id     = typed.get("external_id")
        source          = typed.get("source")
        total_ep        = typed.get("total")
        external_url    = typed.get("external_url")
        genres          = typed.get("genres")
        external_rating = typed.get("external_rating")
        custom_list     = typed.get("custom_list")

        try:
            # Narrow providers by medium when available.
            results = await search_media(title, medium=medium)
            if results:
                r = results[0]
                # CSV values take priority: only fill from search if CSV had no value.
                if cover_url       is None: cover_url       = r.cover_url
                if year            is None: year            = r.year
                if origin          is None: origin          = r.origin
                if external_id     is None: external_id     = r.external_id
                if source          is None: source          = r.source
                if total_ep        is None: total_ep        = r.total
                if external_url    is None: external_url    = r.external_url
                if genres          is None: genres          = r.genres
                if external_rating is None: external_rating = r.external_rating
                if _titles_similar(title, r.title):
                    display = f"'{title}' → '{r.title}'" if r.title != title else f"'{title}'"
                    title = r.title
                else:
                    display = f"'{title}' (kept; result was '{r.title}')"
                yield {"type": "log", "message": f"[{i}/{total}] FOUND  {display} ({r.source})"}
            else:
                yield {"type": "log", "message": f"[{i}/{total}] NO HIT '{title}' (medium={medium or '—'})"}
        except Exception as exc:
            yield {"type": "log", "message": f"[{i}/{total}] ERROR  '{title}': {exc}"}

        entry_data = dict(
            title=title,
            medium=typed.get("medium"),
            origin=origin,
            year=year,
            cover_url=cover_url,
            notes=typed.get("notes"),
            status=typed["status"],
            rating=typed.get("rating"),
            progress=typed.get("progress"),
            total=total_ep,
            external_id=external_id,
            source=source,
            external_url=external_url,
            genres=genres,
            external_rating=external_rating,
            custom_list=custom_list,
            completed_at=typed.get("completed_at"),
            username=username,
        )
        if typed.get("created_at") is not None:
            entry_data["created_at"] = typed["created_at"]
        insert_entry(db, {**entry_data, "updated_at": typed.get("updated_at"), "events": typed.get("events")}, source="auto")
        db.commit()
        created += 1

        if i < total:
            await asyncio.sleep(SEARCH_DELAY)

    yield {"type": "done", "created": created, "skipped": skipped}
