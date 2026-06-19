"""Camera stream access control."""

from __future__ import annotations

from core import dashboard_store
from core.dashboard.normalize import _normalize_dashboard_store, _widget_entity_ids
from core.smart_home_registry import entity_domain
import core.models as models


def dashboard_entity_ids() -> set[str]:
    """Entity ids referenced by any dashboard page widget."""
    try:
        raw = dashboard_store.load_store()
    except Exception:
        return set()
    store = _normalize_dashboard_store(raw)
    ids: set[str] = set()
    for page in store.get("pages") or []:
        if not isinstance(page, dict):
            continue
        for panel in page.get("panels") or []:
            if not isinstance(panel, dict):
                continue
            for widget in panel.get("widgets") or []:
                if isinstance(widget, dict):
                    ids.update(_widget_entity_ids(widget))
    return ids


def user_may_access_camera(user: models.User, entity_id: str) -> bool:
    """Admins may stream any camera; other users only cameras on the dashboard."""
    eid = str(entity_id or "").strip()
    if not eid:
        return False
    if getattr(user, "is_admin", False):
        return True
    domain = entity_domain(eid)
    if domain not in ("camera", "image"):
        return False
    return eid in dashboard_entity_ids()
