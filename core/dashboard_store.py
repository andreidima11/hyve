"""File-based persistence for dashboard pages.

Historically the whole dashboard (pages + widgets) lived inside ``config.json``
under the ``dashboard`` key and was written with ``settings.save_config`` which
performs a shallow ``dict.update``. A single save that carried a reduced
``pages`` list therefore replaced *all* pages, silently wiping user-created
pages on the next restart.

This module stores each dashboard page in its own JSON file under
``dashboards/`` (one file per page, like add-ons/widgets) plus a small
``_meta.json`` for ``current_page_id`` and ``templates``. Writes are atomic
(temp file + ``os.replace``) and every save keeps a timestamped backup so data
can be recovered. On first use it migrates any existing ``config.json``
dashboard data into files.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from copy import deepcopy
from typing import Any

log = logging.getLogger("dashboard_store")

_BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dashboards")
_BACKUP_DIR = os.path.join(_BASE_DIR, ".backups")
_META_FILE = os.path.join(_BASE_DIR, "_meta.json")
_MIGRATED_MARKER = os.path.join(_BASE_DIR, ".migrated")
_MAX_BACKUPS = 30

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _ensure_dirs() -> None:
    os.makedirs(_BASE_DIR, exist_ok=True)
    os.makedirs(_BACKUP_DIR, exist_ok=True)


def _safe_filename(page_id: str, used: set[str]) -> str:
    base = _SAFE_ID_RE.sub("_", str(page_id or "page")).strip("_") or "page"
    name = base
    i = 1
    while name in used:
        i += 1
        name = f"{base}_{i}"
    used.add(name)
    return name


def _atomic_write(path: str, payload: Any) -> None:
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _page_files() -> list[str]:
    if not os.path.isdir(_BASE_DIR):
        return []
    out = []
    for name in os.listdir(_BASE_DIR):
        if not name.endswith(".json"):
            continue
        if name.startswith("_") or name.startswith("."):
            continue
        out.append(os.path.join(_BASE_DIR, name))
    return out


def _read_json(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as exc:  # pragma: no cover - corrupt file
        log.warning("dashboard page read failed %s: %s", path, exc)
        return None


def _read_meta() -> dict[str, Any]:
    data = _read_json(_META_FILE) or {}
    return {
        "current_page_id": str(data.get("current_page_id") or ""),
        "templates": data.get("templates") if isinstance(data.get("templates"), list) else [],
    }


def _migrate_from_config() -> dict[str, Any] | None:
    """Pull dashboard data out of config.json (one-time) into files."""
    try:
        import core.settings as settings

        cfg = settings.reload_config()
    except Exception as exc:  # pragma: no cover
        log.warning("dashboard migration: cannot read config: %s", exc)
        return None
    dashboard = cfg.get("dashboard")
    if not isinstance(dashboard, dict):
        return None
    store = {
        "pages": dashboard.get("pages") if isinstance(dashboard.get("pages"), list) else [],
        "current_page_id": str(dashboard.get("current_page_id") or ""),
        "templates": dashboard.get("templates") if isinstance(dashboard.get("templates"), list) else [],
    }
    # Persist a verbatim backup of the original config dashboard for safety.
    _ensure_dirs()
    try:
        _atomic_write(
            os.path.join(_BACKUP_DIR, f"config-migration-{int(time.time())}.json"),
            dashboard,
        )
    except Exception:
        pass
    save_store(store)
    try:
        with open(_MIGRATED_MARKER, "w", encoding="utf-8") as f:
            f.write(str(int(time.time())))
    except Exception:
        pass
    log.info("dashboard: migrated %d page(s) from config.json to files", len(store["pages"]))
    return store


def load_store() -> dict[str, Any]:
    """Return ``{pages, current_page_id, templates}`` from disk.

    Pages are ordered by their ``order`` field (then title). Migrates from
    config.json on first use when no page files exist yet.
    """
    _ensure_dirs()
    files = _page_files()
    if not files and not os.path.exists(_MIGRATED_MARKER):
        migrated = _migrate_from_config()
        if migrated is not None:
            files = _page_files()

    pages: list[dict[str, Any]] = []
    for path in files:
        rec = _read_json(path)
        if rec and rec.get("id"):
            pages.append(rec)
    pages.sort(key=lambda p: (int(p.get("order") or 0), str(p.get("title") or "")))

    meta = _read_meta()
    return {
        "pages": pages,
        "current_page_id": meta.get("current_page_id") or (pages[0].get("id") if pages else ""),
        "templates": meta.get("templates") or [],
    }


def save_store(store: dict[str, Any]) -> None:
    """Persist the full dashboard store: one file per page + meta.

    Removes files for pages that are no longer present and keeps a timestamped
    backup snapshot of the whole store on every save.
    """
    _ensure_dirs()
    pages = [p for p in (store.get("pages") or []) if isinstance(p, dict) and p.get("id")]

    # Timestamped backup of the complete store (recovery safety net).
    try:
        _atomic_write(
            os.path.join(_BACKUP_DIR, f"store-{int(time.time() * 1000)}.json"),
            {"pages": pages, "current_page_id": store.get("current_page_id"), "templates": store.get("templates") or []},
        )
        _prune_backups()
    except Exception as exc:  # pragma: no cover
        log.debug("dashboard backup skipped: %s", exc)

    used: set[str] = set()
    keep_files: set[str] = set()
    for idx, page in enumerate(pages):
        rec = deepcopy(page)
        rec.setdefault("order", idx)
        fname = _safe_filename(rec.get("id"), used)
        path = os.path.join(_BASE_DIR, f"{fname}.json")
        keep_files.add(os.path.abspath(path))
        _atomic_write(path, rec)

    # Delete page files that no longer correspond to a page.
    for path in _page_files():
        if os.path.abspath(path) not in keep_files:
            try:
                os.remove(path)
            except OSError:
                pass

    _atomic_write(
        _META_FILE,
        {
            "current_page_id": str(store.get("current_page_id") or (pages[0].get("id") if pages else "")),
            "templates": store.get("templates") or [],
        },
    )


def _prune_backups() -> None:
    try:
        backups = sorted(
            (os.path.join(_BACKUP_DIR, n) for n in os.listdir(_BACKUP_DIR) if n.startswith("store-")),
            key=os.path.getmtime,
            reverse=True,
        )
    except OSError:
        return
    for path in backups[_MAX_BACKUPS:]:
        try:
            os.remove(path)
        except OSError:
            pass
