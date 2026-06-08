from __future__ import annotations

import logging
from typing import Any

import models
from fastapi import Depends, HTTPException
from integrations.entity_utils import entity_id_lookup_variants, resolve_entity_by_id
from routers import scenes as scenes_module
from routers.dashboard.models import DashboardToggleBody
from routers.dashboard.store import (
    _widget_entity_ids,
    _widget_entity_records,
    _widget_renderer,
)
from smart_home_registry import entity_domain, is_controllable_domain
from sqlalchemy.orm import Session

import auth
import database

log = logging.getLogger("dashboard")

def _resolve_integration_component(
    manager: Any,
    *,
    entity_snapshot: dict[str, Any] | None,
    entity_id: str,
    widget_source: str,
) -> Any:
    """Pick the integration instance that owns a dashboard widget entity."""
    from core.device_control import integration_for_entity

    if entity_snapshot:
        inst = integration_for_entity(entity_snapshot, raw_entity_id=entity_id)
        if inst is not None:
            return inst
    source = str(widget_source or "").strip().lower()
    slug_map = {"zigbee2mqtt": "mosquitto", "mosquitto": "mosquitto"}
    if source in slug_map:
        entries = manager.entries_for("mosquitto")
        return entries[0] if entries else manager.get("mosquitto")
    return manager.get(source) if source else None


def _normalize_widget_control_action(
    action: str,
    *,
    entity_snapshot: dict[str, Any] | None,
    desired_state: str | None,
) -> str:
    act = str(action or "").strip().lower()
    if act and act != "toggle":
        return act
    if desired_state in ("on", "off"):
        return "turn_on" if desired_state == "on" else "turn_off"
    state = str((entity_snapshot or {}).get("state") or "").lower()
    if state in {"on", "open", "locked", "playing", "cleaning", "unlocked", "heat", "cool", "auto", "dry", "fan_only"}:
        return "turn_off"
    return "turn_on"


def _expand_entity_id_aliases(
    entity_ids: set[str] | list[str],
    entity_items: list[dict[str, Any]],
) -> set[str]:
    """Allow widget control when the card stores either entity_id or unique_id."""
    expanded = {str(eid).strip() for eid in entity_ids if str(eid).strip()}
    for raw in list(expanded):
        for variant in entity_id_lookup_variants(raw):
            expanded.add(variant)
    by_key: dict[str, dict[str, Any]] = {}
    for ent in entity_items:
        if not isinstance(ent, dict):
            continue
        eid = str(ent.get("entity_id") or "").strip()
        uid = str(ent.get("unique_id") or "").strip()
        if eid:
            by_key[eid] = ent
        if uid:
            by_key[uid] = ent
    for raw in list(expanded):
        ent = by_key.get(raw)
        if not ent:
            continue
        eid = str(ent.get("entity_id") or "").strip()
        uid = str(ent.get("unique_id") or "").strip()
        if eid:
            expanded.add(eid)
        if uid:
            expanded.add(uid)
    return expanded


def _primary_widget_entity_id(widget: dict[str, Any]) -> str:
    primary_uid = str(widget.get("unique_id") or "").strip()
    if primary_uid:
        return primary_uid
    primary = str(widget.get("entity_id") or "").strip()
    if primary:
        return primary
    records = _widget_entity_records(widget)
    if records:
        rec_uid = str(records[0].get("unique_id") or "").strip()
        if rec_uid:
            return rec_uid
        return str(records[0].get("entity_id") or "").strip()
    return ""


async def toggle_dashboard_widget(
    widget_id: str,
    body: DashboardToggleBody | None = None,
    page_id: str | None = None,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    """Toggle a dashboard card entity for any authenticated user.

    RBAC: raw integration control (``POST /api/integrations/{slug}/control``) is
    admin-only; dashboard toggle is the member-facing path for everyday device
    control (lights, climate, scenes on configured cards).
    """
    from routers import dashboard as dash

    widget = dash._find_widget_any_page(widget_id, page_id)
    if not widget:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.widget_not_found"})

    if _widget_renderer(widget) in {"info", "label", "weather", "weather_rich"}:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.info_card_not_toggleable"})

    requested_entity_id = str((body.entity_id if body else None) or "").strip()
    if not requested_entity_id and body and isinstance(body.data, dict):
        requested_entity_id = str(body.data.get("entity_id") or "").strip()

    entity_items: list[dict[str, Any]] = []
    try:
        entity_items = await dash._available_entities()
    except Exception:
        entity_items = []

    allowed_entity_ids = _expand_entity_id_aliases(set(_widget_entity_ids(widget)), entity_items)
    if requested_entity_id and requested_entity_id not in allowed_entity_ids:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.entity_not_on_card"})
    entity_id = requested_entity_id or _primary_widget_entity_id(widget)
    if not entity_id:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.widget_missing_entity"})

    entity_snapshot = resolve_entity_by_id(entity_id, entity_items)
    control_entity_id = str((entity_snapshot or {}).get("entity_id") or entity_id).strip()
    source = str(widget.get("source") or "").strip().lower()
    if entity_snapshot:
        source = str(entity_snapshot.get("source") or source).strip().lower()
    manager = dash.get_integration_manager()
    component = _resolve_integration_component(
        manager,
        entity_snapshot=entity_snapshot,
        entity_id=entity_id,
        widget_source=source,
    )
    resolved_source = str((entity_snapshot or {}).get("source") or source).strip().lower()
    uses_integration = bool(
        component
        or "." not in entity_id
        or entity_id.startswith("z2m:")
        or resolved_source in {"mosquitto", "zigbee2mqtt"}
        or (entity_snapshot and entity_snapshot.get("controllable") and resolved_source)
    )
    if uses_integration:
        if not component:
            raise HTTPException(
                status_code=400,
                detail={"key": "dashboard.api.integration_toggle_unavailable", "params": {"source": resolved_source or source or "unknown"}},
            )
        requested_action = str((body.action if body else "") or "").strip().lower()
        if requested_action not in {
            "turn_on", "turn_off", "toggle", "set", "set_value",
            "set_temperature", "set_hvac_mode", "set_fan_mode", "set_swing_mode", "set_preset_mode",
        }:
            requested_action = ""
        desired = body.desired_state if body else None
        action = _normalize_widget_control_action(
            requested_action or "toggle",
            entity_snapshot=entity_snapshot,
            desired_state=desired,
        )
        payload = body.data if body and isinstance(body.data, dict) else None
        try:
            from core.device_control import SOURCE_SLUG_ALIASES, control_entity

            slug_hint = SOURCE_SLUG_ALIASES.get(resolved_source, resolved_source) or None
            result = await control_entity(
                control_entity_id,
                action,
                payload,
                entity=entity_snapshot,
                slug_hint=slug_hint,
            )
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc))
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            log.error("Widget toggle via integration failed for %s: %s", entity_id, exc)
            raise HTTPException(status_code=500, detail=str(exc))
        return {"status": "ok", "action": action, "desired_state": desired, "result": result}

    if _widget_renderer(widget) == "scene" or entity_id.startswith("scene."):
        scene_id = entity_id.split(".", 1)[1] if "." in entity_id else ""
        if not scene_id:
            raise HTTPException(status_code=400, detail={"key": "dashboard.api.invalid_scene_card"})
        scene = scenes_module._load_visible(db, scene_id, user)
        return await scenes_module.activate_scene_internal(db, scene)

    domain = entity_domain(entity_id)
    if not is_controllable_domain(domain):
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.entity_not_directly_toggleable"})
    raise HTTPException(status_code=501, detail={"key": "dashboard.api.direct_toggle_unavailable"})
