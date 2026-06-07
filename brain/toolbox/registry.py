from __future__ import annotations

import os
from typing import Dict, List

import settings as settings_mod
from logger import log_line
from brain.tool_shell import _shell_config
from brain.toolbox.definitions import *  # noqa: F401,F403 — tool constants used in builder

# Cache for tool list (invalidated when config changes)
_tools_cache: dict = {"fingerprint": "", "tools": [], "tools_anon": []}


def _tools_fingerprint() -> str:
    """Cheap fingerprint for tool-affecting config sections."""
    cfg = settings_mod.CFG
    parts = [
        str(cfg.get("searxng", {}).get("enabled")),
        str(cfg.get("searxng", {}).get("url", "")),
        str((cfg.get("intelligence") or {}).get("lazy_history", True)),
        str((cfg.get("intelligence") or {}).get("file_read", {}).get("enabled", True)),
        str((cfg.get("intelligence") or {}).get("run_script", {}).get("enabled", True)),
        str((cfg.get("intelligence") or {}).get("propose_patch", {}).get("enabled", True)),
        str((cfg.get("security") or {}).get("restrict_mutating_tools_on_untrusted_content", True)),
        str(cfg.get("skills_disabled") or []),
        str(bool((cfg.get("cctv") or {}).get("enabled"))),
        str(bool((cfg.get("comfyui") or {}).get("enabled"))),
        str(bool((cfg.get("coder") or {}).get("target_url", "").strip()
                  or (cfg.get("llm") or {}).get("target_url", "").strip())),
        # Device list mtime (changes when user toggles devices)
        str(_device_list_mtime()),
    ]
    return "|".join(parts)


def _device_list_mtime() -> float:
    try:
        return os.path.getmtime("ha_entities.json")
    except OSError:
        return 0.0


def get_available_tools(user_id: str, is_anonymous: bool = False) -> List[Dict]:
    """Build the tools array based on what is currently enabled. Descriptions may be dynamic (e.g. device count).
    When is_anonymous=True, dangerous tools (shell, HA control, file ops, forge) are excluded.
    Results are cached and invalidated when config changes."""
    fp = _tools_fingerprint()
    cache_key = "tools_anon" if is_anonymous else "tools"
    if _tools_cache["fingerprint"] == fp and _tools_cache[cache_key]:
        return list(_tools_cache[cache_key])  # shallow copy
    tools = _build_tools_list(is_anonymous)
    _tools_cache["fingerprint"] = fp
    _tools_cache[cache_key] = tools
    return list(tools)


