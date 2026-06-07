from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import settings as settings_mod
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


def _prompt_cache_fingerprint(user_id: str, persona_override: Optional[str]) -> str:
    h = hashlib.md5(usedforsecurity=False)
    h.update(f"v1|{user_id}|{persona_override or ''}|".encode())
    h.update(json.dumps(settings_mod.CFG, sort_keys=True, ensure_ascii=False).encode())
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
