"""SQLite helpers for auxiliary sidecar databases (audit logs, scheduler meta, etc.)."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Callable

InitFn = Callable[[sqlite3.Connection], None]

_INIT_LOCK = threading.Lock()
_INITIALIZED: set[str] = set()


def reset_initialized() -> None:
    """Clear one-time init tracking (for tests)."""
    with _INIT_LOCK:
        _INITIALIZED.clear()


def open_sqlite(
    path: str | Path,
    *,
    check_same_thread: bool = True,
    row_factory: bool = False,
    foreign_keys: bool = False,
    init: InitFn | None = None,
) -> sqlite3.Connection:
    """Open SQLite at *path*, apply standard pragmas, run *init* DDL once."""
    resolved = str(Path(path).resolve())
    conn = sqlite3.connect(resolved, check_same_thread=check_same_thread)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    if foreign_keys:
        conn.execute("PRAGMA foreign_keys=ON")
    if row_factory:
        conn.row_factory = sqlite3.Row
    if init is not None:
        with _INIT_LOCK:
            if resolved not in _INITIALIZED:
                init(conn)
                conn.commit()
                _INITIALIZED.add(resolved)
    return conn


class SidecarPool:
    """Thread-safe lazy singleton connection for a sidecar DB."""

    def __init__(
        self,
        path: str | Path,
        init: InitFn,
        *,
        check_same_thread: bool = True,
        row_factory: bool = False,
        foreign_keys: bool = False,
    ) -> None:
        self._path = path
        self._init = init
        self._check_same_thread = check_same_thread
        self._row_factory = row_factory
        self._foreign_keys = foreign_keys
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    def connection(self) -> sqlite3.Connection:
        if self._conn is None:
            with self._lock:
                if self._conn is None:
                    self._conn = open_sqlite(
                        self._path,
                        check_same_thread=self._check_same_thread,
                        row_factory=self._row_factory,
                        foreign_keys=self._foreign_keys,
                        init=self._init,
                    )
        return self._conn
