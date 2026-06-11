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

async def _exec_run_skill(args: Dict, user_id: str) -> str:
    skill_name = (args.get("skill_name") or "").strip()
    if not skill_name:
        return "Error: No skill name specified."

    skill_input = dict(args.get("input") or {})
    if isinstance(args.get("input"), str):
        skill_input = {"query": args.get("input")}
    # Inject SearXNG URL as plain data so sandboxed skills can use urllib for web search
    allow_network = False
    from integrations import entry_settings

    searxng = entry_settings.searxng_settings()
    if searxng.get("url"):
        skill_input["_searxng_url"] = searxng["url"].strip()
        allow_network = True

    # Check if skill exists and is enabled
    try:
        from skills import get_skill_registry
        available = [s["name"] for s in get_skill_registry()]
    except Exception:
        available = []

    if skill_name not in available:
        return f"Error: Skill '{skill_name}' not found. Available skills: {', '.join(available) if available else 'none'}."

    disabled = settings_mod.CFG.get("skills_disabled") or []
    if skill_name in disabled:
        return f"Error: Skill '{skill_name}' is currently disabled."

    try:
        import asyncio
        import skills as skills_mod
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: skills_mod.run_skill(skill_name, skill_input, allow_network=allow_network),
        )
        msg = result.get("message", "")
        data = result.get("data") or {}
        success = result.get("success", False)

        # Format data nicely if it has results
        if isinstance(data, dict) and data.get("results"):
            results_preview = data["results"][:8]
            parts = []
            for i, r in enumerate(results_preview, 1):
                title = (r.get("title") or r.get("url") or "")[:100]
                content = (r.get("content") or r.get("snippet") or "").strip()[:400]
                url = (r.get("url") or "")[:80]
                line = f"[{i}] {title}"
                if content:
                    line += f" — {content}"
                if url:
                    line += f" (URL: {url})"
                parts.append(line)
            data_text = "\n".join(parts)
            return _guard(f"Skill '{skill_name}' result: {msg}\n{data_text}", "skill_output")
        elif data:
            return _guard(f"Skill '{skill_name}' result: {msg}. Data: {json.dumps(data, ensure_ascii=False)[:800]}", "skill_output")
        else:
            return f"Skill '{skill_name}': {'success' if success else 'failed'}. {msg}"
    except Exception as e:
        return f"Error running skill '{skill_name}': {type(e).__name__}: {e}"


async def _exec_create_skill(args: Dict, status_queue: Optional[Any] = None) -> str:
    description = (args.get("description") or "").strip()
    if not description or len(description) < 3:
        return "Error: Skill description too short. Describe what the skill should do."

    name_hint = (args.get("name_hint") or "").strip() or None
    inputs_hint = (args.get("inputs_hint") or "").strip() or None
    allow_network = bool(args.get("allow_network"))

    def _status_cb(t: str, label: str) -> None:
        if status_queue is not None:
            try:
                status_queue.put_nowait({"t": "status", "type": t, "label": label})
            except Exception:
                pass  # queue full; non-critical UI status drop

    last_preview_sent = ""
    last_preview_at = 0.0

    def _preview_cb(code: str, done: bool = False) -> None:
        nonlocal last_preview_sent, last_preview_at
        if status_queue is None:
            return
        code = code or ""
        now = time.monotonic()
        grew_by = len(code) - len(last_preview_sent)
        if not done and code == last_preview_sent:
            return
        if not done and grew_by < 16 and (now - last_preview_at) < 0.08:
            return
        last_preview_sent = code
        last_preview_at = now
        try:
            status_queue.put_nowait({"t": "forge_preview", "language": "python", "content": code, "done": done})
        except Exception:
            pass  # queue full; non-critical streaming preview drop

    try:
        from integrations.component_import import load_component_module

        forge_mod = load_component_module("forge", "pipeline")
        ok, msg, _ = await forge_mod.run_forge(
            description, save=True,
            name_hint=name_hint, inputs_hint=inputs_hint, allow_network=allow_network,
            status_callback=_status_cb,
            preview_callback=_preview_cb,
        )
        if ok:
            try:
                from brain.cortex import invalidate_prompt_cache
                invalidate_prompt_cache()
            except Exception as e:
                log_line("warn", "⚠️", "FORGE", f"Cache invalidation failed after forge: {e}")
        return msg if msg else ("Skill created successfully." if ok else "Forge failed to create the skill.")
    except Exception as e:
        return f"Error creating skill: {type(e).__name__}: {e}"


async def _exec_edit_skill(args: Dict) -> str:
    skill_name = (args.get("skill_name") or "").strip()
    instruction = (args.get("instruction") or "").strip()
    if not skill_name or not instruction:
        return "Error: edit_skill requires skill_name and instruction."
    try:
        from integrations.component_import import load_component_module

        forge_mod = load_component_module("forge", "pipeline")
        ok, msg = await forge_mod.run_forge_edit(skill_name, instruction)
        if ok:
            try:
                from brain.cortex import invalidate_prompt_cache
                invalidate_prompt_cache()
            except Exception as e:
                log_line("warn", "⚠️", "FORGE", f"Cache invalidation failed after edit: {e}")
        return msg
    except Exception as e:
        return f"Error editing skill: {type(e).__name__}: {e}"


async def _exec_improve_skill(args: Dict) -> str:
    skill_name = (args.get("skill_name") or "").strip()
    error_message = (args.get("error_message") or "").strip()
    if not skill_name or not error_message:
        return "Error: improve_skill requires skill_name and error_message."
    try:
        from integrations.component_import import load_component_module

        forge_mod = load_component_module("forge", "pipeline")
        ok, msg = await forge_mod.run_forge_improve(skill_name, error_message)
        if ok:
            try:
                from brain.cortex import invalidate_prompt_cache
                invalidate_prompt_cache()
            except Exception as e:
                log_line("warn", "⚠️", "FORGE", f"Cache invalidation failed after improve: {e}")
        return msg
    except Exception as e:
        return f"Error improving skill: {type(e).__name__}: {e}"


