#!/usr/bin/env python3
"""
Fix entries where status='completed' but completed_at is None (or in the current month).

For each such entry, assigns a random completed_at timestamp between:
  - Jan 1 of the entry's year (or Jan 1, 1900 if year is None)
  - The current date (UTC)

Usage:
    python fix_completed_at.py [username] [--dry-run] [--current]

    username  defaults to "lingwei"
    --current  target completed entries whose completed_at falls in the current month
               instead of entries with no completed_at
"""

import sys
import random
from datetime import datetime, timezone, timedelta

# Allow running from the backend/ directory
import os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.chdir(Path(__file__).resolve().parents[1])

from sqlalchemy import extract
from db import SessionLocal
from models import Entry
from services.entry_service import _apply_update


def random_datetime_between(start: datetime, end: datetime) -> datetime:
    delta = end - start
    random_seconds = random.randint(0, int(delta.total_seconds()))
    return start + timedelta(seconds=random_seconds)


def fix_completed_at(username: str, dry_run: bool = False, current_month: bool = False) -> None:
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)

        if current_month:
            entries = (
                db.query(Entry)
                .filter(
                    Entry.username == username,
                    Entry.status == "completed",
                    Entry.completed_at.isnot(None),
                    extract("year",  Entry.completed_at) == now.year,
                    extract("month", Entry.completed_at) == now.month,
                )
                .all()
            )
            mode_label = f"completed_at in {now.strftime('%B %Y')}"
        else:
            entries = (
                db.query(Entry)
                .filter(
                    Entry.username == username,
                    Entry.status == "completed",
                    Entry.completed_at.is_(None),
                )
                .all()
            )
            mode_label = "completed_at IS NULL"

        if not entries:
            print(f"No entries to fix for user '{username}' ({mode_label}).")
            return

        print(f"Found {len(entries)} entries to fix for user '{username}' ({mode_label}).")
        if dry_run:
            print("[DRY RUN] No changes will be committed.\n")

        for entry in entries:
            start_year = entry.year if entry.year else 1900
            range_start = datetime(start_year, 1, 1, tzinfo=timezone.utc)

            # Clamp: if the release year is in the future somehow, use now as both bounds
            if range_start >= now:
                range_start = now - timedelta(days=1)

            chosen = random_datetime_between(range_start, now)
            print(f"  [{entry.id}] {entry.title!r:50s}  year={entry.year}  -> completed_at={chosen.date()}")

            if not dry_run:
                _apply_update(db, entry, {"completed_at": chosen})

        if not dry_run:
            db.commit()
            print(f"\nCommitted {len(entries)} updates.")
        else:
            print(f"\n[DRY RUN] Would have updated {len(entries)} entries.")

    finally:
        db.close()


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    current_month = "--current" in sys.argv
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    username = positional[0] if positional else "lingwei"

    fix_completed_at(username, dry_run=dry_run, current_month=current_month)
