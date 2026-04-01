"""Audit log for shell commands: who ran what, when, and the outcome."""
import os
import sqlite3
import time
from typing import List, Optional

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHELL_AUDIT_DB = os.path.join(_ROOT, "shell_audit.sqlite")
_CONN = None


def _get_conn():
    global _CONN
    if _CONN is None:
        _CONN = sqlite3.connect(SHELL_AUDIT_DB)
        _CONN.execute("PRAGMA journal_mode=WAL")
        _CONN.row_factory = sqlite3.Row
        _CONN.execute("""
            CREATE TABLE IF NOT EXISTS shell_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                ts REAL NOT NULL,
                command TEXT NOT NULL,
                exit_code INTEGER,
                output_preview TEXT,
                output_len INTEGER,
                blocked_reason TEXT
            )
        """)
        _CONN.execute("CREATE INDEX IF NOT EXISTS idx_shell_runs_user_ts ON shell_runs(user_id, ts DESC)")
        _CONN.commit()
    return _CONN


def append_run(
    user_id: str,
    command: str,
    exit_code: Optional[int] = None,
    output_preview: str = "",
    output_len: int = 0,
    blocked_reason: Optional[str] = None,
) -> None:
    """Record one shell run (executed or blocked)."""
    try:
        conn = _get_conn()
        conn.execute(
            """INSERT INTO shell_runs (user_id, ts, command, exit_code, output_preview, output_len, blocked_reason)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user_id, time.time(), command[:2000], exit_code, (output_preview or "")[:2000], output_len, blocked_reason),
        )
        conn.commit()
    except Exception as exc:
        import logging
        logging.getLogger("shell_audit").error("Failed to write shell audit log: %s (command=%s, user=%s)", exc, command[:80], user_id)


def get_recent(user_id: Optional[str] = None, limit: int = 50) -> List[dict]:
    """List recent runs (optionally for one user). For admin, user_id=None returns all."""
    try:
        conn = _get_conn()
        if user_id:
            rows = conn.execute(
                "SELECT id, user_id, ts, command, exit_code, output_preview, output_len, blocked_reason FROM shell_runs WHERE user_id = ? ORDER BY ts DESC LIMIT ?",
                (user_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, user_id, ts, command, exit_code, output_preview, output_len, blocked_reason FROM shell_runs ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
