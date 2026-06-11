"""Integrations management API — split from monolithic routers/integrations.py."""

from __future__ import annotations

import core.area_resolver as area_resolver

from routers.integrations.helpers import (
    all_entities as _all_entities,
    apply_instance_sync_schedule as _apply_instance_sync_schedule,
    build_all_entities_uncached as _build_all_entities_uncached,
    ensure_fetcher as _ensure_fetcher,
    group_entities_into_devices as _group_entities_into_devices,
    invalidate_all_entities_cache,
    provider_meta as _provider_meta,
    redact_entry as _redact_entry,
    register_instance_fetcher as _register_instance_fetcher,
)
from routers.integrations.entries import wire_new_entry as _wire_new_entry
from routers.integrations.router import router

# Side-effect imports: register routes on the shared router.
from routers.integrations import devices as _devices  # noqa: F401
from routers.integrations import entities as _entities  # noqa: F401
from routers.integrations import entries as _entries  # noqa: F401
from routers.integrations import sync as _sync  # noqa: F401
from routers.integrations import ws as _ws  # noqa: F401

__all__ = [
    "router",
    "area_resolver",
    "_all_entities",
    "_build_all_entities_uncached",
    "_apply_instance_sync_schedule",
    "_ensure_fetcher",
    "_group_entities_into_devices",
    "_provider_meta",
    "_redact_entry",
    "_register_instance_fetcher",
    "_wire_new_entry",
    "invalidate_all_entities_cache",
    "get_integrations_live_hub",
    "picker_entities",
    "picker_areas",
    "picker_domains",
]

from routers.integrations.entities import picker_areas, picker_domains, picker_entities
from routers.integrations.ws import get_integrations_live_hub
