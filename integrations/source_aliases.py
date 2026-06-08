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


def device_config_slugs_for_entity_source(entity_source: str) -> tuple[str, ...]:
    """Integration config buckets that may hold device aliases/registry rows.

    Entity ``source`` values (e.g. ``zigbee2mqtt``) can differ from the
    integration slug used in ``device_aliases.yaml`` (``mosquitto``). Return
    every bucket that should be consulted for a given entity source.
    """
    src = str(entity_source or "").strip().lower()
    if not src:
        return ()
    slugs: list[str] = []
    for integration_slug, sources in _INTEGRATION_ENTITY_SOURCES.items():
        if src in sources and integration_slug not in slugs:
            slugs.append(integration_slug)
    if src not in slugs:
        slugs.append(src)
    return tuple(slugs)
