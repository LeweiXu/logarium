"""Record changes explicitly, in the same transaction as the entry write."""
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field, field_validator

from sqlalchemy import select
from sqlalchemy.orm import Session

from constants import VALID_EVENT_ACTIONS
from models import Entry, EntryEvent

TRACKED_FIELDS = (
    "status", "rating", "progress", "total", "custom_list", "notes",
    "title", "medium", "origin", "year", "cover_url", "external_url", "genres",
)
# What the Dashboard's Activity Log shows: entries appearing, and every status
# move after that. The rest (ratings, progress, notes, metadata edits, and the
# "edited" rows the migration backfilled) is detail, not activity.
STATUS_ACTIONS = ("created", "status")
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
    if action == "notes":
        before = after = None

    def value(v):
        return v.isoformat() if isinstance(v, datetime) else str(v) if v is not None else None
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


def _text(value):
    """Event values are stored as text; None stays None."""
    return None if value is None else str(value)


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
        # Keep the old and new values, not just which fields moved: a bulk
        # refresh can rewrite metadata across hundreds of entries, and "medium
        # changed" is no use afterwards if you can't see what it changed from.
        values = {
            field: [_text(before[field]), _text(getattr(entry, field))]
            for field in meta
        }
        record_event(db, entry, "meta", detail={**detail, "fields": meta, "values": values})
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


def parse_events(raw):
    """Validate portable events without accepting entry IDs or account ownership."""
    import json
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


def entry_events(db, entry_id, username):
    return db.scalars(select(EntryEvent).where(
        EntryEvent.entry_id == entry_id, EntryEvent.username == username,
    ).order_by(EntryEvent.at, EntryEvent.id)).all()


def activity(db, username, *, limit=20, exclude=(), actions=STATUS_ACTIONS,
             per_entry=False, visible_mediums=None):
    """Recent activity, newest first.

    `actions` keeps the feed to the events worth reading as a log; the Dashboard
    wants status transitions only, so that is the default. Pass actions=None for
    everything and use `exclude` to drop individual kinds.

    `per_entry` gives one row per entry, its newest qualifying event, which is
    what the Dashboard log shows: where each title stands now, not every step it
    took to get there. Otherwise rows are per event and a batch edit collapses
    into a single row carrying a count.
    """
    from sqlalchemy import cast, String, func, or_
    from schemas import ActivityRead
    from services.cover_cache_service import cover_cache_key

    from sqlalchemy import literal
    batch = func.coalesce(EntryEvent.detail["batch"].as_string(), cast(EntryEvent.id, String))
    groups = [EntryEvent.entry_id] if per_entry else [batch, EntryEvent.action, EntryEvent.to_value]
    # One entry per row means the count is always 1; collapsing a batch instead
    # means the row stands for however many entries shared that edit.
    count = literal(1) if per_entry else func.count().over(partition_by=groups)
    q = select(
        EntryEvent.id.label("event_id"),
        func.row_number().over(partition_by=groups, order_by=[EntryEvent.recorded_at.desc(), EntryEvent.id.desc()]).label("position"),
        count.label("count"),
    ).join(Entry, Entry.id == EntryEvent.entry_id).where(
        EntryEvent.username == username, Entry.username == username,
    )
    if actions:
        q = q.where(EntryEvent.action.in_(actions))
    if exclude:
        q = q.where(EntryEvent.action.not_in(exclude))
    if visible_mediums is not None:
        q = q.where(or_(Entry.medium.is_(None), Entry.medium.in_(visible_mediums)))
    ranked = q.subquery()
    rows = db.execute(select(EntryEvent, Entry.title, Entry.cover_url, Entry.medium, ranked.c.count)
        .join(ranked, ranked.c.event_id == EntryEvent.id).join(Entry, Entry.id == EntryEvent.entry_id)
        .where(ranked.c.position == 1)
        .order_by(EntryEvent.recorded_at.desc(), EntryEvent.id.desc()).limit(limit)).all()
    return [ActivityRead.model_validate({
        **{k: getattr(event, k) for k in ("id", "entry_id", "action", "at", "recorded_at", "from_value", "to_value", "detail")},
        "title": title, "cover_url": cover, "cover_key": cover_cache_key(cover) if cover else None,
        "medium": medium, "count": count,
    }) for event, title, cover, medium, count in rows]
