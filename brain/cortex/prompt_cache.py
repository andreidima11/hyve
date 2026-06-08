from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import settings as settings_mod
from integrations import entry_settings
from logger import log_line

_CORTEX_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_UNTRUSTED_SOURCE_TOOL_NAMES = {
    "search_web",
    "search_web_images",
    "read_web_page",
    "extract_web_data",
    "cctv_describe",
}


class _PromptCache:
    """LRU cache for the static prefix of the system prompt AND the tools array."""

    _MAX = 4

    def __init__(self):
        self._cache: OrderedDict = OrderedDict()
        self._hits = 0
        self._misses = 0

    def invalidate(self):
        self._cache.clear()

    def get(self, fp: str) -> Optional[Dict]:
        if fp in self._cache:
            self._hits += 1
            self._cache.move_to_end(fp)
            return self._cache[fp]
        self._misses += 1
        return None

    def put(self, fp: str, data: dict):
        self._cache[fp] = data
        self._cache.move_to_end(fp)
        while len(self._cache) > self._MAX:
            self._cache.popitem(last=False)

    @property
    def stats(self) -> str:
        total = self._hits + self._misses
        rate = (self._hits / total * 100) if total > 0 else 0
        return f"hits={self._hits} misses={self._misses} rate={rate:.0f}%"


_prompt_cache = _PromptCache()


def invalidate_prompt_cache():
    """Force rebuild of cached system prompt + tools on next request."""
    _prompt_cache.invalidate()
    log_line("agent", "🗑️", "PROMPT CACHE", "Invalidated")


_PROMPT_CACHE_PROMPT_KEYS = (
    "system_persona",
    "agent_instructions",
    "agent_instructions_fallback",
    "agent_instruction_overrides",
    "agent_principles",
    "app_capabilities",
    "search_web_single_message_instruction",
    "web_content_reply_instruction",
)


def _prompt_cache_config_snapshot() -> dict:
    """Subset of CFG that affects the cached static system prompt + tools list."""
    cfg = settings_mod.CFG
    prompts = cfg.get("prompts") or {}
    intel = cfg.get("intelligence") or {}
    sec = cfg.get("security") or {}
    return {
        "prompts": {k: prompts.get(k) for k in _PROMPT_CACHE_PROMPT_KEYS},
        "active_persona": cfg.get("active_persona"),
        "personas": cfg.get("personas"),
        "lazy_history": intel.get("lazy_history"),
        "lazy_history_keep": intel.get("lazy_history_keep"),
        "search_use_conversation_context": intel.get("search_use_conversation_context"),
        "skills_disabled": cfg.get("skills_disabled") or [],
        "tools": {
            "searxng_enabled": bool(entry_settings.searxng_settings()),
            "searxng_url": (entry_settings.searxng_settings().get("url") or ""),
            "file_read": (intel.get("file_read") or {}).get("enabled", True),
            "run_script": (intel.get("run_script") or {}).get("enabled", False),
            "shell": (intel.get("shell") or {}).get("enabled", False),
            "propose_patch": (intel.get("propose_patch") or {}).get("enabled", True),
            "restrict_mutating": sec.get("restrict_mutating_tools_on_untrusted_content", True),
            "cctv": entry_settings.is_active("cctv"),
            "comfyui": entry_settings.is_active("comfyui"),
            "coder": bool(
                (cfg.get("coder") or {}).get("target_url", "").strip()
                or (cfg.get("llm") or {}).get("target_url", "").strip()
            ),
        },
    }


def _prompt_cache_fingerprint(user_id: str, persona_override: Optional[str]) -> str:
    h = hashlib.md5(usedforsecurity=False)
    h.update(f"v2|{user_id}|{persona_override or ''}|".encode())
    h.update(json.dumps(_prompt_cache_config_snapshot(), sort_keys=True, ensure_ascii=False).encode())
    try:
        h.update(f"|ha={os.path.getmtime(os.path.join(_CORTEX_ROOT, 'ha_entities.json')):.3f}".encode())
    except OSError:
        h.update(b"|ha=none")
    for d in (os.path.join(_CORTEX_ROOT, "skills"),
              os.path.join(_CORTEX_ROOT, "skills", "generated")):
        try:
            h.update(f"|{d}={os.path.getmtime(d):.3f}".encode())
        except OSError:
            pass
    return h.hexdigest()[:16]


def _filter_tools_for_untrusted_context(tools: List[Dict[str, Any]], safe_tool_names: set[str]) -> List[Dict[str, Any]]:
    return [t for t in (tools or []) if ((t.get("function") or {}).get("name") in safe_tool_names)]


def _tool_result_taints_context(tool_name: str, result: str) -> bool:
    text = result or ""
    if tool_name in _UNTRUSTED_SOURCE_TOOL_NAMES:
        local_only_prefixes = (
            "[SEARCH SKIPPED]",
            "Search limit reached",
            "Read-page limit reached",
            "Search error:",
            "Unknown tool:",
            "Error executing",
            "Error: Vision model",
            "Error: Camera",
            "Error: No frame",
            "Error: Could not capture",
            "Error: camera_id",
        )
        if any(text.startswith(prefix) for prefix in local_only_prefixes):
            return False
        return True
    return (
        "BEGIN UNTRUSTED DATA" in text
        or text.startswith("[Blocked suspicious external content")
        or "UNTRUSTED CONTENT from" in text
    )
