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
        "integration_entries.sqlite",
    }
)

_SQLITE_HEADER = b"SQLite format 3\x00"


def is_core_sqlite_path(rel: str) -> bool:
    return Path(rel).name in SQLITE_FILENAMES


def is_sqlite_database_file(path: Path) -> bool:
    """Return True when ``path`` is a readable SQLite database."""
    if not path.is_file():
        return False
    try:
        with path.open("rb") as fh:
            if fh.read(len(_SQLITE_HEADER)) != _SQLITE_HEADER:
                return False
        conn = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
        try:
            conn.execute("SELECT 1 FROM sqlite_schema LIMIT 1")
        finally:
            conn.close()
        return True
    except (OSError, sqlite3.Error):
        return False


def should_snapshot_sqlite(path: Path, rel: str) -> bool:
    """Use the online backup API only for Hyve core DBs or real SQLite files."""
    if is_core_sqlite_path(rel):
        return True
    return is_sqlite_database_file(path)


def is_sqlite_archive_path(rel: str) -> bool:
    """Legacy helper — prefer ``should_snapshot_sqlite`` when the file is available."""
    return is_core_sqlite_path(rel)


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
