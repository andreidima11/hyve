"""Entity numeric state history table for dashboard sparklines.

Revision ID: 004_entity_history
Revises: 003_entity_store
Create Date: 2026-06-07

Replaces runtime DDL in core/entity_history.init_history_table().
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "004_entity_history"
down_revision: Union[str, None] = "003_entity_store"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS entity_state_history (
            entity_id TEXT NOT NULL,
            ts        INTEGER NOT NULL,
            value     REAL NOT NULL
        )
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_entity_state_history_eid_ts "
        "ON entity_state_history (entity_id, ts)"
    ))


def downgrade() -> None:
    pass
