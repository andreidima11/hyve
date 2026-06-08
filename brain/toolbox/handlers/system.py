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

def _exec_get_app_help(args: Dict) -> str:
    """Look up Hyve UI navigation / capabilities on demand."""
    topic = (args.get("topic") or "").strip()
    try:
        from brain.app_capabilities import get_app_help
        out = get_app_help(topic)
        log_line("agent", "🔧", "APP_HELP", f"topic={topic or '(index)'} → {len(out)} chars")
        return out
    except Exception as e:
        log_line("error", "⚠️", "APP_HELP", f"{type(e).__name__}: {e}")
        return f"App help lookup failed: {type(e).__name__}."


def _exec_get_system_status(args: Dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return "Error: query is required (try 'overview')."
    try:
        from brain.app_capabilities import get_system_status
        out = get_system_status(
            query,
            slug=args.get("slug"),
            source=args.get("source"),
            domain=args.get("domain"),
            limit=args.get("limit"),
        )
        log_line("agent", "🔧", "SYSTEM_STATUS", f"query={query} → {len(out)} chars")
        return out
    except Exception as e:
        log_line("error", "⚠️", "SYSTEM_STATUS", f"{type(e).__name__}: {e}")
        return f"System status lookup failed: {type(e).__name__}."


def _exec_get_conversation_history(args: Dict, user_id: str) -> str:
    """Return earlier conversation messages from lazy history buffer."""
    last_n = min(int(args.get("last_n") or 10), 30)
    full_history = _lazy_history_store.get(user_id, [])
    if not full_history:
        return "No earlier conversation history available. This appears to be a new conversation or the beginning of the session."

    # Format messages cleanly — skip tool/system noise
    lines = []
    for msg in full_history[-last_n:]:
        role = msg.get("role", "")
        content = (msg.get("content") or "").strip()
        if role == "system" or role == "tool":
            continue
        if not content:
            continue
        if role == "user":
            lines.append(f"User: {content[:500]}")
        elif role == "assistant":
            from brain.cortex import strip_think
            clean = strip_think(content)
            if clean:
                lines.append(f"Assistant: {clean[:500]}")

    if not lines:
        return "No meaningful earlier messages found."

    header = f"Earlier conversation ({len(lines)} messages):"
    return header + "\n" + "\n".join(lines)

