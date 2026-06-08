"""Tests for core.db_schema table verification."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, text

from core.db_schema import MissingSchemaError, require_sqlite_tables, sqlite_table_exists


def test_sqlite_table_exists_false_on_empty_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'empty.db'}")
    with engine.connect() as conn:
        assert sqlite_table_exists(conn, "integration_entities") is False


def test_require_sqlite_tables_raises_when_missing(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'empty.db'}")
    with pytest.raises(MissingSchemaError, match="integration_entities"):
        require_sqlite_tables(engine, "integration_entities")


def test_require_sqlite_tables_passes_when_present(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'ok.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE integration_entities (id INTEGER PRIMARY KEY)"))
    require_sqlite_tables(engine, "integration_entities")
