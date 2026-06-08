"""State observer — publishes ``entity_state_changed`` events.

Two complementary paths feed the event bus:

1. **Real-time MQTT listener** — subscribes to the MQTT bridge's live queue
   and publishes entity-level state changes as soon as a Z2M state message
   arrives.  This is critical for momentary events (remote button presses)
   that only exist for a fraction of a second.

2. **EntityMirror snapshots** (fallback) — receives shared rebuilds from
   :mod:`core.entity_mirror` instead of running its own poll loop.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from core import event_bus

log = logging.getLogger("state_observer")

TOPIC_STATE_CHANGED = "entity_state_changed"
TOPIC_MQTT_ACTION = "mqtt_action"

_task: asyncio.Task | None = None
_mqtt_task: asyncio.Task | None = None
_last_snapshot: dict[str, dict[str, Any]] = {}

# Maps Z2M state topic → {property → entity_id}.
_topic_entity_map: dict[str, dict[str, str]] = {}

# Entities recently updated by the real-time MQTT path.
_mqtt_recently_updated: dict[str, float] = {}
_MQTT_GUARD_SECONDS = 6.0


def _index(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {item.get("entity_id"): item for item in items if item.get("entity_id")}


def _publish_diffs(prev: dict[str, dict[str, Any]], curr: dict[str, dict[str, Any]]) -> int:
    import time as _time

    now = _time.monotonic()
    fired = 0
    for entity_id, new in curr.items():
        old = prev.get(entity_id)
        new_state = new.get("state")
        old_state = old.get("state") if old is not None else None
        if str(old_state) == str(new_state):
            continue
        guarded_at = _mqtt_recently_updated.get(entity_id)
        if guarded_at is not None:
            if (now - guarded_at) < _MQTT_GUARD_SECONDS:
                continue
            del _mqtt_recently_updated[entity_id]
        event_bus.publish(TOPIC_STATE_CHANGED, {
            "entity_id": entity_id,
            "old_state": old_state,
            "new_state": new_state,
            "old": old,
            "new": new,
        })
        fired += 1
    return fired


def _rebuild_topic_map(snapshot: dict[str, dict[str, Any]]) -> None:
    global _topic_entity_map
    new_map: dict[str, dict[str, str]] = {}
    for eid, entity in snapshot.items():
        attrs = entity.get("attributes") or {}
        z2m_prop = attrs.get("z2m_property") or ""
        state_topic = (attrs.get("capabilities") or {}).get("state_topic") or ""
        if not state_topic:
            state_topic = attrs.get("state_topic") or ""
        if state_topic and z2m_prop:
            new_map.setdefault(state_topic, {})[z2m_prop] = eid
        elif state_topic:
            vt = (attrs.get("capabilities") or {}).get("value_template") or ""
            m = re.search(r"\{\{\s*value_json\.(\w+)", vt)
            if m:
                new_map.setdefault(state_topic, {})[m.group(1)] = eid
    _topic_entity_map = new_map


async def ingest_mirror_snapshot(items: list[dict[str, Any]]) -> None:
    """Apply a shared EntityMirror rebuild and emit automation diffs."""
    global _last_snapshot
    curr = _index(items)
    if event_bus.subscriber_count(TOPIC_STATE_CHANGED) > 0 and _last_snapshot:
        import time as _time

        now = _time.monotonic()
        guarded_curr = dict(curr)
        for eid, guarded_at in list(_mqtt_recently_updated.items()):
            if (now - guarded_at) < _MQTT_GUARD_SECONDS:
                prev_ent = _last_snapshot.get(eid)
                if prev_ent and eid in guarded_curr:
                    guarded_curr[eid] = dict(guarded_curr[eid])
                    guarded_curr[eid]["state"] = prev_ent.get("state", guarded_curr[eid].get("state"))
        _publish_diffs(_last_snapshot, guarded_curr)
    _last_snapshot = curr
    _rebuild_topic_map(curr)


async def _emit_state_change(
    entity_id: str, old_state: str, new_state: str, is_action: bool,
    old_entity: dict | None = None, new_entity: dict | None = None,
) -> None:
    try:
        if is_action:
            event_bus.publish(TOPIC_MQTT_ACTION, {
                "entity_id": entity_id,
                "action": new_state,
                "topic": "",
            })
        event_bus.publish(TOPIC_STATE_CHANGED, {
            "entity_id": entity_id,
            "old_state": old_state,
            "new_state": new_state,
            "old": old_entity if old_entity is not None else _last_snapshot.get(entity_id),
            "new": new_entity if new_entity is not None else _last_snapshot.get(entity_id),
        })
    except Exception as exc:
        log.warning("emit_state_change failed for %s: %s", entity_id, exc)


async def _mqtt_listener():
    from components.mosquitto import bridge as mosquitto_bridge

    log.info("MQTT real-time listener waiting for bridge...")
    for _ in range(60):
        bridge = mosquitto_bridge.get_bridge()
        if bridge is not None and bridge.is_running():
            break
        await asyncio.sleep(1.0)
    else:
        log.warning("MQTT real-time listener: bridge not available, giving up")
        return

    queue = bridge.subscribe()
    log.info("MQTT real-time listener active")

    _last_state: dict[str, str] = {}
    for eid, entity in _last_snapshot.items():
        _last_state[eid] = str(entity.get("state") or "")

    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                continue

            if event.get("type") != "state":
                continue

            topic = event.get("topic") or ""
            payload = event.get("payload")
            if not isinstance(payload, dict) or not topic:
                continue

            prop_map = _topic_entity_map.get(topic) or {}
            if not prop_map:
                continue

            for prop, entity_id in prop_map.items():
                raw_val = payload.get(prop)
                if raw_val is None:
                    continue

                if isinstance(raw_val, bool):
                    new_state = "on" if raw_val else "off"
                else:
                    new_state = str(raw_val).strip()
                    if not new_state:
                        continue

                old_state = _last_state.get(entity_id, "unknown")
                is_action = prop == "action"

                if new_state != old_state or is_action:
                    _last_state[entity_id] = new_state
                    prev_entity = _last_snapshot.get(entity_id)
                    old_entity = dict(prev_entity) if isinstance(prev_entity, dict) else None
                    new_entity = None
                    if entity_id in _last_snapshot:
                        _last_snapshot[entity_id] = dict(_last_snapshot[entity_id])
                        _last_snapshot[entity_id]["state"] = new_state
                        new_entity = dict(_last_snapshot[entity_id])

                    import time as _time
                    _mqtt_recently_updated[entity_id] = _time.monotonic()

                    asyncio.create_task(_emit_state_change(
                        entity_id, old_state, new_state, is_action,
                        old_entity, new_entity,
                    ))
                    try:
                        from core.mirror_nudge import nudge_entity_mirror

                        nudge_entity_mirror()
                    except Exception:
                        pass

    except asyncio.CancelledError:
        log.info("MQTT real-time listener stopped")
    finally:
        bridge.unsubscribe(queue)


def start():
    global _mqtt_task
    if _mqtt_task is None or _mqtt_task.done():
        _mqtt_task = asyncio.create_task(_mqtt_listener())


def stop():
    global _mqtt_task
    if _mqtt_task is not None:
        _mqtt_task.cancel()
        _mqtt_task = None
