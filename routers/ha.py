"""Home Assistant API routes."""
from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, Field
from typing import List
import home_assistant
import models
import auth

router = APIRouter(prefix="/api/ha", tags=["home_assistant"])


class UpdateSelectionBody(BaseModel):
    entity_id: str
    selected: bool


class BulkSelectionBody(BaseModel):
    selected: bool = False


class UpdateAliasBody(BaseModel):
    entity_id: str
    aliases: List[str] = Field(default_factory=list)


class BulkDeleteBody(BaseModel):
    ids: List[str] = Field(default_factory=list)


class AddEntitiesBody(BaseModel):
    ids: List[str] = Field(default_factory=list, min_length=1)


def _log_line(style, icon, title, message=""):
    from main import log_line
    log_line(style, icon, title, message)


@router.get("/states")
async def ha_states(_: models.User = Depends(auth.get_current_user)):
    return await home_assistant.fetch_ha_states()


@router.get("/manage")
async def ha_get_managed_entities(_: models.User = Depends(auth.get_current_user)):
    return home_assistant.load_config()


@router.post("/update_selection")
async def ha_update_selection(data: UpdateSelectionBody, _: models.User = Depends(auth.get_current_user)):
    home_assistant.update_device_selection(data.entity_id, data.selected)
    try:
        from core.agent_engine import invalidate_prompt_cache
        invalidate_prompt_cache()
    except Exception:
        pass
    return {"status": "ok"}


@router.post("/bulk_selection")
async def ha_bulk_selection(data: BulkSelectionBody, _: models.User = Depends(auth.get_current_user)):
    """Set selected=true/false for all devices at once."""
    home_assistant.set_all_devices_selection(data.selected)
    try:
        from core.agent_engine import invalidate_prompt_cache
        invalidate_prompt_cache()
    except Exception:
        pass
    return {"status": "ok"}


@router.post("/update_alias")
async def ha_update_alias(data: UpdateAliasBody, _: models.User = Depends(auth.get_current_user)):
    home_assistant.update_device_alias(data.entity_id, data.aliases)
    return {"status": "ok"}


@router.post("/bulk_delete")
async def ha_bulk_delete(data: BulkDeleteBody, _: models.User = Depends(auth.get_current_admin)):
    home_assistant.remove_devices(data.ids)
    return {"status": "ok"}


@router.delete("/delete/{entity_id}")
async def ha_delete_entity(entity_id: str, _: models.User = Depends(auth.get_current_admin)):
    home_assistant.remove_devices([entity_id])
    return {"status": "ok"}


@router.post("/sync")
async def sync_ha_to_memory(background_tasks: BackgroundTasks, _: models.User = Depends(auth.get_current_user)):
    _log_line("ha_head", "🏠", "HA SYNC", "Full sync requested...")
    items = await home_assistant.sync_entities()
    _log_line("success", "✅", "HA SYNC", f"Synced {len(items)} devices.")
    try:
        from core.agent_engine import invalidate_prompt_cache
        invalidate_prompt_cache()
    except Exception:
        pass
    return {"status": "ok", "count": len(items)}


@router.get("/available")
async def ha_available_entities(_: models.User = Depends(auth.get_current_user)):
    """Return HA entities NOT yet in local config (for Add Devices picker)."""
    return await home_assistant.get_available_entities()


@router.post("/add")
async def ha_add_entities(data: AddEntitiesBody, _: models.User = Depends(auth.get_current_user)):
    """Add specific entities from HA to local config."""
    added = await home_assistant.add_entities(data.ids)
    _log_line("ha_head", "➕", "HA ADD", f"Added {added} devices selectively.")
    return {"status": "ok", "count": added}


class ToggleDeviceBody(BaseModel):
    entity_id: str


@router.post("/toggle")
async def ha_toggle_device(data: ToggleDeviceBody, _: models.User = Depends(auth.get_current_user)):
    _log_line("ha_head", "💡", "MANUAL", f"Toggle {data.entity_id}")
    return await home_assistant.call_service(data.entity_id.split('.')[0], "toggle", data.entity_id)
