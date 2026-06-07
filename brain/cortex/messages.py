"""History cleaning, token budgeting, and input sanitization."""

from __future__ import annotations

import copy
import re
from functools import lru_cache
from typing import Any, Dict, List, Optional

import settings as settings_mod
from brain.injection_guard import sanitize_untrusted_content
from brain.cortex.thinking import RE_HA_CALL_LOG

def clean_history(history: List[Dict]) -> List[Dict]:
    """Preserve role, content, tool_calls, tool_call_id so the model sees prior tool-use and uses tools again.
    Skips notification messages (automated system notifications injected into session history)
    — they break the user→assistant alternation and can push user messages out of the
    lazy-history window, causing 'No user query found' errors in local LLM jinja templates.
    Also prevents orphaned tool messages (role='tool' without a preceding tool_calls) which
    cause API 400 errors."""
    clean_msgs = []
    if not history:
        return []
    # First pass: collect tool_call_ids from assistant messages we'll keep
    kept_tool_call_ids = set()
    for msg in history:
        if msg.get("notification"):
            continue
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "assistant":
            tc = msg.get("tool_calls")
            if tc and isinstance(tc, list) and len(tc) > 0:
                for call in tc:
                    call_id = call.get("id") if isinstance(call, dict) else None
                    if call_id:
                        kept_tool_call_ids.add(call_id)
            elif not content and not tc:
                continue  # will be skipped in second pass too
    for msg in history:
        # Skip automated notification messages
        if msg.get("notification"):
            continue
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "tool":
            # Only keep tool messages whose tool_call_id matches a kept assistant's tool_calls
            tc_id = msg.get("tool_call_id", "")
            if tc_id and tc_id not in kept_tool_call_ids:
                continue  # orphaned tool message — skip to prevent API 400
            clean_msgs.append({"role": "tool", "content": RE_HA_CALL_LOG.sub("", content or ""), "tool_call_id": tc_id})
            continue
        if role == "assistant" and not content and not msg.get("tool_calls"):
            continue
        content = RE_HA_CALL_LOG.sub("", content or "")
        # Strip <think>/<thinking> blocks from assistant messages so the model
        # never sees its own prior reasoning chain and gets confused.
        if role == "assistant" and isinstance(content, str):
            content = strip_think(content)
        out = {"role": role, "content": content if content else ""}
        tc = msg.get("tool_calls")
        if tc and isinstance(tc, list) and len(tc) > 0:
            out["tool_calls"] = tc
        # Preserve model_name so cross-model awareness check can use it
        if role == "assistant" and msg.get("model_name"):
            out["model_name"] = msg["model_name"]
        clean_msgs.append(out)
    return clean_msgs


def _normalize_messages_for_api(messages: List[Dict]) -> List[Dict]:
    """Ensure messages have API-safe types: content always string (never None), tool_calls with valid id/function.
    For assistant messages, always include reasoning_content (at least "") so providers like DeepSeek accept the request.
    Also removes orphaned tool messages (tool messages without a preceding assistant with matching tool_calls)."""
    # Collect all tool_call IDs from assistant messages
    valid_tc_ids = set()
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            for tc in msg["tool_calls"]:
                tid = tc.get("id") if isinstance(tc, dict) else None
                if tid:
                    valid_tc_ids.add(tid)

    out = []
    for i, msg in enumerate(messages):
        role = msg.get("role", "user")
        content = msg.get("content")
        if content is None:
            content = ""
        if not isinstance(content, str) and not isinstance(content, list):
            content = str(content) if content else ""
        m = {"role": role, "content": content}
        if role == "assistant":
            # Only include reasoning_content when non-empty.
            # Always sending reasoning_content="" breaks local LLM jinja templates (e.g. Qwen3 in LM Studio).
            # DeepSeek only needs it when actual thinking was produced (non-empty string).
            rc = msg.get("reasoning_content")
            if rc:
                m["reasoning_content"] = rc
        if role == "tool":
            tc_id = msg.get("tool_call_id") or ""
            # Skip orphaned tool messages that have no matching assistant tool_call
            if tc_id and tc_id not in valid_tc_ids:
                continue
            m["tool_call_id"] = tc_id
            out.append(m)
            continue
        if msg.get("tool_calls"):
            tool_calls = []
            for j, tc in enumerate(msg["tool_calls"]):
                fn = tc.get("function") or {}
                tid = tc.get("id")
                if not isinstance(tid, str):
                    tid = f"call_{i}_{j}"
                tool_calls.append({
                    "id": tid,
                    "type": "function",
                    "function": {
                        "name": fn.get("name") or "",
                        "arguments": fn.get("arguments") if isinstance(fn.get("arguments"), str) else json.dumps(fn.get("arguments") or {}),
                    },
                })
            m["tool_calls"] = tool_calls
        out.append(m)
    return out