def _build_tools_list(is_anonymous: bool) -> List[Dict]:
    """Build the tools array (uncached inner function)."""
    tools = []
    cfg = settings_mod.CFG

    if not is_anonymous:
        tools.append(TOOL_VALIDATE_AUTOMATION_YAML)
        tools.append(TOOL_LIST_AUTOMATION_DEFINITIONS)
        tools.append(TOOL_GET_AUTOMATION_DEFINITION)
        tools.append(TOOL_CREATE_AUTOMATION_DEFINITION)
        tools.append(TOOL_UPDATE_AUTOMATION_DEFINITION)
        tools.append(TOOL_ENABLE_AUTOMATION_DEFINITION)
        tools.append(TOOL_DISABLE_AUTOMATION_DEFINITION)
        tools.append(TOOL_DELETE_AUTOMATION_DEFINITION)
        tools.append(TOOL_RUN_AUTOMATION_DEFINITION)

    # Smart home control tools (when integrations exist; never for anon)
    if not is_anonymous:
        tools.append(TOOL_CONTROL_DEVICE)
        tools.append(TOOL_GET_HOME_STATUS)
        tools.append(TOOL_GET_ENTITY_HISTORY)
        tools.append(TOOL_GET_DEVICE_STATE)

    # Planner tools (always available)
    tools.append(TOOL_PLANNER_ADD_LIST)
    tools.append(TOOL_PLANNER_LIST_LISTS)
    tools.append(TOOL_PLANNER_DELETE_LIST)
    tools.append(TOOL_PLANNER_ADD_ENTRY)
    tools.append(TOOL_PLANNER_UPDATE_ENTRY)
    tools.append(TOOL_PLANNER_LIST_ENTRIES)
    tools.append(TOOL_PLANNER_COMPLETE_ENTRY)
    tools.append(TOOL_PLANNER_DELETE_ENTRY)

    # Web search + read page + extract by selectors (when SearXNG/web is enabled)
    if cfg.get("searxng", {}).get("enabled") and cfg.get("searxng", {}).get("url"):
        tools.append(TOOL_SEARCH_WEB)
        tools.append(TOOL_SEARCH_WEB_IMAGES)
        tools.append(TOOL_READ_WEB_PAGE)
        tools.append(TOOL_EXTRACT_WEB_DATA)

    # Memory recall and store (always available – user memory about preferences/facts)
    tools.append(TOOL_RECALL_MEMORY)
    tools.append(TOOL_STORE_MEMORY)

    # App help + system status (always available — read-only introspection)
    tools.append(TOOL_GET_APP_HELP)
    tools.append(TOOL_GET_SYSTEM_STATUS)

    # Conversation history tool (only in lazy_history mode)
    intel = cfg.get("intelligence") or {}
    if intel.get("lazy_history", True):
        tools.append(TOOL_GET_CONVERSATION_HISTORY)

    # Skills
    try:
        from skills import get_skill_registry
        skill_list = get_skill_registry()
        disabled = cfg.get("skills_disabled") or []
        active_skills = [s for s in skill_list if s["name"] not in disabled]
        if active_skills:
            tools.append(TOOL_RUN_SKILL)
    except Exception as e:
        log_line("error", "⚠️", "TOOLS", f"Skill registry error: {e}")

    # Shell (allow_shell + run_shell + suggest_shell) — only when enabled in config; never for anon
    if not is_anonymous and _shell_config().get("enabled", True):
        tools.append(TOOL_ALLOW_SHELL)
        tools.append(TOOL_RUN_SHELL)
        tools.append(TOOL_SUGGEST_SHELL)

    # read_file (when enabled)
    fr_cfg = (cfg.get("intelligence") or {}).get("file_read") or {}
    if fr_cfg.get("enabled", True):
        tools.append(TOOL_READ_FILE)

    # run_script (when enabled; same permission as shell; never for anon)
    rs_cfg = (cfg.get("intelligence") or {}).get("run_script") or {}
    if not is_anonymous and rs_cfg.get("enabled", True) and _shell_config().get("enabled", True):
        tools.append(TOOL_RUN_SCRIPT)

    # propose_patch / propose_file (when enabled; never for anon)
    pp_cfg = (cfg.get("intelligence") or {}).get("propose_patch") or {}
    if not is_anonymous and pp_cfg.get("enabled", True):
        tools.append(TOOL_PROPOSE_PATCH)
        tools.append(TOOL_PROPOSE_FILE)

    # CCTV (when enabled, vision_llm OR main llm configured, and at least one camera)
    cctv_cfg = cfg.get("cctv") or {}
    vision_cfg = cfg.get("vision_llm") or {}
    llm_cfg_cctv = cfg.get("llm") or {}
    has_vision = bool((vision_cfg.get("target_url") or "").strip() and (vision_cfg.get("model_name") or "").strip())
    has_main_llm = bool((llm_cfg_cctv.get("target_url") or "").strip())
    if cctv_cfg.get("enabled") and (has_vision or has_main_llm):
        cameras = cctv_cfg.get("cameras") or []
        if cameras:
            from copy import deepcopy
            cctv_tool = deepcopy(TOOL_CCTV_DESCRIBE)
            cam_list = ", ".join(f"'{c.get('id') or c.get('name') or '?'}' ({c.get('name', '')})" for c in cameras[:20])
            cctv_tool["function"]["description"] = (
                (cctv_tool["function"].get("description") or "").rstrip(". ")
                + f" Available cameras: {cam_list}."
            )
            tools.append(cctv_tool)

    # ComfyUI image generation (when enabled)
    comfyui_cfg = cfg.get("comfyui") or {}
    if comfyui_cfg.get("enabled") and (comfyui_cfg.get("url") or "").strip():
        tools.append(TOOL_GENERATE_IMAGE)

    # Pago Plătește (bills, vehicles, payments — when enabled)
    pago_cfg = cfg.get("pago") or {}
    if pago_cfg.get("enabled") and (pago_cfg.get("email") or "").strip():
        tools.append(TOOL_GET_PAGO_DATA)

    # Forge (skill creation, edit, improve; never for anon)
    coder = cfg.get("coder") or {}
    llm = cfg.get("llm") or {}
    if not is_anonymous and ((coder.get("target_url") or "").strip() or (llm.get("target_url") or "").strip()):
        tools.append(TOOL_CREATE_SKILL)
        tools.append(TOOL_EDIT_SKILL)
        tools.append(TOOL_IMPROVE_SKILL)

    return tools


def get_skills_list_text() -> str:
    """Return a compact skills list for the system prompt."""
    try:
        from skills import get_skill_registry
        skill_list = get_skill_registry()
        disabled = settings_mod.CFG.get("skills_disabled") or []
        active = [s for s in skill_list if s["name"] not in disabled]
        if active:
            return "\n".join(f"- {s['name']}: {s['description']}" for s in active)
    except Exception as e:
        log_line("warn", "⚠️", "SKILLS", f"get_skill_registry failed: {e}")
    return "None available."

