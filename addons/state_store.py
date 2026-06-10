"""Persistent add-on install state in SQLite (users.db).

Replaces ``config.json → addons.<slug>`` with a dedicated table. Legacy
``addons`` entries are migrated once at startup and removed from config.json.
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import contextmanager
from typing import Any

from sqlalchemy import text

import database
import settings as settings_mod

log = logging.getLogger("addon_state")

DEFAULT_STATE: dict[str, Any] = {
    "installed": False,
    "enabled": False,
    "version": None,
    "latest_version": None,
    "config": {},
    "watchdog": False,
}


@contextmanager
def _db():
    gen = database.get_db()
    session = next(gen)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def normalize_state(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(raw or {})
    return {
        "installed": bool(raw.get("installed", False)),
        "enabled": bool(raw.get("enabled", False)),
        "version": raw.get("version"),
        "latest_version": raw.get("latest_version"),
        "config": dict(raw.get("config") or {}),
        "watchdog": bool(raw.get("watchdog", False)),
    }


def _row_to_state(row: tuple[Any, ...]) -> dict[str, Any]:
    (
        _slug,
        installed,
        enabled,
        version,
        latest_version,
        config_json,
        watchdog,
        _created_at,
        _updated_at,
    ) = row
    try:
        config = json.loads(config_json or "{}")
    except json.JSONDecodeError:
        config = {}
    if not isinstance(config, dict):
        config = {}
    return {
        "installed": bool(installed),
        "enabled": bool(enabled),
        "version": version,
        "latest_version": latest_version,
        "config": config,
        "watchdog": bool(watchdog),
    }


def get_state(slug: str) -> dict[str, Any]:
    with _db() as session:
        row = session.execute(
            text("""
                SELECT slug, installed, enabled, version, latest_version,
                       config_json, watchdog, created_at, updated_at
                FROM addon_state
                WHERE slug = :slug
            """),
            {"slug": slug},
        ).fetchone()
    if not row:
        return dict(DEFAULT_STATE)
    return _row_to_state(tuple(row))


def save_state(slug: str, state: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_state(state)
    now = time.time()
    config_json = json.dumps(normalized["config"], ensure_ascii=False)
    with _db() as session:
        existing = session.execute(
            text("SELECT slug FROM addon_state WHERE slug = :slug"),
            {"slug": slug},
        ).fetchone()
        if existing:
            session.execute(
                text("""
                    UPDATE addon_state
                    SET installed = :installed,
                        enabled = :enabled,
                        version = :version,
                        latest_version = :latest_version,
                        config_json = :config_json,
                        watchdog = :watchdog,
                        updated_at = :updated_at
                    WHERE slug = :slug
                """),
                {
                    "slug": slug,
                    "installed": int(normalized["installed"]),
                    "enabled": int(normalized["enabled"]),
                    "version": normalized["version"],
                    "latest_version": normalized["latest_version"],
                    "config_json": config_json,
                    "watchdog": int(normalized["watchdog"]),
                    "updated_at": now,
                },
            )
        else:
            session.execute(
                text("""
                    INSERT INTO addon_state (
                        slug, installed, enabled, version, latest_version,
                        config_json, watchdog, created_at, updated_at
                    ) VALUES (
                        :slug, :installed, :enabled, :version, :latest_version,
                        :config_json, :watchdog, :created_at, :updated_at
                    )
                """),
                {
                    "slug": slug,
                    "installed": int(normalized["installed"]),
                    "enabled": int(normalized["enabled"]),
                    "version": normalized["version"],
                    "latest_version": normalized["latest_version"],
                    "config_json": config_json,
                    "watchdog": int(normalized["watchdog"]),
                    "created_at": now,
                    "updated_at": now,
                },
            )
    return normalized


def delete_state(slug: str) -> None:
    with _db() as session:
        session.execute(
            text("DELETE FROM addon_state WHERE slug = :slug"),
            {"slug": slug},
        )


def _strip_addons_from_config_json() -> None:
    """Remove legacy ``addons`` section from config.json after DB migration."""
    path = settings_mod.CONFIG_FILE
    current = settings_mod._load_config_raw()
    if "addons" not in current:
        return
    current = dict(current)
    current.pop("addons", None)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(current, fh, indent=4)
    settings_mod.CFG.pop("addons", None)


def migrate_from_config_json() -> int:
    """One-shot import of ``config.json → addons`` into SQLite."""
    raw = settings_mod._load_config_raw()
    legacy = raw.get("addons")
    if not isinstance(legacy, dict) or not legacy:
        return 0

    migrated = 0
    for slug, state in legacy.items():
        if not isinstance(state, dict):
            continue
        save_state(str(slug), state)
        migrated += 1

    if migrated:
        _strip_addons_from_config_json()
        log.info("Migrated %d add-on state(s) from config.json to addon_state", migrated)
    return migrated
