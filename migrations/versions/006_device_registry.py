"""Hyve device registry — persistent device metadata keyed by device_id.

Revision ID: 006_device_registry
Revises: 005_entity_registry
Create Date: 2026-06-07
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "006_device_registry"
down_revision: Union[str, None] = "005_entity_registry"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS device_registry (
            device_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            manufacturer TEXT,
            model TEXT,
            via_device_id TEXT,
            area_id TEXT,
            source TEXT NOT NULL,
            config_entry_id TEXT,
            z2m_friendly_name TEXT,
            name_by_user INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_device_registry_source "
        "ON device_registry (source)"
    ))

    cols = {row[1] for row in conn.execute(text("PRAGMA table_info(entity_registry)"))}
    if "entity_id_user_set" not in cols:
        conn.execute(text(
            "ALTER TABLE entity_registry "
            "ADD COLUMN entity_id_user_set INTEGER NOT NULL DEFAULT 0"
        ))


def downgrade() -> None:
    pass
