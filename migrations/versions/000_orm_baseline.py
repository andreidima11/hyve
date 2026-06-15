"""ORM tables from ``core.models`` — replaces startup ``create_all``.

Revision ID: 000_orm_baseline
Revises:
Create Date: 2026-06-07
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

from core.db_migrations import create_orm_tables_if_missing

revision: str = "000_orm_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    create_orm_tables_if_missing(op.get_bind())


def downgrade() -> None:
    pass
