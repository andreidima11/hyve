"""Versioned schema migrations for auxiliary SQLite sidecar databases."""

from __future__ import annotations

import sqlite3
from typing import Callable

SidecarMigration = Callable[[sqlite3.Connection], None]


def _ensure_version_table(conn: sqlite3.Connection) -> int:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS _sidecar_schema (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL
        )
        """
    )
    row = conn.execute("SELECT version FROM _sidecar_schema WHERE id = 1").fetchone()
    if row is None:
        conn.execute("INSERT INTO _sidecar_schema (id, version) VALUES (1, 0)")
        return 0
    return int(row[0])


def run_sidecar_migrations(
    conn: sqlite3.Connection,
    migrations: dict[int, SidecarMigration],
) -> int:
    """Apply pending migrations in ascending version order. Returns final version."""
    version = _ensure_version_table(conn)
    for target in sorted(migrations.keys()):
        if target <= version:
            continue
        migrations[target](conn)
        conn.execute("UPDATE _sidecar_schema SET version = ? WHERE id = 1", (target,))
        version = target
    conn.commit()
    return version
