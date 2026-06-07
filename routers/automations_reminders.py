"""
Automation definitions API.
YAML-backed automation definitions for scheduled HA automations.
"""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional
import asyncio

import automation_definitions
import database
import models
import auth
from core.automations_engine import blueprints as bp_engine

router = APIRouter(tags=["automations"])


def _owner_id_for_user(user: models.User) -> str:
    return f"user_{user.id}"


def _actor_for_user(user: models.User) -> str:
    return f"user:{user.username}"


# --- Automation Definitions (YAML-backed) ---

class AutomationDefinitionValidateBody(BaseModel):
    source_yaml: str = Field(..., min_length=1)


class AutomationDefinitionCreateBody(BaseModel):
    source_yaml: str = Field(..., min_length=1)


class AutomationDefinitionReplaceBody(BaseModel):
    source_yaml: str = Field(..., min_length=1)
    expected_revision: int = Field(..., ge=1)


class AutomationDefinitionToggleBody(BaseModel):
    expected_revision: int = Field(..., ge=1)


@router.post("/api/automations/definitions/validate")
async def validate_automation_definition(
    data: AutomationDefinitionValidateBody,
    _: models.User = Depends(auth.get_current_user),
):
    try:
        normalized = automation_definitions.validate_source_yaml(data.source_yaml)
    except automation_definitions.AutomationValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "valid": True,
        "normalized": normalized,
        "warnings": automation_definitions.lint_definition(normalized),
        "trigger_summary": automation_definitions.summarize_trigger_set(normalized.get("trigger") or []),
        "action_summary": automation_definitions.summarize_action_set(normalized.get("action") or []),
    }


@router.get("/api/automations/capabilities")
async def get_automation_capabilities(
    current_user: models.User = Depends(auth.get_current_user),
):
    """Static schema (modes, trigger platforms, condition kinds, action kinds,
    service verbs, weekdays) plus the list of entities + areas the user can
    reference. Drives the editor selectors and client-side validation.

    Auth-gated, owner-scoped, read-only — safe to call freely from the UI."""
    schema = automation_definitions.describe_schema()
    entities: list[dict] = []
    areas: list[dict] = []
    try:
        from routers.integrations import _all_entities  # lazy: heavy module
        raw_entities = await _all_entities(include_derived=True)
        for ent in raw_entities:
            eid = ent.get("entity_id") or ""
            if not eid or "." not in eid:
                continue
            entities.append({
                "entity_id": eid,
                "name": ent.get("name") or eid,
                "domain": eid.split(".", 1)[0],
                "area": ent.get("area") or "",
                "source": ent.get("source") or "",
                "controllable": bool(ent.get("controllable")),
            })
    except Exception:
        # Capabilities should still return the static schema even if the
        # integration manager is unavailable.
        entities = []
    try:
        import area_resolver
        areas = list(area_resolver.list_areas() or [])
    except Exception:
        areas = []
    entities.sort(key=lambda e: e["name"].lower())
    return {
        "schema": schema,
        "entities": entities,
        "areas": areas,
    }


