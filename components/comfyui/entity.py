"""ComfyUI — image generation service integration."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.base import BaseEntity
from integrations.component_import import import_sibling

_client_mod = import_sibling(Path(__file__).resolve().parent, "client")


class ComfyuiEntity(BaseEntity):
    slug = "comfyui"
    label = "ComfyUI"
    description = "Generare imagini prin ComfyUI (Stable Diffusion / Flux)."
    icon = "fa-palette"
    color = "text-fuchsia-400"
    supports_sync = False
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {"key": "url", "label": "Server URL", "type": "url", "default": "http://localhost:8188", "required": True},
        {"key": "default_checkpoint", "label": "Checkpoint implicit", "type": "text", "placeholder": "model.safetensors"},
        {"key": "default_steps", "label": "Steps", "type": "number", "default": 20, "min": 1, "max": 150},
        {"key": "default_cfg_scale", "label": "CFG scale", "type": "number", "default": 7, "min": 1, "max": 30},
        {"key": "default_width", "label": "Lățime", "type": "number", "default": 1024, "min": 256, "max": 2048},
        {"key": "default_height", "label": "Înălțime", "type": "number", "default": 1024, "min": 256, "max": 2048},
        {
            "key": "default_sampler",
            "label": "Sampler",
            "type": "select",
            "default": "euler",
            "options": [
                {"value": "euler", "label": "euler"},
                {"value": "euler_ancestral", "label": "euler_ancestral"},
                {"value": "dpmpp_2m", "label": "dpmpp_2m"},
            ],
        },
        {
            "key": "default_scheduler",
            "label": "Scheduler",
            "type": "select",
            "default": "normal",
            "options": [
                {"value": "normal", "label": "normal"},
                {"value": "karras", "label": "karras"},
            ],
        },
        {"key": "default_negative_prompt", "label": "Negative prompt", "type": "text", "default": "bad quality, blurry"},
        {"key": "timeout", "label": "Timeout (sec)", "type": "number", "default": 120, "min": 10, "max": 600},
        {"key": "workflow_file", "label": "Workflow (fișier în comfyui_workflows/)", "type": "text", "placeholder": "optional.json"},
    ]

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        url = str((data or {}).get("url") or "").strip()
        result = await _client_mod.test_connection(override_url=url or None)
        if result.get("ok"):
            return {"ok": True, "message": result.get("message") or "Conectat la ComfyUI."}
        return {"ok": False, "message": result.get("error") or result.get("message") or "Conexiune ComfyUI eșuată"}

    async def fetch_entities(self) -> dict[str, Any]:
        return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return []
