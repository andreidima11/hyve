"""Tests for core.sqlite_sidecar."""

from __future__ import annotations

import sqlite3

from core import sqlite_sidecar


def test_open_sqlite_runs_init_once(tmp_path):
    db_path = tmp_path / "sidecar.sqlite"
    calls: list[str] = []

    def _init(conn: sqlite3.Connection) -> None:
        calls.append("init")
        conn.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY)")

    sqlite_sidecar.reset_initialized()
    conn1 = sqlite_sidecar.open_sqlite(db_path, init=_init)
    conn1.execute("INSERT INTO items DEFAULT VALUES")
    conn1.commit()
    conn1.close()

    conn2 = sqlite_sidecar.open_sqlite(db_path, init=_init)
    row = conn2.execute("SELECT COUNT(*) FROM items").fetchone()
    conn2.close()

    assert calls == ["init"]
    assert row[0] == 1


def test_sidecar_migrations_run_once(tmp_path):
    db_path = tmp_path / "migrated.sqlite"
    calls: list[int] = []

    def _v1(conn: sqlite3.Connection) -> None:
        calls.append(1)
        conn.execute("CREATE TABLE IF NOT EXISTS t (v TEXT)")

    def _v2(conn: sqlite3.Connection) -> None:
        calls.append(2)
        conn.execute("ALTER TABLE t ADD COLUMN n INTEGER")

    sqlite_sidecar.reset_initialized()

    def _bootstrap(conn: sqlite3.Connection) -> None:
        from core.sidecar_migrations import run_sidecar_migrations

        run_sidecar_migrations(conn, {1: _v1, 2: _v2})

    pool = sqlite_sidecar.SidecarPool(db_path, _bootstrap)
    pool.connection()
    pool.connection()

    sqlite_sidecar.reset_initialized()
    pool2 = sqlite_sidecar.SidecarPool(db_path, _bootstrap)
    pool2.connection()

    assert calls == [1, 2]


def test_sidecar_pool_reuses_connection(tmp_path):
    db_path = tmp_path / "pool.sqlite"

    def _init(conn: sqlite3.Connection) -> None:
        conn.execute("CREATE TABLE IF NOT EXISTS t (v TEXT)")

    sqlite_sidecar.reset_initialized()
    pool = sqlite_sidecar.SidecarPool(db_path, _init)
    c1 = pool.connection()
    c2 = pool.connection()
    assert c1 is c2
