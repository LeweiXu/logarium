from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select, asc, desc, and_, or_, nullslast, update
from sqlalchemy.orm import Session

from models import Entry, User
from schemas import (
    EntryCreate,
    EntryUpdate,
    EntryListResponse,
    EntryRead,
    EntryCountsResponse,
    DuplicateCheckItem,
)
from services.cover_cache_service import cover_cache_key

# Columns that the frontend is allowed to sort by
SORTABLE_COLUMNS: dict[str, object] = {
    "title":        Entry.title,
    "medium":       Entry.medium,
    "origin":       Entry.origin,
    "year":         Entry.year,
    "status":       Entry.status,
    "rating":       Entry.rating,
    "created_at":   Entry.created_at,
    "updated_at":   Entry.updated_at,
    "completed_at": Entry.completed_at,
}


def _normalise_custom_list(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _apply_filters(q, *, status, medium, origin, title, custom_list, custom_list_empty=False, external_url=None):
    """Apply optional WHERE clauses to a query."""
    if status:
        q = q.where(Entry.status == status)
    if medium:
        q = q.where(Entry.medium == medium)
    if origin:
        q = q.where(Entry.origin == origin)
    if title:
        q = q.where(Entry.title.ilike(f"%{title}%"))
    if external_url:
        q = q.where(Entry.external_url == external_url)
    if custom_list_empty:
        q = q.where(or_(Entry.custom_list.is_(None), Entry.custom_list == ""))
    elif custom_list:
        normalised = _normalise_custom_list(custom_list)
        if normalised:
            q = q.where(Entry.custom_list == normalised)
    return q


def _apply_visible_mediums(q, visible_mediums: set[str] | None):
    if visible_mediums is None:
        return q
    return q.where(or_(Entry.medium.is_(None), Entry.medium.in_(visible_mediums)))


def entry_read(entry: Entry) -> EntryRead:
    result = EntryRead.model_validate(entry)
    if entry.cover_url:
        result.cover_key = cover_cache_key(entry.cover_url)
    return result


# ── Read ──────────────────────────────────────────────────────────────────────

def get_entries(
    db: Session,
    *,
    username: str,
    status: Optional[str] = None,
    medium: Optional[str] = None,
    origin: Optional[str] = None,
    title:  Optional[str] = None,
    custom_list: Optional[str] = None,
    custom_list_empty: bool = False,
    external_url: Optional[str] = None,
    sort:   str = "updated_at",
    order:  str = "desc",
    limit:  int = 40,
    offset: int = 0,
    visible_mediums: set[str] | None = None,
    include_total: bool = True,
) -> EntryListResponse:
    sort_col = SORTABLE_COLUMNS.get(sort, Entry.updated_at)
    direction = asc if order == "asc" else desc

    base_q = select(Entry).where(Entry.username == username)
    base_q = _apply_visible_mediums(base_q, visible_mediums)
    base_q = _apply_filters(
        base_q,
        status=status,
        medium=medium,
        origin=origin,
        title=title,
        custom_list=custom_list,
        custom_list_empty=custom_list_empty,
        external_url=external_url,
    )

    # Dashboard buckets do not display pagination totals, so their bootstrap can
    # skip the extra count query and use the returned row count instead.
    total = None
    if include_total:
        count_q = select(func.count()).select_from(base_q.subquery())
        total = db.execute(count_q).scalar_one()

    # Paginated results — always put NULLs last so unrated/undated entries
    # don't float to the top when sorting descending.
    # Secondary sort by title ASC ensures consistent ordering within ties.
    order_clauses = [nullslast(direction(sort_col))]
    if sort != "title":
        order_clauses.append(asc(Entry.title))
    rows = db.execute(
        base_q.order_by(*order_clauses).limit(limit).offset(offset)
    ).scalars().all()

    return EntryListResponse(
        items=[entry_read(r) for r in rows],
        total=total if total is not None else len(rows),
        limit=limit,
        offset=offset,
    )


def get_entry_by_id(db: Session, entry_id: int) -> Optional[Entry]:
    return db.get(Entry, entry_id)


def get_entry_counts(
    db: Session,
    username: str,
    visible_mediums: set[str] | None = None,
    *,
    status: Optional[str] = None,
    medium: Optional[str] = None,
    origin: Optional[str] = None,
    title:  Optional[str] = None,
    custom_list: Optional[str] = None,
    custom_list_empty: bool = False,
) -> EntryCountsResponse:
    """Sidebar counts for the current filter selection.

    Each facet is counted with every active filter applied EXCEPT its own, which
    is what makes the sidebar read the way you'd expect: with Completed selected,
    the medium and origin rows show how many completed entries each one has,
    while the status rows keep showing what you'd get by switching status within
    the current medium/origin. `total` follows the status rows (status dropped),
    so the "All" row equals the sum of the ones under it.

    `unlisted` stays unfiltered on purpose: it sits next to the custom-list chips,
    whose counts come from /custom-lists, so facing one and not the others would
    just look broken.
    """
    def counted(column=None, *, skip: str = ""):
        q = (
            select(column, func.count(Entry.id)).group_by(column)
            if column is not None
            else select(func.count(Entry.id))
        )
        q = q.where(Entry.username == username)
        q = _apply_visible_mediums(q, visible_mediums)
        return _apply_filters(
            q,
            status=None if skip == "status" else status,
            medium=None if skip == "medium" else medium,
            origin=None if skip == "origin" else origin,
            title=title,
            custom_list=custom_list,
            custom_list_empty=custom_list_empty,
        )

    def grouped(column, *, skip: str) -> dict[str, int]:
        return {
            key: count
            for key, count in db.execute(counted(column, skip=skip)).all()
            if key
        }

    total = db.execute(counted(skip="status")).scalar_one()
    unlisted = db.execute(
        _apply_visible_mediums(
            select(func.count(Entry.id)).where(Entry.username == username),
            visible_mediums,
        ).where(or_(Entry.custom_list.is_(None), Entry.custom_list == ""))
    ).scalar_one()

    return EntryCountsResponse(
        total=total,
        unlisted=unlisted,
        statuses=grouped(Entry.status, skip="status"),
        mediums=grouped(Entry.medium, skip="medium"),
        origins=grouped(Entry.origin, skip="origin"),
    )


def get_custom_lists(db: Session, username: str, visible_mediums: set[str] | None = None) -> list[dict]:
    latest_updated = func.max(Entry.updated_at).label("updated_at")
    q = (
        select(Entry.custom_list, func.count(Entry.id), latest_updated)
        .where(Entry.username == username, Entry.custom_list.is_not(None), Entry.custom_list != "")
    )
    q = _apply_visible_mediums(q, visible_mediums)
    rows = db.execute(
        q.group_by(Entry.custom_list)
        .order_by(desc(latest_updated), asc(Entry.custom_list))
    ).all()
    return [{"name": name, "count": count, "updated_at": updated_at} for name, count, updated_at in rows]


def rename_custom_list(db: Session, username: str, old_name: str, new_name: str) -> int:
    old_name = _normalise_custom_list(old_name)
    new_name = _normalise_custom_list(new_name)
    if old_name is None or new_name is None:
        return 0
    entries = db.query(Entry).filter(
        Entry.username == username,
        Entry.custom_list == old_name,
    ).all()
    now = datetime.now(timezone.utc)
    for entry in entries:
        entry.custom_list = new_name
        entry.updated_at = now
    db.commit()
    return len(entries)


def clear_custom_list(db: Session, username: str, list_name: str) -> int:
    list_name = _normalise_custom_list(list_name)
    if list_name is None:
        return 0
    entries = db.query(Entry).filter(
        Entry.username == username,
        Entry.custom_list == list_name,
    ).all()
    now = datetime.now(timezone.utc)
    for entry in entries:
        entry.custom_list = None
        entry.updated_at = now
    db.commit()
    return len(entries)


# ── Create ────────────────────────────────────────────────────────────────────

def create_entry(db: Session, payload: EntryCreate, username: str) -> Entry:
    data = payload.model_dump(exclude_none=False)
    entry = Entry(**data, username=username)

    # If created as completed, use provided completed_at or auto-stamp
    if entry.status == "completed":
        if entry.completed_at is None:
            entry.completed_at = datetime.now(timezone.utc)
        # Auto-set progress to total to indicate full completion
        if entry.total is not None:
            entry.progress = entry.total

    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


# ── Update ────────────────────────────────────────────────────────────────────

def _apply_update(entry: Entry, data: dict) -> None:
    """Apply an EntryUpdate dict to an entry in place (no commit).

    Preserves completed_at / progress auto-management so single and batch
    updates behave identically. `data` is expected to be the result of
    EntryUpdate.model_dump(exclude_unset=True).
    """
    for field, value in data.items():
        setattr(entry, field, value)

    # Handle completed_at when status changes to completed
    if data.get("status") == "completed":
        # Auto-stamp only if completed_at was not explicitly provided in this update
        if entry.completed_at is None:
            entry.completed_at = datetime.now(timezone.utc)
        # Auto-set progress to total
        if entry.total is not None:
            entry.progress = entry.total

    # Clear completed_at if status moves away from completed
    if data.get("status") and data["status"] != "completed":
        entry.completed_at = None

    entry.updated_at = datetime.now(timezone.utc)


def update_entry(db: Session, entry: Entry, payload: EntryUpdate) -> Entry:
    _apply_update(entry, payload.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(entry)
    return entry


def batch_update_entries(db: Session, username: str, ids: list[int], payload: EntryUpdate) -> int:
    """Apply the same patch to every owned entry in `ids`. Returns count updated."""
    data = payload.model_dump(exclude_unset=True)
    if not ids or not data:
        return 0
    entries = db.execute(
        select(Entry).where(Entry.username == username, Entry.id.in_(ids))
    ).scalars().all()
    for entry in entries:
        _apply_update(entry, data)
    db.commit()
    return len(entries)


def batch_delete_entries(db: Session, username: str, ids: list[int]) -> int:
    """Delete every owned entry in `ids`. Returns count deleted."""
    if not ids:
        return 0
    entries = db.execute(
        select(Entry).where(Entry.username == username, Entry.id.in_(ids))
    ).scalars().all()
    for entry in entries:
        db.delete(entry)
    db.commit()
    return len(entries)


def find_duplicate_groups(db: Session, username: str) -> list[dict]:
    """Group a user's entries by (lower(title), medium); return groups of size > 1.

    Medium is part of the key (NULL treated as empty) so a film and a book that
    share a title aren't flagged. Groups are ordered by title for stable display.
    """
    rows = db.execute(
        select(Entry)
        .where(Entry.username == username)
        .order_by(asc(Entry.title), asc(Entry.id))
    ).scalars().all()

    groups: dict[tuple[str, str], list[Entry]] = {}
    for entry in rows:
        key = (entry.title.strip().lower(), (entry.medium or "").lower())
        groups.setdefault(key, []).append(entry)

    return [
        {"key": f"{title} · {medium or '—'}", "entries": [entry_read(e) for e in members]}
        for (title, medium), members in groups.items()
        if len(members) > 1
    ]


# ── Delete ────────────────────────────────────────────────────────────────────

def delete_entry(db: Session, entry: Entry) -> None:
    db.delete(entry)
    db.commit()


def check_duplicates(db: Session, username: str, items: list[DuplicateCheckItem]) -> list[bool]:
    results = []
    for item in items:
        conditions = [
            Entry.username == username,
            func.lower(Entry.title) == item.title.lower(),
        ]
        if item.medium:
            conditions.append(Entry.medium == item.medium)
        if item.year is not None:
            conditions.append(Entry.year == item.year)
        exists = db.execute(
            select(Entry.id).where(and_(*conditions)).limit(1)
        ).scalar() is not None
        results.append(exists)
    return results


def delete_all_entries(db: Session, username: str) -> None:
    affected = db.query(Entry).filter(Entry.username == username).delete()
    if affected:
        db.execute(
            update(User)
            .where(User.username == username)
            .values(library_revision=User.library_revision + 1),
            execution_options={"synchronize_session": "fetch"},
        )
    db.commit()
