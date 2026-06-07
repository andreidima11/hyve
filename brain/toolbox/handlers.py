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

def _automation_owner_id(user_id: str) -> str:
    return str(user_id or "user_1")


def _automation_actor(user_id: str) -> str:
    return f"assistant:{user_id or 'unknown'}"



async def _exec_validate_automation_yaml(args: Dict) -> str:
    source_yaml = (args.get("source_yaml") or "").strip()
    if not source_yaml:
        return "Error: source_yaml is required."
    try:
        normalized = automation_definitions.validate_source_yaml(source_yaml)
    except automation_definitions.AutomationValidationError as exc:
        return f"Invalid automation YAML: {exc}"
    return (
        f"Valid automation YAML: id='{normalized['id']}', title='{normalized['title']}', "
        f"triggers={json.dumps(normalized.get('trigger') or [], ensure_ascii=False)}, "
        f"actions={json.dumps(normalized.get('action') or [], ensure_ascii=False)}"
    )


async def _exec_list_automation_definitions(user_id: str) -> str:
    db = database.SessionLocal()
    try:
        items = automation_definitions.list_definitions(db, _automation_owner_id(user_id))
        if not items:
            return "No automation definitions found."
        lines = []
        for index, item in enumerate(items, 1):
            serialized = automation_definitions.serialize_definition(item)
            next_run = serialized.get("next_runs") or []
            next_text = next_run[0].get("next_run_at") if next_run else "none"
            lines.append(
                f"{index}. [AutomationDefinition] {serialized['title']} — id: {serialized['id']}, revision: {serialized['revision']}, "
                f"enabled: {serialized['enabled']}, next_run: {next_text}, yaml: {serialized['yaml_path']}"
            )
        return "\n".join(lines)
    finally:
        db.close()


async def _exec_get_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        serialized = automation_definitions.serialize_definition(item)
        return json.dumps(serialized, ensure_ascii=False)
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_create_automation_definition(args: Dict, user_id: str) -> str:
    source_yaml = (args.get("source_yaml") or "").strip()
    if not source_yaml:
        return "Error: source_yaml is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.create_definition(
            db,
            owner_id=_automation_owner_id(user_id),
            actor=_automation_actor(user_id),
            source_yaml=source_yaml,
        )
        serialized = automation_definitions.serialize_definition(item)
        return f"Created automation definition '{serialized['id']}' revision={serialized['revision']} yaml='{serialized['yaml_path']}'"
    except automation_definitions.AutomationValidationError as exc:
        return f"Error: {exc}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_update_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    source_yaml = (args.get("source_yaml") or "").strip()
    expected_revision = args.get("expected_revision")
    if not automation_id or not source_yaml or expected_revision is None:
        return "Error: automation_id, source_yaml, and expected_revision are required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        updated = automation_definitions.replace_definition(
            db,
            item,
            actor=_automation_actor(user_id),
            source_yaml=source_yaml,
            expected_revision=int(expected_revision),
        )
        serialized = automation_definitions.serialize_definition(updated)
        return f"Updated automation definition '{serialized['id']}' to revision={serialized['revision']} yaml='{serialized['yaml_path']}'"
    except automation_definitions.AutomationValidationError as exc:
        return f"Error: {exc}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_enable_automation_definition(args: Dict, user_id: str) -> str:
    return await _exec_toggle_automation_definition(args, user_id, True)


async def _exec_disable_automation_definition(args: Dict, user_id: str) -> str:
    return await _exec_toggle_automation_definition(args, user_id, False)


async def _exec_toggle_automation_definition(args: Dict, user_id: str, enabled: bool) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    expected_revision = args.get("expected_revision")
    if not automation_id or expected_revision is None:
        return "Error: automation_id and expected_revision are required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        updated = automation_definitions.set_enabled(db, item, _automation_actor(user_id), enabled, int(expected_revision))
        serialized = automation_definitions.serialize_definition(updated)
        return f"Automation definition '{serialized['id']}' enabled={serialized['enabled']} revision={serialized['revision']}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_delete_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        automation_definitions.delete_definition(db, item)
        return f"Deleted automation definition '{automation_id}'."
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_run_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        await asyncio.to_thread(automation_definitions.execute_automation_definition, item.id, "manual")
        refreshed = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        history = automation_definitions.list_history(db, refreshed, limit=1)
        return f"Ran automation definition '{automation_id}'. Last run: {json.dumps(history[0] if history else {}, ensure_ascii=False)}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


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

