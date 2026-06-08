"""SQLite schema helpers — runtime verifies Alembic-owned tables, no DDL."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


class MissingSchemaError(RuntimeError):
    """Raised when expected tables are absent after migrations."""


def sqlite_table_exists(connection, table: str) -> bool:
    row = connection.execute(
        text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name LIMIT 1"),
        {"name": table},
    ).fetchone()
    return row is not None


def require_sqlite_tables(engine: Engine, *tables: str) -> None:
    """Fail fast if Alembic did not create required tables in users.db."""
    with engine.connect() as conn:
        missing = [name for name in tables if not sqlite_table_exists(conn, name)]
    if missing:
        raise MissingSchemaError(
            "Missing SQLite table(s): "
            + ", ".join(missing)
            + ". Run Alembic migrations (startup should call run_startup_migrations)."
        )
