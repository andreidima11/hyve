"""Debounced EntityMirror refresh requests for push sources (MQTT, etc.)."""

from __future__ import annotations


def nudge_entity_mirror(store_key: str | None = None) -> None:
    """Ask EntityMirror to rebuild soon without waiting for the next tick."""
    try:
        from core.entity_mirror import signal_source_refresh

        signal_source_refresh(store_key)
    except Exception:
        pass
