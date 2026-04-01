"""
CCTV camera management and vision API.
Handles camera listing and AI-based camera frame description.
"""
from fastapi import APIRouter, Depends
import settings
import models
import auth

router = APIRouter(tags=["cctv"])


@router.get("/api/cctv/cameras")
async def cctv_list_cameras(current_user: models.User = Depends(auth.get_current_user)):
    """List configured cameras (id, name) for automations."""
    cfg = settings.CFG.get("cctv") or {}
    if not cfg.get("enabled"):
        return []
    cameras = cfg.get("cameras") or []
    return [{"id": c.get("id") or "", "name": (c.get("name") or "").strip() or c.get("id") or "?"} for c in cameras]


@router.post("/api/cctv/cameras/{camera_id:path}/describe")
async def cctv_describe_camera(
    camera_id: str,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Describe what camera sees (RTSP frame + vision model). For automations / Node-RED / HA."""
    from core.tool_runtime import execute_tool
    result = await execute_tool("cctv_describe", {"camera_id": camera_id.strip()}, str(current_user.id))
    return {"description": result}
