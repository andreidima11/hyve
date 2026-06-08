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

import automation_definitions
import database
import models
import settings as settings_mod
from logger import log_line, log_detail
from memory_context import get_memory_context
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

async def _exec_recall_memory(args: Dict, user_id: str) -> str:
    topic = (args.get("topic") or "").strip()
    if not topic:
        return "Error: No topic specified for memory recall."

    import asyncio
    facts = await asyncio.to_thread(get_memory_context, topic, "", user_id)
    if facts and facts.strip():
        return f"Memories about '{topic}':\n{facts}"
    else:
        return f"No memories found about '{topic}'."


async def _exec_store_memory(args: Dict, user_id: str) -> str:
    fact = (args.get("fact") or "").strip()
    if not fact:
        return "Error: No fact provided. Use the 'fact' parameter with a clear statement about the user (e.g. 'User likes Type O Negative')."
    log_line("mem", "🔧", "STORE_MEMORY", f"Tool called: {fact[:80]}{'…' if len(fact) > 80 else ''}")
    try:
        from brain.cortex import save_fact_from_agent
        out = await save_fact_from_agent(fact, user_id)
        log_line("mem", "🔧", "STORE_MEMORY", f"Result: {out[:60]}{'…' if len(out) > 60 else ''}")
        return out
    except Exception as e:
        log_line("error", "⚠️", "STORE_MEMORY", f"{type(e).__name__}: {e}")
        return f"Memory save failed: {type(e).__name__}."


