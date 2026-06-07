# ADR 006: Alembic database migrations (Phase 6)

## Status

Accepted — Phase 6 started.

## Context

Schema changes were applied via `create_all()` plus silent `ALTER TABLE` try/except loops in `core/http/startup_migrations.py` and import-time `_ensure_user_profile_columns()` in `models.py`. Hard to audit, duplicate, and unsafe for multi-step upgrades.

## Decision

1. **`migrations/`** — Alembic layout (`alembic.ini`, `env.py`, `versions/`). Named `migrations/` (not `alembic/`) so the PyPI package is not shadowed at import time.
2. **`core/db_migrations.py`** — idempotent SQLite helpers (`add_sqlite_column_if_missing`).
3. **`001_baseline_legacy_columns`** — consolidates all historical ADD COLUMN + `memento` → `event` data fix.
4. **`run_startup_migrations()`** — `create_all()` then `alembic upgrade head`; automation YAML bootstrap unchanged.
5. **Removed** import-time column patching from `models.py`.

New schema changes: `alembic revision -m "description"` → edit upgrade → commit.

## Consequences

- Existing installs upgrade idempotently on next startup.
- Fresh installs get tables from `create_all` + stamped migration.
- SQLite remains forward-only (no column drops in downgrade).

## Deferred

- `dashboard.js` further split — `debug.js`, `hyveview_setup.js`, `yaml_editor.js`, `pull_refresh.js`, `live_ws.js`, `entity_patch.js`; core grid/render still in `dashboard.js` (~7.6k lines).
- Docker / multi-worker packaging.
