"""Sinapse: log de evenimente legate de memorii (adăugare, editare, ștergere, consolidare). Pentru transparență în UI."""
import os
import json
import sqlite3
import time
import threading
from typing import Optional, List, Dict, Any

from core.sqlite_sidecar import SidecarPool

# DB în rădăcina proiectului, nu în brain/
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEMORY_LOG_DB = os.path.join(_ROOT, "memory_log.sqlite")
_LOCK = threading.Lock()

EVENT_ADDED = "fact_added"
EVENT_UPDATED = "fact_updated"
EVENT_DELETED = "fact_deleted"
EVENT_CONSOLIDATION_START = "consolidation_start"
EVENT_CONSOLIDATION_END = "consolidation_end"
EVENT_CONSOLIDATION_DEDUPE = "consolidation_dedupe"
EVENT_CONSOLIDATION_AI_PRUNE = "consolidation_ai_prune"


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memory_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            event_type TEXT NOT NULL,
            user_id TEXT,
            summary TEXT,
            details TEXT,
            created_at DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_ev_ts ON memory_events(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_ev_type ON memory_events(event_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_ev_user ON memory_events(user_id)")


_POOL = SidecarPool(MEMORY_LOG_DB, _init_schema, check_same_thread=False, row_factory=True)


def _get_conn():
    return _POOL.connection()


def append_event(
    event_type: str,
    user_id: Optional[str] = None,
    summary: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    """Înregistrează un eveniment în logul de memorii."""
    try:
        conn = _get_conn()
        with _LOCK:
            conn.execute(
                "INSERT INTO memory_events (ts, event_type, user_id, summary, details) VALUES (?, ?, ?, ?, ?)",
                (time.time(), event_type, user_id or "", summary or "", json.dumps(details or {}, ensure_ascii=False)),
            )
            conn.commit()
    except Exception:
        pass


def get_events(
    limit: int = 100,
    offset: int = 0,
    event_type: Optional[str] = None,
    user_id: Optional[str] = None,
    since_ts: Optional[float] = None,
    include_system_events: bool = False,
) -> List[Dict[str, Any]]:
    """Returnează evenimente, cele mai recente primele."""
    try:
        conn = _get_conn()
        q = "SELECT id, ts, event_type, user_id, summary, details FROM memory_events WHERE 1=1"
        params = []
        if event_type:
            q += " AND event_type = ?"
            params.append(event_type)
        if user_id:
            q += " AND (user_id = ? OR event_type IN ('consolidation_start', 'consolidation_end'))"
            params.append(user_id)
        if since_ts is not None:
            q += " AND ts >= ?"
            params.append(since_ts)
        q += " ORDER BY ts DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        with _LOCK:
            cur = conn.execute(q, params)
            rows = cur.fetchall()
        out = []
        for r in rows:
            d = dict(r)
            if d.get("details"):
                try:
                    d["details"] = json.loads(d["details"])
                except Exception:
                    pass
            out.append(d)
        return out
    except Exception:
        return []


def get_events_count(event_type: Optional[str] = None, user_id: Optional[str] = None) -> int:
    """Număr total de evenimente (pentru paginare)."""
    try:
        conn = _get_conn()
        q = "SELECT COUNT(*) FROM memory_events WHERE 1=1"
        params = []
        if event_type:
            q += " AND event_type = ?"
            params.append(event_type)
        if user_id:
            q += " AND (user_id = ? OR event_type IN ('consolidation_start', 'consolidation_end'))"
            params.append(user_id)
        with _LOCK:
            cur = conn.execute(q, params)
            count = cur.fetchone()[0]
        return count
    except Exception:
        return 0


def clear_events() -> bool:
    """Șterge toate evenimentele din log. Returnează True la succes."""
    try:
        conn = _get_conn()
        with _LOCK:
            conn.execute("DELETE FROM memory_events")
            conn.commit()
        return True
    except Exception:
        return False
