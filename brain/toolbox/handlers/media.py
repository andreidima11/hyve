from __future__ import annotations

import asyncio
import base64
import html
import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx
import yaml
from fastapi import HTTPException

import core.automation_definitions as automation_definitions
import core.database as database
import core.models as models
import core.settings as settings_mod
from core.logger import log_line, log_detail
from brain.memory_context import get_memory_context
from brain.injection_guard import sanitize_untrusted_content
from brain.tool_shell import (
    exec_allow_shell,
    exec_run_script,
    exec_run_shell,
    exec_suggest_shell,
    get_last_shell_run,
    get_last_suggest_shell,
)
from brain.tool_workspace import (
    apply_proposal,
    exec_propose_file,
    exec_propose_patch,
    exec_read_file,
    get_last_proposal,
    project_root,
)
from brain.web_search import (
    _extract_by_selectors,
    _extract_relevant_paragraphs,
    _fetch_page_html,
    _fetch_page_text,
    _is_internal_url,
    _searxng_defaults,
    clear_last_search_sources,
    get_last_search_sources,
    searxng_search,
    searxng_search_images,
    set_last_search_sources,
)
from brain.toolbox.guardrails import _guard, _is_explicit_skill_request, _tool_guardrails_enabled
from brain.toolbox.state import _lazy_history_store

async def _exec_cctv_describe(arguments: Dict[str, Any]) -> str:
    """Capture a frame from the given CCTV camera and return vision model description."""
    camera_id = (arguments.get("camera_id") or "").strip()
    if not camera_id:
        return "Error: camera_id is required."
    from integrations import entry_settings

    cameras = entry_settings.cctv_cameras()
    cam = None
    cid_lower = camera_id.lower()
    for c in cameras:
        c_id = (c.get("id") or "").strip().lower()
        c_name = (c.get("name") or "").strip().lower()
        if c_id == cid_lower or c_name == cid_lower or (c_name and cid_lower in c_name) or (c_id and cid_lower in c_id):
            cam = c
            break
    if not cam:
        names = ", ".join((c.get("name") or c.get("id") or "?") for c in cameras[:10])
        return f"Error: Camera '{camera_id}' not found. Available: {names or 'none'}."
    rtsp_url = (cam.get("rtsp_url") or "").strip()
    if not rtsp_url:
        return f"Error: Camera '{cam.get('name') or cam.get('id')}' has no RTSP URL configured."
    try:
        import core.cctv_capture as cctv_capture
        loop = asyncio.get_event_loop()
        frame_bytes = await loop.run_in_executor(None, cctv_capture.get_rtsp_frame, rtsp_url)
    except Exception as e:
        log_line("agent", "⚠️", "CCTV", f"Frame capture: {e}")
        return f"Error: Could not capture frame from camera (check RTSP URL and ffmpeg). {type(e).__name__}: {e}"
    if not frame_bytes:
        return "Error: No frame received from camera (stream unavailable or ffmpeg failed)."
    image_b64 = base64.b64encode(frame_bytes).decode("ascii")
    context_hint = (cam.get("context") or "").strip()
    base_instruction = (
        "CCTV frame. Reply in 1–3 short sentences. ALLOWED only: "
        "people present or 'nobody visible'; vehicles (type, color, where parked); lights on/off; doors/gates open or closed; movement or something out of place. "
        "FORBIDDEN: do not mention plants, trees, shrubs, garden, fence, trash bin, stones, pavement, alley surface, sky, decoration, or any static background. "
        "Example: 'Nobody visible. Two black cars parked in front. Outside lights on.'"
    )
    if context_hint:
        prompt = (
            "Expected: " + context_hint + ". "
            + base_instruction
            + " If something doesn't match, add: 'Unusual: ...'"
        )
    else:
        prompt = base_instruction
    try:
        from brain.cortex import _describe_image_with_vision_llm
        description = await _describe_image_with_vision_llm(image_b64, prompt)
    except Exception as e:
        log_line("agent", "⚠️", "CCTV", f"Vision: {e}")
        return f"Error: Vision model failed. {type(e).__name__}: {e}"
    if not description:
        vision_cfg = settings_mod.CFG.get("vision_llm") or {}
        has_vision = (vision_cfg.get("target_url") or "").strip() and (vision_cfg.get("model_name") or "").strip()
        if not has_vision:
            return "Error: Vision model returned no description (no vision_llm configured; main LLM may not support images — set a vision_llm in Settings › AI Models)."
        return "Error: Vision model returned no description."
    name = cam.get("name") or cam.get("id") or "Camera"
    return f"[{name}]\n{description}"


async def _exec_generate_image(arguments: Dict[str, Any]) -> str:
    """Generate an image using ComfyUI and return a markdown image link."""
    from integrations.component_import import load_component_module

    comfyui = load_component_module("comfyui", "client")

    prompt_text = (arguments.get("prompt") or "").strip()
    if not prompt_text:
        return "Error: No prompt provided for image generation."

    negative = (arguments.get("negative_prompt") or "").strip()
    width = int(arguments.get("width") or 0)
    height = int(arguments.get("height") or 0)
    steps = int(arguments.get("steps") or 0)

    try:
        image_url, metadata = await comfyui.generate_image(
            prompt=prompt_text,
            negative_prompt=negative,
            width=width,
            height=height,
            steps=steps,
        )
        return (
            f"Image generated successfully.\n"
            f"![Generated Image]({image_url})\n"
            f"URL: {image_url}"
        )
    except Exception as e:
        log_line("error", "⚠️", "COMFYUI", f"Generation failed: {type(e).__name__}: {e}")
        return f"Error generating image: {type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# Planner tool implementations
# ---------------------------------------------------------------------------

