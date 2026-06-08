"""Home-Assistant style "config entries" for integrations.

Each entry is one independent configuration of an integration (e.g. one
Pago account, one MQTT broker). Multiple entries per slug are supported
when the provider declares ``SUPPORTS_MULTIPLE = True``.

Entries are stored in SQLite. Fields marked ``secret: True`` in the
provider's ``CONFIG_SCHEMA`` are encrypted at rest with Fernet.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

from . import secrets as _secrets

_DB_PATH = Path(__file__).resolve().parent.parent / "config" / "integration_entries.sqlite"
_LOCK = threading.RLock()


def _init_schema(cx: sqlite3.Connection) -> None:
    cx.execute(
        """
        CREATE TABLE IF NOT EXISTS integration_entries (
            entry_id   TEXT PRIMARY KEY,
            slug       TEXT NOT NULL,
            title      TEXT NOT NULL DEFAULT '',
            data_json  TEXT NOT NULL DEFAULT '{}',
            enabled    INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    cx.execute("CREATE INDEX IF NOT EXISTS idx_ie_slug ON integration_entries(slug)")


def _conn() -> sqlite3.Connection:
    from core.sqlite_sidecar import open_sqlite

    return open_sqlite(
        _DB_PATH,
        row_factory=True,
        foreign_keys=True,
        init=_init_schema,
    )


def _init() -> None:
    """Ensure sidecar schema exists (idempotent)."""
    with _LOCK:
        _conn().close()


def _now() -> int:
    return int(time.time())


# ─────────── encryption helpers driven by the provider's schema ───────────

def _secret_keys(schema: list[dict[str, Any]] | None) -> set[str]:
    if not schema:
        return set()
    return {str(f.get("key")) for f in schema if f.get("secret") and f.get("key")}


def _normalize_schema_values(data: dict[str, Any], schema: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Clamp numeric CONFIG_SCHEMA fields to declared min/max so stored values
    match what ``BaseEntity.sync_interval()`` (and similar) will enforce."""
    out = dict(data or {})
    if not schema:
        return out
    for field in schema:
        key = str(field.get("key") or "").strip()
        if not key or key not in out:
            continue
        ftype = str(field.get("type") or "").strip().lower()
        if ftype not in {"number", "integer"} and key not in {"scan_interval", "scan_interval_seconds"}:
            continue
        try:
            value = int(out[key])
        except (TypeError, ValueError):
            continue
        if field.get("min") is not None:
            try:
                value = max(int(field["min"]), value)
            except (TypeError, ValueError):
                pass
        if field.get("max") is not None:
            try:
                value = min(int(field["max"]), value)
            except (TypeError, ValueError):
                pass
        out[key] = value
    return out


def _encrypt_payload(data: dict[str, Any], schema: list[dict[str, Any]] | None) -> dict[str, Any]:
    secrets = _secret_keys(schema)
    if not secrets:
        return dict(data or {})
    out = dict(data or {})
    for k in secrets:
        v = out.get(k)
        if v is None or v == "":
            continue
        out[k] = {"__enc__": _secrets.encrypt(str(v))}
    return out


def _decrypt_payload(data: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in (data or {}).items():
        if isinstance(v, dict) and "__enc__" in v:
            out[k] = _secrets.decrypt(v["__enc__"])
        else:
            out[k] = v
    return out


def _row_to_entry(row: sqlite3.Row, *, redact_schema: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    try:
        raw = json.loads(row["data_json"] or "{}")
    except (json.JSONDecodeError, TypeError):
        raw = {}
    data = _decrypt_payload(raw)
    if redact_schema is not None:
        secrets = _secret_keys(redact_schema)
        for k in secrets:
            if data.get(k):
                data[k] = "••••••"
    return {
        "entry_id": row["entry_id"],
        "slug": row["slug"],
        "title": row["title"],
        "data": data,
        "enabled": bool(row["enabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# ─────────── public API ───────────

def list_entries(slug: str | None = None) -> list[dict[str, Any]]:
    _init()
    with _LOCK, _conn() as cx:
        if slug:
            rows = cx.execute(
                "SELECT * FROM integration_entries WHERE slug=? ORDER BY created_at",
                (slug,),
            ).fetchall()
        else:
            rows = cx.execute(
                "SELECT * FROM integration_entries ORDER BY slug, created_at"
            ).fetchall()
    return [_row_to_entry(r) for r in rows]


def list_entries_redacted(slug: str, schema: list[dict[str, Any]]) -> list[dict[str, Any]]:
    _init()
    with _LOCK, _conn() as cx:
        rows = cx.execute(
            "SELECT * FROM integration_entries WHERE slug=? ORDER BY created_at",
            (slug,),
        ).fetchall()
    return [_row_to_entry(r, redact_schema=schema) for r in rows]


def get_entry(entry_id: str) -> dict[str, Any] | None:
    _init()
    with _LOCK, _conn() as cx:
        row = cx.execute(
            "SELECT * FROM integration_entries WHERE entry_id=?",
            (entry_id,),
        ).fetchone()
    return _row_to_entry(row) if row else None


def create_entry(
    slug: str,
    title: str,
    data: dict[str, Any],
    schema: list[dict[str, Any]] | None,
    *,
    enabled: bool = True,
    entry_id: str | None = None,
) -> dict[str, Any]:
    _init()
    entry_id = entry_id or uuid.uuid4().hex
    payload = _encrypt_payload(_normalize_schema_values(data, schema), schema)
    now = _now()
    with _LOCK, _conn() as cx:
        cx.execute(
            "INSERT INTO integration_entries(entry_id, slug, title, data_json, enabled, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (entry_id, slug, title or slug, json.dumps(payload), int(bool(enabled)), now, now),
        )
        cx.commit()
    return get_entry(entry_id)  # type: ignore[return-value]


def update_entry(
    entry_id: str,
    *,
    title: str | None = None,
    data: dict[str, Any] | None = None,
    enabled: bool | None = None,
    schema: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    _init()
    existing = get_entry(entry_id)
    if not existing:
        return None
    new_title = title if title is not None else existing["title"]
    new_enabled = bool(enabled) if enabled is not None else existing["enabled"]
    if data is not None:
        # Merge with existing so callers can PATCH a subset (e.g. only password)
        merged = {**existing["data"], **(data or {})}
        # When a secret arrives masked (••••••), keep existing value
        secrets = _secret_keys(schema)
        for k in secrets:
            v = (data or {}).get(k)
            if isinstance(v, str) and set(v) <= {"•", "*"}:
                merged[k] = existing["data"].get(k, "")
        merged = _normalize_schema_values(merged, schema)
        payload = _encrypt_payload(merged, schema)
    else:
        payload = _encrypt_payload(existing["data"], schema)
    now = _now()
    with _LOCK, _conn() as cx:
        cx.execute(
            "UPDATE integration_entries SET title=?, data_json=?, enabled=?, updated_at=? WHERE entry_id=?",
            (new_title, json.dumps(payload), int(new_enabled), now, entry_id),
        )
        cx.commit()
    return get_entry(entry_id)


def delete_entry(entry_id: str) -> bool:
    _init()
    with _LOCK, _conn() as cx:
        cur = cx.execute("DELETE FROM integration_entries WHERE entry_id=?", (entry_id,))
        cx.commit()
        return cur.rowcount > 0


def short_id(entry_id: str) -> str:
    return (entry_id or "")[:8]


def migrate_from_cfg(cfg: dict[str, Any], known_slugs: Iterable[str]) -> int:
    """One-time migration: for each integration section in ``cfg`` that has
    ``enabled=True`` and no entry yet, create a Default entry.

    After migrating, the legacy ``cfg[slug].enabled`` is flipped to ``False``
    and persisted, so the loader's legacy fallback can't resurrect the
    integration after the user deletes the entry — entries become the sole
    source of truth (HA-style).

    Returns the number of entries created. Safe to call repeatedly.
    """
    _init()
    created = 0
    dirty = False
    for slug in known_slugs:
        section = cfg.get(slug)
        if not isinstance(section, dict):
            continue
        if list_entries(slug):
            # Entry already exists. If the legacy section is still marked
            # enabled, disable it now so deletes don't fall back to it.
            if section.get("enabled"):
                section["enabled"] = False
                dirty = True
            continue
        if not section.get("enabled"):
            continue
        data = {k: v for k, v in section.items() if k not in {"enabled"}}
        try:
            from .loader import get_integration_manager  # local import to avoid cycle

            schema = getattr(get_integration_manager().get_class(slug), "CONFIG_SCHEMA", None)
        except Exception:
            schema = None
        create_entry(slug, title=f"{slug} (migrat)", data=data, schema=schema, enabled=True)
        section["enabled"] = False
        dirty = True
        created += 1
    if dirty:
        try:
            import settings as _settings_mod

            _settings_mod.save_config(cfg)
        except Exception:
            pass
    return created
