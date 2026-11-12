"""Integration checks. Run from backend with DATABASE_URL pointing to a test DB."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from db import engine
from models import Entry, EntryEvent, User
from schemas import EntryCreate, EntryUpdate
from services import entry_service as entries


class HistoryChecks(unittest.TestCase):
    def setUp(self):
        self.connection = engine.connect()
        self.transaction = self.connection.begin()
        self.db = Session(bind=self.connection, join_transaction_mode="create_savepoint")
        self.username = "history_" + uuid4().hex
        self.db.add(User(username=self.username, email=self.username + "@example.test", hashed_password="unused"))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.transaction.rollback()
        self.connection.close()

    def create(self, **kw):
        return entries.create_entry(self.db, EntryCreate(title="History check", **kw), self.username)

    def events(self, e):
        return self.db.scalars(select(EntryEvent).where(EntryEvent.entry_id == e.id).order_by(EntryEvent.id)).all()

    def test_changes_and_backdating(self):
        e = self.create(status="current", total=12)
        created = e.created_at
        old = datetime(2019, 4, 2, tzinfo=timezone.utc)
        entries.update_entry(self.db, e, EntryUpdate(status="completed", completed_at=old))
        self.assertEqual(e.completed_at, old)
        self.assertEqual(e.progress, 12)
        self.assertEqual([v.action for v in self.events(e)], ["created", "status"])
        entries.update_entry(self.db, e, EntryUpdate(rating=8.5))
        self.assertEqual(e.completed_at, old)
        self.assertEqual(self.events(e)[-1].action, "rating")
        earlier = old - timedelta(days=100)
        entries.update_entry(self.db, e, EntryUpdate(completed_at=earlier))
        self.assertEqual(e.completed_at, earlier)
        self.assertGreater(e.updated_at, old)
        entries.update_entry(self.db, e, EntryUpdate(completed_at=None))
        self.assertIsNone(e.completed_at)
        entries.update_entry(self.db, e, EntryUpdate(status="current"))
        self.assertIsNone(e.completed_at)
        entries.update_entry(self.db, e, EntryUpdate(status="completed"))
        self.assertGreater(e.completed_at, old)
        self.assertEqual(e.created_at, created)

    def test_coalescing_noise_and_batches(self):
        e = self.create(status="current")
        for progress in (1, 2, 3):
            entries.update_entry(self.db, e, EntryUpdate(progress=progress))
        self.assertEqual([v.action for v in self.events(e)], ["created", "progress"])
        for note in ("one", "two"):
            entries.update_entry(self.db, e, EntryUpdate(notes=note))
        self.assertEqual(len([v for v in self.events(e) if v.action == "notes"]), 1)
        updated = e.updated_at
        entries.update_entry(self.db, e, EntryUpdate(external_rating=9))
        self.assertEqual(e.updated_at, updated)
        other = self.create()
        entries.batch_update_entries(self.db, self.username, [e.id, other.id], EntryUpdate(custom_list="test"))
        batches = [self.events(x)[-1].detail["batch"] for x in (e, other)]
        self.assertEqual(*batches)
        entries.rename_custom_list(self.db, self.username, "test", "renamed")
        entries.clear_custom_list(self.db, self.username, "renamed")
        self.assertEqual(self.events(e)[-1].action, "list")
        for sort in ("created_at", "updated_at", "completed_at"):
            self.assertEqual(entries.get_entries(self.db, username=self.username, sort=sort).total, 2)
        eid = e.id
        entries.delete_entry(self.db, e)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(EntryEvent).where(EntryEvent.entry_id == eid)), 0)


if __name__ == "__main__":
    unittest.main()
