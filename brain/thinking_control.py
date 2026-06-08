"""Suppress hybrid-model thinking (Qwen3+) when /no_think in the prompt is ignored.

Ollama hybrid models stopped honoring /no_think in v0.12.3+.
Use instead (OpenAI-compat /v1/chat/completions):
  - reasoning_effort: "none"
  - think: false (newer Ollama builds)
  - trailing assistant prefill with an empty thinking block (briefings workaround)

User-facing modes (chat UI): auto | think | no_think
"""
from __future__ import annotations

import copy
import re
from typing import Any, Literal

ThinkingMode = Literal["auto", "think", "no_think"]
DEFAULT_THINKING_MODE: ThinkingMode = "auto"
VALID_THINKING_MODES = frozenset({"auto", "think", "no_think"})

OLLAMA_THINK_PREFILL = "<think>\n\n</think>\n\n"
_NO_THINK_SUFFIX_RE = re.compile(r"\s*/no_think\s*$", re.I)


def is_qwen_thinking_model(model_name: str) -> bool:
    model = (model_name or "").lower()
    return "qwen" in model and any(token in model for token in ("qwen3", "qwen2.5", "qwen-3", "qwen/"))


def should_suppress_thinking(model_name: str, tool_intent: str, user_msg: str = "") -> bool:
    """Auto mode: suppress only for casual simple_chat / memory on hybrid Qwen models."""
    if not is_qwen_thinking_model(model_name):
        return False
    if tool_intent == "memory":
        return True
    if tool_intent == "simple_chat":
        from intent_router import is_casual_message
        return is_casual_message(user_msg)
    return False


def normalize_thinking_mode(mode: str | None) -> ThinkingMode:
    raw = (mode or DEFAULT_THINKING_MODE).strip().lower().replace("-", "_")
    if raw in ("no_think", "nothink", "no think"):
        return "no_think"
    if raw in VALID_THINKING_MODES:
        return raw  # type: ignore[return-value]
    return DEFAULT_THINKING_MODE


def resolve_thinking_suppression(
    model_name: str,
    tool_intent: str,
    user_msg: str = "",
    thinking_mode: str | None = DEFAULT_THINKING_MODE,
) -> bool:
    """Return True when the next LLM request should suppress internal reasoning."""
    mode = normalize_thinking_mode(thinking_mode)
    if mode == "think":
        return False
    if mode == "no_think":
        return is_qwen_thinking_model(model_name)
    return should_suppress_thinking(model_name, tool_intent, user_msg)


def is_ollama_openai_endpoint(target_url: str, provider: str = "") -> bool:
    """True only for Ollama OpenAI-compat endpoints (not LM Studio / other local servers)."""
    url = (target_url or "").lower()
    prov = (provider or "").lower()
    if prov == "ollama":
        return True
    if "11434" in url or "/ollama" in url:
        return True
    return False


def _strip_no_think_suffix(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = copy.deepcopy(messages)
    for msg in out:
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            stripped = _NO_THINK_SUFFIX_RE.sub("", content).strip()
            # Never blank the only user text — local jinja templates require a query.
            if stripped:
                msg["content"] = stripped
    return out


def _append_no_think_suffix(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = copy.deepcopy(messages)
    for idx in range(len(out) - 1, -1, -1):
        if out[idx].get("role") != "user":
            continue
        content = out[idx].get("content")
        if isinstance(content, str) and "/no_think" not in content.lower():
            out[idx] = {**out[idx], "content": content.rstrip() + " /no_think"}
        break
    return out


def _has_think_prefill(messages: list[dict[str, Any]]) -> bool:
    if not messages or messages[-1].get("role") != "assistant":
        return False
    content = str(messages[-1].get("content") or "")
    return "<think>" in content or "<thinking>" in content.lower()


def _should_append_think_prefill(messages: list[dict[str, Any]]) -> bool:
    """Ollama think prefill after tool messages breaks Qwen jinja ('No user query found')."""
    if not messages:
        return False
    last = messages[-1]
    role = last.get("role")
    if role == "tool":
        return False
    if role == "assistant" and last.get("tool_calls"):
        return False
    return True


def apply_thinking_suppression(
    payload: dict[str, Any],
    messages: list[dict[str, Any]],
    *,
    target_url: str,
    model_name: str,
    provider: str = "",
    suppress: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Apply provider-specific thinking suppression. Returns (payload, messages)."""
    if not suppress:
        return payload, messages

    out_payload = dict(payload)
    out_messages = _strip_no_think_suffix(messages)

    if is_ollama_openai_endpoint(target_url, provider):
        # https://docs.ollama.com/api/openai-compatibility — reasoning_effort: none
        out_payload["reasoning_effort"] = "none"
        out_payload["think"] = False
        if (
            not _has_think_prefill(out_messages)
            and _should_append_think_prefill(out_messages)
        ):
            out_messages.append({"role": "assistant", "content": OLLAMA_THINK_PREFILL})
        return out_payload, out_messages

    out_payload["enable_thinking"] = False
    out_payload["chat_template_kwargs"] = {"enable_thinking": False}
    out_messages = _append_no_think_suffix(out_messages)
    return out_payload, out_messages
