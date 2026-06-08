"""Build prompts, tools, and LLM message payloads for the agent tool loop."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import settings as settings_mod
from brain.cortex.agent_helpers import _AGENT_MINIMAL_TOOL_NAMES, _effective_tool_intent
from brain.cortex.llm import _describe_image_with_vision_llm, _normalize_chat_url
from brain.cortex.memory import _is_trivial_message
from brain.cortex.messages import (
    _collapse_old_tool_turns,
    _compute_safe_completion_tokens,
    _estimate_messages_tokens,
    _estimate_tokens,
    _trim_messages_to_fit,
    clean_history,
    ensure_alternating_roles,
)
from brain.cortex.prompt import _build_dynamic_prompt_suffix, _build_static_prompt_prefix
from brain.cortex.prompt_cache import (
    _filter_tools_for_untrusted_context,
    _prompt_cache,
    _prompt_cache_fingerprint,
)
from brain.injection_guard import sanitize_untrusted_content
from logger import log_line

_MEMORY_TOOL_NAMES = frozenset({
    "recall_memory",
    "store_memory",
    "get_conversation_history",
    "get_app_help",
    "get_system_status",
})


@dataclass
class AgentTurnContext:
    """Prepared state for ``generate_response_stream`` tool loop."""

    system_prompt: str
    tools: List[Dict[str, Any]]
    tool_catalog: List[Dict[str, Any]]
    tools_token_estimate: int
    llm_messages: List[Dict[str, Any]]
    safe_max_tokens: int
    lazy_history_enabled: bool
    model_name: str
    llm_cfg: Dict[str, Any]
    light_context: bool
    tool_intent: str
    direct_vision_response: Optional[str] = None
    user_profile_context: Optional[dict] = None


async def prepare_agent_turn(
    *,
    user_msg: str,
    history: List[Dict],
    user_id: str,
    persona_override: Optional[str] = None,
    conversation_summary: Optional[str] = None,
    image_base64: Optional[str] = None,
    llm_cfg: Dict[str, Any],
    is_anonymous: bool = False,
    routed_intent: Optional[str] = None,
    user_profile_context: Optional[dict] = None,
) -> AgentTurnContext:
    """Resolve profile/facts/entities, build prompt + tools, trim messages."""
    intel = (settings_mod.CFG.get("intelligence") or {})
    tool_intent = _effective_tool_intent(routed_intent, user_msg)
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
            from core.entity_catalog import get_entities

            all_items = await get_entities(include_derived=True, sort_mode="name")
            return [e for e in all_items if e.get("selected")]
        except Exception:
            return []

    resolved_profile, relevant_facts, selected_entities_snapshot = await asyncio.gather(
        _resolve_profile(),
        _fetch_relevant_facts(),
        _fetch_selected_entities(),
    )
    profile_ctx = resolved_profile

    from brain.toolbox import get_available_tools, is_tool_allowed_for_untrusted_context

    cache_fp = _prompt_cache_fingerprint(user_id, persona_override)
    cached = _prompt_cache.get(cache_fp)
    if cached:
        static_prefix = cached["static_prefix"]
        tools = cached["tools"]
        tools_token_estimate = cached["tools_token_est"]
        log_line("agent", "⚡", "PROMPT CACHE", f"HIT — reusing prefix + {len(tools)} tools ({_prompt_cache.stats})")
    else:
        tools = get_available_tools(user_id, is_anonymous=is_anonymous)
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        max_ctx_pre = int(llm_cfg.get("context_length", 0) or 0) or 24000
        system_prompt_budget = max_ctx_pre - tools_token_estimate - 3024
        if system_prompt_budget < 2000:
            system_prompt_budget = 2000
        static_prefix = _build_static_prompt_prefix(
            user_id, persona_override, max_prompt_tokens=system_prompt_budget
        )
        _prompt_cache.put(
            cache_fp,
            {"static_prefix": static_prefix, "tools": tools, "tools_token_est": tools_token_estimate},
        )
        log_line("agent", "🔨", "PROMPT CACHE", f"MISS — built prefix + {len(tools)} tools ({_prompt_cache.stats})")

    if tool_intent == "simple_chat" and tools:
        tools = [t for t in tools if (t.get("function") or {}).get("name") in _AGENT_MINIMAL_TOOL_NAMES]
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        log_line("agent", "✂️", "INTENT FILTER", f"simple_chat → reduced to {len(tools)} tools")
    elif tool_intent == "memory" and tools:
        tools = [t for t in tools if (t.get("function") or {}).get("name") in _MEMORY_TOOL_NAMES]
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        log_line("agent", "✂️", "INTENT FILTER", f"memory → reduced to {len(tools)} tools")

    tool_catalog = list(tools)
    sec_cfg = settings_mod.CFG.get("security") or {}
    restrict_mutating = bool(sec_cfg.get("restrict_mutating_tools_on_untrusted_content", True))
    safe_untrusted = {
        (t.get("function") or {}).get("name")
        for t in tool_catalog
        if is_tool_allowed_for_untrusted_context((t.get("function") or {}).get("name", ""))
    }
    untrusted_active = bool(restrict_mutating and image_base64 and image_base64.strip())
    if untrusted_active and tool_catalog:
        tools = _filter_tools_for_untrusted_context(tool_catalog, safe_untrusted)
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        log_line("agent", "🛡️", "TOOL POLICY", f"Image input detected → restricted tools {len(tool_catalog)}→{len(tools)}")

    dynamic_suffix = _build_dynamic_prompt_suffix(
        conversation_summary,
        relevant_facts,
        selected_entities_snapshot,
        profile_ctx,
        light_context=light_context,
        user_msg=user_msg,
    )
    system_prompt = static_prefix + dynamic_suffix

    clean_hist = _collapse_old_tool_turns(clean_history(history), keep_recent_turns=1)

    current_profile_name = (getattr(settings_mod, "get_active_profile_name", lambda: "")() or "").strip()
    current_model_id = (llm_cfg.get("model_name") or "").strip()
    foreign_labels: list[str] = []
    has_foreign = False
    for cm in clean_hist:
        if cm.get("role") != "assistant":
            continue
        mn = (cm.get("model_name") or "").strip()
        if not mn:
            continue
        if mn != current_profile_name and mn != current_model_id:
            if mn not in foreign_labels:
                foreign_labels.append(mn)
            has_foreign = True
    if has_foreign:
        for cm in clean_hist:
            if cm.get("role") != "assistant":
                continue
            mn = (cm.get("model_name") or "").strip()
            if not mn:
                continue
            is_foreign = mn != current_profile_name and mn != current_model_id
            if is_foreign:
                cm["content"] = f"[{mn} answered:] {cm.get('content', '')}"
            else:
                cm["content"] = f"[You ({mn}) answered:] {cm.get('content', '')}"
        foreign_str = ", ".join(foreign_labels)
        me = current_profile_name or current_model_id
        system_prompt += (
            f"\n\n[CONTEXT] In this conversation the user switched AI profiles. "
            f"Messages marked [{foreign_str} answered:] were NOT your responses — "
            f"they came from a different AI. You are {me}."
        )
        log_line("agent", "🔀", "CROSS-MODEL", f"Annotated history — foreign: {foreign_str}, self: {me}")

    lazy_history_enabled = bool(intel.get("lazy_history", True))
    lazy_keep = max(2, int(intel.get("lazy_history_keep", 4) or 4))
    if lazy_history_enabled and len(clean_hist) > lazy_keep:
        older = clean_hist[:-lazy_keep]
        recent = clean_hist[-lazy_keep:]
        from brain.toolbox import set_lazy_history

        set_lazy_history(user_id, older)
        clean_hist = recent
        log_line("agent", "📦", "LAZY HISTORY", f"Buffered {len(older)} older, keeping {len(recent)} recent")
    else:
        from brain.toolbox import clear_lazy_history

        clear_lazy_history(user_id)

    direct_vision_response: Optional[str] = None
    last_user_content: Any = user_msg

    if image_base64 and image_base64.strip():
        vision_cfg = settings_mod.CFG.get("vision_llm") or {}
        vision_url = _normalize_chat_url((vision_cfg.get("target_url") or "").strip())
        vision_model = (vision_cfg.get("model_name") or "").strip()
        if vision_url and vision_model:
            prompts_cfg = settings_mod.CFG.get("prompts") or {}
            image_placeholder = prompts_cfg.get("image_placeholder") or "What do you see in this image?"
            prompt_for_vision = (user_msg or image_placeholder).strip()
            description = await _describe_image_with_vision_llm(image_base64, prompt_for_vision)
            if vision_cfg.get("respond_directly"):
                sec = settings_mod.CFG.get("security") or {}
                if description:
                    log_line("agent", "🖼", "VISION", "Direct vision model response")
                    direct_vision_response = (
                        sanitize_untrusted_content(description, "vision")
                        if sec.get("anti_injection", True)
                        else description
                    )
                else:
                    direct_vision_response = "[Descrierea imaginii nu a putut fi obținută.]"
            elif description:
                log_line("agent", "🖼", "VISION", "Description obtained, sent to main model")
                sec = settings_mod.CFG.get("security") or {}
                safe_desc = (
                    sanitize_untrusted_content(description, "vision")
                    if sec.get("anti_injection", True)
                    else description
                )
                combined = (user_msg or "").strip()
                combined += (
                    "\n\n[Descriere imagine: " + safe_desc + "]"
                    if combined
                    else "[Descriere imagine: " + safe_desc + "]"
                )
                last_user_content = combined or "[Utilizatorul a încărcat o imagine.]"
            else:
                last_user_content = (
                    (user_msg or "").strip()
                    + "\n\n[Imagine încărcată; descrierea de la modelul vision nu a putut fi obținută.]"
                )
        else:
            prompts_cfg = settings_mod.CFG.get("prompts") or {}
            image_placeholder = prompts_cfg.get("image_placeholder") or "What do you see in this image?"
            text_part = (user_msg or image_placeholder).strip()
            data_url = (
                image_base64
                if image_base64.startswith("data:")
                else f"data:image/jpeg;base64,{image_base64.strip()}"
            )
            last_user_content = [
                {"type": "text", "text": text_part},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]

    messages = ensure_alternating_roles(clean_hist + [{"role": "user", "content": last_user_content}])
    while messages and messages[0].get("role") == "assistant":
        messages = messages[1:]

    if not any(msg.get("role") == "user" and msg.get("content") for msg in messages):
        log_line("agent", "⚠️", "MSG_VALIDATION", "No user message found, adding placeholder")
        if not messages or messages[-1].get("role") != "user":
            messages.append({"role": "user", "content": last_user_content or "[continuing conversation]"})

    model_name = llm_cfg.get("model_name", "")
    llm_messages = [{"role": "system", "content": system_prompt}] + messages

    max_ctx = int(llm_cfg.get("context_length", 0) or 0) or 24000
    effective_max = max_ctx - tools_token_estimate
    requested_max_tokens = int(llm_cfg.get("max_tokens", 0) or 2048)
    reserve_for_response = max(256, min(requested_max_tokens, max_ctx // 3))
    llm_messages = _trim_messages_to_fit(
        llm_messages,
        effective_max,
        reserve_for_response=reserve_for_response,
        enable_summary_buffer=not lazy_history_enabled,
        model_name=model_name,
    )
    prompt_tokens = _estimate_messages_tokens(llm_messages, model_name=model_name) + tools_token_estimate
    safe_max_tokens = _compute_safe_completion_tokens(max_ctx, prompt_tokens, requested_max_tokens)
    log_line("agent", "📏", "TOKENS", f"prompt~{prompt_tokens}/{max_ctx}, completion_max={safe_max_tokens}")

    return AgentTurnContext(
        system_prompt=system_prompt,
        tools=tools,
        tool_catalog=tool_catalog,
        tools_token_estimate=tools_token_estimate,
        llm_messages=llm_messages,
        safe_max_tokens=safe_max_tokens,
        lazy_history_enabled=lazy_history_enabled,
        model_name=model_name,
        llm_cfg=llm_cfg,
        light_context=light_context,
        tool_intent=tool_intent,
        direct_vision_response=direct_vision_response,
        user_profile_context=profile_ctx,
    )
