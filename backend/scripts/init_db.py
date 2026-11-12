#!/usr/bin/env python3
"""
Initialise the database.

Usage:
    python scripts/init_db.py          # create tables only
    python scripts/init_db.py --seed   # create tables + insert sample entries
"""
import sys
import os
from pathlib import Path

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from db import engine, SessionLocal, Base
import models  # noqa: F401


def create_tables() -> None:
    print("Creating tables…")
    Base.metadata.create_all(bind=engine)
    print("Done.")


SAMPLE_ENTRIES = [
    dict(title="Shogun",              medium="TV Show", origin="Japanese", year=2024, status="current",   progress=7,  total=10),
    dict(title="The Name of the Wind",medium="Book",    origin="Western",  year=2007, status="current",   progress=312,total=662),
    dict(title="Elden Ring",          medium="Game",    origin="Japanese", year=2022, status="current"),
    dict(title="Frieren: Beyond Journey's End", medium="Anime", origin="Japanese", year=2023, status="completed", rating=10.0),
    dict(title="Oppenheimer",         medium="Film",    origin="Western",  year=2023, status="completed", rating=9.0),
    dict(title="Piranesi",            medium="Book",    origin="Western",  year=2020, status="completed", rating=9.0),
    dict(title="Severance",           medium="TV Show", origin="Western",  year=2022, status="completed", rating=9.0),
    dict(title="Hollow Knight",       medium="Game",    origin="Western",  year=2017, status="completed", rating=8.0),
    dict(title="Dune: Part Two",      medium="Film",    origin="Western",  year=2024, status="planned"),
    dict(title="Dungeon Meshi",       medium="Anime",   origin="Japanese", year=2024, status="planned"),
    dict(title="Disco Elysium",       medium="Game",    origin="Western",  year=2019, status="planned"),
    dict(title="Succession",          medium="TV Show", origin="Western",  year=2018, status="planned"),
    dict(title="Chainsaw Man",        medium="Manga",   origin="Japanese", year=2018, status="planned"),
    dict(title="The Witcher 3",       medium="Game",    origin="Western",  year=2015, status="on_hold"),
]


def seed_data(username: str) -> None:
    from datetime import datetime, timezone
    from models import Entry, User
    from services.history_service import insert_entry

    db = SessionLocal()
    try:
        if db.query(Entry).count() > 0:
            print("Database already has data — skipping seed.")
            return

        print(f"Inserting {len(SAMPLE_ENTRIES)} sample entries…")
        if not db.get(User, username):
            raise ValueError("Register the seed user in the app first")
        now = datetime.now(timezone.utc)
        for data in SAMPLE_ENTRIES:
            insert_entry(db, {**data, "username": username,
                "completed_at": now if data["status"] == "completed" else None}, source="manual")
        db.commit()
        print("Seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    create_tables()
    if "--seed" in sys.argv:
        seed_data(sys.argv[sys.argv.index("--seed") + 1] if sys.argv.index("--seed") + 1 < len(sys.argv) else "lingwei")
