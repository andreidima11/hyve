"""ORM tables previously created only via SQLAlchemy create_all at startup.

Revision ID: 008_scenes_areas
Revises: 007_addon_state
Create Date: 2026-06-15
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "008_scenes_areas"
down_revision: Union[str, None] = "007_addon_state"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS scenes (
            id TEXT PRIMARY KEY,
            owner_id INTEGER NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            description TEXT,
            icon TEXT,
            color TEXT,
            is_shared INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            entries_json TEXT NOT NULL DEFAULT '[]',
            last_activated_at DATETIME,
            activation_count INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_scenes_id ON scenes (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_scenes_owner_id ON scenes (owner_id)"))

    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS areas (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ha_area_id TEXT,
            icon TEXT,
            color TEXT,
            floor TEXT,
            aliases_json TEXT NOT NULL DEFAULT '[]',
            extra_entities_json TEXT NOT NULL DEFAULT '[]',
            ordering INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_areas_id ON areas (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_areas_ha_area_id ON areas (ha_area_id)"))


def downgrade() -> None:
    pass
