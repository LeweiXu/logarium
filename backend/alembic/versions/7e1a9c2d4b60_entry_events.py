"""Record entry history and backfill existing timestamps."""
from alembic import op

revision = "7e1a9c2d4b60"
down_revision = "a1c3e5f7b209"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        CREATE TABLE entry_events (
            id SERIAL PRIMARY KEY,
            entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            username VARCHAR(100) NOT NULL REFERENCES users(username),
            action VARCHAR(30) NOT NULL,
            at TIMESTAMPTZ NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL,
            from_value VARCHAR(200), to_value VARCHAR(200), detail JSON
        );
        CREATE INDEX ix_entry_events_user_recorded ON entry_events(username, recorded_at);
        CREATE INDEX ix_entry_events_entry_at ON entry_events(entry_id, at);
        INSERT INTO entry_events (entry_id, username, action, at, recorded_at, to_value, detail)
        SELECT id, username, 'created', created_at, LEAST(created_at, updated_at),
               CASE WHEN status = 'completed' THEN 'planned' ELSE status END,
               '{"backfilled": true}'::json FROM entries;
        INSERT INTO entry_events (entry_id, username, action, at, recorded_at, from_value, to_value, detail)
        SELECT id, username, 'status', completed_at, updated_at, 'planned', 'completed',
               '{"backfilled": true}'::json
        FROM entries WHERE status = 'completed' AND completed_at IS NOT NULL;
        INSERT INTO entry_events (entry_id, username, action, at, recorded_at, detail)
        SELECT e.id, e.username, 'edited', e.updated_at, e.updated_at, '{"backfilled": true}'::json
        FROM entries e WHERE e.updated_at > (
            SELECT max(v.recorded_at) FROM entry_events v WHERE v.entry_id = e.id
        );
    """)


def downgrade():
    op.execute("DROP TABLE entry_events")
