# Entry history plan

Replacing `created_at` / `updated_at` / `completed_at` on `Entry` with a full
per-entry event log, and rebuilding the Dashboard activity log on top of it.

Status: implemented and migrated on the home server, 2026-11-12. Written 2026-08-23.

## Implementation and rollout

- All six phases are implemented. The Dashboard uses recorded events, the detail modal shows a timeline, and CSV exports/imports and scheduled backups preserve history.
- The actual migration baseline was `a1c3e5f7b209`. Two hand-written revisions create/backfill events (`7e1a9c2d4b60`) and then remove the columns (`8f2b0d3e5c71`). Column removal checks timestamp equality inside the migration before dropping columns.
- Seven local entries had unusual timestamp ordering. Backfill uses the earlier of created/updated for the created event's recording time, and the stored updated time for completion's recording time. This preserves those legacy values exactly. Completed entries with unknown completion dates get no completion-defining event.
- Upgrade, full downgrade, and re-upgrade preserved all 851 local timestamp tuples. Integration checks cover writes, date corrections and clearing, coalescing, batches, ownership, API responses, imports and history restore. Chrome checks covered Dashboard activity, entry timelines, backdating labels, and Library rendering. The production frontend build passed.
- The nightly demo refresh now copies histories. Verified against a restored database copy: 843 copied entries retained identical metadata, dates, and events.
- Home server: stopped the API, made and checked a PostgreSQL backup, deployed with `./deploy.sh`, then verified all 1,814 production timestamp tuples with zero differences. Activity, timelines, Dashboard bootstrap, statistics, date sorting, and CSV exports passed authenticated checks for both accounts (907 entries each).
- Production backup: `~/LOG_backups/entry-history-20261112/database.dump`, with `timestamps.json` and the previous Alembic revision beside it. The service is active at revision `8f2b0d3e5c71`.
- Frontend changes are committed locally. Nothing was pushed, as specified below.

The remaining sections retain the original design and phase outline.

## Why

The Dashboard activity log (`frontend/pages/Dashboard.jsx:126-142`) reconstructs a
feed client-side by pairing each status bucket with `updated_at`. So editing the
rating of something you finished in 2019 makes the log announce that you just
completed it. There is no record of what actually changed or when, because the
entry only carries three timestamps and any edit clobbers `updated_at`.

The fix is to record every change as an event, and derive the three timestamps
from those events instead of storing them.

## One caveat, decided and accepted

Dropping the physical columns means every list query derives three timestamps
from `entry_events`, `ORDER BY` included. Mitigation: expose them as SQLAlchemy
`column_property` correlated subqueries named exactly `created_at`, `updated_at`,
`completed_at` on `Entry`. `SORTABLE_COLUMNS`, `EntryRead.model_validate`,
`stats_service`'s ORM iteration and the entire frontend read surface keep working
untouched, while events become the only source of truth. Cost is three indexed
lookups per selected row, which is sub-millisecond at this library size. If it
ever bites, the escape hatch is a materialized cache column maintained from
events. Not doing that now.

## 1. Schema

```
entry_events
  id           PK
  entry_id     FK entries.id ON DELETE CASCADE
  username     FK users.username          denormalised: feed query + ownership scoping
  action       VARCHAR(30)
  at           TIMESTAMPTZ NOT NULL       when it happened (user-backdatable)
  recorded_at  TIMESTAMPTZ NOT NULL       when the server wrote it (never backdated)
  from_value   VARCHAR(200) NULL
  to_value     VARCHAR(200) NULL
  detail       JSON NULL                  {source, batch, fields, backfilled}

  ix_entry_events_user_recorded (username, recorded_at)   the activity feed
  ix_entry_events_entry_at      (entry_id, at)            timeline + derivation
```

The two-timestamp split is what makes column removal work at all. Backdate a
completion to 2019 (`EntryForm` already sends `completed_at`) and `at` is 2019
while `recorded_at` is now, so the Library "Updated" column still says today and
the activity feed shows it as something you just did.

`from_value` / `to_value` as plain columns rather than everything in `detail`
keeps rendering trivial and leaves the door open to queries like "when did I ever
rate something a 10".

## 2. Action taxonomy

Lives in `backend/constants.py` as `VALID_EVENT_ACTIONS`, mirrored in
`frontend/utils.jsx` like the other canonical enums.

