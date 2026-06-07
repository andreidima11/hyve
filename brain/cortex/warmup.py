from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List

import httpx
import settings as settings_mod
from logger import log_line, log_detail

# ── Prompt Warmup ──────────────────────────────────────────────────────────
#  Send minimal requests on server start to pre-fill Ollama's KV cache with
#  the same system prompt shape real chat uses (static + dynamic suffix + tools).

_WARMUP_MINIMAL_TOOL_NAMES = frozenset({
    "recall_memory", "store_memory", "get_conversation_history",
})


def _resolve_warmup_llm_cfg() -> dict:
    """Use the active model profile when set, else flat llm config."""
    cfg = settings_mod.CFG or {}
    active_id = (cfg.get("active_profile_id") or "").strip()
    if active_id:
        for profile in (cfg.get("model_profiles") or []):
            if (profile.get("id") or "") == active_id:
                from core.chat_helpers import build_llm_override
                override = build_llm_override(profile) or {}
                if (override.get("target_url") or "").strip() and (override.get("model_name") or "").strip():
                    return override
    return cfg.get("llm") or {}


async def _wait_for_startup_ready(timeout: float = 45.0) -> None:
    """Wait until integration bootstrap finishes so entity snapshot is populated."""
    from core.startup_status import get_startup_status
    deadline = time.monotonic() + max(0.0, timeout)
    while time.monotonic() < deadline:
        if get_startup_status().get("ready"):
            return
        await asyncio.sleep(0.5)


async def _warmup_selected_entities() -> list[dict]:
    try:
        from core.entity_catalog import get_entities
        all_items = await get_entities(include_derived=True, sort_mode="name")
        return [e for e in all_items if e.get("selected")]
    except Exception:
        return []


async def _send_warmup_request(
    client: httpx.AsyncClient,
    llm_url: str,
    headers: dict,
    llm_cfg: dict,
    system_prompt: str,
    tools: list[dict],
    label: str,
) -> tuple[bool, int]:
    """One warmup POST. Returns (ok, elapsed_ms)."""
    t0 = time.monotonic()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "ping"},
    ]
    payload: dict = {
        "model": llm_cfg.get("model_name", ""),
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": 1,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
    from brain.thinking_control import apply_thinking_suppression, should_suppress_thinking
    if should_suppress_thinking(llm_cfg.get("model_name", ""), "simple_chat", "ping"):
        payload, messages = apply_thinking_suppression(
            payload,
            messages,
            target_url=llm_url,
            model_name=llm_cfg.get("model_name", ""),
            provider=str(llm_cfg.get("provider") or ""),
            suppress=True,
        )
        payload["messages"] = messages
    try:
        timeout = float(llm_cfg.get("timeout", 120) or 120)
        resp = await client.post(llm_url, json=payload, timeout=timeout, headers=headers)
        elapsed = round((time.monotonic() - t0) * 1000)
        return resp.status_code == 200, elapsed
    except Exception as e:
        elapsed = round((time.monotonic() - t0) * 1000)
        log_line("sys", "⚠️", "WARMUP", f"{label}: {type(e).__name__}: {e} ({elapsed}ms)")
        return False, elapsed


async def warmup_llm_cache(user_id: str = "user_1") -> None:
    """Pre-fill the LLM KV cache with the static + dynamic system prompt and tools.

    Waits for integration bootstrap, then sends warmup requests that mirror real chat:
    full tool set (complex intent) and minimal tool set (simple_chat intent).
    """
    llm_cfg = _resolve_warmup_llm_cfg()
    url = (llm_cfg.get("target_url") or "").strip()
    model = (llm_cfg.get("model_name") or "").strip()
    if not url or not model:
        log_line("sys", "⏩", "WARMUP", "Skipped (no LLM configured)")
        return

    t0 = time.monotonic()
    try:
        await _wait_for_startup_ready()

        from brain.toolbox import get_available_tools
        from core.user_profile import load_user_profile_context

        tools = get_available_tools(user_id, is_anonymous=False)
        tools_token_estimate = _estimate_tokens(json.dumps(tools)) if tools else 0
        max_ctx = int(llm_cfg.get("context_length", 0) or 0) or 24000
        budget = max(2000, max_ctx - tools_token_estimate - 3024)
        static_prefix = _build_static_prompt_prefix(user_id, None, max_prompt_tokens=budget)

        fp = _prompt_cache_fingerprint(user_id, None)
        _prompt_cache.put(fp, {
            "static_prefix": static_prefix,
            "tools": tools,
            "tools_token_est": tools_token_estimate,
        })

        profile_ctx, selected_entities = await asyncio.gather(
            asyncio.to_thread(load_user_profile_context, user_id),
            _warmup_selected_entities(),
        )
        dynamic_suffix = _build_dynamic_prompt_suffix(
            conversation_summary=None,
            relevant_facts=None,
            selected_entities=selected_entities,
            user_profile_context=profile_ctx,
        )
        system_prompt = static_prefix + dynamic_suffix
        prompt_tokens = _estimate_tokens(system_prompt) + tools_token_estimate

        client = await get_llm_client()
        llm_url = _normalize_chat_url(url)
        headers = _llm_headers(llm_cfg.get("api_key") or "")

        ok_full, ms_full = await _send_warmup_request(
            client, llm_url, headers, llm_cfg, system_prompt, tools, "full",
        )

        minimal_tools = [
            t for t in tools
            if (t.get("function") or {}).get("name") in _WARMUP_MINIMAL_TOOL_NAMES
        ]
        ok_min, ms_min = True, 0
        if minimal_tools and len(minimal_tools) < len(tools):
            ok_min, ms_min = await _send_warmup_request(
                client, llm_url, headers, llm_cfg, system_prompt, minimal_tools, "minimal",
            )

        elapsed = round((time.monotonic() - t0) * 1000)
        entities_n = len(selected_entities)
        if ok_full and ok_min:
            log_line(
                "sys", "🔥", "WARMUP",
                f"KV primed in {elapsed}ms — profile={bool(profile_ctx)}, entities={entities_n}, "
                f"prompt~{prompt_tokens}tok, full={ms_full}ms, minimal={ms_min}ms, model={model}",
            )
        else:
            log_line(
                "sys", "⚠️", "WARMUP",
                f"partial ({elapsed}ms) full={'OK' if ok_full else 'FAIL'} minimal={'OK' if ok_min else 'FAIL'}",
            )
    except Exception as e:
        elapsed = round((time.monotonic() - t0) * 1000)
        log_line("sys", "⚠️", "WARMUP", f"{type(e).__name__}: {e} ({elapsed}ms)")
