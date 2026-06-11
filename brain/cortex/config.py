"""Shared cortex configuration and session state."""

from __future__ import annotations

import asyncio
from typing import Any, Dict

import core.settings as settings_mod
from rich.console import Console

console = Console()
TIMEOUT_LLM = 120.0
CONTEXT_LOCK = asyncio.Lock()
USER_CONTEXT: Dict[str, Dict[str, Any]] = {}
DEFAULT_MAX_AGENT_TURNS = 6


def get_coder_cfg():
    """Coder for Forge (code generation). If URL/model not set, uses main AI model (llm)."""
    """Coder for Forge (code generation). If URL/model not set, uses main AI model (llm)."""
    c = settings_mod.CFG.get("coder") or {}
    llm = settings_mod.CFG.get("llm") or {}
    target = (c.get("target_url") or "").strip()
    model = (c.get("model_name") or "").strip()
    api_key = (c.get("api_key") or "").strip() or (llm.get("api_key") or "").strip()
    timeout = c.get("timeout")
    if timeout is not None:
        timeout = float(timeout)
    return {
        "target_url": target or llm.get("target_url", ""),
        "model_name": model or llm.get("model_name", ""),
        "api_key": api_key,
        "timeout": timeout,
    }