@router.get("/api/automations/definitions")
async def list_automation_definitions(
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    items = automation_definitions.list_definitions(db, _owner_id_for_user(current_user))
    return {"items": [automation_definitions.serialize_definition(item) for item in items]}


@router.get("/api/automations/definitions/events")
async def list_automation_events(
    limit: int = 30,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Recent automation runs across all automations for the event log."""
    owner_id = _owner_id_for_user(current_user)
    def_ids = [d.id for d in automation_definitions.list_definitions(db, owner_id)]
    if not def_ids:
        return {"items": []}
    runs = (db.query(models.AutomationRun)
            .filter(models.AutomationRun.automation_id.in_(def_ids))
            .order_by(models.AutomationRun.started_at.desc())
            .limit(min(limit, 50)).all())
    title_map = {d.id: d.title for d in db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id.in_(def_ids)).all()}
    return {"items": [{
        "automation_id": r.automation_id,
        "title": title_map.get(r.automation_id, r.automation_id),
        "status": r.status,
        "trigger_source": r.trigger_source,
        "message": r.message,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    } for r in runs]}


@router.get("/api/automations/definitions/statuses")
async def list_automation_statuses(
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Lightweight endpoint returning only run status + timestamp per automation."""
    items = automation_definitions.list_definitions(db, _owner_id_for_user(current_user))
    return {"items": [{
        "id": d.id,
        "enabled": bool(d.enabled),
        "last_run_at": d.last_run_at.isoformat() if d.last_run_at else None,
        "last_run_status": d.last_run_status,
        "last_error": d.last_error,
    } for d in items]}


@router.post("/api/automations/definitions")
async def create_automation_definition(
    data: AutomationDefinitionCreateBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        definition = automation_definitions.create_definition(
            db,
            owner_id=_owner_id_for_user(current_user),
            actor=_actor_for_user(current_user),
            source_yaml=data.source_yaml,
        )
    except automation_definitions.AutomationValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "created", "item": automation_definitions.serialize_definition(definition)}


@router.get("/api/automations/definitions/{automation_id}")
async def get_automation_definition(
    automation_id: str,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    return {"item": automation_definitions.serialize_definition(definition)}


@router.put("/api/automations/definitions/{automation_id}")
async def replace_automation_definition(
    automation_id: str,
    data: AutomationDefinitionReplaceBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    try:
        definition = automation_definitions.replace_definition(
            db,
            definition,
            actor=_actor_for_user(current_user),
            source_yaml=data.source_yaml,
            expected_revision=data.expected_revision,
        )
    except automation_definitions.AutomationValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "updated", "item": automation_definitions.serialize_definition(definition)}


@router.post("/api/automations/definitions/{automation_id}/enable")
async def enable_automation_definition(
    automation_id: str,
    data: AutomationDefinitionToggleBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    definition = automation_definitions.set_enabled(db, definition, _actor_for_user(current_user), True, data.expected_revision)
    return {"status": "enabled", "item": automation_definitions.serialize_definition(definition)}


@router.post("/api/automations/definitions/{automation_id}/disable")
async def disable_automation_definition(
    automation_id: str,
    data: AutomationDefinitionToggleBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    definition = automation_definitions.set_enabled(db, definition, _actor_for_user(current_user), False, data.expected_revision)
    return {"status": "disabled", "item": automation_definitions.serialize_definition(definition)}


@router.post("/api/automations/definitions/{automation_id}/run")
async def run_automation_definition(
    automation_id: str,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    await asyncio.to_thread(automation_definitions.execute_automation_definition, definition.id, "manual")
    refreshed = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    history = automation_definitions.list_history(db, refreshed, limit=1)
    return {"status": "queued", "item": automation_definitions.serialize_definition(refreshed), "last_run": history[0] if history else None}


@router.post("/api/automations/definitions/{automation_id}/test")
async def test_automation_definition(
    automation_id: str,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Dry-run / simulate. Evaluates conditions and walks the action sequence
    but suppresses every side-effecting branch (service / scene / notify /
    skill / delay / wait_template). Returns the full trace so the editor can
    show what *would* happen without touching devices, scheduler or DB run
    history."""
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    result = await asyncio.to_thread(
        automation_definitions.execute_automation_definition, definition.id, "manual", True
    )
    return {"status": "ok", "result": result or {"status": "error", "error": "no result"}}


@router.get("/api/automations/definitions/{automation_id}/history")
async def get_automation_definition_history(
    automation_id: str,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    return {"items": automation_definitions.list_history(db, definition)}


@router.delete("/api/automations/definitions/{automation_id}")
async def delete_automation_definition(
    automation_id: str,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    definition = automation_definitions.get_definition_for_owner(db, automation_id, _owner_id_for_user(current_user))
    automation_definitions.delete_definition(db, definition)
    return {"status": "deleted"}


# --------------------------------------------------------------------------- #
# Blueprints                                                                  #
# --------------------------------------------------------------------------- #


class BlueprintCreateBody(BaseModel):
    source_yaml: str = Field(..., min_length=1)


class BlueprintInstantiateBody(BaseModel):
    inputs: dict = Field(default_factory=dict)


@router.get("/api/automations/blueprints")
async def list_blueprints(
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    items = bp_engine.list_blueprints(db, _owner_id_for_user(current_user))
    return {"items": [bp_engine.serialize_blueprint(item) for item in items]}


@router.post("/api/automations/blueprints")
async def create_blueprint(
    data: BlueprintCreateBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        bp = bp_engine.create_blueprint(
            db, _owner_id_for_user(current_user), _actor_for_user(current_user), data.source_yaml
        )
    except automation_definitions.AutomationValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "created", "item": bp_engine.serialize_blueprint(bp)}


@router.get("/api/automations/blueprints/{blueprint_id}")
async def get_blueprint(
    blueprint_id: str,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        bp = bp_engine.get_blueprint_for_owner(db, blueprint_id, _owner_id_for_user(current_user))
    except automation_definitions.AutomationValidationError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"item": bp_engine.serialize_blueprint(bp)}


@router.delete("/api/automations/blueprints/{blueprint_id}")
async def delete_blueprint_endpoint(
    blueprint_id: str,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    try:
        bp = bp_engine.get_blueprint_for_owner(db, blueprint_id, _owner_id_for_user(current_user))
    except automation_definitions.AutomationValidationError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    bp_engine.delete_blueprint(db, bp)
    return {"status": "deleted"}


@router.post("/api/automations/blueprints/{blueprint_id}/instantiate")
async def instantiate_blueprint(
    blueprint_id: str,
    data: BlueprintInstantiateBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Render a blueprint with the supplied inputs and create a new
    AutomationDefinition. Returns the created definition."""
    try:
        bp = bp_engine.get_blueprint_for_owner(db, blueprint_id, _owner_id_for_user(current_user))
        result = bp_engine.instantiate_blueprint(bp.source_yaml, data.inputs)
        definition = automation_definitions.create_definition(
            db,
            owner_id=_owner_id_for_user(current_user),
            actor=_actor_for_user(current_user),
            source_yaml=result["automation_yaml"],
        )
    except automation_definitions.AutomationValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "created", "item": automation_definitions.serialize_definition(definition)}
