from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Optional

from logger import log_detail

from brain.ambient import config

from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled

def _integration_sync_issues() -> list[dict[str, str]]:
    """Integrations whose last sync failed (excluding muted slugs)."""
    issues: list[dict[str, str]] = []
    ignored = _ignored_sources()
    try:
        from addons.entity_store import get_entity_store

        store = get_entity_store()
        for slug in sorted(getattr(store, "_fetchers", {}).keys()):
            slug_key = str(slug).strip().lower()
            if slug_key in ignored:
                continue
            row = store.get_entities(slug)
            if not row:
                continue
            err = str(row.get("last_error") or "").strip()
            if err:
                issues.append({"slug": slug_key, "error": err[:240]})
    except Exception as exc:
        log_detail("ambient", "INTEGRATION_ISSUES_ERR", error=str(exc))
    return issues

def _domain(entity_id: str) -> str:
    return (entity_id or "").split(".", 1)[0]

def _entity_name(entity: dict) -> str:
    attrs = entity.get("attributes") or {}
    return str(entity.get("name") or attrs.get("friendly_name") or entity.get("entity_id") or "?")

def _entity_area(entity: dict) -> str:
    attrs = entity.get("attributes") or {}
    return str(entity.get("area") or entity.get("area_name") or attrs.get("area") or "").strip()

def _snapshot() -> dict[str, dict]:
    try:
        from core import state_observer
        return dict(state_observer._last_snapshot or {})
    except Exception:
        return {}

def _minutes_in_state(eid: str, ent: dict) -> Optional[int]:
    """How many minutes the entity has held its current state, if known.
    Lazily initialises tracking for entities that were already in this state
    when ambient started (so durations accrue from first sight)."""
    state = ent.get("state")
    rec = runtime._state_since.get(eid)
    if not rec or str(rec.get("state")) != str(state):
        runtime._state_since[eid] = {"state": state, "since": time.time()}
        return 0
    return int(max(0, (time.time() - float(rec.get("since", time.time()))) / 60.0))

def _is_long_running(eid: str, state: Any, minutes: Optional[int]) -> bool:
    if minutes is None:
        return False
    dom = _domain(eid)
    st = str(state or "").lower()
    if st not in constants._ON_STATES:
        return False
    if dom in {"light", "switch", "fan", "media_player"}:
        return minutes >= constants._LONG_ON_MINUTES
    if dom in {"cover", "lock", "binary_sensor", "alarm_control_panel"}:
        return minutes >= constants._LONG_OPEN_MINUTES
    return False

def _get_weather_forecast() -> list[dict]:
    """Get weather/sensor data from entity store for predictive reasoning."""
    try:
        from addons.entity_store import get_entity_store
        store = get_entity_store()
        entities = store.get_all_entities()
        weather = []
        for e in entities:
            eid = e.get("entity_id") or ""
            if any(k in eid.lower() for k in ("weather", "temperature", "humidity", "rain", "wind")):
                weather.append({
                    "entity_id": eid,
                    "name": e.get("name") or eid,
                    "state": e.get("state"),
                    "unit": (e.get("attributes") or {}).get("unit_of_measurement", ""),
                })
        return weather[:10]
    except Exception:
        return []

def _get_upcoming_events() -> list[dict]:
    """Get today's upcoming planner events for context-aware reasoning."""
    try:
        import database
        import models
        from datetime import date as _date
        db = database.SessionLocal()
        try:
            now = datetime.now()
            end_of_day = datetime.combine(_date.today(), datetime.max.time())
            entries = (
                db.query(models.Entry)
                .filter(
                    models.Entry.start_at >= now,
                    models.Entry.start_at <= end_of_day,
                    models.Entry.entry_type == "event",
                )
                .order_by(models.Entry.start_at.asc())
                .limit(5)
                .all()
            )
            return [
                {"title": e.title, "starts_in_min": max(0, int((e.start_at - now).total_seconds() / 60))}
                for e in entries if e.start_at
            ]
        finally:
            db.close()
    except Exception:
        return []