def _ensure_text_user_message(messages: List[Dict]) -> List[Dict]:
    """Guarantee at least one text-bearing user message for local LLM prompt templates.

    Some local backends render chat via jinja templates that expect a user query
    as plain text. Tool-heavy turns or multimodal-only payloads can otherwise trip
    errors like: "No user query found in messages.".
    """
    normalized = _normalize_messages_for_api(messages)
    has_text_user = any(
        msg.get("role") == "user" and _message_content_to_text(msg.get("content")).strip()
        for msg in normalized
    )
    if has_text_user:
        return normalized

    fallback_text = "[continuing conversation]"
    for msg in reversed(normalized):
        text = _message_content_to_text(msg.get("content")).strip()
        if text:
            fallback_text = text
            break

    log_line("agent", "⚠️", "MSG_VALIDATION", "Injecting synthetic user text for local prompt-template compatibility")
    return normalized + [{"role": "user", "content": fallback_text}]


@lru_cache(maxsize=8)
def _get_tiktoken_encoder(model_name: str):
    """Best-effort token encoder: use model-specific encoder, fallback to cl100k_base."""
    try:
        import tiktoken  # type: ignore[import-not-found]  # optional dependency
    except ImportError:
        return None  # tiktoken not installed; use heuristic fallback

    if model_name:
        try:
            return tiktoken.encoding_for_model(model_name)
        except (KeyError, ValueError):
            pass  # unknown model; fall through to cl100k_base
    try:
        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None  # encoding unavailable; caller uses heuristic


def _message_content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: List[str] = []
        for part in content:
            if not isinstance(part, dict):
                chunks.append(str(part))
                continue
            if part.get("type") == "text" and part.get("text"):
                chunks.append(str(part.get("text")))
            elif part.get("type") == "image_url":
                chunks.append("[image]")
            elif part.get("text"):
                chunks.append(str(part.get("text")))
        return "\n".join(chunks)
    return str(content)


