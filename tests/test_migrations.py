"""Alembic migration smoke tests."""

import os

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import core.database as database
import core.models as models
from core.http.startup_migrations import run_startup_migrations


def test_startup_migrations_idempotent():
    run_startup_migrations()
    run_startup_migrations()

    with database.engine.connect() as conn:
        user_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        entry_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(entries)"))}
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }

    assert "location" in user_cols
    assert "about_me" in user_cols
    assert "default_profile_id" in user_cols
    assert "event_color" in entry_cols
    assert "scenes" in tables
    assert "areas" in tables
    assert version == "008_scenes_areas"


def test_fresh_install_schema_via_alembic_only(tmp_path, monkeypatch):
    """Empty SQLite file gets full schema from Alembic (no startup create_all)."""
    db_path = tmp_path / "fresh.db"
    db_url = f"sqlite:///{db_path}"
    engine = create_engine(
        db_url,
        connect_args={"check_same_thread": False},
    )
    SessionLocal = sessionmaker(bind=engine)
    monkeypatch.setattr(database, "SQLALCHEMY_DATABASE_URL", db_url)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)

    run_startup_migrations()

    with engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        user_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}

    assert version == "008_scenes_areas"
    assert "users" in tables
    assert "entries" in tables
    assert "automation_definitions" in tables
    assert "integration_entities" in tables
    assert "entity_registry" in tables
    assert "addon_state" in tables
    assert "scenes" in tables
    assert "areas" in tables
    assert "default_profile_id" in user_cols


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


def test_entity_registry_table_from_migrations():
    run_startup_migrations()

    with database.engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        cols = {
            row[1] for row in conn.execute(text("PRAGMA table_info(entity_registry)"))
        }
        index_names = {
            row[1] for row in conn.execute(text("PRAGMA index_list(entity_registry)"))
        }

    assert "entity_registry" in tables
    assert {"unique_id", "entity_id", "domain", "name", "device_id", "entity_id_user_set"}.issubset(cols)
    assert "idx_entity_registry_entity_id" in index_names


def test_device_registry_table_from_migrations():
    run_startup_migrations()

    with database.engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        cols = {
            row[1] for row in conn.execute(text("PRAGMA table_info(device_registry)"))
        }
        index_names = {
            row[1] for row in conn.execute(text("PRAGMA index_list(device_registry)"))
        }

    assert "device_registry" in tables
    assert {"device_id", "name", "manufacturer", "model", "z2m_friendly_name", "name_by_user"}.issubset(cols)
    assert "idx_device_registry_source" in index_names


def test_entity_store_initialize_schema_verifies_tables():
    import asyncio

    from core.entity_store import IntegrationEntityStore

    run_startup_migrations()
    asyncio.run(IntegrationEntityStore().initialize_schema())


def test_alembic_ini_exists():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    assert os.path.isfile(os.path.join(root, "alembic.ini"))
    assert os.path.isfile(os.path.join(root, "migrations", "env.py"))
