"""Entity numeric state history (Phase 5).

Lightweight time-series store backed by SQLite. A background recorder
polls the same entity snapshot the dashboard uses and persists numeric
state values. The dashboard fetches recent history to render sparkline
charts on sensor / info cards.

Design goals:
- Minimal write amplification: only insert when value changed by a
  small delta OR > _MIN_INTERVAL_SEC have passed since last write.
- Bounded growth: prune rows older than RETENTION_DAYS once a day.
- No new SQLAlchemy models — direct sqlite via the shared engine.
"""
from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Any

from sqlalchemy import text

import database
from logger import log_line

_POLL_INTERVAL_SEC = 30.0      # how often the recorder samples
_MIN_INTERVAL_SEC = 120.0      # always force a sample after this gap
_MIN_REL_DELTA = 0.005         # 0.5% relative change triggers a sample
_MIN_ABS_DELTA = 0.01          # absolute floor (covers near-zero values)
RETENTION_DAYS = 14
_PRUNE_INTERVAL_SEC = 6 * 3600  # prune every 6h

_recorder_task: asyncio.Task | None = None
_stop_event: asyncio.Event | None = None
_last_sample: dict[str, tuple[float, float]] = {}  # entity_id -> (ts, value)


def init_history_table() -> None:
    """Verify Alembic created entity_state_history (see migrations/004)."""
    from core.db_schema import require_sqlite_tables

    require_sqlite_tables(database.engine, "entity_state_history")


def _coerce_numeric(state: Any) -> float | None:
    if isinstance(state, bool):
        return 1.0 if state else 0.0
    if isinstance(state, (int, float)):
        try:
            v = float(state)
            if v != v or v in (float("inf"), float("-inf")):
                return None
            return v
        except Exception:
            return None
    if isinstance(state, str):
        s = state.strip()
        if not s:
            return None
        # Common boolean-ish states
        low = s.lower()
        if low in {"on", "open", "true", "yes", "active", "home"}:
            return 1.0
        if low in {"off", "closed", "false", "no", "inactive", "away", "unavailable", "unknown"}:
            return 0.0 if low != "unavailable" and low != "unknown" else None
        try:
            v = float(s.replace(",", "."))
            if v != v or v in (float("inf"), float("-inf")):
                return None
            return v
        except Exception:
            return None
    return None


def _should_record(entity_id: str, value: float, now: float) -> bool:
    last = _last_sample.get(entity_id)
    if last is None:
        return True
    last_ts, last_val = last
    if (now - last_ts) >= _MIN_INTERVAL_SEC:
        return True
    delta = abs(value - last_val)
    if delta < _MIN_ABS_DELTA:
        return False
    denom = max(abs(last_val), 1.0)
    return (delta / denom) >= _MIN_REL_DELTA


def record_snapshot(items: list[dict[str, Any]]) -> int:
    """Persist numeric values from a fresh entity snapshot. Returns count."""
    now = time.time()
    rows: list[dict[str, Any]] = []
    for item in items:
        eid = item.get("entity_id")
        if not eid:
            continue
        value = _coerce_numeric(item.get("state"))
        if value is None:
            continue
        if not _should_record(eid, value, now):
            continue
        _last_sample[eid] = (now, value)
        rows.append({"entity_id": eid, "ts": int(now), "value": value})
    if not rows:
        return 0
    try:
        with database.engine.begin() as conn:
            conn.execute(
                text("INSERT INTO entity_state_history (entity_id, ts, value) VALUES (:entity_id, :ts, :value)"),
                rows,
            )
    except Exception as exc:
        log_line("error", "⚠️", "HISTORY", f"insert failed: {exc}")
        return 0
    return len(rows)


def prune_old(retention_days: int = RETENTION_DAYS) -> int:
    cutoff = int(time.time()) - retention_days * 86400
    try:
        with database.engine.begin() as conn:
            res = conn.execute(
                text("DELETE FROM entity_state_history WHERE ts < :cutoff"),
                {"cutoff": cutoff},
            )
            return int(res.rowcount or 0)
    except Exception as exc:
        log_line("error", "⚠️", "HISTORY", f"prune failed: {exc}")
        return 0


def get_history(entity_id: str, hours: float = 24.0, max_points: int = 240) -> list[dict[str, Any]]:
    """Return [{ts, value}] for `entity_id` over the last `hours`.

    Downsampled by simple striding so the client never receives more
    than `max_points` samples per request.
    """
    if not entity_id:
        return []
    hours = max(0.25, min(float(hours), 24.0 * 7))
    since = int(time.time() - hours * 3600)
    try:
        with database.engine.begin() as conn:
            rows = conn.execute(
                text(
                    "SELECT ts, value FROM entity_state_history "
                    "WHERE entity_id = :eid AND ts >= :since ORDER BY ts ASC"
                ),
                {"eid": entity_id, "since": since},
            ).fetchall()
    except Exception as exc:
        log_line("error", "⚠️", "HISTORY", f"query failed: {exc}")
        return []
    pts = [{"ts": int(r[0]), "value": float(r[1])} for r in rows]
    if len(pts) > max_points:
        step = len(pts) / max_points
        sampled: list[dict[str, Any]] = []
        idx = 0.0
        while int(idx) < len(pts):
            sampled.append(pts[int(idx)])
            idx += step
        # Always keep the latest point
        if sampled and sampled[-1] is not pts[-1]:
            sampled.append(pts[-1])
        pts = sampled
    return pts


async def _recorder_loop():
    # Lazy-import to avoid circular dependency (routers.dashboard imports many things).
    from routers.dashboard import _available_entities

    last_prune = 0.0
    while _stop_event is not None and not _stop_event.is_set():
        try:
            items = await _available_entities()
            count = record_snapshot(items)
            if count:
                log_line("sys", "📈", "HISTORY", f"recorded {count} samples")
        except Exception as exc:
            log_line("error", "⚠️", "HISTORY", f"recorder error: {exc}")
        now = time.time()
        if (now - last_prune) >= _PRUNE_INTERVAL_SEC:
            try:
                removed = prune_old()
                if removed:
                    log_line("sys", "🧹", "HISTORY", f"pruned {removed} old samples")
            except Exception:
                pass
            last_prune = now
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=_POLL_INTERVAL_SEC)
        except asyncio.TimeoutError:
            continue


def start_history_recorder() -> None:
    """Start the background recorder. Idempotent."""
    global _recorder_task, _stop_event
    if _recorder_task is not None and not _recorder_task.done():
        return
    init_history_table()
    _stop_event = asyncio.Event()
    _recorder_task = asyncio.create_task(_recorder_loop())
    log_line("sys", "📈", "HISTORY", "recorder started")


async def stop_history_recorder() -> None:
    global _recorder_task, _stop_event
    if _stop_event is not None:
        _stop_event.set()
    if _recorder_task is not None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(_recorder_task, timeout=2.0)
    _recorder_task = None
    _stop_event = None
