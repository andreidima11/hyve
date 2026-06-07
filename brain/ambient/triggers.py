from __future__ import annotations

import asyncio
import time

from logger import log_detail

from brain.ambient import config, constants, entities, runtime

from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled
from brain.ambient.entities import _domain, _entity_area, _entity_name, _get_upcoming_events, _get_weather_forecast, _integration_sync_issues, _is_long_running, _minutes_in_state, _snapshot

def _on_state_event(payload: dict) -> None:
    """event_bus handler (runs in the publisher's task). Keep it cheap:
    filter, dedupe per-entity cooldown, then hand off to the async worker."""
    try:
        if not is_enabled():
            return
        entity_id = str(payload.get("entity_id") or "")
        if _domain(entity_id) not in constants._TRIGGER_DOMAINS:
            return
        # Track when this entity entered its new state (for duration awareness).
        new_state = payload.get("new_state")
        prev = runtime._state_since.get(entity_id)
        if not prev or str(prev.get("state")) != str(new_state):
            runtime._state_since[entity_id] = {"state": new_state, "since": time.time()}
        now = time.monotonic()
        last = runtime._entity_cooldown.get(entity_id, 0.0)
        if (now - last) < constants._ENTITY_COOLDOWN_S:
            return
        runtime._entity_cooldown[entity_id] = now
        _enqueue({
            "type": "event",
            "entity_id": entity_id,
            "old_state": payload.get("old_state"),
            "new_state": payload.get("new_state"),
            "at": time.time(),
        })
    except Exception as exc:
        log_detail("ambient", "EVENT_HANDLER_ERR", error=str(exc))

def _enqueue(trigger: dict) -> None:
    """Thread/loop-safe enqueue onto the async worker queue."""
    if runtime._loop is None or runtime._queue is None:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is runtime._loop:
        try:
            runtime._queue.put_nowait(trigger)
        except Exception:
            pass
    else:
        try:
            runtime._loop.call_soon_threadsafe(runtime._queue.put_nowait, trigger)
        except Exception as exc:
            log_detail("ambient", "ENQUEUE_ERR", error=str(exc))

