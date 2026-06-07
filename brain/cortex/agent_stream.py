"""Agent-mode streaming response generator (tool-use loop)."""

from __future__ import annotations

import asyncio
import copy
import json
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx
import settings as settings_mod
from logger import log_line, log_detail, log_conversation_model_activity
from rich.panel import Panel

from brain.cortex.agent_helpers import (
    _AGENT_MINIMAL_TOOL_NAMES,
    _append_no_think,
    _effective_tool_intent,
    _event_status,
    _should_suppress_thinking,
    _tool_call_status_label,
)
from brain.cortex.config import DEFAULT_MAX_AGENT_TURNS, console
from brain.cortex.llm import _describe_image_with_vision_llm, _get_aux_or_main_llm, _llm_headers, _normalize_chat_url, _stream_llm_turn
from brain.cortex.messages import (
    _collapse_old_tool_turns,
    clean_history,
    ensure_alternating_roles,
    sanitize_input,
)
from brain.cortex.prompt import _build_dynamic_prompt_suffix, _build_static_prompt_prefix
from brain.cortex.prompt_cache import (
    _filter_tools_for_untrusted_context,
    _prompt_cache,
    _prompt_cache_fingerprint,
    _tool_result_taints_context,
)
from brain.cortex.thinking import (
    RE_TOOL_CALL_BLOCK,
    _MarkdownStreamBuffer,
    _ThinkContentStreamParser,
    strip_think,
    strip_think_content,
)

