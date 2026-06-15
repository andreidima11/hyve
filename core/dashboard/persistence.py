"""Dashboard store persistence and section assembly."""

from __future__ import annotations

import logging
from typing import Any

import core.settings as settings
from core import dashboard_store
from core.dashboard.constants import (
    _DEFAULT_DASHBOARD_ICON,
    _DEFAULT_PAGE_ID,
    _DEFAULT_PREFS,
)
from core.dashboard.normalize import (
    _find_page,
    _make_page,
    _migrate_to_section_layout,
    _normalize_dashboard_store,
    _normalize_icon,
    _normalize_page_columns,
    _normalize_page_record,
    _section_panels_only,
)

log = logging.getLogger("dashboard.store")



def _read_dashboard_raw() -> dict[str, Any]:
    """Load the dashboard store (pages/current_page_id/templates) from files."""
    try:
        return dashboard_store.load_store()
    except Exception:
        log.exception("dashboard store load failed; falling back to empty store")
        return {"pages": [], "current_page_id": "", "templates": []}


def _write_dashboard_raw(payload: dict[str, Any]) -> None:
    """Persist the dashboard store to files, preserving templates if omitted."""
    data = dict(payload or {})
    if "templates" not in data:
        try:
            data["templates"] = dashboard_store.load_store().get("templates") or []
        except Exception:
            data["templates"] = []
    dashboard_store.save_store(data)


def _dashboard_section(page_id: str | None = None) -> dict[str, Any]:
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    _, page = _find_page(store.get("pages") or [], page_id or store.get("current_page_id"))
    page = page or _make_page(page_id=_DEFAULT_PAGE_ID)

    if _migrate_to_section_layout(page):
        _save_dashboard(
            {
                "page_id": page.get("id") or _DEFAULT_PAGE_ID,
                "pages": store.get("pages") or [],
                "current_page_id": store.get("current_page_id") or page.get("id") or _DEFAULT_PAGE_ID,
                "panels": list(page.get("panels") or []),
                "preferences": page.get("preferences") or {},
                "title": page.get("title"),
                "subtitle": page.get("subtitle"),
                "icon": page.get("icon"),
                "columns": page.get("columns"),
                "theme": page.get("theme"),
                "parent_page_id": page.get("parent_page_id"),
            },
            page.get("id") or page_id,
        )

    return {
        "page_id": page.get("id") or _DEFAULT_PAGE_ID,
        "pages": store.get("pages") or [],
        "current_page_id": store.get("current_page_id") or page.get("id") or _DEFAULT_PAGE_ID,
        "panels": _section_panels_only(list(page.get("panels") or [])),
        "preferences": {**_DEFAULT_PREFS, **(page.get("preferences") or {})},
        "title": str(page.get("title") or "Dashboard"),
        "subtitle": str(page.get("subtitle") or "Acasă"),
        "icon": _normalize_icon(page.get("icon"), _DEFAULT_DASHBOARD_ICON),
        "columns": _normalize_page_columns(page.get("columns")),
        "theme": str(page.get("theme") or ""),
        "parent_page_id": str(page.get("parent_page_id") or ""),
    }


def _dashboard_user_prefs(username: str | None) -> dict[str, Any]:
    """Per-user dashboard preferences stored under config dashboard.user_prefs.

    The dashboard layout itself stays central (Home Assistant-style); only the
    viewer's own default page is kept per account.
    """
    if not username:
        return {}
    cfg = settings.reload_config()
    store = cfg.get("dashboard") if isinstance(cfg.get("dashboard"), dict) else {}
    prefs = store.get("user_prefs") if isinstance(store.get("user_prefs"), dict) else {}
    entry = prefs.get(username)
    return dict(entry) if isinstance(entry, dict) else {}


def _user_default_page_id(username: str | None) -> str | None:
    pid = str(_dashboard_user_prefs(username).get("default_page_id") or "").strip()
    return pid or None


def _set_user_default_page_id(username: str | None, page_id: str | None) -> None:
    if not username:
        return
    cfg = settings.reload_config()
    store = cfg.get("dashboard") if isinstance(cfg.get("dashboard"), dict) else {}
    prefs = dict(store.get("user_prefs") if isinstance(store.get("user_prefs"), dict) else {})
    entry = dict(prefs.get(username) if isinstance(prefs.get(username), dict) else {})
    cleaned = str(page_id or "").strip()
    if cleaned:
        entry["default_page_id"] = cleaned
    else:
        entry.pop("default_page_id", None)
    if entry:
        prefs[username] = entry
    else:
        prefs.pop(username, None)
    # Shallow-merged into the dashboard dict; pages/templates are untouched.
    settings.save_config({"dashboard": {"user_prefs": prefs}})
    settings.reload_config()


