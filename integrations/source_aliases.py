"""Map catalog integration slugs to entity ``source`` values stored in snapshots."""

from __future__ import annotations

_INTEGRATION_ENTITY_SOURCES: dict[str, frozenset[str]] = {
    # Z2M devices keep source=zigbee2mqtt in entity records but belong to the
    # Mosquitto integration in Settings → Integrări.
    "mosquitto": frozenset({"mosquitto", "zigbee2mqtt"}),
}


def entity_sources_for_integration(slug: str) -> frozenset[str]:
    key = (slug or "").strip().lower()
    if not key:
        return frozenset()
    return _INTEGRATION_ENTITY_SOURCES.get(key, frozenset({key}))


def entity_matches_integration(entity_source: str, slug: str) -> bool:
    return str(entity_source or "").strip().lower() in entity_sources_for_integration(slug)
