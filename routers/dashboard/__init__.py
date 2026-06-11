"""Dashboard API — split from monolithic routers/dashboard.py."""

from __future__ import annotations

from core import dashboard_store
from integrations.extractors import (
    extract_fusion_solar_candidates as _extract_fusion_solar_candidates,
    extract_pago_candidates as _extract_pago_candidates,
    extract_weather_candidates as _extract_weather_candidates,
    extract_z2m_widget_candidates as _extract_z2m_candidates,
    infer_source as _infer_source,
    normalize_entities as _normalize_entities,
)
from integrations import get_integration_manager
from routers.dashboard.constants import (
    STANDALONE_PANEL_ID,
    _DEFAULT_PAGE_ID,
    _DEFAULT_PAGE_TITLE,
    _DEFAULT_PREFS,
)
from routers.dashboard.entities import (
    _available_entities,
    _hydrate_panels,
    _hydrate_widgets,
    _panel_entity_ids,
    _scene_synthetic_entities,
    invalidate_available_entities_cache,
)
from routers.dashboard.control import (
    _expand_entity_id_aliases,
    _normalize_widget_control_action,
    _primary_widget_entity_id,
    toggle_dashboard_widget,
)
from routers.dashboard.models import (
    DashboardDefaultPageBody,
    DashboardImportBody,
    DashboardMoveBody,
    DashboardPageBody,
    DashboardPageUpdateBody,
    DashboardPageYamlBody,
    DashboardPanelBody,
    DashboardPanelLayoutBody,
    DashboardPanelUpdateBody,
    DashboardPreferencesBody,
    DashboardReorderBody,
    DashboardTemplateInstantiateBody,
    DashboardTemplateSaveBody,
    DashboardToggleBody,
    DashboardWidgetBody,
    DashboardWidgetRelocateBody,
    DashboardWidgetUpdateBody,
)
from routers.dashboard.routes import router
from routers.dashboard import store as _store
from routers.dashboard.store import (
    _apply_widget_patch,
    _make_page,
    _normalize_dashboard_store,
    _normalize_icon,
    _normalize_panel_record,
    _save_dashboard,
    _widget_renderer,
)


def _dashboard_section(page_id: str | None = None):
    return _store._dashboard_section(page_id)


def _find_widget_any_page(widget_id: str, page_id: str | None = None):
    section = _dashboard_section(page_id)
    _, _, _, widget = _store._find_widget(section, widget_id)
    if widget is not None:
        return widget
    store_data = _store._normalize_dashboard_store(_store._read_dashboard_raw())
    for page in store_data.get("pages") or []:
        candidate = {"panels": _store._section_panels_only(list(page.get("panels") or []))}
        _, _, _, widget = _store._find_widget(candidate, widget_id)
        if widget is not None:
            return widget
    return None


# Re-export route handlers referenced by tests
from routers.dashboard.routes import (
    delete_dashboard_page,
    move_dashboard_panel,
    patch_dashboard_preferences,
    reorder_dashboard_page,
    reorder_dashboard_panel,
)

__all__ = [
    "router",
    "dashboard_store",
    "STANDALONE_PANEL_ID",
    "_DEFAULT_PAGE_ID",
    "_DEFAULT_PAGE_TITLE",
    "_DEFAULT_PREFS",
    "_available_entities",
    "_scene_synthetic_entities",
    "invalidate_available_entities_cache",
    "_expand_entity_id_aliases",
    "_normalize_widget_control_action",
    "_primary_widget_entity_id",
    "toggle_dashboard_widget",
    "DashboardToggleBody",
    "DashboardWidgetBody",
    "_hydrate_widgets",
    "_hydrate_panels",
    "_panel_entity_ids",
    "_apply_widget_patch",
    "_dashboard_section",
    "_save_dashboard",
    "_normalize_dashboard_store",
    "_normalize_icon",
    "_normalize_panel_record",
    "_make_page",
    "_find_widget_any_page",
    "_widget_renderer",
    "_extract_z2m_candidates",
    "_extract_pago_candidates",
    "_extract_fusion_solar_candidates",
    "_extract_weather_candidates",
    "_infer_source",
    "_normalize_entities",
    "get_integration_manager",
    "delete_dashboard_page",
    "patch_dashboard_preferences",
    "reorder_dashboard_page",
    "move_dashboard_panel",
    "reorder_dashboard_panel",
]
