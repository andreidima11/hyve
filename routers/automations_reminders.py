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
        "trigger_summary": automation_definitions.summarize_trigger_set(normalized.get("trigger") or []),
        "action_summary": automation_definitions.summarize_action_set(normalized.get("action") or []),
    }


@router.get("/api/automations/definitions")
async def list_automation_definitions(
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    items = automation_definitions.list_definitions(db, _owner_id_for_user(current_user))
    return {"items": [automation_definitions.serialize_definition(item) for item in items]}


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
