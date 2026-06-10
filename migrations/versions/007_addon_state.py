"""Hyve add-on install state — persistent state keyed by slug.

Revision ID: 007_addon_state
Revises: 006_device_registry
Create Date: 2026-06-07
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "007_addon_state"
down_revision: Union[str, None] = "006_device_registry"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS addon_state (
            slug TEXT PRIMARY KEY,
            installed INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 0,
            version TEXT,
            latest_version TEXT,
            config_json TEXT NOT NULL DEFAULT '{}',
            watchdog INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    """))


def downgrade() -> None:
    pass
