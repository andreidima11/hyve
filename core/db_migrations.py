"""Shared helpers for idempotent SQLite schema upgrades."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Connection


def sqlite_columns(connection: Connection, table: str) -> set[str]:
    rows = connection.execute(text(f"PRAGMA table_info({table})")).fetchall()
    if not rows:
        return set()
    return {str(row[1]) for row in rows}


def add_sqlite_column_if_missing(
    connection: Connection,
    table: str,
    column: str,
    column_type: str,
) -> None:
    if column in sqlite_columns(connection, table):
        return
    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}"))


def create_orm_tables_if_missing(connection: Connection) -> None:
    """Create SQLAlchemy ORM tables when absent (``checkfirst=True``)."""
    import core.models as _models  # noqa: F401 — register tables on Base.metadata

    from core.database import Base

    _ = _models
    Base.metadata.create_all(bind=connection, checkfirst=True)
