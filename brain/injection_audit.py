"""Audit log for prompt injection detections from external/untrusted sources."""
import os
import sqlite3
import time
from typing import List, Optional

from core.sqlite_sidecar import SidecarPool

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INJECTION_AUDIT_DB = os.path.join(_ROOT, "injection_audit.sqlite")


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS injection_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            source_label TEXT NOT NULL,
            risk_score INTEGER NOT NULL,
            primary_category TEXT,
            action TEXT NOT NULL,
            snippet TEXT,
            content_len INTEGER NOT NULL,
            details_json TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_injection_events_ts ON injection_events(ts DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_injection_events_source ON injection_events(source_label, ts DESC)")


_POOL = SidecarPool(INJECTION_AUDIT_DB, _init_schema, row_factory=True)


def _get_conn():
    return _POOL.connection()


def append_event(
    source_label: str,
    risk_score: int,
    action: str,
    primary_category: Optional[str] = None,
    snippet: str = "",
    content_len: int = 0,
    details_json: str = "",
) -> None:
    try:
        conn = _get_conn()
        conn.execute(
            """INSERT INTO injection_events (ts, source_label, risk_score, primary_category, action, snippet, content_len, details_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (time.time(), source_label[:80], int(risk_score), (primary_category or "")[:80], action[:40], (snippet or "")[:500], int(content_len), (details_json or "")[:4000]),
        )
        conn.commit()
    except Exception:
        pass


def get_recent(limit: int = 50, source_label: Optional[str] = None) -> List[dict]:
    try:
        conn = _get_conn()
        if source_label:
            rows = conn.execute(
                "SELECT id, ts, source_label, risk_score, primary_category, action, snippet, content_len, details_json FROM injection_events WHERE source_label = ? ORDER BY ts DESC LIMIT ?",
                (source_label, int(limit)),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, ts, source_label, risk_score, primary_category, action, snippet, content_len, details_json FROM injection_events ORDER BY ts DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
