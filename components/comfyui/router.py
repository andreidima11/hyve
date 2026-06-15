"""ComfyUI HTTP API — capability router."""

from __future__ import annotations

import json
import os
from typing import Optional

from fastapi import APIRouter, Depends, File, Query, UploadFile

import core.auth as auth
import core.models as models
from integrations.component_import import load_component_module

comfyui = load_component_module("comfyui", "client")

router = APIRouter(tags=["comfyui"])


@router.get("/api/comfyui/test")
async def comfyui_test(
    url: Optional[str] = Query(None, description="ComfyUI server URL to test"),
    _: models.User = Depends(auth.get_current_admin),
):
    return await comfyui.test_connection(override_url=url)


@router.get("/api/comfyui/checkpoints")
async def comfyui_checkpoints(
    url: Optional[str] = Query(None),
    _: models.User = Depends(auth.get_current_admin),
):
    ckpts = await comfyui.get_checkpoints(override_url=url)
    return {"checkpoints": ckpts}


@router.get("/api/comfyui/samplers")
async def comfyui_samplers(
    url: Optional[str] = Query(None),
    _: models.User = Depends(auth.get_current_admin),
):
    return await comfyui.get_samplers(override_url=url)


@router.get("/api/comfyui/workflows")
async def comfyui_workflows(_: models.User = Depends(auth.get_current_admin)):
    workflows = comfyui._get_workflow_list()
    return {"workflows": workflows}


@router.post("/api/comfyui/workflows/upload")
async def comfyui_upload_workflow(
    file: UploadFile = File(...),
    _: models.User = Depends(auth.get_current_admin),
):
    content = await file.read()
    try:
        workflow_data = json.loads(content)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"Invalid JSON: {exc}"}

    if not isinstance(workflow_data, dict) or not any(
        isinstance(v, dict) and "class_type" in v for v in workflow_data.values()
    ):
        return {
            "ok": False,
            "error": "This doesn't look like a ComfyUI API-format workflow. "
            "Make sure you export using 'Save (API Format)' in ComfyUI, not the regular Save.",
        }

    fname = file.filename or "workflow.json"
    if not fname.endswith(".json"):
        fname += ".json"
    fname = "".join(c for c in fname if c.isalnum() or c in "._- ").strip()
    fpath = os.path.join(comfyui.WORKFLOWS_DIR, fname)
    with open(fpath, "w", encoding="utf-8") as handle:
        json.dump(workflow_data, handle, indent=2)

    return {"ok": True, "file": fname, "path": fpath}
