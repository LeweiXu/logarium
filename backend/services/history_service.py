"""Record changes explicitly, in the same transaction as the entry write."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from constants import VALID_EVENT_ACTIONS
from models import Entry, EntryEvent

TRACKED_FIELDS = (
    "status", "rating", "progress", "total", "custom_list", "notes",
    "title", "medium", "origin", "year", "cover_url", "external_url", "genres",
)
FIELD_ACTION = {"custom_list": "list", **{k: k for k in ("status", "rating", "progress", "total", "notes")}}


def utc(value=None):
    value = value or datetime.now(timezone.utc)
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def snapshot(entry):
    return {k: getattr(entry, k) for k in (*TRACKED_FIELDS, "completed_at")}


def record_event(db: Session, entry: Entry, action, *, before=None, after=None, at=None, detail=None):
    if action not in VALID_EVENT_ACTIONS:
        raise ValueError("Unknown history action")
    now = utc()
    detail = detail or {}
    value = lambda v: v.isoformat() if isinstance(v, datetime) else str(v) if v is not None else None
    previous = None
    if action in {"progress", "notes"} and not detail.get("batch"):
        db.flush()
        previous = db.scalar(select(EntryEvent).where(
            EntryEvent.entry_id == entry.id, EntryEvent.action == action,
        ).order_by(EntryEvent.recorded_at.desc(), EntryEvent.id.desc()).limit(1))
        if previous and (previous.detail or {}).get("batch"):
            previous = None
    if previous and now - utc(previous.recorded_at) < timedelta(minutes=15):
        previous.to_value = value(after)
        previous.recorded_at = now
        previous.at = utc(at) if at else now
        previous.detail = detail
    else:
        db.add(EntryEvent(entry_id=entry.id, username=entry.username, action=action,
                          at=utc(at) if at else now, recorded_at=now,
                          from_value=value(before), to_value=value(after), detail=detail))
    db.info.setdefault("library_revision_users", set()).add(entry.username)


def diff_entry(db, entry, before, *, completed_at=None, completion_supplied=False, batch=None):
    detail = {"batch": batch} if batch else {}
    changed = [k for k in TRACKED_FIELDS if before[k] != getattr(entry, k)]
    meta = []
    for field in changed:
        if field == "progress" and "status" in changed and entry.status == "completed":
            continue
        action = FIELD_ACTION.get(field)
        if action:
            extra = {"total": entry.total} if action == "progress" else {}
            record_event(db, entry, action, before=before[field], after=getattr(entry, field),
                         at=completed_at if action == "status" and entry.status == "completed" else None,
                         detail={**detail, **extra})
        else:
            meta.append(field)
    if meta:
        record_event(db, entry, "meta", detail={**detail, "fields": meta})
    if completion_supplied and entry.status == "completed" and "status" not in changed:
        old = before["completed_at"]
        if (utc(old) if old else None) != (utc(completed_at) if completed_at else None):
            record_event(db, entry, "completed_at", before=old, after=completed_at,
                         at=completed_at, detail=detail)
