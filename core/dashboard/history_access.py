"""Dashboard entity history access control."""

from __future__ import annotations

import core.models as models
from core.cameras.access import dashboard_entity_ids
from integrations.entity_utils import entity_id_lookup_variants


def user_may_access_entity_history(user: models.User, entity_id: str) -> bool:
    """Allow history only for entities referenced on a dashboard page widget."""
    eid = str(entity_id or "").strip()
    if not eid:
        return False
    allowed = dashboard_entity_ids()
    if not allowed:
        return False
    if eid in allowed:
        return True
    for variant in entity_id_lookup_variants(eid):
        if variant in allowed:
            return True
    return False


def filter_entity_ids_for_history(user: models.User, entity_ids: list[str]) -> list[str]:
    """Return entity ids the user may query in batch history requests."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in entity_ids:
        eid = str(raw or "").strip()
        if not eid or eid in seen:
            continue
        if user_may_access_entity_history(user, eid):
            out.append(eid)
            seen.add(eid)
    return out
