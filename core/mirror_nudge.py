"""Debounced EntityMirror refresh requests for push sources (MQTT, etc.)."""

from __future__ import annotations

import time as _time

_last_nudge_at = 0.0
_MIN_INTERVAL_SEC = 0.4


def nudge_entity_mirror(store_key: str | None = None) -> None:
    """Ask EntityMirror to rebuild soon without waiting for the next tick."""
    global _last_nudge_at
    now = _time.monotonic()
    if (now - _last_nudge_at) < _MIN_INTERVAL_SEC:
        return
    _last_nudge_at = now
    try:
        from core.entity_mirror import signal_source_refresh

        signal_source_refresh(store_key)
    except Exception:
        pass
