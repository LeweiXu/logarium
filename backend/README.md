# Logarium Backend

FastAPI + PostgreSQL backend for the Logarium media tracker. Service-oriented:
`routers.py` holds thin handlers, all logic lives in `services/*`. Schema changes
go through Alembic migrations (the source of truth for the database).

See the [root README](../README.md) for the full setup-from-scratch guide and
feature overview.

## Requirements

- Python 3.11+
- PostgreSQL 14+

## Quick Start

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Create `.env` (minimum):

```env
DATABASE_URL=postgresql://log:log_password@localhost:5432/mediatracker
CORS_ORIGINS=http://localhost:3000
SECRET_KEY=replace-with-a-long-random-secret
```

External API keys (`TMDB_API_KEY`, `IGDB_*`, `RAWG_API_KEY`, `GOOGLE_BOOKS_API_KEY`,
`COMICVINE_API_KEY`) and SMTP backup settings are optional; missing ones are
skipped. See `config.py` for the full list of settings and defaults.

Build the schema and run:

```bash
alembic upgrade head              # apply migrations
python main.py                    # serve API on http://0.0.0.0:6443
```

Interactive docs: <http://localhost:6443/docs>.

Optional sample data:

```bash
python scripts/init_db.py --seed
```

## Migrations

```bash
alembic revision --autogenerate -m "describe the change"
alembic upgrade head
alembic downgrade -1
```

## Production

The repository root contains `logarium-api.service` and `deploy.sh` for the
home-server deployment. Run the deploy script from the repository root. It
syncs this directory, applies migrations, restarts the service, and checks the
local health endpoint.

```bash
./deploy.sh
```

The service uses one uvicorn worker because the periodic backup scheduler runs
inside the API process. Move that scheduler into its own service or add a
single-leader lock before increasing the worker count.


## Entry history

Entry timestamps are derived from `entry_events`. App writes record events in the same transaction; CSV exports and scheduled backups include full histories in the trailing `events` column. Legacy CSVs still import using their timestamp columns. See [the project context](../public/context.md) for the data model and API contract.

Run integration checks from this directory against a local test database:

```bash
DATABASE_URL=postgresql:///mediatracker ~/venvs/LOG-venv/bin/python scripts/test_entry_history.py
```

Back up the production database before deploying migrations. The timestamp-column removal migration checks that every derived date matches its stored value before dropping anything.
