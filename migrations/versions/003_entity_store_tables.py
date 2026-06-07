"""Integration entity store tables and overrides.selected column.

Revision ID: 003_entity_store
Revises: 002_users_default_profile_id
Create Date: 2026-06-07

Consolidates schema previously created in addons/entity_store.initialize_schema()
plus the inline ALTER for integration_entity_overrides.selected.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

from core.db_migrations import add_sqlite_column_if_missing

revision: str = "003_entity_store"
down_revision: Union[str, None] = "002_users_default_profile_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS integration_entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            integration_slug TEXT NOT NULL UNIQUE,
            entity_data TEXT NOT NULL,
            timestamp REAL NOT NULL,
            last_error TEXT
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS integration_entity_schedule (
            integration_slug TEXT PRIMARY KEY,
            fetch_interval_seconds INTEGER NOT NULL DEFAULT 300,
            enabled BOOLEAN NOT NULL DEFAULT 1,
            last_fetch_time REAL,
            next_fetch_time REAL
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS integration_entity_overrides (
            entity_id TEXT PRIMARY KEY,
            custom_name TEXT,
            aliases TEXT NOT NULL DEFAULT '[]',
            selected INTEGER NOT NULL DEFAULT 0
        )
    """))
    add_sqlite_column_if_missing(
        conn, "integration_entity_overrides", "selected", "INTEGER NOT NULL DEFAULT 0"
    )


def downgrade() -> None:
    pass
