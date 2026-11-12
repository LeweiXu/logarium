import csv
import io
import json
from services.history_service import export_history
from sqlalchemy.orm import Session
from models import Entry

EXPORT_COLUMNS = [
    "title", "medium", "origin", "year", "cover_url", "notes",
    "external_id", "source", "status", "rating", "progress", "total",
    "created_at", "updated_at", "completed_at",
    "external_url", "genres", "external_rating", "custom_list", "events",
]


def export_entries_csv(db: Session, username: str) -> str:
    entries = (
        db.query(Entry)
        .filter(Entry.username == username)
        .order_by(Entry.id)
        .all()
    )
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(EXPORT_COLUMNS)
    histories = export_history(db, [e.id for e in entries])
    for e in entries:
        writer.writerow([json.dumps(histories[e.id], separators=(",", ":")) if col == "events"
                         else getattr(e, col) for col in EXPORT_COLUMNS])
    return output.getvalue()
