"""LLM streaming helpers for agent-mode responses."""

from __future__ import annotations

import time
from typing import Any, AsyncIterator, Dict, List, Optional

import settings as settings_mod
from logger import log_line

from brain.cortex.agent_helpers import _event_status
from brain.cortex.config import TIMEOUT_LLM
from brain.cortex.llm import _stream_llm_turn
from brain.cortex.thinking import _MarkdownStreamBuffer


def apply_glm_thinking_payload(payload: Dict[str, Any], llm_cfg: Dict[str, Any], tools: List[Dict]) -> None:
    model_name = (llm_cfg.get("model_name") or "").lower()
    glm_supports_thinking = (
        ("glm" in model_name and ("flash" in model_name or "thinking" in model_name))
        or "4.7-flash" in model_name
    )
    if not glm_supports_thinking:
        return
    payload["thinking"] = {"type": "enabled"}
    if tools:
        payload["thinking"]["clear_thinking"] = False
        payload["tool_stream"] = True


def llm_stream_error_message(
    stream_done: Dict[str, Any],
    llm_cfg: Dict[str, Any],
    tools_token_estimate: int,
) -> Optional[str]:
    if not stream_done.get("error"):
        return None
    err_code = stream_done.get("error")
    err_detail = stream_done.get("error_detail") or ""
    err_str = str(err_code) + " " + str(err_detail)
    if "reasoning_content" in err_detail:
        log_line("agent", "⚠️", "LLM REQUEST", f"API rejected: {err_detail[:200]}")
        return "Model request error: assistant messages must include reasoning_content. Try a new session."
    is_context_overflow = (
        err_code == 400
        and ("context" in err_str.lower() or "n_ctx" in err_str.lower() or "exceeds" in err_str.lower())
    ) or ("context" in err_str.lower() and "exceeds" in err_str.lower())
    if is_context_overflow:
        prompt_tokens = stream_done.get("prompt_tokens")
        log_line(
            "agent",
            "🚨",
            "CONTEXT OVERFLOW",
            f"Prompt too large for model context window. "
            f"Config context_length={llm_cfg.get('context_length')}, "
            f"tools_tokens~{tools_token_estimate}, "
            f"prompt_tokens~{prompt_tokens}. "
            f"Increase model context in LM Studio or reduce context_length in config.",
        )
        prompts = settings_mod.CFG.get("prompts") or {}
        return prompts.get("conversation_too_long") or (
            "Conversation too long. Please start a new session or send a shorter message."
        )
    msg = f"Model Error: {err_code}"
    if err_detail:
        msg += " — " + (err_detail[:200] if len(err_detail) > 200 else err_detail)
    return msg


async def stream_agent_llm_turn(
    *,
    client,
    llm_url: str,
    payload: Dict[str, Any],
    llm_cfg: Dict[str, Any],
    llm_headers: Optional[Dict[str, str]],
    has_image_in_msgs: bool,
    request_start: float,
    md_buf: _MarkdownStreamBuffer,
    first_content_state: Dict[str, bool],
) -> AsyncIterator[Any]:
    """Stream one agent LLM turn. Mutates ``first_content_state['yielded']`` on first token."""
    llm_timeout = float(llm_cfg.get("timeout", TIMEOUT_LLM))
    stream_done: Optional[Dict[str, Any]] = None
    vision_stream_failed = False

    if has_image_in_msgs:
        yield _event_status("search_web_images", label="Analizez imaginea")

    try:
        if has_image_in_msgs:
            try:
                async for event in _stream_llm_turn(client, llm_url, payload, llm_timeout, llm_headers):
                    if isinstance(event, dict) and event.get("t") == "_stream_done":
                        stream_done = event
                        err_detail = str(event.get("error_detail") or "").lower()
                        if event.get("error") and (
                            "image" in err_detail or "multimodal" in err_detail or "vision" in err_detail
                        ):
                            vision_stream_failed = True
                            stream_done = None
                        break
                    if isinstance(event, dict) and event.get("t") == "thinking":
                        if not first_content_state.get("yielded"):
                            first_content_state["yielded"] = True
                            ttft = round((time.monotonic() - request_start) * 1000)
                            log_line("agent", "⏱️", "TTFT", f"{ttft}ms (first thinking token)")
                        yield event
                        continue
                    if isinstance(event, str):
                        if not first_content_state.get("yielded"):
                            first_content_state["yielded"] = True
                            ttft = round((time.monotonic() - request_start) * 1000)
                            log_line("agent", "⏱️", "TTFT", f"{ttft}ms (first content token)")
                        for buf_chunk in md_buf.feed(event):
                            yield buf_chunk
                        continue
                buf_tail = md_buf.flush()
                if buf_tail:
                    yield buf_tail
            except Exception as exc:
                log_line(
                    "agent",
                    "🖼",
                    "VISION",
                    f"Streaming failed ({type(exc).__name__}: {str(exc)[:120]}), falling back to non-streaming",
                )
                vision_stream_failed = True

            if vision_stream_failed:
                log_line("agent", "🖼", "VISION", "Non-streaming fallback for vision call")
                ns_payload = {**payload, "stream": False}
                response = await client.post(
                    llm_url, json=ns_payload, timeout=llm_timeout, headers=llm_headers or {},
                )
                if response.status_code != 200:
                    body_hint = response.text[:300] if response.text else "(empty)"
                    stream_done = {
                        "t": "_stream_done",
                        "content": "",
                        "tool_calls": [],
                        "finish_reason": "error",
                        "error": response.status_code,
                        "error_detail": body_hint,
                    }
                else:
                    ns_data = response.json()
                    ns_choice = (ns_data.get("choices") or [{}])[0]
                    ns_msg = ns_choice.get("message") or {}
                    ns_content = (ns_msg.get("content") or "").strip()
                    ns_reasoning = (ns_msg.get("reasoning_content") or "").strip()
                    if ns_reasoning:
                        yield {"t": "thinking", "content": ns_reasoning}
                    if not ns_content and ns_reasoning:
                        ns_content = ns_reasoning
                    if ns_content:
                        yield ns_content
                    stream_done = {
                        "t": "_stream_done",
                        "content": ns_content,
                        "tool_calls": [],
                        "finish_reason": ns_choice.get("finish_reason") or "stop",
                        "reasoning_content": ns_reasoning or None,
                    }
        else:
            async for event in _stream_llm_turn(client, llm_url, payload, llm_timeout, llm_headers):
                if isinstance(event, dict) and event.get("t") == "_stream_done":
                    stream_done = event
                    break
                if isinstance(event, dict) and event.get("t") == "thinking":
                    if not first_content_state.get("yielded"):
                        first_content_state["yielded"] = True
                        ttft = round((time.monotonic() - request_start) * 1000)
                        log_line("agent", "⏱️", "TTFT", f"{ttft}ms (first thinking token)")
                    yield event
                    continue
                if isinstance(event, str):
                    if not first_content_state.get("yielded"):
                        first_content_state["yielded"] = True
                        ttft = round((time.monotonic() - request_start) * 1000)
                        log_line("agent", "⏱️", "TTFT", f"{ttft}ms (first content token)")
                    for buf_chunk in md_buf.feed(event):
                        yield buf_chunk
                    continue
            buf_tail = md_buf.flush()
            if buf_tail:
                yield buf_tail
    except Exception as exc:
        log_line("agent", "⚠️", "LLM ERROR", f"{type(exc).__name__}: {exc}")
        yield f"Error: {str(exc)}"
        return

    yield {"t": "_agent_stream_done", "stream_done": stream_done}