async def _exec_run_skill(args: Dict, user_id: str) -> str:
    skill_name = (args.get("skill_name") or "").strip()
    if not skill_name:
        return "Error: No skill name specified."

    skill_input = dict(args.get("input") or {})
    if isinstance(args.get("input"), str):
        skill_input = {"query": args.get("input")}
    # Inject SearXNG URL as plain data so sandboxed skills can use urllib for web search
    allow_network = False
    searxng = settings_mod.CFG.get("searxng") or {}
    if searxng.get("enabled") and (searxng.get("url") or "").strip():
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
        import forge as forge_mod
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
        import forge as forge_mod
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
        import forge as forge_mod
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


async def _exec_cctv_describe(arguments: Dict[str, Any]) -> str:
    """Capture a frame from the given CCTV camera and return vision model description."""
    camera_id = (arguments.get("camera_id") or "").strip()
    if not camera_id:
        return "Error: camera_id is required."
    cctv_cfg = settings_mod.CFG.get("cctv") or {}
    cameras = cctv_cfg.get("cameras") or []
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
        import cctv_capture
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
    import comfyui

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

def _resolve_user(db, user_id: str):
    """Resolve brain user_id (e.g. 'user_1') to a User row."""
    if user_id and user_id.startswith("user_"):
        try:
            numeric_id = int(user_id.split("_", 1)[1])
            return db.query(models.User).filter(models.User.id == numeric_id).first()
        except (ValueError, IndexError):
            pass
    return db.query(models.User).filter(models.User.username == user_id).first()


def _planner_get_or_create_list(db, uid: int, list_name: str) -> models.TodoList:
    normalized = (list_name or "Inbox").strip()[:128] or "Inbox"
    todo_list = db.query(models.TodoList).filter(
        models.TodoList.user_id == uid,
        models.TodoList.title == normalized,
        models.TodoList.archived.is_(False),
    ).first()
    if todo_list:
        return todo_list
    todo_list = models.TodoList(user_id=uid, title=normalized)
    db.add(todo_list)
    db.flush()
    return todo_list


