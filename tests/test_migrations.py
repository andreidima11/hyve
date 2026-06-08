"""Alembic migration smoke tests."""

import os

from sqlalchemy import text

import database
import models
from core.http.startup_migrations import run_startup_migrations


def test_startup_migrations_idempotent():
    run_startup_migrations()
    run_startup_migrations()

    with database.engine.connect() as conn:
        user_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        entry_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(entries)"))}
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()

    assert "location" in user_cols
    assert "about_me" in user_cols
    assert "default_profile_id" in user_cols
    assert "event_color" in entry_cols
    assert version == "004_entity_history"


def test_users_db_uses_wal():
    with database.engine.connect() as conn:
        mode = conn.execute(text("PRAGMA journal_mode")).scalar()
    assert str(mode or "").lower() == "wal"


def test_entity_store_tables_from_migrations():
    run_startup_migrations()

    with database.engine.connect() as conn:
        override_cols = {
            row[1] for row in conn.execute(text("PRAGMA table_info(integration_entity_overrides)"))
        }
        tables = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name LIKE 'integration_%'"
                )
            )
        }

    assert "integration_entities" in tables
    assert "integration_entity_schedule" in tables
    assert "integration_entity_overrides" in tables
    assert "selected" in override_cols


def test_entity_state_history_table_from_migrations():
    run_startup_migrations()

    with database.engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        index_names = {
            row[1]
            for row in conn.execute(text("PRAGMA index_list(entity_state_history)"))
        }

    assert "entity_state_history" in tables
    assert "idx_entity_state_history_eid_ts" in index_names


def test_entity_store_initialize_schema_verifies_tables():
    import asyncio

    from addons.entity_store import IntegrationEntityStore

    run_startup_migrations()
    asyncio.run(IntegrationEntityStore().initialize_schema())


def test_alembic_ini_exists():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    assert os.path.isfile(os.path.join(root, "alembic.ini"))
    assert os.path.isfile(os.path.join(root, "migrations", "env.py"))
