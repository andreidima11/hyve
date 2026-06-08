"""Lightweight in-process event bus.

Used by automations and other reactive subsystems. Subscribers register a
callable for a named topic and receive events posted by publishers. Callbacks
are invoked synchronously inside the publisher's task — keep handlers fast,
or schedule their own background work.

Currently the bus is used by:
- `core.entity_mirror` — publishes ``entity_mirror_tick`` after each rebuild
- `core.state_observer` — publishes ``entity_state_changed`` events
- `automation_definitions` — subscribes ``state`` / ``numeric_state`` triggers
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List

log = logging.getLogger("event_bus")

# topic -> list of (handler_id, callback)
_SUBSCRIBERS: Dict[str, List[tuple[str, Callable[[dict], None]]]] = {}


def subscribe(topic: str, handler_id: str, callback: Callable[[dict], None]) -> None:
    """Register a callback for ``topic``. ``handler_id`` is used by
    ``unsubscribe`` to remove it later — callers should pick a unique id
    per subscription (e.g. f"automation:{def_id}:{idx}")."""
    bucket = _SUBSCRIBERS.setdefault(topic, [])
    # Replace existing handler with same id so re-syncs don't accumulate.
    bucket[:] = [(hid, cb) for (hid, cb) in bucket if hid != handler_id]
    bucket.append((handler_id, callback))


def unsubscribe(topic: str, handler_id: str) -> None:
    bucket = _SUBSCRIBERS.get(topic)
    if not bucket:
        return
    bucket[:] = [(hid, cb) for (hid, cb) in bucket if hid != handler_id]
    if not bucket:
        _SUBSCRIBERS.pop(topic, None)


def unsubscribe_prefix(prefix: str) -> int:
    """Remove every handler whose id starts with ``prefix`` across all topics.
    Returns the number of subscriptions removed. Useful when an automation
    definition is deleted/disabled and we want to drop all its triggers."""
    removed = 0
    for topic, bucket in list(_SUBSCRIBERS.items()):
        keep = [(hid, cb) for (hid, cb) in bucket if not hid.startswith(prefix)]
        removed += len(bucket) - len(keep)
        if keep:
            _SUBSCRIBERS[topic] = keep
        else:
            _SUBSCRIBERS.pop(topic, None)
    return removed


def publish(topic: str, payload: dict) -> None:
    """Synchronously fan out ``payload`` to every subscriber of ``topic``.
    Exceptions in handlers are logged and swallowed so a misbehaving
    subscriber cannot break the publisher."""
    for handler_id, callback in list(_SUBSCRIBERS.get(topic, [])):
        try:
            callback(payload)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("event_bus handler %s for %s failed: %s", handler_id, topic, exc)


def subscriber_count(topic: str | None = None) -> int:
    if topic is None:
        return sum(len(v) for v in _SUBSCRIBERS.values())
    return len(_SUBSCRIBERS.get(topic, []))


def list_topics() -> list[str]:
    return sorted(_SUBSCRIBERS.keys())
