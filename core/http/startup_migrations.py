"""SQLite schema bootstrap and Alembic migrations at startup."""

from __future__ import annotations

import importlib
import os
import sys

import core.automation_definitions as automation_definitions
import core.database as database
import core.models as models
from sqlalchemy import text
from core.log_stream import log_line


def _import_alembic_command():
    """Import Alembic CLI helpers without shadowing from ``./migrations/``.

    When the PyPI ``alembic`` package is missing, Python can treat unrelated
    project paths named ``alembic`` as a namespace package (``unknown location``).
    Migrations live in ``migrations/`` to avoid that; this helper still validates
    the real library is installed.
    """
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    saved = sys.path[:]
    try:
        # Drop project root so a stray ``alembic/`` folder cannot shadow the lib.
        sys.path = [p for p in sys.path if os.path.abspath(p or ".") != root]
        command = importlib.import_module("alembic.command")
        config_mod = importlib.import_module("alembic.config")
        return command, config_mod.Config
    except ImportError as exc:
        raise ImportError(
            "Alembic is not installed in this virtualenv. "
            "Run: pip install -r requirements.txt"
        ) from exc
    finally:
        sys.path = saved


def run_startup_migrations() -> None:
    """Ensure ORM tables exist, then apply Alembic revisions (idempotent).

    New schema changes belong in ``migrations/versions/`` only — do not add
    ad-hoc ``ALTER TABLE`` here. ``create_all`` bootstraps tables declared on
    SQLAlchemy models for fresh installs; Alembic brings existing DBs to head.
    """
    models.Base.metadata.create_all(bind=database.engine)

    try:
        command, Config = _import_alembic_command()
        ini_path = os.path.join(os.path.dirname(__file__), "..", "..", "alembic.ini")
        alembic_cfg = Config(os.path.abspath(ini_path))
        command.upgrade(alembic_cfg, "head")
    except Exception as e:
        log_line("error", "⚠️", "MIGRATIONS", f"Alembic upgrade failed: {e}")
        raise

    try:
        from addons.state_store import migrate_from_config_json

        migrated = migrate_from_config_json()
        if migrated:
            log_line(
                "success",
                "📦",
                "ADDONS",
                f"Migrated {migrated} add-on state(s) from config.json to SQLite",
            )
    except Exception as e:
        log_line("error", "⚠️", "ADDONS", f"Add-on state migration failed: {e}")
        raise

    try:
        from addons.registry import reconcile_addon_state

        with database.engine.connect() as conn:
            has_addon_state = conn.execute(
                text("SELECT 1 FROM sqlite_master WHERE type='table' AND name='addon_state'")
            ).fetchone()
        if has_addon_state:
            repaired = reconcile_addon_state()
            if repaired:
                log_line(
                    "success",
                    "📦",
                    "ADDONS",
                    f"Reconciled {repaired} add-on state(s) from integration config / disk",
                )
    except Exception as e:
        log_line("error", "⚠️", "ADDONS", f"Add-on state reconcile failed: {e}")
        raise

    try:
        db = next(database.get_db())
        try:
            automation_definitions.backfill_yaml_files_from_db(db)
            n = automation_definitions.reschedule_all(db)
            if n:
                log_line("success", "🔁", "AUTOMATION", f"Rescheduled {n} automation(s)")
        finally:
            db.close()
    except Exception as e:
        log_line("error", "⚠️", "AUTOMATION", f"YAML storage bootstrap failed: {e}")
