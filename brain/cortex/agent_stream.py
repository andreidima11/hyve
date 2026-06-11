"""Agent-mode streaming response generator (tool-use loop)."""

from __future__ import annotations

import asyncio
import time
from typing import Dict, List, Optional

import core.settings as settings_mod
from core.logger import log_line, log_detail, log_conversation_model_activity

from brain.cortex.agent_context import prepare_agent_turn
from brain.cortex.agent_helpers import (
    _effective_tool_intent,
    _should_suppress_thinking,
)
from brain.cortex.agent_stream_llm import (
    apply_glm_thinking_payload,
    llm_stream_error_message,
    stream_agent_llm_turn,
)
from brain.cortex.agent_stream_tools import AgentToolLoopState, execute_agent_tool_calls
from brain.cortex.config import DEFAULT_MAX_AGENT_TURNS, TIMEOUT_LLM
from brain.cortex.llm import _llm_headers, _normalize_chat_url, _stream_llm_turn
from brain.llm_client import get_llm_client
from brain.cortex.messages import (
    _compute_safe_completion_tokens,
    _ensure_text_user_message,
    _estimate_messages_tokens,
    _message_content_to_text,
    _trim_messages_to_fit,
    sanitize_input,
)
from brain.cortex.prompt_cache import (
    _filter_tools_for_untrusted_context,
)
from brain.cortex.thinking import (
    RE_HA_CALL_LOG,
    _MarkdownStreamBuffer,
    _strip_think_robust,
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

    tool_intent = _effective_tool_intent(routed_intent, user_msg)
    _thinking_mode = thinking_mode
    try:
        from brain.thinking_control import normalize_thinking_mode
        _thinking_mode = normalize_thinking_mode(thinking_mode)
    except Exception:
        _thinking_mode = "auto"

    turn = await prepare_agent_turn(
        user_msg=user_msg,
        history=history,
        user_id=user_id,
        persona_override=persona_override,
        conversation_summary=conversation_summary,
        image_base64=image_base64,
        llm_cfg=llm_cfg,
        is_anonymous=is_anonymous,
        routed_intent=routed_intent,
        user_profile_context=user_profile_context,
    )
    if turn.direct_vision_response is not None:
        yield turn.direct_vision_response
        return

    tools = turn.tools
    tool_catalog = turn.tool_catalog
    tools_token_estimate = turn.tools_token_estimate
    llm_messages = turn.llm_messages
    safe_max_tokens = turn.safe_max_tokens
    lazy_history_enabled = turn.lazy_history_enabled
    trim_token_budget = turn.trim_token_budget
    trim_reserve_for_response = turn.trim_reserve_for_response
    context_length = turn.context_length
    requested_max_tokens = turn.requested_max_tokens
    model_name = turn.model_name
    light_context = turn.light_context
    tool_intent = turn.tool_intent
    user_profile_context = turn.user_profile_context

    from brain.toolbox import execute_tool, is_tool_allowed_for_untrusted_context

    sec_cfg = settings_mod.CFG.get("security") or {}
    restrict_mutating_tools = bool(sec_cfg.get("restrict_mutating_tools_on_untrusted_content", True))
    untrusted_context_active = bool(restrict_mutating_tools and image_base64 and image_base64.strip())
    safe_untrusted_tool_names = {
        (t.get("function") or {}).get("name")
        for t in tool_catalog
        if is_tool_allowed_for_untrusted_context((t.get("function") or {}).get("name", ""))
    }

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
    from integrations import entry_settings

    searxng_cfg = entry_settings.searxng_settings()
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
            normalized_msgs = _ensure_text_user_message(normalized_msgs)
            payload["messages"] = normalized_msgs
            log_line("agent", "⚡", "NO_THINK", f"mode={_thinking_mode} intent={tool_intent}")
        elif _thinking_mode == "think":
            log_line("agent", "🧠", "THINK", f"mode=think intent={tool_intent}")
        if not any(msg.get("role") == "user" and _message_content_to_text(msg.get("content")).strip() for msg in normalized_msgs):
            log_line("agent", "⚠️", "MSG_VALIDATION", f"No valid user message in {len(normalized_msgs)} messages, aborting turn")
            yield "Error: No valid user message in conversation"
            return
        
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

        apply_glm_thinking_payload(payload, llm_cfg, tools)

        stream_done = None
        first_content_state = {"yielded": _t_first_content_yielded}
        async for event in stream_agent_llm_turn(
            client=client,
            llm_url=llm_url,
            payload=payload,
            llm_cfg=llm_cfg,
            llm_headers=llm_headers,
            has_image_in_msgs=_has_image_in_msgs,
            request_start=_t_request_start,
            md_buf=_md_buf,
            first_content_state=first_content_state,
        ):
            if isinstance(event, dict) and event.get("t") == "_agent_stream_done":
                stream_done = event.get("stream_done")
                break
            if isinstance(event, str) and event.startswith("Error:"):
                yield event
                return
            yield event
        _t_first_content_yielded = first_content_state.get("yielded", _t_first_content_yielded)

        if not stream_done:
            yield "Error: No response from model."
            return
        err_msg = llm_stream_error_message(stream_done, llm_cfg, tools_token_estimate)
        if err_msg:
            yield err_msg
            return

        text_content = (stream_done.get("content") or "").strip()
        tool_calls = stream_done.get("tool_calls") or []
        fr = stream_done.get("finish_reason") or ""
        if fr == "length":
            log_line("agent", "⚠️", "TRUNCATED", f"Model stopped with finish_reason=length (max_tokens={max_tokens}). Response may be incomplete.")

        if tool_calls:
            tool_state = AgentToolLoopState(
                user_msg=user_msg,
                user_id=user_id,
                llm_messages=llm_messages,
                agent_turn_messages=agent_turn_messages,
                tool_catalog=tool_catalog,
                restrict_mutating_tools=restrict_mutating_tools,
                untrusted_context_active=untrusted_context_active,
                safe_untrusted_tool_names=safe_untrusted_tool_names,
                max_searches_per_request=max_searches_per_request,
                max_read_pages_per_request=max_read_pages_per_request,
                search_web_calls_this_request=search_web_calls_this_request,
                read_web_page_calls_this_request=read_web_page_calls_this_request,
                forge_preview=last_forge_preview,
                forge_preview_language=last_forge_preview_language,
            )
            async for event in execute_agent_tool_calls(
                tool_calls=tool_calls,
                text_content=text_content,
                stream_done=stream_done,
                state=tool_state,
                execute_tool=execute_tool,
                md_buf=_md_buf,
            ):
                if isinstance(event, dict) and event.get("t") == "_tool_loop_abort":
                    return
                if isinstance(event, dict) and event.get("t") == "_tool_loop_complete":
                    break
                yield event
            llm_messages = tool_state.llm_messages
            untrusted_context_active = tool_state.untrusted_context_active
            search_web_calls_this_request = tool_state.search_web_calls_this_request
            read_web_page_calls_this_request = tool_state.read_web_page_calls_this_request
            last_forge_preview = tool_state.forge_preview
            last_forge_preview_language = tool_state.forge_preview_language
            llm_messages = _trim_messages_to_fit(
                llm_messages,
                trim_token_budget,
                reserve_for_response=trim_reserve_for_response,
                enable_summary_buffer=not lazy_history_enabled,
                model_name=model_name,
            )
            prompt_tokens = _estimate_messages_tokens(llm_messages, model_name=model_name) + tools_token_estimate
            safe_max_tokens = _compute_safe_completion_tokens(
                context_length, prompt_tokens, requested_max_tokens,
            )
            continue

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
                fb_msgs = _ensure_text_user_message(fb_msgs)
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

