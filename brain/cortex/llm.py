"""LLM HTTP helpers, summarization, and streaming turns."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

import httpx
import settings as settings_mod
from logger import log_line, log_detail
from llm_client import get_llm_client
from brain.cortex.config import TIMEOUT_LLM
from brain.cortex.messages import (
    _compute_safe_completion_tokens,
    _ensure_text_user_message,
    _estimate_messages_tokens,
    _normalize_messages_for_api,
    _trim_messages_to_fit,
    sanitize_input,
)
from brain.cortex.thinking import RE_HA_CALL_LOG, strip_think

def _normalize_chat_url(url: str) -> str:
    """Ensure URL points to chat/completions. Z.AI and others use base .../v4 or .../v1; append /chat/completions if missing."""
    u = (url or "").strip()
    if not u or "chat/completions" in u or "chat/" in u:
        return u
    base = u.rstrip("/")
    # Grok API is OpenAI-compatible, so treat like Z.AI/OpenAI
    if base.endswith("/v4") or base.endswith("/v1") or base.endswith("/grok"):
        return base + "/chat/completions"
    return u


def _llm_headers(api_key: Optional[str]) -> Dict[str, str]:
    """Headers for LLM requests (e.g. Z.AI Bearer). Empty if no api_key."""
    if not api_key or not str(api_key).strip():
        return {}
    raw_key = str(api_key)
    # Remove any whitespace copied with the token (spaces/newlines/tabs)
    compact_key = "".join(raw_key.split())
    # HTTP header values must be ASCII.
    safe_key = compact_key.encode("ascii", errors="ignore").decode("ascii")
    if safe_key != raw_key:
        log_line("agent", "⚠️", "LLM API KEY", "Whitespace/non-ASCII removed from API key for header safety")
    return {"Authorization": f"Bearer {safe_key}"} if safe_key else {}


def _get_aux_or_main_llm() -> Tuple[str, str, str]:
    """Return (url, model, api_key) preferring aux_llm when configured, falling back to main llm."""
    aux = (settings_mod.CFG.get("intelligence") or {}).get("aux_llm") or {}
    llm_cfg = settings_mod.CFG.get("llm") or {}
    url = (aux.get("target_url") or "").strip() or llm_cfg.get("target_url", "")
    url = _normalize_chat_url(url)
    model = (aux.get("model_name") or "").strip() or llm_cfg.get("model_name", "")
    api_key = (aux.get("api_key") or "").strip() or (llm_cfg.get("api_key") or "").strip()
    return url, model, api_key


# ── Legacy UPDATE_MEMORY_PROMPT kept only for save_fact_from_agent (agent tool path) ──


async def summarize_conversation(messages: List[Dict]) -> str:
    if not messages:
        return ""
    cleaned = []
    for m in messages:
        content = RE_HA_CALL_LOG.sub("", m.get("content", "")).strip()
        if not content:
            continue
        role = m.get("role", "user")
        label = "User" if role == "user" else "Assistant"
        cleaned.append(f"{label}: {content[:500]}")
    if not cleaned:
        return ""
    block = "\n".join(cleaned[-20:])
    prompt = (settings_mod.CFG.get("prompts") or {}).get("summarize") or "Summarize the conversation below in 2-4 sentences. Do NOT reason or think — reply with ONLY the summary."
    sum_url, sum_model, sum_api_key = _get_aux_or_main_llm()
    try:
        client = await get_llm_client()
        payload_to_send = {
            "model": sum_model,
            "messages": [{"role": "user", "content": f"{prompt}\n\n---\n{block}\n\n/no_think"}],
            "temperature": 0.3,
            "max_tokens": 384,
        }
        resp = await client.post(
            sum_url,
            timeout=30.0,
            headers=_llm_headers(sum_api_key),
            json=payload_to_send,
        )
        if resp.status_code != 200:
            log_line("error", "⚠️", "SUMMARIZE", f"LLM returned {resp.status_code}: {resp.text[:200]}")
            return ""
        out = (resp.json().get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
        # Strip <think>...</think> tags from thinking models
        import re as _re_sum
        out = _re_sum.sub(r"<think>.*?</think>", "", out, flags=_re_sum.S).strip()
        # Strip unclosed <think> tags (when max_tokens cuts off mid-thinking)
        out = _re_sum.sub(r"<think>.*", "", out, flags=_re_sum.S).strip()
        if len(out) > 600:
            out = out[:597] + "..."
        log_line("mem", "📋", "SUMMARIZE", f"OK ({len(block)} chars → {len(out)} chars)")
        return out
    except Exception as e:
        log_line("error", "⚠️", "SUMMARIZE", f"{type(e).__name__}: {e}")
        return ""






# ---------------------------------------------------------------------------
# AGENT MODE: tool-use loop (the AI decides, we execute)
# ---------------------------------------------------------------------------

async def _stream_llm_turn(
    client, url: str, payload: dict, timeout: float, headers: Optional[Dict[str, str]] = None,
) -> Any:
    """
    Stream LLM response (OpenAI-compatible format); yield thinking and content events in real time.
    Supports: delta.content, delta.reasoning_content (and aliases), <think> tags in content.
    Yields: {"t": "thinking", "content": "..."} | str (content chunk) | {"t": "_stream_done", ...}.
    """
    payload = {**payload, "stream": True}
    payload.setdefault("stream_options", {"include_usage": True})
    full_content = ""
    full_reasoning = ""
    tool_calls_acc: Dict[int, Dict] = {}
    finish_reason = ""
    _t_stream_start = time.monotonic()
    _t_first_token: float | None = None
    usage_prompt_tokens = None
    usage_completion_tokens = None
    usage_total_tokens = None
    parser = _ThinkContentStreamParser()
    seen_tag_based_thinking = False  # True once we see <think> or <thinking> in content
    req_headers = headers or {}

    def _norm_str(v: Any) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (list, dict)):
            return json.dumps(v, ensure_ascii=False)
        return str(v)

    _thinking_buf: list[str] = []

    def _log_thinking(c: str) -> None:
        """Buffer thinking tokens; they are flushed as a single log line by _flush_thinking."""
        if not c or not c.strip():
            return
        _thinking_buf.append(c)

    def _flush_thinking() -> None:
        """Flush buffered thinking tokens into one log line."""
        if not _thinking_buf:
            return
        combined = "".join(_thinking_buf).strip()
        _thinking_buf.clear()
        if not combined:
            return
        preview = (combined[:280] + "…" if len(combined) > 280 else combined).replace("\n", " ")
        log_line("agent", "💭", "THINKING", preview)

    try:
        async with client.stream("POST", url, json=payload, timeout=timeout, headers=req_headers) as response:
            if response.status_code != 200:
                err_text = (await response.aread()).decode(errors="replace")[:500]
                log_line("agent", "⚠️", "LLM STREAM ERROR", f"HTTP {response.status_code}: {err_text}")
                yield {"t": "_stream_done", "content": "", "tool_calls": [], "finish_reason": "error", "error": response.status_code, "error_detail": err_text}
                return
            stream_done_flag = False
            async for line in response.aiter_lines():
                if stream_done_flag:
                    break
                # Support multiple "data: {...}" in one line (Z.ai / some proxies)
                parts = [p.strip() for p in (line or "").strip().split("data:") if p.strip()]
                for data_str in parts:
                    if data_str == "[DONE]":
                        stream_done_flag = True
                        break
                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    # Detect SSE-level error events (e.g. LM Studio context overflow)
                    if isinstance(chunk.get("error"), (dict, str)):
                        err_detail = chunk["error"]
                        if isinstance(err_detail, dict):
                            err_detail = err_detail.get("message") or json.dumps(err_detail)
                        log_line("agent", "⚠️", "LLM SSE ERROR", str(err_detail)[:300])
                        yield {"t": "_stream_done", "content": "", "tool_calls": [], "finish_reason": "error", "error": f"SSE: {err_detail}"}
                        return
                    choice = (chunk.get("choices") or [{}])[0] if isinstance((chunk.get("choices") or [{}])[0], dict) else {}
                    delta = choice.get("delta") or {}
                    finish_reason = choice.get("finish_reason") or finish_reason

                    usage = chunk.get("usage") if isinstance(chunk.get("usage"), dict) else None
                    if usage:
                        if isinstance(usage.get("prompt_tokens"), int):
                            usage_prompt_tokens = usage.get("prompt_tokens")
                        if isinstance(usage.get("completion_tokens"), int):
                            usage_completion_tokens = usage.get("completion_tokens")
                        if isinstance(usage.get("total_tokens"), int):
                            usage_total_tokens = usage.get("total_tokens")

                    content = _norm_str(delta.get("content"))

                    # Thinking: delta.reasoning_content (OpenAI-compatible; GLM, DeepSeek, grok-3-mini).
                    # Note: x.ai Grok-4 / grok-4-fast-reasoning do NOT expose reasoning_content in Chat Completions;
                    # thinking may still appear if the model emits <think>...</think> in content (tag parser below).
                    reasoning = _norm_str(
                        delta.get("reasoning_content")
                        or delta.get("reasoning")
                        or delta.get("thinking_content")
                        or delta.get("thought")
                    )
                    if reasoning:
                        full_reasoning += reasoning
                        _log_thinking(reasoning)
                        yield {"t": "thinking", "content": reasoning}

                    # Content: always use delta.content (standard OpenAI streaming)
                    content = content or ""
                    if content:
                        if _t_first_token is None:
                            _t_first_token = time.monotonic()
                        full_content += content
                        # Stream content to the client as it arrives
                        if full_reasoning:
                            _flush_thinking()
                            yield content
                        elif not seen_tag_based_thinking:
                            for event in parser.feed(content):
                                if isinstance(event, dict):
                                    if event.get("t") == "thinking":
                                        seen_tag_based_thinking = True
                                        _log_thinking(event.get("content") or "")
                                    yield event
                                else:
                                    yield event
                        else:
                            for event in parser.feed(content):
                                if isinstance(event, dict):
                                    if event.get("t") == "thinking":
                                        _log_thinking(event.get("content") or "")
                                    yield event
                                else:
                                    yield event
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index")
                        if idx is None:
                            continue
                        if idx not in tool_calls_acc:
                            tool_calls_acc[idx] = {"id": "", "function": {"name": "", "arguments": ""}}
                        acc = tool_calls_acc[idx]
                        if tc.get("id"):
                            acc["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            acc["function"]["name"] = fn["name"]
                        if fn.get("arguments"):
                            acc["function"]["arguments"] = acc["function"]["arguments"] + fn["arguments"]

        _flush_thinking()
        had_reasoning_channel = bool(full_reasoning)
        flush_events = parser.flush()
        for event in flush_events:
            if isinstance(event, dict):
                if event.get("t") == "thinking":
                    seen_tag_based_thinking = True
                    _log_thinking(event.get("content") or "")
            yield event

        tool_calls_list = []
        for i in sorted(tool_calls_acc.keys()):
            acc = tool_calls_acc[i]
            if acc.get("function", {}).get("name"):
                tool_calls_list.append({"id": acc.get("id", ""), "function": acc["function"]})

        # Fallback: parse <tool_call> tags from content (Qwen, some models put tool calls in content)
        if not tool_calls_list and full_content and "<tool_call>" in full_content.lower():
            for m in RE_TOOL_CALL_BLOCK.finditer(full_content):
                try:
                    tc_obj = json.loads(m.group(1))
                    fn_name = tc_obj.get("name") or ""
                    fn_args = tc_obj.get("arguments") or tc_obj.get("parameters") or {}
                    if fn_name:
                        tool_calls_list.append({
                            "id": str(uuid.uuid4()),
                            "function": {
                                "name": fn_name,
                                "arguments": json.dumps(fn_args, ensure_ascii=False) if isinstance(fn_args, dict) else str(fn_args),
                            },
                        })
                        log_line("agent", "🔧", "TOOL_CALL (content)", f"Parsed from <tool_call> in content: {fn_name}")
                except (json.JSONDecodeError, Exception) as e:
                    log_line("agent", "⚠️", "TOOL_CALL PARSE", f"Failed to parse <tool_call> block: {e}")
            if tool_calls_list:
                # Strip the tool_call blocks and think blocks from content (they are not user-visible)
                cleaned = RE_TOOL_CALL_BLOCK.sub("", full_content)
                cleaned = RE_THINK_BLOCK.sub("", cleaned).strip()
                full_content = cleaned

        _flush_thinking()
        _llm_elapsed = (time.monotonic() - _t_stream_start) * 1000
        _ttft = ((_t_first_token - _t_stream_start) * 1000) if _t_first_token else _llm_elapsed
        yield {
            "t": "_stream_done",
            "content": full_content,
            "tool_calls": tool_calls_list,
            "finish_reason": finish_reason,
            "reasoning_content": full_reasoning or None,
            "prompt_tokens": usage_prompt_tokens,
            "completion_tokens": usage_completion_tokens,
            "total_tokens": usage_total_tokens,
            "ttft_ms": round(_ttft, 1),
            "llm_elapsed_ms": round(_llm_elapsed, 1),
        }
    except Exception as e:
        log_line("agent", "⚠️", "LLM STREAM", f"{type(e).__name__}: {e}")
        _flush_thinking()
        _llm_elapsed = (time.monotonic() - _t_stream_start) * 1000
        yield {"t": "_stream_done", "content": full_content, "tool_calls": [], "finish_reason": "error", "error": str(e), "reasoning_content": full_reasoning or None, "prompt_tokens": usage_prompt_tokens, "completion_tokens": usage_completion_tokens, "total_tokens": usage_total_tokens, "ttft_ms": None, "llm_elapsed_ms": round(_llm_elapsed, 1)}


async def _describe_image_with_vision_llm(image_base64: str, user_prompt: str) -> str:
    """Trimite imaginea la modelul vision și returnează descrierea (text).
    Fallback: dacă vision_llm nu e configurat, folosește modelul principal."""
    vision_cfg = (settings_mod.CFG.get("vision_llm") or {})
    url = _normalize_chat_url((vision_cfg.get("target_url") or "").strip())
    model = (vision_cfg.get("model_name") or "").strip()
    if not url or not model:
        # Fallback: use main LLM (works if it supports vision / multimodal)
        llm_cfg_fb = settings_mod.CFG.get("llm") or {}
        url = _normalize_chat_url((llm_cfg_fb.get("target_url") or "").strip())
        model = (llm_cfg_fb.get("model_name") or "").strip()
        if not url or not model:
            return ""
        log_line("agent", "🖼", "VISION FALLBACK", f"Using main LLM ({model}) — no vision_llm configured")
        vision_cfg = llm_cfg_fb  # use main LLM's timeout/api_key
    timeout = float(vision_cfg.get("timeout") or 60)
    data_url = image_base64 if image_base64.startswith("data:") else f"data:image/jpeg;base64,{image_base64.strip()}"
    sec_cfg = settings_mod.CFG.get("security") or {}
    safety_prefix = (sec_cfg.get("vision_untrusted_text_prompt") or "").strip()
    prompt = (user_prompt or "Describe this image in detail: what you see, text visible, objects, layout, colors. Reply in the same language as the user request if possible.").strip()
    if safety_prefix:
        prompt = f"{safety_prefix}\n\nUser request: {prompt}"
    messages = [
        {"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": data_url}}]}
    ]
    payload = {"model": model, "messages": messages, "stream": False, "max_tokens": 1024}
    try:
        client = await get_llm_client()
        r = await client.post(url, json=payload, timeout=timeout, headers=_llm_headers(vision_cfg.get("api_key") or ""))
        if r.status_code != 200:
            body_hint = r.text[:300] if r.text else "(empty)"
            log_line("agent", "⚠️", "VISION LLM ERROR", f"HTTP {r.status_code} url={url} model={model} body={body_hint}")
            return ""
        data = r.json()
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        content = (msg.get("content") or "").strip()
        # Thinking-mode models (e.g. Qwen3) put the answer in reasoning_content
        if not content and msg.get("reasoning_content"):
            content = msg["reasoning_content"].strip()
            log_line("agent", "📷", "VISION", "used reasoning_content (thinking-mode model)")
        return content
    except Exception as e:
        log_line("agent", "⚠️", "VISION LLM", str(e)[:150])
        return ""
