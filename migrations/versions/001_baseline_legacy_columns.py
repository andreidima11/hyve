"""Baseline: legacy additive columns previously applied via startup ALTER loops.

Revision ID: 001_baseline
Revises:
Create Date: 2026-06-06

Idempotent on existing Hyve installs (checks PRAGMA table_info before ADD COLUMN).
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

from core.db_migrations import add_sqlite_column_if_missing

revision: str = "001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    for column, col_type in (
        ("persona_override", "TEXT"),
        ("notification_preferences", "TEXT"),
        ("location", "VARCHAR"),
        ("about_me", "TEXT"),
    ):
        add_sqlite_column_if_missing(conn, "users", column, col_type)

    for column, col_type in (
        ("event_color", "VARCHAR"),
        ("event_notify", "BOOLEAN"),
        ("event_notify_minutes", "INTEGER"),
        ("event_notify_job_id", "VARCHAR"),
        ("event_action_enabled", "BOOLEAN"),
        ("event_action_entity_id", "VARCHAR"),
        ("event_action_service", "VARCHAR"),
        ("event_action_offset_minutes", "INTEGER"),
        ("event_action_job_id", "VARCHAR"),
    ):
        add_sqlite_column_if_missing(conn, "entries", column, col_type)

    try:
        conn.execute(text("UPDATE entries SET entry_type = 'event' WHERE entry_type = 'memento'"))
    except Exception:
        pass


def downgrade() -> None:
    # SQLite cannot drop columns safely without table rebuild; keep forward-only.
    pass
