"""Add users.default_profile_id if missing (replaces startup inline ALTER)."""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

from core.db_migrations import add_sqlite_column_if_missing

revision: str = "002_users_default_profile_id"
down_revision: Union[str, None] = "001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    add_sqlite_column_if_missing(conn, "users", "default_profile_id", "VARCHAR")


def downgrade() -> None:
    pass