| action | from -> to | rendered as |
|---|---|---|
| `created` | -> status | "Added **X**" (`detail.source`: manual, extension, csv, mal, auto, explore) |
| `status` | `planned` -> `current` | "Started / Completed / Dropped / Put on hold / Re-planned **X**" |
| `rating` | `null` -> `8.5` | "Rated **X** 8.5" / "Cleared rating on **X**" |
| `progress` | `4` -> `5` | "Progress on **X**: 5/12" |
| `total` | `null` -> `12` | "Set length of **X** to 12" |
| `list` | `null` -> `seasonals` | "Added **X** to list *seasonals*" / "Removed from *seasonals*" |
| `notes` | (no values) | "Edited notes on **X**" |
| `meta` | `detail.fields` | "Edited **X** (title, year)" |
| `completed_at` | old -> new date | "Backdated completion of **X** to 2019-04-02" |
| `edited` | (no values) | backfill only, "Edited **X**", subdued |

Deletes cascade the events away with the entry. A tombstone would need a
separate user-scoped table; skipping it unless we want "you deleted X" in the
feed later.

## 3. Derivation rules

| derived | rule |
|---|---|
| `created_at` | `at` of the `created` event |
| `updated_at` | `max(recorded_at)` over all of the entry's events |
| `completed_at` | `NULL` unless current `status = 'completed'`; otherwise the `at` of the most recently *recorded* completion-defining event (`created` / `status` with `to_value='completed'`, or a `completed_at` correction event) |

Gating `completed_at` on the current status reproduces today's
clear-on-status-change behaviour exactly (`entry_service.py:275-277`). Picking by
`recorded_at` rather than `max(at)` is what makes correcting a completion date
*backwards* work.

## 4. Recording layer

New `backend/services/history_service.py`, with explicit recording calls rather
than a passive SQLAlchemy session listener. Reason: with the columns gone, writes
have to declare intent (this completion is backdated to X, this create came from
a MAL import, these 30 updates are one batch). A generic differ cannot see intent,
and events are now load-bearing rather than decorative. A `diff_entry(before, after)`
helper keeps each call site to roughly one line.

Noise control, same as it would have been with a listener:

- Tracked-field allowlist only: `status, rating, progress, total, custom_list,
  notes, completed_at, title, medium, origin, year, cover_url, external_url,
  genres`. Everything else (cover-cache backfills, `external_rating` refresh) is
  ignored, otherwise the resync and cover tools spam the log.
- Suppress derived writes. Completing an entry auto-snaps `progress` to `total`;
  when a `status` event is emitted in the same update, drop the `progress` event
  it caused so "Completed X" is one line, not two.
- Coalesce `progress` and `notes`: if the entry's last event of the same action
  is under ~15 minutes old, amend its `to_value` and `recorded_at` instead of
  appending a new row.
- Batch updates carry `detail.batch = <uuid>` so the feed can collapse them into
  "Moved 34 entries to Dropped".

## 5. Write paths to rewire

- `entry_service.create_entry` (`:236`) - drop the `completed_at` auto-stamp,
  emit `created` plus a completion event when created as completed. Keep the
  progress-snaps-to-total rule.
- `entry_service._apply_update` (`:256`) - drop `completed_at` management and
  `entry.updated_at = now`, emit a diff instead. Covers single and batch.
- `entry_service.rename_custom_list` / `clear_custom_list` (`:213`, `:229`) - the
  `entry.updated_at = now` lines become `list` events.
- `import_service.py` `:309-361`, `:433-442`, `:570-574` - three sites feeding
  `created_at` / `updated_at` / `completed_at` into `Entry(...)`; become seeded
  events.
- `import_mal_service.py` `:396`, `:451` - same.
- `scripts/init_db.py:60` - seed via events.
- `scripts/fix_completed_at.py` - writes the column directly, so it stops making
  sense as-is. Port it to write completion events.
- `models.py` - drop the three columns, the `onupdate=_utcnow`, and the
  `ix_entries_user_updated_at` / `ix_entries_user_completed_at` indexes. Keep the
  `library_revision` session listener as-is.
- `entry_service.get_entries` count query (`:115`) - switch to
  `select(func.count(Entry.id))` so the count stops dragging the derived
  subqueries through a wrapped subquery.

Read sites need no changes at all thanks to `column_property`: `stats_service`,
`bootstrap_service`, `routers.py`, and every frontend usage
(`Library.jsx`, `Dashboard.jsx`, `EntryDetailModal.jsx`, `Console.jsx`,
`preferences.jsx`, `data/keys.js`, `data/hooks.jsx`).

Schema inputs stay: `EntryCreate.completed_at` and `EntryUpdate.completed_at`
remain accepted, because `EntryForm` and `QuickAddModal` send them. They now mean
"record the completion event at this timestamp" instead of "write this column".