def _estimate_tokens(text: str, model_name: str = "") -> int:
    """Token count with optional tiktoken; falls back to heuristic if unavailable."""
    if not text:
        return 0
    encoder = _get_tiktoken_encoder(model_name or "")
    if encoder is not None:
        try:
            return max(1, len(encoder.encode(text)))
        except Exception:
            pass  # encode failed; fall through to heuristic
    return max(1, len(text) // 3)


def _estimate_messages_tokens(messages: List[Dict], model_name: str = "") -> int:
    """Estimate total tokens for messages (role overhead + content + tool metadata)."""
    total = 0
    for msg in messages:
        total += 4
        total += _estimate_tokens(_message_content_to_text(msg.get("content", "")), model_name=model_name)
        if msg.get("tool_calls"):
            total += _estimate_tokens(json.dumps(msg.get("tool_calls"), ensure_ascii=False), model_name=model_name)
        if msg.get("tool_call_id"):
            total += _estimate_tokens(str(msg.get("tool_call_id")), model_name=model_name)
    return total


def _build_summary_buffer(dropped_messages: List[Dict], max_chars: int = 1200) -> str:
    """Create a compact topic-level summary from dropped messages.

    IMPORTANT: The output must NOT look like actual conversation turns.
    Raw snippets like 'Utilizator: ce faci?' confuse local LLMs into
    responding to the old text instead of the latest user message.
    Use neutral topic descriptions instead.
    """
    if not dropped_messages:
        return ""

    snippets: List[str] = []
    for msg in dropped_messages:
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        raw = _message_content_to_text(msg.get("content", ""))
        text = " ".join((raw or "").split())
        if not text:
            continue
        # Use neutral third-person labels — never "Utilizator:" / "User:"
        # which local models confuse with actual current user intent.
        prefix = "[user said]" if role == "user" else "[assistant replied]"
        snippets.append(f"{prefix} {text[:200]}")
        if len(snippets) >= 8:
            break

    if not snippets:
        return ""
    summary = " → ".join(snippets)
    if len(summary) > max_chars:
        summary = summary[: max_chars - 3].rstrip() + "..."
    return summary


def _compute_safe_completion_tokens(max_context: int, prompt_tokens: int, requested_max_tokens: int, min_completion: int = 128) -> int:
    """Clamp completion tokens to avoid context overflow."""
    requested_max_tokens = max(16, int(requested_max_tokens or min_completion))
    min_completion = max(16, min(min_completion, requested_max_tokens))
    available = max_context - prompt_tokens - 64
    if available <= 0:
        return min_completion
    return max(min_completion, min(requested_max_tokens, available))


def _trim_messages_to_fit(
    messages: List[Dict],
    max_tokens: int,
    reserve_for_response: int = 1024,
    enable_summary_buffer: bool = True,
    model_name: str = "",
) -> List[Dict]:
    """Sliding-window trim that always keeps system prompt and latest user message."""
    if not messages:
        return messages

    max_tokens = max(512, int(max_tokens or 0))
    budget = max_tokens - max(128, int(reserve_for_response or 0))
    if budget <= 0:
        budget = int(max_tokens * 0.7)

    system_msgs = []
    if messages[0].get("role") == "system":
        system_msgs = [messages[0]]
        body = messages[1:]
    else:
        body = messages

    if not body:
        return system_msgs

    latest_user_idx = None
    for idx in range(len(body) - 1, -1, -1):
        if body[idx].get("role") == "user":
            latest_user_idx = idx
            break

    selected_indices: set = set()
    if latest_user_idx is not None:
        selected_indices.add(latest_user_idx)

    for idx in range(len(body) - 1, -1, -1):
        if idx in selected_indices:
            continue
        candidate_indices = sorted(selected_indices | {idx})
        candidate_msgs = system_msgs + [body[i] for i in candidate_indices]
        if _estimate_messages_tokens(candidate_msgs, model_name=model_name) <= budget:
            selected_indices.add(idx)

    kept_middle = [body[i] for i in sorted(selected_indices)]
    dropped_messages = [body[i] for i in range(len(body)) if i not in selected_indices]
    result = system_msgs + kept_middle

    if enable_summary_buffer and dropped_messages:
        summary = _build_summary_buffer(dropped_messages)
        if summary:
            summary_label = (
                "[EARLIER CONTEXT — already handled, do NOT respond to these]\n"
                f"{summary}"
            )
            summary_msg = {
                "role": "system",
                "content": summary_label,
            }
            with_summary = system_msgs + [summary_msg] + kept_middle
            if _estimate_messages_tokens(with_summary, model_name=model_name) <= budget:
                result = with_summary
            else:
                available_for_summary = budget - _estimate_messages_tokens(system_msgs + kept_middle, model_name=model_name)
                if available_for_summary > 64:
                    target_chars = max(80, available_for_summary * 3)
                    summary_short = summary[:target_chars].rstrip()
                    if summary_short:
                        result = system_msgs + [{"role": "system", "content": f"[EARLIER CONTEXT — already handled]\n{summary_short}"}] + kept_middle

    trimmed_count = len(dropped_messages)
    if trimmed_count > 0:
        current_tokens = _estimate_messages_tokens(result, model_name=model_name)
        log_line("agent", "✂️", "TRIM", f"Dropped {trimmed_count} older messages; prompt ~{current_tokens}/{budget} tokens")

    return result


def _collapse_old_tool_turns(messages: List[Dict], keep_recent_turns: int = 1) -> List[Dict]:
    """Collapse tool exchanges from older turns — keep only user + final assistant text.

    Problem: after a few turns the history is full of intermediate tool_call / tool result
    messages (recall_memory, search_web, store_memory, etc.) that fragment the
    conversational flow.  Local LLMs lose track of the thread because they see
    huge tool-result blobs between short human exchanges.

    Solution: for all turns except the most recent N, strip tool/tool_call messages
    and keep only the user message + the final assistant text response.
    The last N turns keep full tool context so the model can still learn tool-use patterns.
    """
    if not messages:
        return messages

    # Split into turns: a turn starts at each user message
    turns: List[List[Dict]] = []
    current_turn: List[Dict] = []
    for msg in messages:
        if msg.get("role") == "user" and current_turn:
            turns.append(current_turn)
            current_turn = []
        current_turn.append(msg)
    if current_turn:
        turns.append(current_turn)

    if len(turns) <= keep_recent_turns:
        return messages  # Few turns — keep everything

    result: List[Dict] = []
    cutoff = len(turns) - keep_recent_turns

    for i, turn in enumerate(turns):
        if i < cutoff:
            # Older turn: keep user message + short assistant summary only.
            # CRITICAL: local LLMs latch onto long old responses and repeat them
            # instead of attending to current tool results. Truncate aggressively.
            user_msg = None
            last_assistant_text = None
            for msg in turn:
                role = msg.get("role")
                if role == "user":
                    user_msg = {"role": "user", "content": msg.get("content", "")}
                elif role == "assistant" and not msg.get("tool_calls"):
                    content = (msg.get("content") or "").strip()
                    if content:
                        # Truncate to prevent the model from regurgitating old responses
                        max_old_response = 150
                        if len(content) > max_old_response:
                            content = content[:max_old_response].rstrip() + "…"
                        last_assistant_text = {"role": "assistant", "content": content}
                        # Preserve model_name for cross-model awareness
                        if msg.get("model_name"):
                            last_assistant_text["model_name"] = msg["model_name"]
            if user_msg:
                result.append(user_msg)
            if last_assistant_text:
                result.append(last_assistant_text)
        else:
            # Recent turn: keep full tool context
            result.extend(turn)

    return result


def ensure_alternating_roles(messages: List[Dict]) -> List[Dict]:
    """Keep user/assistant/tool sequence; merge only consecutive same-role text (no tool_calls).
    Tool messages and assistant messages with tool_calls are never merged."""
    if not messages:
        return []
    out: List[Dict] = []
    for msg in messages:
        role = (msg.get("role") or "user").lower()
        if role == "tool":
            out.append({k: msg.get(k) for k in ("role", "content", "tool_call_id") if k in msg})
            continue
        if role not in ("user", "assistant", "system"):
            role = "user"
        content = msg.get("content", "")
        has_tool_calls = bool(msg.get("tool_calls"))
        if not out:
            m = {"role": role, "content": content}
            if has_tool_calls:
                m["tool_calls"] = msg["tool_calls"]
            out.append(m)
            continue
        last = out[-1]
        if last["role"] == role and not last.get("tool_calls") and not has_tool_calls:
            c1, c2 = last.get("content", ""), content
            if isinstance(c1, str) and isinstance(c2, str):
                last["content"] = (c1.strip() + "\n\n" + c2.strip()).strip()
            elif isinstance(c1, list) and isinstance(c2, str):
                last["content"] = c1 + [{"type": "text", "text": c2}]
            elif isinstance(c1, str) and isinstance(c2, list):
                last["content"] = [{"type": "text", "text": c1}] + c2
            elif isinstance(c1, list) and isinstance(c2, list):
                last["content"] = c1 + c2
            else:
                last["content"] = c2 if c2 else last["content"]
        else:
            m = {"role": role, "content": content}
            if has_tool_calls:
                m["tool_calls"] = msg["tool_calls"]
            out.append(m)
    return out


# Section markers used in system prompts — must be stripped from user input to prevent prompt injection
_PROMPT_SECTION_MARKERS = [
    "[System]", "[User]", "[ROLE]", "[AVAILABLE DEVICES]", "[AVAILABLE SKILLS]",
    "[CONVERSATION SUMMARY]", "[MEMORIES ABOUT THE USER]", "[USER IDENTITY]", "[USER PROFILE]", "[CURRENT DATE AND TIME]",
    "[APP CAPABILITIES]",
    "[Current exchange]", "[Earlier context]",
]

# LLM control tokens and prompt injection patterns
_INJECTION_RE = re.compile(
    r"(?:<<SYS>>|<</SYS>>|<\|im_start\|>|<\|im_end\|>|"
    r"\[INST\]|\[/INST\]|<\|system\|>|<\|user\|>|<\|assistant\|>|"
    r"<\|end_header_id\|>|<\|begin_of_text\|>|<\|end_of_text\|>|<\|eot_id\|>|"
    r"<\|start_header_id\|>|<\|endoftext\|>|"
    r"<thinking>|</thinking>|<tool_call>|</tool_call>|"
    r"SYSTEM:|ASSISTANT:|HUMAN:)",
    re.IGNORECASE,
)

# Zero-width and invisible Unicode characters used to hide injections
_INVISIBLE_CHARS_RE = re.compile(r'[\u200b\u200c\u200d\u200e\u200f\u2060\u2061\u2062\u2063\u2064\ufeff\u0000-\u0008]')

def sanitize_input(text: str) -> str:
    if not isinstance(text, str):
        return ""
    import unicodedata
    result = unicodedata.normalize('NFKC', text)
    result = _INVISIBLE_CHARS_RE.sub('', result)
    for marker in _PROMPT_SECTION_MARKERS:
        result = result.replace(marker, "")
        result = result.replace(marker.lower(), "")
    result = _INJECTION_RE.sub('', result)
    return result


# ---------------------------------------------------------------------------
# Shared config helpers (eliminate repeated config lookups)
