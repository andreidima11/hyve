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
import re
import time
from typing import Optional, Tuple

import httpx

import core.settings as settings_mod
from brain.llm_client import get_llm_client
from core.logger import log_line

# Router response categories
INTENT_DEVICE_CONTROL = "device_control"
INTENT_DEVICE_QUERY = "device_query"
INTENT_SIMPLE_CHAT = "simple_chat"
INTENT_MEMORY = "memory"
INTENT_COMPLEX = "complex"
INTENT_COMPOUND = "compound"

_VALID_INTENTS = [INTENT_DEVICE_CONTROL, INTENT_COMPOUND, INTENT_DEVICE_QUERY, INTENT_MEMORY, INTENT_SIMPLE_CHAT, INTENT_COMPLEX]

_DEVICE_CONTROL_RE = re.compile(
    r"\b(aprinde|stinge|porn(?:eș|e)te|opre(?:ș|e)te|turn on|turn off|toggle|dim|"
    r"aprind|sting|deschide|închide|inchide)\b",
    re.I,
)
_DEVICE_QUERY_RE = re.compile(
    r"\b(temperature|temperatur[aă]?|sensor|senzor|is the .+ on|starea|statusul|"
    r"c[aâ]t e|cat e|ce temperatur)\b",
    re.I,
)
_COMPLEX_RE = re.compile(
    r"\b(search|caut[ăa]|google|look up|g[aă]se[sș]te(?:te)?|verific[aă]|"
    r"vremea|weather|forecast|prognoz[aă]|"
    r"reminder|amintire|automati|"
    r"integr[aă][a-z]*|entity|entities|entit[aă]|camere|camera|dashboard|widget|"
    r"skill|shell|script|istoric|history|sync|addon|scene|automatiz|"
    r"hyve|hub|set[aă]ri|settings|notification|notific|factur|pago|"
    r"genereaz[aă]|imagine|yaml|patch|read_web|extract_web|run_script|"
    r"propose_patch|forge|comfyui|cctv)\b",
    re.I,
)
_NEEDS_CURRENT_INFO_RE = re.compile(
    r"\b(?:"
    r"azi|ast[aă]zi|today|acum|now|currently|current|curent|curent[aă]|"
    r"latest|recent|recente|live|breaking|headline|"
    r"news|știri|stiri|nout[aă]ți|noutati|"
    r"pre[țt]|price|stock|burs[aă]|curs(?:ul)?|rate|"
    r"c[aâ]t cost[aă]|how much (?:does|is|are)|"
    r"what(?:'s| is) the (?:weather|score|price|exchange)|"
    r"who won|who is the (?:current|new)|"
    r"cine (?:a )?(?:c[aâ]stigat|este|e) (?:acum|actual|noul|noua)|"
    r"premier|prim(?:e)?[\s-]?minist|pre[sș]edinte|president|ministru|minister|guvern|"
    r"when is (?:the )?next|c[aâ]nd (?:e|este) (?:urm[aă]tor|next)|"
    r"anul (?:acesta|ăsta|202[4-9])|this year|last (?:week|month|year)|"
    r"ultim(?:a|ele|ul)|cel mai recent|most recent|"
    r"202[4-9]"
    r")\b",
    re.I,
)
_SIMPLE_CHAT_RE = re.compile(
    r"^(?:"
    r"salut|bun[aă](?:\s+(?:ziua|seara|dimineața|dimineata))?|"
    r"hello|hi|hey|yo|ce faci|what(?:'s| is) up|how are you|how r u|"
    r"multumesc|mulțumesc|mersi|thanks|thank you|thx|"
    r"ok(?:ay)?|bine|cool|super|nice|"
    r"la revedere|bye|goodbye|good night|noapte bun[aă]|"
    r"good morning|bun[aă] dimineața|buna dimineata|"
    r"haha|lol|mdr"
    r")[\s!.?,:)]*$",
    re.I,
)
_MEMORY_RE = re.compile(
    r"\b(remember|recall|memor|ține minte|tine minte|ce .*imi place|what do i like|"
    r"what fruits|prefer|preference|imi plac|îmi plac|as manca|a[sș] m[aâ]nca|"
    r"ce fructe|cum ma cheama|cum m[aă] cheam[aă])\b",
    re.I,
)
_COMPOUND_SPLIT_RE = re.compile(r"\s+(?:și|and|,)\s+", re.I)


def is_casual_message(message: str) -> bool:
    """Greetings and small talk — safe for the fast no-tools path."""
    text = (message or "").strip()
    if not text:
        return False
    if _SIMPLE_CHAT_RE.match(text):
        return True
    if len(text) <= 25 and "?" not in text and not _NEEDS_CURRENT_INFO_RE.search(text):
        return True
    return False


def message_needs_tools(message: str) -> bool:
    """Questions that likely need search, integrations, or other tools."""
    text = (message or "").strip()
    if not text:
        return False
    if _COMPLEX_RE.search(text):
        return True
    return bool(_NEEDS_CURRENT_INFO_RE.search(text))