## 6. Export and import round-trip

Goal: Export CSV plus Export Settings fully reconstitutes an account.

- CSV keeps every existing column, with the three timestamps synthesized from
  events, so the file stays human-readable and old importers keep working.
- One new trailing column `events` holding that entry's full history as a compact
  JSON array.
- Import replays `events` verbatim when present (it becomes the source of truth
  for that entry's timestamps), and falls back to synthesizing events from
  `created_at` / `updated_at` / `completed_at` when absent, which is how every
  existing CSV in the wild will import.
- Side effect worth having: the emailed backup attaches this same CSV
  (`backup_service.py:71`), so scheduled backups carry full history for free.

Open question: a JSON blob in a spreadsheet cell is not exactly readable. The
alternative is a compact `action:from>to@timestamp;` line format. Going with JSON
for parse safety unless told otherwise.

## 7. API

- `GET /entries/{id}/events` - one entry's timeline, oldest first, owner-scoped in
  the router like every other entry route.
- `GET /activity?limit=20&exclude=progress,meta` - the feed, joined to entry
  title/cover/medium so the client does not need the entries loaded. Ordered by
  `recorded_at DESC` so backdated completions still surface.
- `activity` added to `DashboardBootstrapResponse` (`bootstrap_service.py:21`) so
  the Dashboard still loads in one request and `Dashboard.jsx:126` deletes its
  client-side reconstruction outright.

## 8. Migration

Hand-written, chained onto head `4c2e1a8b7d90`, raw `op.execute` SQL, no
autogenerate.

1. `CREATE TABLE entry_events` plus the two indexes.
2. Backfill per entry, preserving today's values exactly:
   - `created` event at `created_at` (`recorded_at = created_at`), `to_value` =
     `'planned'` if a later status event gets synthesized, else the current status.
   - if `status='completed' AND completed_at IS NOT NULL`: a `status` event with
     `at = completed_at`, `recorded_at = GREATEST(completed_at, created_at)`.
   - if `updated_at` is strictly later than every `recorded_at` written above: an
     `edited` event with `at = recorded_at = updated_at` and
     `detail = {"backfilled": true}`. This row is what makes derived `updated_at`
     come out bit-identical to the old column. It renders subdued, since the
     actual field that changed is unknowable.
   - `status='completed'` with a NULL `completed_at` gets no completion event, so
     derived `completed_at` stays NULL, matching today.
3. Drop `ix_entries_user_updated_at` and `ix_entries_user_completed_at`, then drop
   the three columns.

`downgrade()` re-adds the columns, repopulates them from the derivation rules,
then drops the table. Verify the round trip, do not assume it.

## 9. Testing

`backend/.env` points at local `postgresql://.../mediatracker`, taken as the
dummy/test database given production deploys separately.

1. `pg_dump` snapshot first.
2. Capture `(id, created_at, updated_at, completed_at)` for every entry into a
   temp table pre-migration.
3. `alembic upgrade head`, then diff derived values against the snapshot. Require
   zero differing rows.
4. `downgrade`, diff again, `upgrade` again.
5. Exercise the app: `python main.py` and hit the affected routes at
   `http://localhost:6443/docs`; `./dev.sh` and click through Library sorting on
   all three date columns, Dashboard, detail modal, CSV export, re-import of that
   export; `npm run build`.

There is no test runner in this repo, so that manual pass is the gate.

## 10. Phases

Each lands as its own commit, nothing pushed.

1. `entry_events` model, `history_service`, hand-written migration, backfill
   verification. (`entry events table`)
2. Column removal, `column_property` derivation, all write paths rewired.
   (`derive timestamps from events`)
3. Export/import round-trip with history. (`export entry history`)
4. API endpoints plus dashboard bootstrap wiring. (`activity endpoints`)
5. Frontend: Dashboard feed off real events, detail-modal timeline,
   `describeEvent` in `utils.jsx`. (`real activity log`)
6. Docs: `AGENTS.md` and `context.md` data model and API contract sections.

Phase 2 is the risky one. It lands green or not at all.

## Later, not now

- Statistics currently reads `completed_at`, a single mutable field. Events make
  "completed per month" retroactively correct and unlock rating-over-time. Out of
  scope here, but the table is what unlocks it.
- Event pruning. Roughly 1-3 rows per edit means a heavily edited 2000-entry
  library lands in the tens of thousands of rows, which is nothing for Postgres.
  No retention policy needed initially.
