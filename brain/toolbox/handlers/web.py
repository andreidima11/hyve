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

async def _exec_search_web(args: Dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return "Error: No search query provided."

    result, status_messages, sources = await searxng_search(query)
    set_last_search_sources(sources or [])
    if result:
        cutoff = (settings_mod.CFG.get("intelligence") or {}).get("knowledge_cutoff", "2024-01")
        raw = (
            f"Web search results for '{query}' (your knowledge cutoff: {cutoff}, use these results for current info):\n"
            f"{result}"
        )
        return _guard(raw, "web_search")
    else:
        return f"No web results found for '{query}'."


async def _exec_search_web_images(args: Dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return "Error: No search query provided for image search."
    result, _ = await searxng_search_images(query)
    if result:
        return _guard(result, "web_images")
    return f"No image results found for '{query}'. The SearXNG instance may not have image search enabled (categories=images)."


async def _exec_read_web_page(args: Dict) -> str:
    """Fetch a single URL and return its main text content. Works alongside search_web (e.g. search first, then read URLs)."""
    url = (args.get("url") or "").strip()
    if not url:
        return "Error: No URL provided."
    if not url.startswith("http://") and not url.startswith("https://"):
        return "Error: URL must start with http:// or https://."
    if _is_internal_url(url):
        log_line("agent", "🛡️", "SSRF_BLOCK", f"Blocked internal URL: {url[:80]}")
        return "Error: Cannot access internal/private network addresses for security reasons."
    _def = _searxng_defaults()
    searxng = settings_mod.CFG.get("searxng", {})
    max_chars_cfg = int(searxng.get("read_page_max_chars", _def.get("read_page_max_chars", 6000)))
    max_chars = int(args.get("max_chars") or 0) or max_chars_cfg
    max_chars = max(500, min(15000, max_chars))
    timeout = float(searxng.get("search_timeout", _def.get("search_timeout", 10)))
    log_line("ha", "📄", "READ_PAGE", f"Fetching: {url[:60]}...")
    text = await _fetch_page_text(url, max_chars=max_chars, timeout=timeout)
    if text:
        log_line("ha", "📄", "READ_PAGE", f"Got {len(text)} chars from {url[:50]}...")
        raw = f"Content from {url}:\n\n{text}"
        return _guard(raw, "web_page")
    log_line("error", "⚠️", "READ_PAGE", f"Failed or empty: {url[:50]}...")
    return f"Could not read page at {url} (failed, empty, or not text)."


async def _exec_extract_web_data(args: Dict) -> str:
    """Fetch a page and extract text or attributes for given CSS selectors."""
    url = (args.get("url") or "").strip()
    selectors = (args.get("selectors") or "").strip()
    attr = (args.get("attr") or "").strip() or None
    if not url:
        return "Error: No URL provided."
    if not url.startswith("http://") and not url.startswith("https://"):
        return "Error: URL must start with http:// or https://."
    if not selectors:
        return "Error: No selectors provided. Use comma-separated CSS selectors (e.g. h1, .price, #main)."
    _def = _searxng_defaults()
    searxng = settings_mod.CFG.get("searxng", {})
    timeout = float(searxng.get("search_timeout", _def.get("search_timeout", 10)))
    log_line("ha", "🔧", "EXTRACT_WEB", f"Fetching: {url[:50]}... selectors: {selectors[:60]}")
    html_raw = await _fetch_page_html(url, timeout=timeout)
    if not html_raw:
        return f"Could not fetch page at {url} (failed, empty, or too large)."
    ok, result = await asyncio.to_thread(_extract_by_selectors, html_raw, selectors, attr)
    if not ok:
        return str(result)
    lines = [f"Extracted from {url}:"]
    for item in result:
        sel = item.get("selector", "")
        err = item.get("error")
        matches = item.get("matches") or []
        if err:
            lines.append(f"  [{sel}]: error — {err}")
        elif matches:
            lines.append(f"  [{sel}]:")
            for m in matches:
                lines.append(f"    - {m}")
        else:
            lines.append(f"  [{sel}]: (no matches)")
    log_line("ha", "🔧", "EXTRACT_WEB", f"Got {sum(len(i.get('matches') or []) for i in result)} matches")
    return _guard("\n".join(lines), "web_extract")


