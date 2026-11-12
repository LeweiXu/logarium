"""
Copies demo-visible data from user 'lingwei' to user 'demo_user'.
Steps:
  1. Reset demo_user settings to defaults while preserving login credentials
  2. Delete all existing entries and Explore cache rows for 'demo_user'
  3. Copy entries and Explore cache rows from 'lingwei' to 'demo_user'

Run directly:   python demo_script.py
Schedule via cron (see README or comments below).
"""

import sys
import os
import logging
from copy import deepcopy

# Resolve the backend/ directory and make it the cwd so that pydantic-settings
# finds .env, and sibling modules (config, db, models) are importable regardless
# of where the script is invoked from (direct run, different cwd, or cron).
_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(_BACKEND_DIR)
sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy import create_engine, delete, insert, literal, select
from sqlalchemy.orm import sessionmaker
from config import get_settings
from models import Entry, ExploreCache, User
from schemas import DEFAULT_UI
from services.history_service import insert_entry, export_history

DEFAULT_BACKUP_FREQ = "never"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

settings = get_settings()
DATABASE_URL = settings.DATABASE_URL

SOURCE_USER = "lingwei"
DEST_USER = "demo_user"

ENTRY_COPY_EXCLUDE = {"id", "username"}
CACHE_COPY_EXCLUDE = {"id", "username"}


def _copyable_entry_columns() -> list[str]:
    """Columns copied entry-for-entry; generated ids and owners are replaced."""
    return [col.name for col in Entry.__table__.columns if col.name not in ENTRY_COPY_EXCLUDE]


def _copyable_cache_columns() -> list[str]:
    """Columns copied cache-row-for-cache-row; generated ids and owners are replaced."""
    return [col.name for col in ExploreCache.__table__.columns if col.name not in CACHE_COPY_EXCLUDE]


def _sync_demo_user(session) -> None:
    """Ensure demo_user exists and reset its settings to canonical defaults."""
    source = session.get(User, SOURCE_USER)
    if source is None:
        raise RuntimeError(f"Source user {SOURCE_USER!r} does not exist")

    dest = session.get(User, DEST_USER)
    if dest is None:
        dest = User(
            username=DEST_USER,
            email=f"{DEST_USER}@example.invalid",
            hashed_password=source.hashed_password,
        )
        session.add(dest)
        log.info("Created missing destination user '%s'.", DEST_USER)

    dest.backup_freq = DEFAULT_BACKUP_FREQ
    dest.last_backup_at = None
    dest.ui_preferences = deepcopy(DEFAULT_UI)
    log.info("Reset settings for '%s' to defaults.", DEST_USER)


def sync_demo_entries(db_url: str) -> None:
    engine = create_engine(db_url, pool_pre_ping=True)
    Session = sessionmaker(bind=engine)

    with Session() as session:
        with session.begin():
            _sync_demo_user(session)

            # 1. Delete stale per-user cache and demo_user entries.
            cache_result = session.execute(
                delete(ExploreCache).where(ExploreCache.username == DEST_USER)
            )
            log.info("Deleted %d explore cache rows for '%s'.", cache_result.rowcount, DEST_USER)

            result = session.execute(delete(Entry).where(Entry.username == DEST_USER))
            log.info("Deleted %d existing entries for '%s'.", result.rowcount, DEST_USER)

            # 2. Copy source entries to demo_user. The column list comes from
            # the current SQLAlchemy model so migrations like custom_list do not
            # silently fall out of sync with this cron job.
            source_entries = session.scalars(select(Entry).where(Entry.username == SOURCE_USER)).all()
            histories = export_history(session, [e.id for e in source_entries])
            for entry in source_entries:
                data = {col: getattr(entry, col) for col in _copyable_entry_columns()}
                insert_entry(session, {**data, "username": DEST_USER, "events": histories[entry.id]}, source="csv")
            log.info("Copied %d entries and histories to '%s'.", len(source_entries), DEST_USER)


            # 3. Copy Explore cache so the demo account can serve cached
            # recommendations immediately without inheriting source settings.
            copy_cols = _copyable_cache_columns()
            insert_cols = [*copy_cols, "username"]
            select_cols = [getattr(ExploreCache, col) for col in copy_cols]
            result = session.execute(
                insert(ExploreCache).from_select(
                    insert_cols,
                    select(*select_cols, literal(DEST_USER)).where(ExploreCache.username == SOURCE_USER),
                )
            )
            log.info("Copied %d explore cache rows from '%s' to '%s'.", result.rowcount, SOURCE_USER, DEST_USER)


if __name__ == "__main__":
    try:
        sync_demo_entries(DATABASE_URL)
        log.info("Done.")
    except Exception as exc:
        log.exception("Failed: %s", exc)
        sys.exit(1)
