"""Tests for core.db_migrations helpers."""

from __future__ import annotations

from sqlalchemy import create_engine, text

from core.db_migrations import create_orm_tables_if_missing


def test_create_orm_tables_if_missing_on_empty_db(tmp_path):
    db_path = tmp_path / "empty.db"
    engine = create_engine(f"sqlite:///{db_path}")

    with engine.begin() as conn:
        create_orm_tables_if_missing(conn)

    with engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }

    assert "users" in tables
    assert "todo_lists" in tables
    assert "entries" in tables
    assert "automation_blueprints" in tables


def test_create_orm_tables_if_missing_is_idempotent(tmp_path):
    db_path = tmp_path / "repeat.db"
    engine = create_engine(f"sqlite:///{db_path}")

    with engine.begin() as conn:
        create_orm_tables_if_missing(conn)
        create_orm_tables_if_missing(conn)

    with engine.connect() as conn:
        count = conn.execute(
            text("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'")
        ).scalar()

    assert count == 1
