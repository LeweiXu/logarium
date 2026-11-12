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


def seed_history(db, entry, data, *, source, replace=False):
    """Preserve legacy timestamps, including unknown completion dates."""
    from sqlalchemy import delete
    events = parse_events(data.get("events"))
    if replace:
        db.execute(delete(EntryEvent).where(EntryEvent.entry_id == entry.id))
    if events is not None:
        for values in events:
            db.add(EntryEvent(entry_id=entry.id, username=entry.username, **values))
        db.info.setdefault("library_revision_users", set()).add(entry.username)
        return
    now = utc()
    created = utc(data["created_at"]) if data.get("created_at") else now
    updated = utc(data["updated_at"]) if data.get("updated_at") else now
    completed = data.get("completed_at")
    detail = {"source": source}
    if data.get("created_at") or data.get("updated_at"):
        detail["backfilled"] = True
    db.add(EntryEvent(entry_id=entry.id, username=entry.username, action="created",
        at=created, recorded_at=min(created, updated),
        to_value="planned" if entry.status == "completed" else entry.status, detail=detail))
    if entry.status == "completed" and completed:
        db.add(EntryEvent(entry_id=entry.id, username=entry.username, action="status",
            at=utc(completed), recorded_at=updated, from_value="planned", to_value="completed", detail=detail))
    elif updated > created:
        db.add(EntryEvent(entry_id=entry.id, username=entry.username, action="edited",
            at=updated, recorded_at=updated, detail=detail))
    db.info.setdefault("library_revision_users", set()).add(entry.username)


def insert_entry(db, data, *, source):
    data = dict(data)
    dates = {k: data.pop(k, None) for k in ("created_at", "updated_at", "completed_at", "events")}
    entry = Entry(**data)
    db.add(entry)
    db.flush()
    seed_history(db, entry, dates, source=source)
    return entry


def parse_events(raw):
    """Validate portable events without accepting entry IDs or account ownership."""
    import json
    from pydantic import BaseModel, Field, field_validator

    class PortableEvent(BaseModel):
        action: str
        at: datetime
        recorded_at: datetime
        from_value: str | None = Field(None, max_length=200)
        to_value: str | None = Field(None, max_length=200)
        detail: dict | None = None

        @field_validator("action")
        @classmethod
        def action_known(cls, value):
            if value not in VALID_EVENT_ACTIONS:
                raise ValueError("Unknown history action")
            return value

    if raw is None or raw == "":
        return None
    rows = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(rows, list) or not rows:
        raise ValueError("events must be a nonempty JSON array")
    events = [PortableEvent.model_validate(row).model_dump() for row in rows]
    if sum(v["action"] == "created" for v in events) != 1:
        raise ValueError("History must contain exactly one created event")
    return [{**v, "at": utc(v["at"]), "recorded_at": utc(v["recorded_at"])} for v in events]


def export_history(db, entry_ids):
    """Load all requested histories in one query, preserving tie order."""
    result = {eid: [] for eid in entry_ids}
    if not result:
        return result
    rows = db.scalars(select(EntryEvent).where(EntryEvent.entry_id.in_(result))
                      .order_by(EntryEvent.recorded_at, EntryEvent.id))
    for event in rows:
        result[event.entry_id].append({
            "action": event.action, "at": event.at.isoformat(),
            "recorded_at": event.recorded_at.isoformat(),
            "from_value": event.from_value, "to_value": event.to_value, "detail": event.detail,
        })
    return result
