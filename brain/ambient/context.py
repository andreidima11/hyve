from __future__ import annotations

from datetime import datetime
from typing import Any

from brain.ambient import config, constants, entities, issues

from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled
from brain.ambient.entities import _domain, _entity_area, _entity_name, _get_upcoming_events, _get_weather_forecast, _integration_sync_issues, _is_long_running, _minutes_in_state, _snapshot
from brain.ambient.issues import _attach_issue_awareness, _current_proactive_issues, _mark_issues_notified, _new_issue_keys, _reconcile_notified_issues, _unavailable_clusters

def _build_context(batch: list[dict]) -> dict:
    snapshot = _snapshot()
    now = datetime.now()

    # Triggering events (resolved against the snapshot for names/areas).
    events = []
    seen = set()
    for t in batch:
        if t.get("type") != "event":
            continue
        eid = t.get("entity_id")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        ent = snapshot.get(eid) or {}
        if ent and _should_skip_entity(eid, ent):
            continue
        events.append({
            "entity_id": eid,
            "name": _entity_name(ent) if ent else eid,
            "area": _entity_area(ent) if ent else "",
            "from": t.get("old_state"),
            "to": t.get("new_state"),
        })

    # Compact home state for the relevant domains, with duration awareness.
    home = []
    long_running = []
    for eid, ent in snapshot.items():
        if _domain(eid) not in constants._CONTEXT_DOMAINS:
            continue
        if _should_skip_entity(eid, ent):
            continue
        mins = _minutes_in_state(eid, ent)
        row = {
            "entity_id": eid,
            "name": _entity_name(ent),
            "area": _entity_area(ent),
            "state": ent.get("state"),
            "minutes_in_state": mins,
        }
        home.append(row)
        if _is_long_running(eid, ent.get("state"), mins):
            long_running.append(row)
    home = home[:120]

    checkin = next((t for t in batch if t.get("type") == "checkin"), None)
    scan = next((t for t in batch if t.get("type") == "scan"), None)
    trigger = "checkin" if checkin else ("scan" if scan else "event")

    # Predictive context: weather + upcoming events
    weather = _get_weather_forecast() if trigger in {"checkin", "scan"} else []
    upcoming_events = _get_upcoming_events() if trigger in {"checkin", "scan"} else []

    ctx = {
        "now": now.strftime("%Y-%m-%d %H:%M (%A)"),
        "hour": now.hour,
        "trigger": trigger,
        "checkin_kind": checkin.get("kind") if checkin else None,
        "events": events,
        "home": home,
        "long_running": long_running,
        "weather": weather,
        "upcoming_events": upcoming_events,
    }
    _attach_issue_awareness(ctx)
    return ctx

