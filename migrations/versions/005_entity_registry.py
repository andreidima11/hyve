"""Hyve entity registry — stable unique_id with editable entity_id.

Revision ID: 005_entity_registry
Revises: 004_entity_history
Create Date: 2026-06-07
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "005_entity_registry"
down_revision: Union[str, None] = "004_entity_history"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS entity_registry (
            unique_id TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL UNIQUE,
            domain TEXT NOT NULL,
            name TEXT,
            device_id TEXT,
            source TEXT,
            config_entry_id TEXT,
            disabled INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_entity_registry_entity_id "
        "ON entity_registry (entity_id)"
    ))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_entity_registry_device "
        "ON entity_registry (device_id)"
    ))


def downgrade() -> None:
    pass
