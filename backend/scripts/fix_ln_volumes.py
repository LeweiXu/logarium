#!/usr/bin/env python3
"""
Fix Light Novel entries that stored MAL's *chapter* count as the total instead
of the *volume* count.

For every entry with medium='Light Novel' and source in (jikan, mal), this
re-queries the MAL manga endpoint by the entry's external_id (MAL id) and sets
``total`` to the series' volume count. Entries whose volume count is unknown
(e.g. ongoing series MAL hasn't filled in) are left untouched — no fallback.

Usage:
    python fix_ln_volumes.py [username] [--dry-run]

    username   defaults to "lingwei"
    --dry-run  report changes without committing
"""

import os
import sys
import time

# Allow running from anywhere — put the backend root on sys.path (so `db`,
# `models`, `config` import) and chdir into it (so config's relative `.env`
# loads). chdir alone is not enough: imports resolve via sys.path, not cwd.
_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(_BACKEND_DIR)
sys.path.insert(0, _BACKEND_DIR)

import httpx
from db import SessionLocal
from models import Entry
from services.search_providers.mal import _headers as _mal_headers

MAL_MANGA_URL = "https://api.myanimelist.net/v2/manga/{mal_id}"
REQUEST_DELAY_SECONDS = 0.1


def _fetch_volumes(client: httpx.Client, mal_id: str) -> int | None:
    headers = _mal_headers()
    if not headers:
        raise RuntimeError("MAL_CLIENT_ID is not set (see backend/.env)")
    r = client.get(
        MAL_MANGA_URL.format(mal_id=mal_id),
        params={"fields": "num_volumes"},
        headers=headers,
    )
    r.raise_for_status()
    # Ongoing series report 0 volumes rather than null.
    return r.json().get("num_volumes") or None


def fix_ln_volumes(username: str, dry_run: bool = False) -> None:
    db = SessionLocal()
    try:
        entries = (
            db.query(Entry)
            .filter(
                Entry.username == username,
                Entry.medium == "Light Novel",
                Entry.source.in_(["jikan", "mal"]),
            )
            .all()
        )

        if not entries:
            print(f"No Light Novel (MAL) entries found for user '{username}'.")
            return

        print(f"Found {len(entries)} Light Novel (MAL) entries for user '{username}'.")
        if dry_run:
            print("[DRY RUN] No changes will be committed.\n")

        updated = skipped_no_id = skipped_no_volumes = unchanged = errors = 0

        with httpx.Client(timeout=20.0) as client:
            for entry in entries:
                if not entry.external_id:
                    print(f"  [{entry.id}] {entry.title!r:45s}  — no external_id, skipping")
                    skipped_no_id += 1
                    continue

                try:
                    volumes = _fetch_volumes(client, entry.external_id)
                except Exception as exc:
                    print(f"  [{entry.id}] {entry.title!r:45s}  - MAL error: {exc}")
                    errors += 1
                    time.sleep(REQUEST_DELAY_SECONDS)
                    continue

                if not volumes:
                    print(f"  [{entry.id}] {entry.title!r:45s}  total={entry.total}  — no volume count, leaving as-is")
                    skipped_no_volumes += 1
                elif entry.total == volumes:
                    unchanged += 1
                else:
                    print(f"  [{entry.id}] {entry.title!r:45s}  total {entry.total} -> {volumes} volumes")
                    if not dry_run:
                        entry.total = volumes
                    updated += 1

                time.sleep(REQUEST_DELAY_SECONDS)

        if not dry_run:
            db.commit()
            print(f"\nCommitted {updated} updates.")
        else:
            print(f"\n[DRY RUN] Would have updated {updated} entries.")

        print(
            f"Summary: updated={updated}  unchanged={unchanged}  "
            f"no_volumes={skipped_no_volumes}  no_id={skipped_no_id}  errors={errors}"
        )

    finally:
        db.close()


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    username = positional[0] if positional else "lingwei"

    fix_ln_volumes(username, dry_run=dry_run)
