"""Derive timestamps from entry events."""
from alembic import op

revision = "8f2b0d3e5c71"
down_revision = "7e1a9c2d4b60"
branch_labels = None
depends_on = None

DERIVED = """
    SELECT e.id,
      (SELECT at FROM entry_events v WHERE v.entry_id=e.id AND action='created'
       ORDER BY recorded_at,id LIMIT 1) AS created_at,
      (SELECT max(recorded_at) FROM entry_events v WHERE v.entry_id=e.id) AS updated_at,
      CASE WHEN e.status='completed' THEN
        (SELECT CASE WHEN action='completed_at' AND to_value IS NULL THEN NULL ELSE at END
         FROM entry_events v WHERE v.entry_id=e.id AND
         ((action IN ('created','status') AND to_value='completed') OR action='completed_at')
         ORDER BY recorded_at DESC,id DESC LIMIT 1)
      END AS completed_at
    FROM entries e
"""


def upgrade():
    op.execute("""DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM entries e JOIN (""" + DERIVED + """) d USING(id)
        WHERE e.created_at IS DISTINCT FROM d.created_at
           OR e.updated_at IS DISTINCT FROM d.updated_at
           OR e.completed_at IS DISTINCT FROM d.completed_at)
      THEN RAISE EXCEPTION 'Event timestamps do not match stored values'; END IF;
    END $$;
    DROP INDEX ix_entries_user_updated_at;
    DROP INDEX ix_entries_user_completed_at;
    ALTER TABLE entries DROP COLUMN created_at, DROP COLUMN updated_at, DROP COLUMN completed_at;
    """)


def downgrade():
    op.execute("""
      ALTER TABLE entries ADD COLUMN created_at TIMESTAMPTZ,
        ADD COLUMN updated_at TIMESTAMPTZ, ADD COLUMN completed_at TIMESTAMPTZ;
      UPDATE entries e SET created_at=d.created_at, updated_at=d.updated_at, completed_at=d.completed_at
      FROM (""" + DERIVED + """) d WHERE d.id=e.id;
      ALTER TABLE entries ALTER COLUMN created_at SET NOT NULL,
        ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL,
        ALTER COLUMN updated_at SET DEFAULT now();
      CREATE INDEX ix_entries_user_updated_at ON entries(username,updated_at);
      CREATE INDEX ix_entries_user_completed_at ON entries(username,completed_at);
    """)
