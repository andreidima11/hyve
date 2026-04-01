"""
Intent Router: lightweight LLM-based pre-classifier that routes user messages
before the heavy agent LLM call.

Uses the aux_llm (if configured) for fast classification:
  - "device_control"  → direct HA call (bypass agent entirely)
  - "device_query"    → agent with minimal tools (get_home_status only)
  - "simple_chat"     → agent (could use lighter model if auto-profile)
  - "complex"         → full agent with all tools

The router adds ~200-500ms latency but can save 2-10s by avoiding unnecessary
tool-calling overhead for simple requests.

Config (in intelligence section of config.json):
  "intent_router": {
      "enabled": true       // false to disable
  }
"""

from __future__ import annotations

import json
import time
from typing import Optional, Tuple

import httpx

import settings as settings_mod
from llm_client import get_llm_client
from logger import log_line

# Router response categories
INTENT_DEVICE_CONTROL = "device_control"
INTENT_DEVICE_QUERY = "device_query"
INTENT_SIMPLE_CHAT = "simple_chat"
INTENT_MEMORY = "memory"
INTENT_COMPLEX = "complex"
INTENT_COMPOUND = "compound"

_VALID_INTENTS = {INTENT_DEVICE_CONTROL, INTENT_DEVICE_QUERY, INTENT_SIMPLE_CHAT, INTENT_MEMORY, INTENT_COMPLEX, INTENT_COMPOUND}

_ROUTER_SYSTEM_PROMPT = """Classify the user message into exactly ONE category. Do NOT reason, think, or explain. Reply with ONLY the category name — one single word.

Categories:
- device_control: User wants to turn on/off/toggle/dim a smart home device, one or multiple. Examples: "turn on the bedroom light", "oprește becul", "aprinde becul și stinge lampa", "stinge lumina"
- device_query: User asks about the current state of devices/sensors. Examples: "what's the temperature?", "is the light on?"
- memory: User wants to remember something or asks what was previously stored. Examples: "remember that I like coffee", "ține minte că..."
- simple_chat: Casual conversation, greetings, jokes, questions the AI can answer from knowledge (definitions, history, science, geography, math, programming, how things work, explanations, comparisons, language, recipes). Examples: "hello", "what's the capital of France?", "explain quantum physics", "how does a car engine work?", "what is GDP?", "who was Einstein?", "ce este fotosinteza?", "cum funcționează un motor?"
- complex: ONLY for things that truly need tools: web search for TODAY's news/weather/prices, setting reminders, running skills, automations, code execution. Examples: "search for...", "set a reminder", "what's the weather today?", "latest news about X"
- compound: Message mixes a device command with a question or other task. Examples: "aprinde lumina și spune-mi cât e ceasul", "turn on the light and what's the weather?"

Reply with ONLY one word."""


async def classify_intent(
    message: str,
    has_image: bool = False,
    has_document: bool = False,
) -> Tuple[str, float]:
    """
    Classify user message intent using aux_llm (fast, cheap model).
    Returns (intent_category, latency_ms).
    Falls back to "complex" if router is disabled or fails.
    """
    # Skip router for non-text inputs
    if has_image or has_document:
        return INTENT_COMPLEX, 0.0

    # Check if router is enabled
    intel = settings_mod.CFG.get("intelligence") or {}
    router_cfg = intel.get("intent_router") or {}
    if not router_cfg.get("enabled", False):
        return INTENT_COMPLEX, 0.0

    # Get aux LLM config (fast model for routing)
    aux = intel.get("aux_llm") or {}
    llm_cfg = settings_mod.CFG.get("llm") or {}
    url = (aux.get("target_url") or "").strip() or llm_cfg.get("target_url", "")
    model = (aux.get("model_name") or "").strip() or llm_cfg.get("model_name", "")
    api_key = (aux.get("api_key") or "").strip() or (llm_cfg.get("api_key") or "").strip()

    if not url or not model:
        return INTENT_COMPLEX, 0.0

    # Normalize URL
    url = url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url.rstrip("/") + "/v1/chat/completions" if "/v1" not in url else url + "/chat/completions"

    start = time.monotonic()

    try:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # Short message for fast classification
        user_msg = message.strip()[:300]  # cap at 300 chars for speed

        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": _ROUTER_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg + " /no_think"},
            ],
            "temperature": 0.0,
            "max_tokens": 128,
            "stream": False,
        }

        client = await get_llm_client()
        resp = await client.post(url, json=payload, headers=headers, timeout=12.0)

        elapsed_ms = (time.monotonic() - start) * 1000

        if resp.status_code != 200:
            log_line("router", "⚠️", "INTENT", f"LLM HTTP {resp.status_code} ({elapsed_ms:.0f}ms)")
            return INTENT_COMPLEX, elapsed_ms

        raw = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "").strip()

        # Strip <think>...</think> tags from thinking models (e.g. Qwen3)
        import re as _re
        # First strip complete <think>...</think> blocks
        raw = _re.sub(r"<think>.*?</think>", "", raw, flags=_re.S).strip()
        # Then strip unclosed <think> tags (when max_tokens cuts off mid-thinking)
        raw = _re.sub(r"<think>.*", "", raw, flags=_re.S).strip()
        raw = raw.lower()

        # Parse response — extract valid intent
        intent = INTENT_COMPLEX
        for valid in _VALID_INTENTS:
            if valid in raw:
                intent = valid
                break

        log_line("router", "🧭", "INTENT", f"'{user_msg[:60]}' → {intent} ({elapsed_ms:.0f}ms)")
        return intent, elapsed_ms

    except httpx.TimeoutException:
        elapsed_ms = (time.monotonic() - start) * 1000
        log_line("router", "⏳", "INTENT", f"Timeout ({elapsed_ms:.0f}ms) — defaulting to complex")
        return INTENT_COMPLEX, elapsed_ms
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        log_line("router", "⚠️", "INTENT", f"{type(exc).__name__}: {exc} ({elapsed_ms:.0f}ms)")
        return INTENT_COMPLEX, elapsed_ms
