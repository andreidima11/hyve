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
    assert "event_color" in entry_cols
    assert version == "001_baseline"


def test_alembic_ini_exists():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    assert os.path.isfile(os.path.join(root, "alembic.ini"))
    assert os.path.isfile(os.path.join(root, "migrations", "env.py"))