async def generate_response_stream(
    user_msg: str,
    history: List[Dict],
    user_id: str,
    persona_override: Optional[str] = None,
    conversation_summary: Optional[str] = None,
    image_base64: Optional[str] = None,
    llm_override: Optional[Dict] = None,
    is_anonymous: bool = False,
    routed_intent: Optional[str] = None,
    user_profile_context: Optional[dict] = None,
    thinking_mode: str = "auto",
):
    """Agent-mode response generator: the AI decides which tools to call. llm_override: optional dict (target_url, model_name, api_key, etc.) to use instead of config llm (e.g. per-user default profile)."""
    _t_request_start = time.monotonic()

    if not user_msg and not image_base64:
        yield "Error: Invalid input. Please provide a message or image."
        return

    llm_cfg = (llm_override if llm_override is not None else settings_mod.CFG.get("llm")) or {}
    user_msg = sanitize_input(user_msg or "")
    
    # Ensure user_msg is never empty after sanitization
    if not user_msg and not image_base64:
        yield "Error: Message is empty after sanitization."
        return

    intel = (settings_mod.CFG.get("intelligence") or {})
    tool_intent = _effective_tool_intent(routed_intent, user_msg)
    _thinking_mode = thinking_mode
    try:
        from brain.thinking_control import normalize_thinking_mode
        _thinking_mode = normalize_thinking_mode(thinking_mode)
    except Exception:
        _thinking_mode = "auto"
    light_context = tool_intent in ("simple_chat", "memory")
    if tool_intent != (routed_intent or "complex"):
        log_line("agent", "⚡", "INTENT", f"tool path: {routed_intent or 'none'} → {tool_intent}")

    async def _resolve_profile() -> Optional[dict]:
        if user_profile_context:
            return user_profile_context
        try:
            from core.user_profile import load_user_profile_context
            return await asyncio.to_thread(load_user_profile_context, user_id)
        except Exception:
            return None

    async def _fetch_relevant_facts() -> Optional[str]:
        if not intel.get("inject_relevant_facts", True):
            return None
        if _is_trivial_message(user_msg):
            return None
        try:
            from memory_context import get_memory_context
            raw = await asyncio.to_thread(get_memory_context, user_msg, "", user_id)
            if raw and isinstance(raw, str):
                lines = [ln.strip() for ln in raw.strip().split("\n") if ln.strip()][:5]
                return "\n".join(lines) if lines else None
        except Exception:
            return None
        return None

    async def _fetch_selected_entities() -> list[dict]:
        if light_context:
            return []
        try:
            from routers.integrations import _all_entities as _all_ents
            all_items = await _all_ents()
            return [e for e in all_items if e.get("selected")]
        except Exception:
            return []

    resolved_profile, relevant_facts, selected_entities_snapshot = await asyncio.gather(
        _resolve_profile(),
        _fetch_relevant_facts(),
        _fetch_selected_entities(),
    )
    user_profile_context = resolved_profile

    # --- Prompt + tools cache: skip expensive rebuild when config hasn't changed ---
    from brain.toolbox import get_available_tools, execute_tool, is_tool_allowed_for_untrusted_context
    _cache_fp = _prompt_cache_fingerprint(user_id, persona_override)
    _cached = _prompt_cache.get(_cache_fp)
    if _cached:
        static_prefix = _cached["static_prefix"]
        tools = _cached["tools"]
        tools_token_estimate = _cached["tools_token_est"]
        log_line("agent", "⚡", "PROMPT CACHE", f"HIT — reusing prefix + {len(tools)} tools ({_prompt_cache.stats})")
    else:
        tools = get_available_tools(user_id, is_anonymous=is_anonymous)
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        llm_cfg_pre = llm_cfg
        max_ctx_pre = int(llm_cfg_pre.get("context_length", 0) or 0)
        if max_ctx_pre <= 0:
            max_ctx_pre = 24000
        system_prompt_budget = max_ctx_pre - tools_token_estimate - 3024
        if system_prompt_budget < 2000:
            system_prompt_budget = 2000
        static_prefix = _build_static_prompt_prefix(user_id, persona_override,
                                                     max_prompt_tokens=system_prompt_budget)
        _prompt_cache.put(_cache_fp, {
            "static_prefix": static_prefix,
            "tools": tools,
            "tools_token_est": tools_token_estimate,
        })
        log_line("agent", "🔨", "PROMPT CACHE", f"MISS — built prefix + {len(tools)} tools ({_prompt_cache.stats})")

    # ── Intent-based tool filtering: reduce tools array for simple intents ──
    # Saves ~6500 tokens for simple_chat by removing HA/search/shell tools
    _MEMORY_TOOL_NAMES = frozenset({
        "recall_memory",
        "store_memory",
        "get_conversation_history",
        "get_app_help",
        "get_system_status",
    })
    if tool_intent == "simple_chat" and tools:
        tools = [t for t in tools if (t.get("function") or {}).get("name") in _AGENT_MINIMAL_TOOL_NAMES]
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        log_line("agent", "✂️", "INTENT FILTER", f"simple_chat → reduced to {len(tools)} tools")
    elif tool_intent == "memory" and tools:
        tools = [t for t in tools if (t.get("function") or {}).get("name") in _MEMORY_TOOL_NAMES]
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        log_line("agent", "✂️", "INTENT FILTER", f"memory → reduced to {len(tools)} tools")

    tool_catalog = tools
    sec_cfg = settings_mod.CFG.get("security") or {}
    restrict_mutating_tools = bool(sec_cfg.get("restrict_mutating_tools_on_untrusted_content", True))
    safe_untrusted_tool_names = {
        (t.get("function") or {}).get("name")
        for t in tool_catalog
        if is_tool_allowed_for_untrusted_context((t.get("function") or {}).get("name", ""))
    }
    untrusted_context_active = bool(restrict_mutating_tools and image_base64 and image_base64.strip())
    if untrusted_context_active and tool_catalog:
        tools = _filter_tools_for_untrusted_context(tool_catalog, safe_untrusted_tool_names)
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        log_line("agent", "🛡️", "TOOL POLICY", f"Image input detected → restricted tools {len(tool_catalog)}→{len(tools)}")

    dynamic_suffix = _build_dynamic_prompt_suffix(
        conversation_summary, relevant_facts, selected_entities_snapshot, user_profile_context,
        light_context=light_context,
        user_msg=user_msg,
    )
    system_prompt = static_prefix + dynamic_suffix

    # Build messages
    clean_hist = clean_history(history)
    # Collapse tool noise from older turns so the model sees a clean conversational flow
    clean_hist = _collapse_old_tool_turns(clean_hist, keep_recent_turns=1)

    # --- Cross-model awareness: tell the current model which past messages came from a different profile ---
    current_profile_name = (getattr(settings_mod, "get_active_profile_name", lambda: "")() or "").strip()
    current_model_id = (llm_cfg.get("model_name") or "").strip()
    _foreign_labels: list = []
    _own_count = 0
    _unlabeled_count = 0
    _has_foreign = False
    for _cm in clean_hist:
        if _cm.get("role") != "assistant":
            continue
        _mn = (_cm.get("model_name") or "").strip()
        if not _mn:
            _unlabeled_count += 1
            continue
        # Foreign = stored model_name differs from both current profile name and current model id
        is_foreign = _mn != current_profile_name and _mn != current_model_id
        if is_foreign:
            if _mn not in _foreign_labels:
                _foreign_labels.append(_mn)
            _has_foreign = True
        else:
            _own_count += 1
    log_line("agent", "🔀", "CROSS-MODEL",
             f"current={current_profile_name!r} model_id={current_model_id!r} | "
             f"assistant msgs: own={_own_count} foreign={len(_foreign_labels)} unlabeled={_unlabeled_count}"
             + (f" foreign_names={_foreign_labels}" if _foreign_labels else ""))
    if _has_foreign:
        # Annotate assistant messages in history so the model sees WHO said what
        for _cm in clean_hist:
            if _cm.get("role") != "assistant":
                continue
            _mn = (_cm.get("model_name") or "").strip()
            if not _mn:
                continue
            is_foreign = _mn != current_profile_name and _mn != current_model_id
            if is_foreign:
                _cm["content"] = f"[{_mn} answered:] {_cm.get('content', '')}"
            else:
                _cm["content"] = f"[You ({_mn}) answered:] {_cm.get('content', '')}"
        _foreign_str = ", ".join(_foreign_labels)
        _me = current_profile_name or current_model_id
        _cross_note = (
            f"[CONTEXT] In this conversation the user switched AI profiles. "
            f"Messages marked [{_foreign_str} answered:] were NOT your responses — "
            f"they came from a different AI. You are {_me}. "
            f"When the user refers to earlier exchanges, understand they may have been talking to {_foreign_str}, not to you. "
            f"If you notice anything incorrect or worth improving in those responses, say so."
        )
        system_prompt = system_prompt + "\n\n" + _cross_note
        log_line("agent", "🔀", "CROSS-MODEL", f"Annotated history — foreign: {_foreign_str}, self: {_me}")

    # --- Lazy history: keep only last N messages, buffer the rest ---
    lazy_history_enabled = bool(intel.get("lazy_history", True))
    lazy_keep = max(2, int(intel.get("lazy_history_keep", 4) or 4))  # messages to keep (default: ~2 exchanges)
    if lazy_history_enabled and len(clean_hist) > lazy_keep:
        older = clean_hist[:-lazy_keep]
        recent = clean_hist[-lazy_keep:]
        from brain.toolbox import set_lazy_history
        set_lazy_history(user_id, older)
        clean_hist = recent
        log_line("agent", "📦", "LAZY HISTORY",
                 f"Buffered {len(older)} older messages, keeping {len(recent)} recent")
    else:
        from brain.toolbox import clear_lazy_history
        clear_lazy_history(user_id)

    if image_base64 and image_base64.strip():
        vision_cfg = settings_mod.CFG.get("vision_llm") or {}
        vision_url = _normalize_chat_url((vision_cfg.get("target_url") or "").strip())
        vision_model = (vision_cfg.get("model_name") or "").strip()
        if vision_url and vision_model:
            # Model principal fără vision: descriem imaginea cu modelul vision, apoi trimitem doar text la principal
            prompts_cfg = settings_mod.CFG.get("prompts") or {}
            image_placeholder = prompts_cfg.get("image_placeholder") or "What do you see in this image?"
            prompt_for_vision = (user_msg or image_placeholder).strip()
            description = await _describe_image_with_vision_llm(image_base64, prompt_for_vision)
            if vision_cfg.get("respond_directly"):
                # Răspunde direct modelul vision; nu trimitem la modelul principal
                if description:
                    log_line("agent", "🖼", "VISION", "Direct vision model response")
                    sec = (settings_mod.CFG.get("security") or {})
                    yield sanitize_untrusted_content(description, "vision") if sec.get("anti_injection", True) else description
                else:
                    yield "[Descrierea imaginii nu a putut fi obținută.]"
                return
            if description:
                log_line("agent", "🖼", "VISION", "Description obtained, sent to main model")
                sec = (settings_mod.CFG.get("security") or {})
                safe_desc = sanitize_untrusted_content(description, "vision") if sec.get("anti_injection", True) else description
                combined = (user_msg or "").strip()
                combined += "\n\n[Descriere imagine: " + safe_desc + "]" if combined else "[Descriere imagine: " + safe_desc + "]"
                last_user_content = combined or "[Utilizatorul a încărcat o imagine.]"
            else:
                last_user_content = (user_msg or "").strip() + "\n\n[Imagine încărcată; descrierea de la modelul vision nu a putut fi obținută.]"
        else:
            # Main model supports vision — send image inline (non-streaming handles it)
            prompts_cfg = settings_mod.CFG.get("prompts") or {}
            image_placeholder = prompts_cfg.get("image_placeholder") or "What do you see in this image?"
            text_part = (user_msg or image_placeholder).strip()
            data_url = image_base64 if image_base64.startswith("data:") else f"data:image/jpeg;base64,{image_base64.strip()}"
            last_user_content = [{"type": "text", "text": text_part}, {"type": "image_url", "image_url": {"url": data_url}}]
    else:
        last_user_content = user_msg

    messages = ensure_alternating_roles(clean_hist + [{"role": "user", "content": last_user_content}])
    while messages and messages[0].get("role") == "assistant":
        messages = messages[1:]
    
    # Safeguard: ensure at least one user message exists (for jinja template rendering in local LLMs)
    has_user_msg = any(msg.get("role") == "user" and msg.get("content") for msg in messages)
    if not has_user_msg:
        log_line("agent", "⚠️", "MSG_VALIDATION", "No user message found, adding placeholder")
        if not messages or messages[-1].get("role") != "user":
            messages.append({"role": "user", "content": last_user_content or "[continuing conversation]"})

    model_name = llm_cfg.get("model_name", "")
    llm_messages = [{"role": "system", "content": system_prompt}] + messages

    # Trim history to fit within context window
    max_ctx = int(llm_cfg.get("context_length", 0) or 0)
    if max_ctx <= 0:
        max_ctx = 24000  # safe default (~32K minus overhead)
    # tools_token_estimate already set by prompt cache above
    effective_max = max_ctx - tools_token_estimate
    requested_max_tokens = int(llm_cfg.get("max_tokens", 0) or 2048)
    reserve_for_response = max(256, min(requested_max_tokens, max_ctx // 3))
    llm_messages = _trim_messages_to_fit(
        llm_messages,
        effective_max,
        reserve_for_response=reserve_for_response,
        enable_summary_buffer=not lazy_history_enabled,  # summary buffer disabled in lazy mode (older messages are in toolbox, not dropped)
        model_name=model_name,
    )
    prompt_tokens = _estimate_messages_tokens(llm_messages, model_name=model_name) + tools_token_estimate
    safe_max_tokens = _compute_safe_completion_tokens(max_ctx, prompt_tokens, requested_max_tokens)
    log_line("agent", "📏", "TOKENS", f"prompt~{prompt_tokens}/{max_ctx}, completion_max={safe_max_tokens}")

    intel_cfg = settings_mod.CFG.get("intelligence") or {}
    max_agent_turns = int(intel_cfg.get("max_agent_turns", DEFAULT_MAX_AGENT_TURNS) or DEFAULT_MAX_AGENT_TURNS)
    llm_temperature = float(llm_cfg.get("temperature", 0.7))

    log_line("agent", "🤖", "AGENT START", f"tools={len(tools)}, history={len(llm_messages)}, prep={round((time.monotonic() - _t_request_start) * 1000)}ms" + (" [image]" if image_base64 else ""))
    log_conversation_model_activity("working", f"agent (tool calling, {len(tools)} tools)")
    _t_first_content_yielded = False

    client = await get_llm_client()
    llm_url = _normalize_chat_url(llm_cfg.get("target_url", ""))
    llm_headers = _llm_headers(llm_cfg.get("api_key") or "")
    agent_turn_messages: List[Dict] = []  # assistant + tool messages to persist so next request sees tool-use
    last_forge_preview = ""
    last_forge_preview_language = "python"
    searxng_cfg = settings_mod.CFG.get("searxng") or {}
    _cfg_max_searches = max(1, min(20, int(searxng_cfg.get("max_searches_per_request", 5) or 5)))
    # Apply search tendency: lower tendency → tighter cap
    _search_tendency = max(1, min(5, int((settings_mod.CFG.get("intelligence") or {}).get("search_tendency", 3) or 3)))
    _tendency_caps = {1: 1, 2: 1, 3: _cfg_max_searches, 4: _cfg_max_searches, 5: max(_cfg_max_searches, 5)}
    max_searches_per_request = min(_cfg_max_searches, _tendency_caps[_search_tendency])
    search_web_calls_this_request = 0
    max_read_pages_per_request = max(1, min(15, int(searxng_cfg.get("max_read_pages_per_request", 5) or 5)))
    read_web_page_calls_this_request = 0

    _md_buf = _MarkdownStreamBuffer()

    for turn in range(max_agent_turns):
        log_detail("agent", "TURN", turn=turn + 1, messages_count=len(llm_messages))

        turn_tools = tool_catalog
        if restrict_mutating_tools and untrusted_context_active:
            turn_tools = _filter_tools_for_untrusted_context(tool_catalog, safe_untrusted_tool_names)

        # Build request payload (normalize so backend never sees content: null or malformed tool_calls)
        max_tokens = safe_max_tokens
        
        # Validate messages before API call (prevents "No user query" jinja template errors)
        normalized_msgs = _ensure_text_user_message(llm_messages)
        _suppress_thinking = _should_suppress_thinking(
            llm_cfg.get("model_name", ""), tool_intent, user_msg, _thinking_mode,
        )
        payload = {
            "model": llm_cfg.get("model_name", ""),
            "messages": normalized_msgs,
            "temperature": llm_temperature,
            "max_tokens": max_tokens,
        }
        if _suppress_thinking:
            from brain.thinking_control import apply_thinking_suppression
            provider = str(llm_cfg.get("provider") or "").strip().lower()
            payload, normalized_msgs = apply_thinking_suppression(
                payload,
                normalized_msgs,
                target_url=llm_url,
                model_name=llm_cfg.get("model_name", ""),
                provider=provider,
                suppress=True,
            )
            payload["messages"] = normalized_msgs
            log_line("agent", "⚡", "NO_THINK", f"mode={_thinking_mode} intent={tool_intent}")
        elif _thinking_mode == "think":
            log_line("agent", "🧠", "THINK", f"mode=think intent={tool_intent}")
        if not any(msg.get("role") == "user" and _message_content_to_text(msg.get("content")).strip() for msg in normalized_msgs):
            log_line("agent", "⚠️", "MSG_VALIDATION", f"No valid user message in {len(normalized_msgs)} messages, aborting turn")
            yield {"t": "error", "error": "No valid user message in conversation"}
            break
        
        # Skip tools when image is present on turn 0:
        # many llama.cpp vision models (Qwen2-VL, LLaVA, etc.) cannot handle
        # tools + multimodal image_url in the same request and return
        # "failed to process image".  The first turn answers the image question
        # as plain text; subsequent turns (if any) re-enable tools normally.
        _has_image_in_msgs = any(
            isinstance(m.get("content"), list) and any(
                isinstance(p, dict) and p.get("type") == "image_url"
                for p in m["content"]
            )
            for m in normalized_msgs
        )
        if turn_tools and not _has_image_in_msgs:
            payload["tools"] = turn_tools
        elif turn_tools and _has_image_in_msgs:
            log_line("agent", "🖼", "VISION", "Skipping tools for image request (tools + multimodal not supported by most local LLMs)")

        # GLM models: enable Deep Thinking + Preserved Thinking + Stream Tool Call
        # Only for GLM variants that explicitly support thinking (flash/thinking models)
        # Plain glm-4.7 does NOT support the thinking parameter and returns HTTP 400
        model_name = (llm_cfg.get("model_name") or "").lower()
        _glm_supports_thinking = (
            ("glm" in model_name and ("flash" in model_name or "thinking" in model_name))
            or "4.7-flash" in model_name
        )
        if _glm_supports_thinking:
            payload["thinking"] = {"type": "enabled"}
            if tools:
                payload["thinking"]["clear_thinking"] = False
                payload["tool_stream"] = True

        # --- LLM call: streaming for both text and vision ---
        # We try streaming first even for image turns; if the backend returns an
        # error related to multimodal+stream, we fall back to a non-streaming
        # call. Some local backends (older llama.cpp, vLLM) need this fallback.
        llm_timeout = float(llm_cfg.get("timeout", TIMEOUT_LLM))
        stream_done = None
        _vision_stream_failed = False
        try:
            if _has_image_in_msgs:
                yield _event_status("search_web_images", label="Analizez imaginea")
            if _has_image_in_msgs:
                # Try streaming first for vision
                try:
                    async for event in _stream_llm_turn(client, llm_url, payload, llm_timeout, llm_headers):
                        if isinstance(event, dict) and event.get("t") == "_stream_done":
                            stream_done = event
                            # Detect multimodal+stream errors → trigger fallback
                            err_detail = str(event.get("error_detail") or "").lower()
                            if event.get("error") and ("image" in err_detail or "multimodal" in err_detail or "vision" in err_detail):
                                _vision_stream_failed = True
                                stream_done = None
                            break
                        if isinstance(event, dict) and event.get("t") == "thinking":
                            if not _t_first_content_yielded:
                                _t_first_content_yielded = True
                                _ttft_total = round((time.monotonic() - _t_request_start) * 1000)
                                log_line("agent", "⏱️", "TTFT", f"{_ttft_total}ms (first thinking token)")
                            yield event
                            continue
                        if isinstance(event, str):
                            if not _t_first_content_yielded:
                                _t_first_content_yielded = True
                                _ttft_total = round((time.monotonic() - _t_request_start) * 1000)
                                log_line("agent", "⏱️", "TTFT", f"{_ttft_total}ms (first content token)")
                            for _buf_chunk in _md_buf.feed(event):
                                yield _buf_chunk
                            continue
                    _buf_tail = _md_buf.flush()
                    if _buf_tail:
                        yield _buf_tail
                except Exception as e:
                    log_line("agent", "🖼", "VISION", f"Streaming failed ({type(e).__name__}: {str(e)[:120]}), falling back to non-streaming")
                    _vision_stream_failed = True

                if _vision_stream_failed:
                    log_line("agent", "🖼", "VISION", "Non-streaming fallback for vision call")
                    _ns_payload = {**payload, "stream": False}
                    r = await client.post(llm_url, json=_ns_payload, timeout=llm_timeout, headers=llm_headers or {})
                    if r.status_code != 200:
                        body_hint = r.text[:300] if r.text else "(empty)"
                        stream_done = {"t": "_stream_done", "content": "", "tool_calls": [], "finish_reason": "error", "error": r.status_code, "error_detail": body_hint}
                    else:
                        _ns_data = r.json()
                        _ns_choice = (_ns_data.get("choices") or [{}])[0]
                        _ns_msg = _ns_choice.get("message") or {}
                        _ns_content = (_ns_msg.get("content") or "").strip()
                        _ns_reasoning = (_ns_msg.get("reasoning_content") or "").strip()
                        if _ns_reasoning:
                            yield {"t": "thinking", "content": _ns_reasoning}
                        if not _ns_content and _ns_reasoning:
                            _ns_content = _ns_reasoning
                        if _ns_content:
                            yield _ns_content
                        stream_done = {
                            "t": "_stream_done",
                            "content": _ns_content,
                            "tool_calls": [],
                            "finish_reason": _ns_choice.get("finish_reason") or "stop",
                            "reasoning_content": _ns_reasoning or None,
                        }
            else:
                async for event in _stream_llm_turn(client, llm_url, payload, llm_timeout, llm_headers):
                    if isinstance(event, dict) and event.get("t") == "_stream_done":
                        stream_done = event
                        break
                    if isinstance(event, dict) and event.get("t") == "thinking":
                        if not _t_first_content_yielded:
                            _t_first_content_yielded = True
                            _ttft_total = round((time.monotonic() - _t_request_start) * 1000)
                            log_line("agent", "⏱️", "TTFT", f"{_ttft_total}ms (first thinking token)")
                        yield event
                        continue
                    if isinstance(event, str):
                        if not _t_first_content_yielded:
                            _t_first_content_yielded = True
                            _ttft_total = round((time.monotonic() - _t_request_start) * 1000)
                            log_line("agent", "⏱️", "TTFT", f"{_ttft_total}ms (first content token)")
                        for _buf_chunk in _md_buf.feed(event):
                            yield _buf_chunk
                        continue
                # Flush any buffered markdown at end of this streaming pass
                _buf_tail = _md_buf.flush()
                if _buf_tail:
                    yield _buf_tail
        except Exception as e:
            log_line("agent", "⚠️", "LLM ERROR", f"{type(e).__name__}: {e}")
            yield f"Error: {str(e)}"
            return

        if not stream_done:
            yield "Error: No response from model."
            return
        if stream_done.get("error"):
            err_code = stream_done.get("error")
            err_detail = stream_done.get("error_detail") or ""
            err_str = str(err_code) + " " + str(err_detail)
            # DeepSeek (and similar) return 400 when reasoning_content is missing in assistant messages — do not treat as context overflow
            if "reasoning_content" in err_detail:
                log_line("agent", "⚠️", "LLM REQUEST", f"API rejected: {err_detail[:200]}")
                yield "Model request error: assistant messages must include reasoning_content. Try a new session."
                return
            # Detect context overflow (LM Studio SSE error or HTTP 400 with context/n_ctx/exceeds)
            is_context_overflow = (
                err_code == 400
                and ("context" in err_str.lower() or "n_ctx" in err_str.lower() or "exceeds" in err_str.lower())
            ) or ("context" in err_str.lower() and "exceeds" in err_str.lower())
            if is_context_overflow:
                log_line("agent", "🚨", "CONTEXT OVERFLOW",
                         f"Prompt too large for model context window. "
                         f"Config context_length={llm_cfg.get('context_length')}, "
                         f"tools_tokens~{tools_token_estimate}, "
                         f"prompt_tokens~{prompt_tokens}. "
                         f"Increase model context in LM Studio or reduce context_length in config.")
                _prompts = settings_mod.CFG.get("prompts") or {}
                yield _prompts.get("conversation_too_long") or "Conversation too long. Please start a new session or send a shorter message."
            else:
                msg = f"Model Error: {err_code}"
                if err_detail:
                    msg += " — " + (err_detail[:200] if len(err_detail) > 200 else err_detail)
                yield msg
            return

        text_content = (stream_done.get("content") or "").strip()
        tool_calls = stream_done.get("tool_calls") or []
        fr = stream_done.get("finish_reason") or ""
        if fr == "length":
            log_line("agent", "⚠️", "TRUNCATED", f"Model stopped with finish_reason=length (max_tokens={max_tokens}). Response may be incomplete.")

        # Case A: AI returned tool calls — execute them and loop
        if tool_calls:
            # Add assistant message with tool calls to conversation (content must be string for API compatibility)
            # z.ai Preserved Thinking: return reasoning_content so the model keeps reasoning coherent (docs.z.ai/guides/capabilities/thinking-mode)
            reasoning_content = stream_done.get("reasoning_content") or ""
            assistant_msg = {"role": "assistant", "content": text_content or "", "tool_calls": tool_calls}
            if reasoning_content and isinstance(reasoning_content, str):
                assistant_msg["reasoning_content"] = reasoning_content
            llm_messages.append(assistant_msg)
            agent_turn_messages.append({"role": "assistant", "content": text_content or "", "tool_calls": tool_calls})

            # PARALLEL SEARCH OPTIMIZATION: if multiple search_web calls, run them in parallel
            search_calls_to_parallel = []
            knowledge_cutoff_str = (settings_mod.CFG.get("intelligence") or {}).get("knowledge_cutoff", "").strip()
            
            for idx, tc in enumerate(tool_calls):
                fn = tc.get("function", {})
                fn_name = fn.get("name", "")
                if fn_name == "search_web" and search_web_calls_this_request < max_searches_per_request:
                    fn_args_raw = fn.get("arguments", "")
                    try:
                        fn_args = json.loads(fn_args_raw) if fn_args_raw else {}
                    except json.JSONDecodeError:
                        continue
                    query = fn_args.get("query", "").strip()
                    
                    # Apply same pre-search validation (with freshness check)
                    skip_search = False
                    skip_reason = ""
                    skip_search, skip_reason = _should_skip_web_search(query, knowledge_cutoff_str, user_msg)
                    
                    if not skip_search:
                        search_calls_to_parallel.append((idx, fn_name, fn_args, tc.get("id")))
            
            # Execute searches in parallel if 2+
            parallel_results = {}
            if len(search_calls_to_parallel) >= 2:
                log_line("agent", "⚡", "PARALLEL_SEARCH", f"Running {len(search_calls_to_parallel)} searches in parallel")
                tasks = [execute_tool(fn_name, fn_args, user_id, untrusted_context=untrusted_context_active) for (_, fn_name, fn_args, _) in search_calls_to_parallel]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for i, (idx, fn_name, fn_args, tc_id) in enumerate(search_calls_to_parallel):
                    result = results[i]
                    if isinstance(result, Exception):
                        result = f"Search error: {type(result).__name__}: {result}"
                    parallel_results[tc_id or idx] = result
                search_web_calls_this_request += len(search_calls_to_parallel)

            # PARALLEL DEVICE CONTROL: if multiple control_device calls, run them in parallel
            device_calls_to_parallel = []
            for idx, tc in enumerate(tool_calls):
                fn = tc.get("function", {})
                fn_name = fn.get("name", "")
                if fn_name == "control_device":
                    fn_args_raw = fn.get("arguments", "")
                    try:
                        fn_args = json.loads(fn_args_raw) if fn_args_raw else {}
                    except json.JSONDecodeError:
                        continue
                    device_calls_to_parallel.append((idx, fn_name, fn_args, tc.get("id")))

            if len(device_calls_to_parallel) >= 2:
                log_line("agent", "⚡", "PARALLEL_DEVICE", f"Running {len(device_calls_to_parallel)} device controls in parallel")
                tasks = [execute_tool(fn_name, fn_args, user_id, untrusted_context=untrusted_context_active) for (_, fn_name, fn_args, _) in device_calls_to_parallel]
                dev_results = await asyncio.gather(*tasks, return_exceptions=True)
                for i, (idx, fn_name, fn_args, tc_id) in enumerate(device_calls_to_parallel):
                    result = dev_results[i]
                    if isinstance(result, Exception):
                        result = f"Device error: {type(result).__name__}: {result}"
                    parallel_results[tc_id or f"dev_{idx}"] = result

            for tc in tool_calls:
                fn = tc.get("function", {})
                fn_name = fn.get("name", "")
                # Sanitize: some models (Qwen) emit XML-corrupted names like "search_web>query</string>="
                if fn_name and not fn_name.replace("_", "").isalpha():
                    clean = re.match(r"^[a-zA-Z_]+", fn_name)
                    if clean:
                        log_line("agent", "🩹", "TOOL NAME FIX", f"'{fn_name}' → '{clean.group()}'")
                        fn_name = clean.group()
                fn_args_raw = fn.get("arguments", "")
                try:
                    fn_args = json.loads(fn_args_raw) if fn_args_raw else {}
                except json.JSONDecodeError:
                    # Fallback: try to salvage args from garbled JSON (e.g. swapped key/value)
                    fn_args = {}
                    if fn_args_raw:
                        # Extract any quoted strings as potential argument values
                        quoted = re.findall(r'"([^"]{2,})"', fn_args_raw)
                        if quoted and fn_name in ("search_web", "search_web_images"):
                            # Pick the longest quoted string as query
                            best = max(quoted, key=len)
                            fn_args = {"query": best}
                            log_line("agent", "🩹", "ARGS FIX", f"Salvaged query from malformed args: '{best[:60]}'")
                        elif quoted:
                            log_line("agent", "⚠️", "ARGS PARSE", f"Could not parse args for {fn_name}: {fn_args_raw[:100]}")

                # Yield status event to frontend (type = tool name so UI can show the right icon)
                status_label = _tool_call_status_label(fn_name, fn_args)
                yield _event_status(fn_name, label=status_label)
                log_conversation_model_activity("calls", f"{fn_name}" + (f"({fn_args_raw[:60]}…)" if len(fn_args_raw or "") > 60 else (f"({fn_args_raw})" if fn_args_raw else "")))

                # Limit search_web and read_web_page calls per request to avoid loops
                if fn_name == "search_web":
                    # Check if this search was already executed in parallel batch
                    tc_id = tc.get("id")
                    if tc_id in parallel_results or (tc_id is None and parallel_results):
                        # Use pre-computed parallel result
                        result = parallel_results.get(tc_id) or parallel_results.get(list(parallel_results.keys())[0])
                        if tc_id in parallel_results:
                            del parallel_results[tc_id]
                        else:
                            parallel_results.pop(list(parallel_results.keys())[0])
                    elif search_web_calls_this_request >= max_searches_per_request:
                        result = f"Search limit reached (max {max_searches_per_request} per message). Use the previous search results to answer."
                        log_line("agent", "🔎", "SEARCH_LIMIT", f"{search_web_calls_this_request} >= {max_searches_per_request}")
                    else:
                        # PRE-SEARCH VALIDATION: check if search is truly necessary (single search, not parallelized)
                        query = fn_args.get("query", "").strip()
                        knowledge_cutoff_str = (settings_mod.CFG.get("intelligence") or {}).get("knowledge_cutoff", "").strip()
                        
                        skip_search = False
                        skip_reason = ""
                        skip_search, skip_reason = _should_skip_web_search(query, knowledge_cutoff_str, user_msg)
                        
                        if skip_search:
                            result = f"[SEARCH SKIPPED] {skip_reason}\n\nUse your existing knowledge to answer this question directly."
                            log_line("agent", "🚫", "SEARCH_SKIP", skip_reason)
                        else:
                            result = await execute_tool(fn_name, fn_args, user_id, untrusted_context=untrusted_context_active)
                            search_web_calls_this_request += 1
                elif fn_name == "read_web_page":
                    if read_web_page_calls_this_request >= max_read_pages_per_request:
                        result = f"Read-page limit reached (max {max_read_pages_per_request} per message). Use the content already fetched to answer."
                        log_line("agent", "📄", "READ_PAGE_LIMIT", f"{read_web_page_calls_this_request} >= {max_read_pages_per_request}")
                    else:
                        result = await execute_tool(fn_name, fn_args, user_id, untrusted_context=untrusted_context_active)
                        read_web_page_calls_this_request += 1
                elif fn_name == "create_skill":
                    status_queue = asyncio.Queue()
                    task = asyncio.create_task(execute_tool(fn_name, fn_args, user_id, status_queue=status_queue, untrusted_context=untrusted_context_active))
                    _skill_timeout = 180  # max seconds to wait for forge
                    _skill_elapsed = 0.0
                    while True:
                        try:
                            ev = await asyncio.wait_for(status_queue.get(), timeout=0.05)
                            if isinstance(ev, dict) and ev.get("t") == "status":
                                yield _event_status(ev.get("type", ""), label=ev.get("label", ""))
                            elif isinstance(ev, dict) and ev.get("t"):
                                if ev.get("t") == "forge_preview":
                                    last_forge_preview = ev.get("content") or ""
                                    last_forge_preview_language = ev.get("language") or "python"
                                yield ev
                            _skill_elapsed = 0.0
                        except asyncio.TimeoutError:
                            _skill_elapsed += 0.05
                            if task.done():
                                try:
                                    result = task.result()
                                except Exception as _forge_exc:
                                    result = f"Error creating skill: {_forge_exc}"
                                break
                            if _skill_elapsed >= _skill_timeout:
                                task.cancel()
                                result = "Error creating skill: timed out after 3 minutes."
                                break
                    if isinstance(result, str) and (result.startswith("Forge:") or result.startswith("Error creating skill:")):
                        friendly = result
                        if not friendly.lower().startswith("i couldn't"):
                            friendly = (
                                "I couldn't create the skill automatically. "
                                + result
                                + " Try a narrower request, or ask for a smaller first version and then improve it."
                            )
                        yield friendly
                        log_line("agent", "⚠️", "CREATE_SKILL_FAIL", result[:220])
                        return
                elif fn_name == "control_device":
                    # Check if already executed in parallel batch
                    tc_id = tc.get("id")
                    if tc_id and tc_id in parallel_results:
                        result = parallel_results.pop(tc_id)
                    else:
                        result = await execute_tool(fn_name, fn_args, user_id, untrusted_context=untrusted_context_active)
                else:
                    result = await execute_tool(fn_name, fn_args, user_id, untrusted_context=untrusted_context_active)
                log_detail("agent", "TOOL_RESULT", tool=fn_name, result_len=len(result))
                if restrict_mutating_tools and not untrusted_context_active and _tool_result_taints_context(fn_name, result):
                    untrusted_context_active = True
                    restricted_count = len(_filter_tools_for_untrusted_context(tool_catalog, safe_untrusted_tool_names))
                    log_line("agent", "🛡️", "TOOL POLICY", f"Restricted tools after untrusted content from {fn_name}: {len(tool_catalog)}→{restricted_count}")
                # Truncate tool result so context stays bounded (performance)
                tool_result_max = int((settings_mod.CFG.get("intelligence") or {}).get("tool_result_max_chars", 6000) or 6000)
                if len(result) > tool_result_max:
                    result = result[:tool_result_max] + "\n... (output truncated)"
                    log_line("agent", "✂️", "TOOL TRUNCATE", f"{fn_name} result truncated to {tool_result_max} chars")

                # Emit memory_saved status for UI (store_memory)
                if fn_name == "store_memory" and ("saved" in result.lower() or "updated" in result.lower()):
                    yield _event_status("store_memory", label="Memorie actualizată")
                # Emit search_sources for UI (search_web) — structured source cards
                if fn_name == "search_web":
                    try:
                        from brain.toolbox import get_last_search_sources, clear_last_search_sources
                        sources = get_last_search_sources()
                        if sources:
                            yield {"t": "search_sources", "sources": sources}
                            clear_last_search_sources()
                    except Exception as e:
                        log_line("warn", "⚠️", "UI_EMIT", f"search_sources emit failed: {e}")
                # Emit shell_done or shell_request for UI transparency (run_shell only)
                if fn_name == "run_shell":
                    try:
                        from brain.tool_shell import get_last_shell_run
                        last = get_last_shell_run()
                        if last:
                            if last.get("requested_but_denied"):
                                yield {"t": "shell_request", "command": last.get("command", "")}
                            else:
                                yield {"t": "shell_done", "command": last.get("command", ""), "exit_code": last.get("exit_code"), "output_preview": last.get("output_preview", "")}
                    except Exception as e:
                        log_line("warn", "⚠️", "UI_EMIT", f"shell_done emit failed: {e}")
                # Emit shell_suggest for UI (suggest_shell)
                if fn_name == "suggest_shell":
                    try:
                        from brain.tool_shell import get_last_suggest_shell
                        last = get_last_suggest_shell()
                        if last:
                            yield {"t": "shell_suggest", "command": last.get("command", ""), "reason": last.get("reason", "")}
                    except Exception as e:
                        log_line("warn", "⚠️", "UI_EMIT", f"shell_suggest emit failed: {e}")
                # Emit proposal for UI (propose_patch / propose_file)
                if fn_name in ("propose_patch", "propose_file"):
                    try:
                        from brain.tool_workspace import get_last_proposal
                        prop = get_last_proposal()
                        if prop:
                            yield {"t": "proposal", "proposal": prop}
                    except Exception as e:
                        log_line("warn", "⚠️", "UI_EMIT", f"proposal emit failed: {e}")

                # Add tool result to conversation
                tool_msg = {"role": "tool", "tool_call_id": tc.get("id", ""), "content": result}
                llm_messages.append(tool_msg)
                agent_turn_messages.append(tool_msg)

            # Flush markdown buffer before clearing content for tool calls
            _buf_tail = _md_buf.flush()
            if _buf_tail:
                yield _buf_tail

            # Clear any reasoning text the LLM streamed before making tool calls
            yield {"t": "clear_content"}

            continue  # next turn — let the AI see the results

        # Case B: AI returned text content — we already streamed thinking + content; just persist and finish
        if text_content:
            text_content = RE_HA_CALL_LOG.sub("", text_content)
            _, content_part = _strip_think_robust(text_content)
            final_assistant_msg = {"role": "assistant", "content": content_part}
            if last_forge_preview:
                final_assistant_msg["forge_preview"] = last_forge_preview
                final_assistant_msg["forge_preview_language"] = last_forge_preview_language
            agent_turn_messages.append(final_assistant_msg)
            if stream_done.get("completion_tokens") is not None or stream_done.get("prompt_tokens") is not None or stream_done.get("total_tokens") is not None:
                _total_elapsed = round((time.monotonic() - _t_request_start) * 1000)
                yield {
                    "t": "metrics",
                    "completion_tokens": stream_done.get("completion_tokens"),
                    "prompt_tokens": stream_done.get("prompt_tokens"),
                    "total_tokens": stream_done.get("total_tokens"),
                    "ttft_ms": stream_done.get("ttft_ms"),
                    "llm_elapsed_ms": stream_done.get("llm_elapsed_ms"),
                    "total_elapsed_ms": _total_elapsed,
                }
            if agent_turn_messages:
                yield {"t": "history_messages", "messages": agent_turn_messages}
            _total_ms = round((time.monotonic() - _t_request_start) * 1000)
            log_line("agent", "✅", "AGENT DONE", f"turns={turn + 1}, reply_len={len(content_part)}, total={_total_ms}ms")
            return

        # Case C: Empty response — try one more time without tools (fallback), streaming in real-time
        log_line("agent", "⚠️", "EMPTY RESPONSE", f"turn={turn + 1}, retrying without tools")
        try:
            max_tokens = int(llm_cfg.get("max_tokens", 0) or 2048)
            payload_no_tools = {
                "model": llm_cfg.get("model_name", ""),
                "messages": _ensure_text_user_message(llm_messages),
                "temperature": llm_temperature,
                "max_tokens": max_tokens,
            }
            if _suppress_thinking:
                from brain.thinking_control import apply_thinking_suppression
                provider = str(llm_cfg.get("provider") or "").strip().lower()
                fb_msgs = payload_no_tools["messages"]
                payload_no_tools, fb_msgs = apply_thinking_suppression(
                    payload_no_tools,
                    fb_msgs,
                    target_url=llm_url,
                    model_name=llm_cfg.get("model_name", ""),
                    provider=provider,
                    suppress=_should_suppress_thinking(
                        llm_cfg.get("model_name", ""), tool_intent, user_msg, _thinking_mode,
                    ),
                )
                payload_no_tools["messages"] = fb_msgs
            llm_timeout = float(llm_cfg.get("timeout", TIMEOUT_LLM))
            fallback_content = ""
            _fb_md_buf = _MarkdownStreamBuffer()
            async for event in _stream_llm_turn(client, llm_url, payload_no_tools, llm_timeout, llm_headers):
                if isinstance(event, dict) and event.get("t") == "_stream_done":
                    fc = (event.get("content") or "").strip()
                    _, fallback_content = _strip_think_robust(fc)
                    break
                if isinstance(event, dict) and event.get("t") == "thinking":
                    yield event
                    continue
                if isinstance(event, str):
                    for _buf_chunk in _fb_md_buf.feed(event):
                        yield _buf_chunk
                    continue
            _buf_tail = _fb_md_buf.flush()
            if _buf_tail:
                yield _buf_tail
            if fallback_content:
                log_line("agent", "✅", "AGENT DONE (fallback)", f"turns={turn + 1}, reply_len={len(fallback_content)}")
                return
        except Exception as e:
            log_line("error", "⚠️", "AGENT FALLBACK", f"{type(e).__name__}: {e}")
            yield "I'm not sure how to help with that."
            return

    # Safety: max turns exceeded
    yield "I've reached the maximum number of steps. Please try a simpler request."
    log_line("agent", "⚠️", "AGENT MAX TURNS", f"Exceeded {max_agent_turns} turns")