def _save_dashboard(section: dict[str, Any], page_id: str | None = None) -> None:
    store = _normalize_dashboard_store({
        "pages": section.get("pages") or [],
        "current_page_id": section.get("current_page_id") or section.get("page_id") or page_id,
    })
    target_page_id = str(page_id or section.get("page_id") or store.get("current_page_id") or _DEFAULT_PAGE_ID).strip() or _DEFAULT_PAGE_ID
    page_idx, page = _find_page(store.get("pages") or [], target_page_id)
    pages = list(store.get("pages") or [])
    if page is None or page_idx is None:
        pages.append(
            _normalize_page_record(
                {
                    "id": target_page_id,
                    "title": str(section.get("title") or "Dashboard"),
                    "subtitle": str(section.get("subtitle") or "Acasă"),
                    "icon": _normalize_icon(section.get("icon"), _DEFAULT_DASHBOARD_ICON),
                    "columns": _normalize_page_columns(section.get("columns")),
                    "preferences": {**_DEFAULT_PREFS, **(section.get("preferences") or {})},
                    "panels": _section_panels_only(list(section.get("panels") or [])),
                },
                len(pages),
            )
        )
    else:
        merged = {
            **page,
            "id": target_page_id,
            "title": str(section.get("title") or page.get("title") or "Dashboard"),
            "subtitle": str(section.get("subtitle") or page.get("subtitle") or "Acasă"),
            "icon": _normalize_icon(section.get("icon") or page.get("icon"), _DEFAULT_DASHBOARD_ICON),
            "columns": _normalize_page_columns(section.get("columns", page.get("columns", 0))),
            "preferences": {**_DEFAULT_PREFS, **(section.get("preferences") or page.get("preferences") or {})},
            "panels": _section_panels_only(list(section.get("panels") or page.get("panels") or [])),
        }
        if "theme" in section:
            merged["theme"] = section.get("theme") or ""
        if "parent_page_id" in section:
            merged["parent_page_id"] = section.get("parent_page_id") or ""
        pages[page_idx] = _normalize_page_record(merged, page_idx)

    payload = {
        "pages": [_normalize_page_record(page, idx) for idx, page in enumerate(pages)],
        "current_page_id": target_page_id,
    }
    existing_cfg = settings.reload_config()
    existing_store = _normalize_dashboard_store(_read_dashboard_raw())
    payload["templates"] = existing_store.get("templates") or []
    _write_dashboard_raw(payload)
    settings.reload_config()


def _all_panel_widgets(section: dict[str, Any]) -> list[dict[str, Any]]:
    widgets: list[dict[str, Any]] = []
    for panel in section.get("panels") or []:
        widgets.extend(list(panel.get("widgets") or []))
    return widgets


def _find_panel(section: dict[str, Any], panel_id: str) -> tuple[int | None, dict[str, Any] | None]:
    panels = section.get("panels") or []
    for idx, panel in enumerate(panels):
        if panel.get("id") == panel_id:
            return idx, panel
    return None, None


def _find_widget(section: dict[str, Any], widget_id: str) -> tuple[int | None, dict[str, Any] | None, int | None, dict[str, Any] | None]:
    panels = section.get("panels") or []
    for panel_idx, panel in enumerate(panels):
        widgets = panel.get("widgets") or []
        for widget_idx, widget in enumerate(widgets):
            if widget.get("id") == widget_id:
                return panel_idx, panel, widget_idx, widget
    return None, None, None, None


def _find_widget_any_page(widget_id: str, page_id: str | None = None) -> dict[str, Any] | None:
    section = _dashboard_section(page_id)
    _, _, _, widget = _find_widget(section, widget_id)
    if widget is not None:
        return widget
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    for page in store.get("pages") or []:
        candidate = {"panels": _section_panels_only(list(page.get("panels") or []))}
        _, _, _, widget = _find_widget(candidate, widget_id)
        if widget is not None:
            return widget
    return None