_ROUTER_SYSTEM_PROMPT = """Classify the user message into exactly ONE category. Do NOT reason, think, or explain. Reply with ONLY the category name — one single word.

Categories:
- device_control: User wants to turn on/off/toggle/dim a smart home device, one or multiple. Examples: "turn on the bedroom light", "oprește becul", "aprinde becul și stinge lampa", "stinge lumina"
- device_query: User asks about the current state of devices/sensors. Examples: "what's the temperature?", "is the light on?"
- memory: User wants to remember/recall personal facts, asks about their preferences or history, OR discusses a personal topic where stored memories would help (food, hobbies, habits, possessions, plans). Examples: "remember that I like coffee", "what do I like?", "as manca un fruct", "what fruits do I like?", "ține minte că..."
- simple_chat: Casual conversation, greetings, jokes, questions the AI can answer from knowledge (definitions, history, science, geography, math, programming, how things work, explanations, comparisons, language, recipes). Examples: "hello", "what's the capital of France?", "explain quantum physics", "how does a car engine work?", "what is GDP?", "who was Einstein?", "ce este fotosinteza?", "cum funcționează un motor?"
- complex: Things that need tools: web search for current info, setting reminders, running skills, automations, code execution, questions about how to use the Hyve app/UI (navigation, settings, buttons, menus, widgets, integrations setup), questions about the Hyve system state (integration counts, entity inventory, sensors, cameras, sync health, dashboard layout, automations, scenes, areas, notifications, addons), entity history queries (past temperatures, sensor trends), or device control requests that need context. Examples: "search for...", "set a reminder", "what's the weather today?", "cum șterg un widget?", "unde schimb tema?", "câte integrări active am?", "how many entities?", "ce camere am?", "where do I find settings?", "what was the temperature last night?", "arată-mi istoricul senzorului", "câte automatizări am?", "ce scene am?", "câte notificări necitite?", "ce addon-uri rulează?"
- compound: Message mixes a device command with a question or other task. Examples: "aprinde lumina și spune-mi cât e ceasul", "turn on the light and what's the weather?"

Reply with ONLY one word."""


def heuristic_intent(message: str) -> Optional[str]:
    """Fast regex intent guess — zero LLM cost. Returns None if uncertain."""
    text = (message or "").strip()
    if not text or len(text) > 2000:
        return None
    if _DEVICE_CONTROL_RE.search(text) and (
        _COMPOUND_SPLIT_RE.search(text) or (_COMPLEX_RE.search(text) and not _DEVICE_QUERY_RE.search(text))
    ):
        return INTENT_COMPOUND
    if _DEVICE_CONTROL_RE.search(text):
        return INTENT_DEVICE_CONTROL
    if _DEVICE_QUERY_RE.search(text):
        return INTENT_DEVICE_QUERY
    if _MEMORY_RE.search(text):
        return INTENT_MEMORY
    if message_needs_tools(text):
        return INTENT_COMPLEX
    if is_casual_message(text):
        return INTENT_SIMPLE_CHAT
    return None


def _resolve_main_chat_llm() -> tuple[str, str]:
    """Active profile LLM (same as chat), for comparing against router aux."""
    cfg = settings_mod.CFG or {}
    active_id = (cfg.get("active_profile_id") or "").strip()
    if active_id:
        for profile in (cfg.get("model_profiles") or []):
            if (profile.get("id") or "") == active_id:
                url = (profile.get("target_url") or "").strip()
                model = (profile.get("model_name") or "").strip()
                if url and model:
                    return url.rstrip("/"), model
    llm = cfg.get("llm") or {}
    return (llm.get("target_url") or "").strip().rstrip("/"), (llm.get("model_name") or "").strip()


def _dedicated_router_llm() -> Optional[tuple[str, str, str]]:
    """Return (url, model, api_key) only when a separate fast router model is configured."""
    intel = settings_mod.CFG.get("intelligence") or {}
    aux = intel.get("aux_llm") or {}
    url = (aux.get("target_url") or "").strip()
    model = (aux.get("model_name") or "").strip()
    api_key = (aux.get("api_key") or "").strip()
    if not url or not model:
        return None
    main_url, main_model = _resolve_main_chat_llm()
    if url.rstrip("/") == main_url and model == main_model:
        return None
    return url, model, api_key


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
        guessed = heuristic_intent(message)
        if guessed:
            log_line("router", "⚡", "INTENT", f"'{message.strip()[:60]}' → {guessed} (heuristic, router off)")
            return guessed, 0.0
        return INTENT_COMPLEX, 0.0

    guessed = heuristic_intent(message)
    if guessed is not None:
        log_line("router", "⚡", "INTENT", f"'{message.strip()[:60]}' → {guessed} (heuristic)")
        return guessed, 0.0

    router_llm = _dedicated_router_llm()
    if not router_llm:
        log_line("router", "⚡", "INTENT", f"'{message.strip()[:60]}' → complex (no fast aux LLM)")
        return INTENT_COMPLEX, 0.0

    url, model, api_key = router_llm

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
