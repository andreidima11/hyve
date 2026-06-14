"""Consistent SQLite snapshots for online backup."""

from __future__ import annotations

import sqlite3
from pathlib import Path

SQLITE_FILENAMES = frozenset(
    {
        "users.db",
        "jobs.sqlite",
        "scheduler_meta.sqlite",
        "hyve.db",
    }
)


def is_sqlite_archive_path(rel: str) -> bool:
    name = Path(rel).name
    return name in SQLITE_FILENAMES or rel.endswith(".sqlite") or rel.endswith(".db")


def read_alembic_revision(db_path: Path) -> str | None:
    if not db_path.is_file():
        return None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        row = conn.execute(
            "SELECT version_num FROM alembic_version LIMIT 1"
        ).fetchone()
        return str(row[0]) if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def snapshot_sqlite(src: Path, dest: Path) -> None:
    """Copy ``src`` to ``dest`` using SQLite online backup API."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    src_uri = f"file:{src.resolve()}?mode=ro"
    src_conn = sqlite3.connect(src_uri, uri=True)
    dest_conn = sqlite3.connect(dest)
    try:
        src_conn.backup(dest_conn)
        dest_conn.commit()
    finally:
        dest_conn.close()
        src_conn.close()
