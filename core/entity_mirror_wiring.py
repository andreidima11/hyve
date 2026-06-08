"""Wire EntityMirror push targets (WS hubs, state observer)."""

from __future__ import annotations

import logging

from core.entity_mirror import get_entity_mirror

log = logging.getLogger("entity_mirror.wiring")

_wired = False


def wire_entity_mirror_targets() -> None:
    """Register mirror consumers once at startup."""
    global _wired
    if _wired:
        return
    mirror = get_entity_mirror()

    from core import state_observer
    from routers.dashboard_ws import get_dashboard_live_hub
    from routers.integrations.ws import get_integrations_live_hub

    mirror.register_push_target(
        "state-observer",
        state_observer.ingest_mirror_snapshot,
        include_derived=False,
        sort_mode="dashboard",
    )
    integrations_hub = get_integrations_live_hub()
    mirror.register_push_target(
        "integrations-ws",
        integrations_hub.ingest_snapshot,
        include_derived=True,
        sort_mode="name",
    )
    dashboard_hub = get_dashboard_live_hub()
    mirror.register_push_target(
        "dashboard-ws",
        dashboard_hub.ingest_snapshot,
        include_derived=False,
        sort_mode="dashboard",
    )
    _wired = True
    log.debug("EntityMirror push targets registered")
