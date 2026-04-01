"""ComfyUI API router — test connection, list checkpoints, list samplers, workflows."""

import json
import os
from typing import Optional
from fastapi import APIRouter, Depends, Query, UploadFile, File
import auth
import models

router = APIRouter()


@router.get("/api/comfyui/test")
async def comfyui_test(
    url: Optional[str] = Query(None, description="ComfyUI server URL to test"),
    _: models.User = Depends(auth.get_current_admin),
):
    import comfyui
    result = await comfyui.test_connection(override_url=url)
    return result


@router.get("/api/comfyui/checkpoints")
async def comfyui_checkpoints(
    url: Optional[str] = Query(None),
    _: models.User = Depends(auth.get_current_admin),
):
    import comfyui
    ckpts = await comfyui.get_checkpoints(override_url=url)
    return {"checkpoints": ckpts}


@router.get("/api/comfyui/samplers")
async def comfyui_samplers(
    url: Optional[str] = Query(None),
    _: models.User = Depends(auth.get_current_admin),
):
    import comfyui
    data = await comfyui.get_samplers(override_url=url)
    return data


@router.get("/api/comfyui/workflows")
async def comfyui_workflows(_: models.User = Depends(auth.get_current_admin)):
    """List available workflow template files from comfyui_workflows/ directory."""
    import comfyui
    workflows = comfyui._get_workflow_list()
    return {"workflows": workflows}


@router.post("/api/comfyui/workflows/upload")
async def comfyui_upload_workflow(
    file: UploadFile = File(...),
    _: models.User = Depends(auth.get_current_admin),
):
    """Upload a ComfyUI workflow JSON file as a template."""
    import comfyui

    content = await file.read()
    try:
        workflow_data = json.loads(content)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"Invalid JSON: {e}"}

    # Validate it has node-like structure
    if not isinstance(workflow_data, dict) or not any(
        isinstance(v, dict) and "class_type" in v for v in workflow_data.values()
    ):
        return {"ok": False, "error": "This doesn't look like a ComfyUI API-format workflow. "
                "Make sure you export using 'Save (API Format)' in ComfyUI, not the regular Save."}

    # Save to workflows dir
    fname = file.filename or "workflow.json"
    if not fname.endswith(".json"):
        fname += ".json"
    # Sanitize filename
    fname = "".join(c for c in fname if c.isalnum() or c in "._- ").strip()
    fpath = os.path.join(comfyui.WORKFLOWS_DIR, fname)
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(workflow_data, f, indent=2)

    return {"ok": True, "file": fname, "path": fpath}
