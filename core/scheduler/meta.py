"""Scheduler job metadata SQLite store (reminder display, automation specs)."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

from core.sidecar_migrations import run_sidecar_migrations
from core.sqlite_sidecar import SidecarPool
from core.logger import log_detail

_ROOT = Path(__file__).resolve().parents[2]
_META_DB_PATH = _ROOT / "scheduler_meta.sqlite"
_meta_lock = threading.Lock()


def _init_meta_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS reminder_display (
            job_id TEXT PRIMARY KEY,
            display_text TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS automation_specs (
            job_id TEXT PRIMARY KEY,
            spec_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS life_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            description TEXT NOT NULL,
            event_time_iso TEXT,
            session_id TEXT,
            created_at REAL NOT NULL
        )
        """
    )


def _bootstrap_meta_schema(conn: sqlite3.Connection) -> None:
    run_sidecar_migrations(conn, {1: _init_meta_schema})


_meta_pool = SidecarPool(str(_META_DB_PATH), _bootstrap_meta_schema, check_same_thread=False)


def _get_meta_conn():
    conn = _meta_pool.connection()
    with _meta_lock:
        if not getattr(_get_meta_conn, "_migrated", False):
            _migrate_json_to_sqlite()
            _get_meta_conn._migrated = True  # type: ignore[attr-defined]
    return conn


def _migrate_json_to_sqlite():
    """One-time migration from old JSON files to SQLite."""
    rd_path = _ROOT / "reminders_display.json"
    as_path = _ROOT / "automation_specs.json"
    conn = _meta_pool.connection()
    migrated = False
    if rd_path.is_file():
        try:
            data = json.loads(rd_path.read_text(encoding="utf-8"))
            for job_id, text in data.items():
                conn.execute(
                    "INSERT OR IGNORE INTO reminder_display (job_id, display_text) VALUES (?, ?)",
                    (str(job_id), str(text)),
                )
            conn.commit()
            rd_path.rename(rd_path.with_suffix(rd_path.suffix + ".migrated"))
            migrated = True
        except Exception as exc:
            log_detail("scheduler", "MIGRATION_REMINDERS_ERROR", error=str(exc))
    if as_path.is_file():
        try:
            data = json.loads(as_path.read_text(encoding="utf-8"))
            for job_id, spec in data.items():
                conn.execute(
                    "INSERT OR IGNORE INTO automation_specs (job_id, spec_json) VALUES (?, ?)",
                    (str(job_id), json.dumps(spec, ensure_ascii=False)),
                )
            conn.commit()
            as_path.rename(as_path.with_suffix(as_path.suffix + ".migrated"))
            migrated = True
        except Exception as exc:
            log_detail("scheduler", "MIGRATION_AUTOMATIONS_ERROR", error=str(exc))
    if migrated:
        log_detail("scheduler", "MIGRATED_JSON_TO_SQLITE")


def set_reminder_display(job_id, text):
    conn = _get_meta_conn()
    with _meta_lock:
        if text is not None and str(text).strip():
            conn.execute(
                "INSERT OR REPLACE INTO reminder_display (job_id, display_text) VALUES (?, ?)",
                (str(job_id), str(text)),
            )
        else:
            conn.execute("DELETE FROM reminder_display WHERE job_id = ?", (str(job_id),))
        conn.commit()


def get_reminder_display(job_id):
    conn = _get_meta_conn()
    row = conn.execute(
        "SELECT display_text FROM reminder_display WHERE job_id = ?", (str(job_id),)
    ).fetchone()
    return row[0] if row else None


def get_reminder_displays_bulk(job_ids):
    if not job_ids:
        return {}
    conn = _get_meta_conn()
    placeholders = ",".join("?" * len(job_ids))
    rows = conn.execute(
        "SELECT job_id, display_text FROM reminder_display WHERE job_id IN (" + placeholders + ")",
        list(job_ids),
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def get_automation_spec(job_id):
    conn = _get_meta_conn()
    row = conn.execute(
        "SELECT spec_json FROM automation_specs WHERE job_id = ?", (str(job_id),)
    ).fetchone()
    if row:
        try:
            return json.loads(row[0])
        except Exception as exc:
            log_detail("scheduler", "SPEC_JSON_INVALID", job_id=str(job_id), error=str(exc))
            return None
    return None


def set_automation_spec(job_id, spec):
    conn = _get_meta_conn()
    with _meta_lock:
        conn.execute(
            "INSERT OR REPLACE INTO automation_specs (job_id, spec_json) VALUES (?, ?)",
            (str(job_id), json.dumps(spec, ensure_ascii=False)),
        )
        conn.commit()


def delete_automation_spec(job_id):
    conn = _get_meta_conn()
    with _meta_lock:
        conn.execute("DELETE FROM automation_specs WHERE job_id = ?", (str(job_id),))
        conn.commit()


def get_automation_specs_bulk(job_ids):
    if not job_ids:
        return {}
    conn = _get_meta_conn()
    placeholders = ",".join("?" * len(job_ids))
    rows = conn.execute(
        "SELECT job_id, spec_json FROM automation_specs WHERE job_id IN (" + placeholders + ")",
        list(job_ids),
    ).fetchall()
    out = {}
    for job_id, spec_json in rows:
        try:
            out[job_id] = json.loads(spec_json)
        except Exception as exc:
            log_detail("scheduler", "SPEC_PARSE_ERROR", job_id=str(job_id), error=str(exc))
    return out
