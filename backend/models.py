from datetime import datetime, timezone
from typing import Any
from sqlalchemy import Integer, String, Float, DateTime, Text, Boolean, JSON, func, ForeignKey, UniqueConstraint, Index, event, update
from sqlalchemy.orm import Mapped, Session, mapped_column
from db import Base

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

class User(Base):
    __tablename__ = "users"
    username: Mapped[str] = mapped_column(String(100), primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(128), nullable=False)
    # ── Settings ─────────────────────────────────────────────────────────────
    # backup_freq stays a real column: it is a backend concern, read by the
    # background backup scheduler. Everything else (library/explore/dashboard/
    # statistics prefs) lives in the single ui_preferences JSON document below.
    backup_freq:              Mapped[str] = mapped_column(String(20), nullable=False, server_default="never")
    # Timestamp of the last successful email backup (NULL = never run).
    last_backup_at:           Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    # Single JSON document holding ALL customizable UI preferences — library
    # (default mode/sort/per-page, columns, view toggles), dashboard (table
    # sizes/columns), statistics (sections + ranges), and explore (medium/bias/
    # personalize/hide-in-library). NULL is treated as "{}"; the app deep-merges
    # it over DEFAULT_UI. See schemas.DEFAULT_UI for the canonical shape.
    ui_preferences:           Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    library_revision:         Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # Read-only profile sharing. NULL = sharing off (no valid link). Otherwise a
    # "shr_"-prefixed opaque token that stands in for a bearer token: it resolves
    # to this user but the API only ever serves reads for it. Regenerating writes
    # a new token, which is what revokes the previous link.
    share_token:              Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True, index=True,
    )
    def __repr__(self) -> str:
        return f"<User username={self.username!r} email={self.email!r}>"

class EntryEvent(Base):
    __tablename__ = "entry_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("entries.id", ondelete="CASCADE"), nullable=False)
    username: Mapped[str] = mapped_column(ForeignKey("users.username"), nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    from_value: Mapped[str | None] = mapped_column(String(200))
    to_value: Mapped[str | None] = mapped_column(String(200))
    detail: Mapped[dict | None] = mapped_column(JSON)
    __table_args__ = (
        Index("ix_entry_events_user_recorded", "username", "recorded_at"),
        Index("ix_entry_events_entry_at", "entry_id", "at"),
    )


class Entry(Base):
    __tablename__ = "entries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title:     Mapped[str]           = mapped_column(String(500), nullable=False, index=True)
    medium:    Mapped[str | None]    = mapped_column(String(100), nullable=True, index=True)
    origin:    Mapped[str | None]    = mapped_column(String(100), nullable=True, index=True)
    year:      Mapped[int | None]    = mapped_column(Integer,     nullable=True)
    cover_url: Mapped[str | None]    = mapped_column(String(1000),nullable=True)
    notes:     Mapped[str | None]    = mapped_column(Text,        nullable=True)
    external_id:     Mapped[str | None]   = mapped_column(String(200),  nullable=True)
    source:          Mapped[str | None]   = mapped_column(String(100),  nullable=True)
    external_url:    Mapped[str | None]   = mapped_column(String(1000), nullable=True)
    genres:          Mapped[str | None]   = mapped_column(String(500),  nullable=True)
    external_rating: Mapped[float | None] = mapped_column(Float,        nullable=True)
    custom_list:     Mapped[str | None]   = mapped_column(String(100),  nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="planned", index=True)
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total:    Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at:   Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at:   Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=_utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    username: Mapped[str] = mapped_column(String(100), ForeignKey("users.username"), nullable=False, index=True)
    __table_args__ = (
        Index("ix_entries_user_updated_at", "username", "updated_at"),
        Index("ix_entries_user_completed_at", "username", "completed_at"),
        Index("ix_entries_user_title", "username", "title"),
        Index("ix_entries_user_rating", "username", "rating"),
        Index("ix_entries_user_year", "username", "year"),
        Index("ix_entries_user_status", "username", "status"),
        Index("ix_entries_user_medium", "username", "medium"),
        Index("ix_entries_user_origin", "username", "origin"),
        Index("ix_entries_user_custom_list", "username", "custom_list"),
        Index("ix_entries_user_external_url", "username", "external_url"),
    )
    def __repr__(self) -> str:
        return f"<Entry id={self.id} title={self.title!r} status={self.status!r} username={self.username!r}>"


class ExploreCache(Base):
    """Per-(user, medium) cache of one medium's Explore recommendations.

    `medium` always holds a real medium name now (e.g. "Anime") — the "All"
    view is computed live by aggregating these rows, never stored. Items are a
    JSON list of ExploreItem dicts in their already-ranked order. Only a reroll
    of that medium writes a row; ordinary reads return the cached payload (with
    library titles re-filtered live).

    `reroll_failed`/`reroll_error` track the last reroll outcome so a failed
    reroll can keep the previous items visible and surface a provider-specific
    message until the user rerolls again or restores the previous results.
    """
    __tablename__ = "explore_cache"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(
        String(100), ForeignKey("users.username", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    medium:     Mapped[str] = mapped_column(String(50), nullable=False, server_default="")
    items_json: Mapped[str] = mapped_column(Text, nullable=False)
    reroll_failed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false",
    )
    reroll_error:  Mapped[str | None] = mapped_column(Text, nullable=True)
    cached_at:  Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
        onupdate=_utcnow, nullable=False,
    )
    __table_args__ = (
        UniqueConstraint("username", "medium", name="uq_explore_cache_user_medium"),
    )


_REVISION_USERS = "library_revision_users"
_REVISION_BUMPED = "library_revision_bumped"


@event.listens_for(Session, "before_flush")
def _collect_library_revision_users(session: Session, _flush_context, _instances) -> None:
    """Track users whose entries changed in this transaction."""
    usernames = session.info.setdefault(_REVISION_USERS, set())
    for entry in session.new:
        if isinstance(entry, Entry) and entry.username:
            usernames.add(entry.username)
    for entry in session.deleted:
        if isinstance(entry, Entry) and entry.username:
            usernames.add(entry.username)
    for entry in session.dirty:
        if (
            isinstance(entry, Entry)
            and entry.username
            and session.is_modified(entry, include_collections=False)
        ):
            usernames.add(entry.username)


@event.listens_for(Session, "after_flush_postexec")
def _bump_library_revisions(session: Session, _flush_context) -> None:
    """Increment each changed library once before its transaction commits."""
    if session.info.get(_REVISION_BUMPED):
        return
    usernames = session.info.get(_REVISION_USERS) or set()
    if not usernames:
        return
    session.execute(
        update(User)
        .where(User.username.in_(usernames))
        .values(library_revision=User.library_revision + 1),
        execution_options={"synchronize_session": "fetch"},
    )
    session.info[_REVISION_BUMPED] = True


def _clear_revision_tracking(session: Session) -> None:
    session.info.pop(_REVISION_USERS, None)
    session.info.pop(_REVISION_BUMPED, None)


@event.listens_for(Session, "after_commit")
def _clear_revision_after_commit(session: Session) -> None:
    _clear_revision_tracking(session)


@event.listens_for(Session, "after_rollback")
def _clear_revision_after_rollback(session: Session) -> None:
    _clear_revision_tracking(session)