async def _exec_planner_add_list(args: Dict, user_id: str) -> str:
    title = (args.get("title") or "").strip()
    if not title:
        return "Error: title is required."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        existing = db.query(models.TodoList).filter(
            models.TodoList.user_id == user.id,
            models.TodoList.title == title,
            models.TodoList.archived.is_(False),
        ).first()
        if existing:
            return f"List already exists: '{existing.title}' (id={existing.id})."

        row = models.TodoList(
            user_id=user.id,
            title=title[:128],
            color=((args.get("color") or "").strip()[:64] or None),
            icon=((args.get("icon") or "").strip()[:64] or None),
            archived=False,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return f"Created list '{row.title}' (id={row.id})."
    finally:
        db.close()


async def _exec_planner_list_lists(args: Dict, user_id: str) -> str:
    include_archived = bool(args.get("include_archived", False))
    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        q = db.query(models.TodoList).filter(models.TodoList.user_id == user.id)
        if not include_archived:
            q = q.filter(models.TodoList.archived.is_(False))
        rows = q.order_by(models.TodoList.updated_at.desc()).all()
        if not rows:
            return "No planner lists found."

        lines = [f"- id={row.id} title='{row.title}'" + (" [archived]" if row.archived else "") for row in rows]
        return f"Found {len(rows)} list(s):\n" + "\n".join(lines)
    finally:
        db.close()


async def _exec_planner_delete_list(args: Dict, user_id: str) -> str:
    list_id = args.get("list_id")
    list_name = (args.get("list_name") or "").strip()
    if list_id is None and not list_name:
        return "Error: provide list_id or list_name."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        q = db.query(models.TodoList).filter(models.TodoList.user_id == user.id)
        if list_id is not None:
            q = q.filter(models.TodoList.id == int(list_id))
        else:
            q = q.filter(models.TodoList.title == list_name)
        row = q.first()
        if not row:
            return "Error: list not found."

        title = row.title
        db.delete(row)
        db.commit()
        return f"Deleted list '{title}' (id={row.id})."
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Smart Home tool implementations
# ---------------------------------------------------------------------------

async def _exec_control_device(args: Dict) -> str:
    entity_id = (args.get("entity_id") or "").strip()
    action = (args.get("action") or "").strip()
    data = args.get("data") if isinstance(args.get("data"), dict) else {}
    if not entity_id:
        return "Error: entity_id is required."
    if not action:
        return "Error: action is required (turn_on, turn_off, toggle, set)."

    from integrations import get_integration_manager
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    all_entities = store.get_all_entities()

    target_id = entity_id
    target_integration = None
    for ent in all_entities:
        if ent.get("entity_id") == entity_id or ent.get("unique_id") == entity_id:
            target_id = str(ent.get("unique_id") or entity_id)
            source = ent.get("source") or ""
            entry_id = ent.get("entry_id") or ""
            manager = get_integration_manager()
            if entry_id:
                target_integration = manager.get_by_entry(entry_id)
            if not target_integration and source:
                target_integration = manager.get(source)
            break

    if not target_integration:
        manager = get_integration_manager()
        for integration in manager.all():
            try:
                if hasattr(integration, "control_entity"):
                    target_integration = integration
                    break
            except Exception:
                continue
        if not target_integration:
            return f"Error: Could not find an integration that owns '{entity_id}'."

    try:
        result = await target_integration.control_entity(target_id, action, data)
        name = entity_id
        for ent in all_entities:
            if ent.get("entity_id") == entity_id:
                name = ent.get("name") or ent.get("attributes", {}).get("friendly_name") or entity_id
                break
        return f"OK: {action} on '{name}' ({entity_id}). Result: {result or 'success'}"
    except NotImplementedError:
        return f"Error: The integration does not support controlling '{entity_id}'."
    except Exception as exc:
        return f"Error controlling '{entity_id}': {type(exc).__name__}: {exc}"


async def _exec_get_home_status(args: Dict) -> str:
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    all_entities = store.get_all_entities()

    if not all_entities:
        return "No smart home devices found. Integrations may not be configured."

    by_area: Dict[str, list] = {}
    for ent in all_entities:
        area = ent.get("area") or ent.get("area_name") or "Unassigned"
        attrs = ent.get("attributes") or {}
        name = ent.get("name") or attrs.get("friendly_name") or ent.get("entity_id") or "?"
        state = ent.get("state") or "unknown"
        entry = {
            "entity_id": ent.get("entity_id") or ent.get("unique_id") or "?",
            "name": name,
            "state": state,
        }
        if attrs.get("brightness") is not None:
            entry["brightness"] = attrs["brightness"]
        if attrs.get("temperature") is not None:
            entry["temperature"] = attrs["temperature"]
        if attrs.get("current_temperature") is not None:
            entry["current_temperature"] = attrs["current_temperature"]
        if attrs.get("unit_of_measurement"):
            entry["unit"] = attrs["unit_of_measurement"]
        by_area.setdefault(area, []).append(entry)

    lines = []
    for area in sorted(by_area.keys()):
        lines.append(f"\n## {area}")
        for e in sorted(by_area[area], key=lambda x: x["name"]):
            extra = ""
            if "brightness" in e:
                extra += f", brightness={e['brightness']}"
            if "temperature" in e:
                extra += f", temp={e['temperature']}"
            if "current_temperature" in e:
                extra += f", current_temp={e['current_temperature']}"
            if "unit" in e:
                extra += f" {e['unit']}"
            lines.append(f"  - {e['name']} ({e['entity_id']}): {e['state']}{extra}")

    return f"Smart home status ({len(all_entities)} entities):\n" + "\n".join(lines)


async def _exec_get_device_state(args: Dict) -> str:
    entity_id = (args.get("entity_id") or "").strip()
    if not entity_id:
        return "Error: entity_id is required."
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    for ent in store.get_all_entities():
        eid = str(ent.get("entity_id") or ent.get("unique_id") or "")
        if eid != entity_id and ent.get("unique_id") != entity_id:
            continue
        attrs = ent.get("attributes") or {}
        name = ent.get("name") or attrs.get("friendly_name") or eid
        lines = [
            f"Entity: {name} ({eid})",
            f"State: {ent.get('state') or 'unknown'}",
            f"Domain: {eid.split('.', 1)[0] if '.' in eid else '?'}",
            f"Source: {ent.get('source') or '?'}",
        ]
        area = ent.get("area") or ent.get("area_name")
        if area:
            lines.append(f"Area: {area}")
        for key in ("brightness", "temperature", "current_temperature", "unit_of_measurement"):
            if attrs.get(key) is not None:
                lines.append(f"{key}: {attrs[key]}")
        return "\n".join(lines)
    return f"No entity found for '{entity_id}'."


async def _exec_get_entity_history(args: Dict) -> str:
    entity_id = (args.get("entity_id") or "").strip()
    hours = min(float(args.get("hours") or 24), 336)
    if not entity_id:
        return "Error: entity_id is required."

    from core.entity_history import get_history

    data = get_history(entity_id, hours=hours, max_points=60)
    if not data:
        return f"No history data found for '{entity_id}' in the last {hours:.0f} hours."

    values = [d["value"] for d in data if d.get("value") is not None]
    if not values:
        return f"No numeric values recorded for '{entity_id}' in the last {hours:.0f} hours."

    avg = sum(values) / len(values)
    mn, mx = min(values), max(values)
    latest = values[-1]

    lines = [
        f"History for '{entity_id}' (last {hours:.0f}h, {len(data)} samples):",
        f"  Current: {latest}",
        f"  Average: {avg:.2f}",
        f"  Min: {mn}, Max: {mx}",
        f"  Trend: {'rising' if len(values) > 2 and values[-1] > values[0] else 'falling' if len(values) > 2 and values[-1] < values[0] else 'stable'}",
        "",
        "Recent samples (newest first):",
    ]
    for d in reversed(data[-10:]):
        ts = d.get("ts") or ""
        lines.append(f"  {ts}: {d.get('value')}")

    return "\n".join(lines)


async def _exec_planner_add_entry(args: Dict, user_id: str) -> str:
    items = args.get("items") or []
    if not isinstance(items, list) or not items:
        return "Error: 'items' must be a non-empty array."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."
        uid = user.id

        created = []
        for item in items[:10]:
            entry_type = (item.get("entry_type") or "task").strip().lower()
            if entry_type not in ("task", "event"):
                entry_type = "task"
            title = (item.get("title") or "").strip()
            if not title:
                continue

            # Resolve list
            list_name = (item.get("list_name") or "Inbox").strip()[:128]
            todo_list = _planner_get_or_create_list(db, uid, list_name)

            from sqlalchemy import func as sa_func
            max_pos = db.query(sa_func.max(models.Entry.position)).filter(
                models.Entry.user_id == uid,
                models.Entry.list_id == todo_list.id,
            ).scalar()
            next_pos = int(max_pos or 0) + 1

            due_at = _planner_parse_dt(item.get("due_at"))
            start_at = _planner_parse_dt(item.get("start_at"))
            end_at = _planner_parse_dt(item.get("end_at"))
            priority = None
            if item.get("priority") is not None:
                try:
                    p = int(item["priority"])
                    if 1 <= p <= 5:
                        priority = p
                except (TypeError, ValueError):
                    pass

            row = models.Entry(
                user_id=uid,
                list_id=todo_list.id,
                entry_type=entry_type,
                title=title[:200],
                content=(item.get("content") or "")[:5000] or None,
                status="active",
                task_status="todo" if entry_type == "task" else None,
                priority=priority if entry_type == "task" else None,
                due_at=due_at if entry_type == "task" else None,
                start_at=start_at if entry_type == "event" else None,
                end_at=end_at if entry_type == "event" else None,
                all_day=item.get("all_day") if entry_type == "event" else None,
                location=(item.get("location") or "")[:200] or None if entry_type == "event" else None,
                position=next_pos,
            )
            db.add(row)
            db.flush()

            # Sync scheduler jobs for events (notifications + actions)
            if entry_type == "event":
                try:
                    from routers.entries import _sync_event_jobs
                    _sync_event_jobs(row, user)
                except Exception:
                    pass

            created.append(f"- [{entry_type}] {title} (id={row.id}, list='{todo_list.title}')")

        db.commit()
        if not created:
            return "No valid items to create. Each item must have a title."
        return f"Created {len(created)} planner entry(ies):\n" + "\n".join(created)
    finally:
        db.close()


async def _exec_planner_update_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    if entry_id is None:
        return "Error: entry_id is required."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = db.query(models.Entry).filter(
            models.Entry.id == int(entry_id),
            models.Entry.user_id == user.id,
            models.Entry.status == "active",
        ).first()
        if not row:
            return f"Error: entry {entry_id} not found."

        changed = []

        if "title" in args:
            title = (args.get("title") or "").strip()
            if not title:
                return "Error: title cannot be empty."
            row.title = title[:200]
            changed.append("title")

        if "content" in args:
            content = (args.get("content") or "").strip()
            row.content = content[:5000] if content else None
            changed.append("content")

        if "list_name" in args:
            target_list = _planner_get_or_create_list(db, user.id, (args.get("list_name") or "Inbox"))
            row.list_id = target_list.id
            changed.append("list")

        if row.entry_type == "task":
            if "due_at" in args:
                due_raw = args.get("due_at")
                if due_raw in (None, ""):
                    row.due_at = None
                else:
                    due_at = _planner_parse_dt(due_raw)
                    if due_at is None:
                        return "Error: due_at must be ISO datetime (e.g. 2026-03-25T17:00)."
                    row.due_at = due_at
                changed.append("due_at")

            if "priority" in args:
                priority_raw = args.get("priority")
                if priority_raw in (None, ""):
                    row.priority = None
                else:
                    try:
                        priority = int(priority_raw)
                    except (ValueError, TypeError):
                        return "Error: priority must be an integer 1-5."
                    if priority < 1 or priority > 5:
                        return "Error: priority must be between 1 and 5."
                    row.priority = priority
                changed.append("priority")

            if "task_status" in args:
                task_status = (args.get("task_status") or "").strip().lower()
                if task_status not in {"todo", "in_progress", "done"}:
                    return "Error: task_status must be todo, in_progress, or done."
                row.task_status = task_status
                row.completed_at = datetime.now() if task_status == "done" else None
                changed.append("task_status")
        else:
            next_start = row.start_at
            next_end = row.end_at

            if "start_at" in args:
                start_raw = args.get("start_at")
                if start_raw in (None, ""):
                    next_start = None
                else:
                    parsed = _planner_parse_dt(start_raw)
                    if parsed is None:
                        return "Error: start_at must be ISO datetime (e.g. 2026-03-25T17:00)."
                    next_start = parsed
                changed.append("start_at")

            if "end_at" in args:
                end_raw = args.get("end_at")
                if end_raw in (None, ""):
                    next_end = None
                else:
                    parsed = _planner_parse_dt(end_raw)
                    if parsed is None:
                        return "Error: end_at must be ISO datetime (e.g. 2026-03-25T18:00)."
                    next_end = parsed
                changed.append("end_at")

            if next_start and next_end and next_end <= next_start:
                return "Error: end_at must be after start_at."

            row.start_at = next_start
            row.end_at = next_end

            if "all_day" in args:
                row.all_day = bool(args.get("all_day"))
                changed.append("all_day")

            if "location" in args:
                location = (args.get("location") or "").strip()
                row.location = location[:200] if location else None
                changed.append("location")

            if "event_color" in args:
                color = (args.get("event_color") or "").strip()
                row.event_color = color[:32] if color else None
                changed.append("event_color")

        if not changed:
            return f"No changes requested for entry {row.id}."

        db.commit()
        return f"Updated entry '{row.title}' (id={row.id}): {', '.join(changed)}."
    finally:
        db.close()


async def _exec_planner_list_entries(args: Dict, user_id: str) -> str:
    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."
        uid = user.id

        q = db.query(models.Entry).filter(
            models.Entry.user_id == uid,
            models.Entry.status == "active",
        )

        entry_type = (args.get("entry_type") or "").strip().lower()
        if entry_type in ("task", "event"):
            q = q.filter(models.Entry.entry_type == entry_type)

        status_filter = (args.get("status") or "all").strip().lower()
        if status_filter == "open":
            q = q.filter(
                (models.Entry.entry_type != "task") |
                (models.Entry.task_status != "done")
            )
        elif status_filter == "done":
            q = q.filter(
                models.Entry.entry_type == "task",
                models.Entry.task_status == "done",
            )

        view = (args.get("view") or "all").strip().lower()
        now = datetime.now()
        if view == "today":
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
            q = q.filter(
                (models.Entry.due_at.between(start, end)) |
                (models.Entry.start_at.between(start, end))
            )
        elif view == "upcoming":
            q = q.filter(
                (models.Entry.due_at > now) | (models.Entry.start_at > now)
            )
        elif view == "overdue":
            q = q.filter(
                models.Entry.entry_type == "task",
                models.Entry.task_status != "done",
                models.Entry.due_at < now,
            )

        list_name = (args.get("list_name") or "").strip()
        if list_name:
            todo_list = db.query(models.TodoList).filter(
                models.TodoList.user_id == uid,
                models.TodoList.title == list_name,
            ).first()
            if todo_list:
                q = q.filter(models.Entry.list_id == todo_list.id)
            else:
                return f"No list named '{list_name}' found."

        rows = q.order_by(
            models.Entry.due_at.asc().nulls_last(),
            models.Entry.start_at.asc().nulls_last(),
            models.Entry.position.asc(),
        ).limit(50).all()

        if not rows:
            return "No planner entries found matching your criteria."

        lines = []
        for r in rows:
            when = r.due_at or r.start_at
            when_str = when.strftime("%Y-%m-%d %H:%M") if when else ""
            status = ""
            if r.entry_type == "task":
                status = f" [{r.task_status or 'todo'}]"
                if r.priority:
                    status += f" P{r.priority}"
            lines.append(f"- id={r.id} [{r.entry_type}]{status} {r.title}{(' | ' + when_str) if when_str else ''}")

        return f"Found {len(rows)} entries:\n" + "\n".join(lines)
    finally:
        db.close()


async def _exec_planner_complete_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    if entry_id is None:
        return "Error: entry_id is required."
    done = args.get("done", True)

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = db.query(models.Entry).filter(
            models.Entry.id == int(entry_id),
            models.Entry.user_id == user.id,
        ).first()
        if not row:
            return f"Error: entry {entry_id} not found."
        if row.entry_type != "task":
            return f"Entry {entry_id} is a {row.entry_type}, not a task. Only tasks can be marked done."

        row.task_status = "done" if done else "todo"
        if done:
            row.completed_at = datetime.now()
        else:
            row.completed_at = None
        db.commit()
        return f"Task '{row.title}' (id={row.id}) marked as {'done' if done else 'todo'}."
    finally:
        db.close()


async def _exec_planner_delete_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    entry_type = (args.get("entry_type") or "").strip().lower()
    title_contains = (args.get("title_contains") or "").strip().lower()
    date_str = (args.get("date") or "").strip()
    time_hm = (args.get("time_hm") or "").strip()

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = None
        if entry_id is not None:
            row = db.query(models.Entry).filter(
                models.Entry.id == int(entry_id),
                models.Entry.user_id == user.id,
            ).first()
            if not row:
                return f"Error: entry {entry_id} not found."
        else:
            q = db.query(models.Entry).filter(
                models.Entry.user_id == user.id,
                models.Entry.status == "active",
            )
            if entry_type in ("task", "event"):
                q = q.filter(models.Entry.entry_type == entry_type)

            candidates = q.all()
            if title_contains:
                candidates = [c for c in candidates if title_contains in (c.title or "").lower()]
            if date_str:
                candidates = [
                    c for c in candidates
                    if ((c.start_at or c.due_at) and (c.start_at or c.due_at).strftime("%Y-%m-%d") == date_str)
                ]
            if time_hm:
                candidates = [
                    c for c in candidates
                    if ((c.start_at or c.due_at) and (c.start_at or c.due_at).strftime("%H:%M") == time_hm)
                ]

            if not candidates:
                return "Error: no matching entry found for delete filters."
            if len(candidates) > 1:
                preview = "\n".join(
                    f"- id={c.id} [{c.entry_type}] {c.title}"
                    + (f" | {(c.start_at or c.due_at).strftime('%Y-%m-%d %H:%M')}" if (c.start_at or c.due_at) else "")
                    for c in candidates[:5]
                )
                return "Multiple entries match. Please specify entry_id.\n" + preview
            row = candidates[0]

        title = row.title
        db.delete(row)
        db.commit()
        return f"Deleted entry '{title}' (id={row.id})."
    finally:
        db.close()


def _planner_parse_dt(value) -> Optional[datetime]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None

