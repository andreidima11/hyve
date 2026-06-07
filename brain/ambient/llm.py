from __future__ import annotations

import json
import re
from typing import Any, Optional

import settings as settings_mod
from core import i18n as core_i18n
from logger import log_detail

from brain.ambient import actions, config

from brain.ambient.actions import _allowed_ambient_tools, _ambient_action_specs, _ambient_context_tags, _ambient_dismiss_issues, _ambient_sync_slugs, _execute_actions, _normalize_ambient_tool, _sanitize_decision_actions, ambient_actions_for_context, format_ambient_actions_catalog
from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled

def _normalize_chat_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/chat/completions"):
        return url
    return (url + "/v1/chat/completions") if "/v1" not in url else (url + "/chat/completions")

def _resolve_profile() -> Optional[dict]:
    """The model profile chosen for ambient (or None = use the active profile)."""
    pid = str(_cfg().get("profile_id") or "").strip()
    if not pid:
        return None
    for p in (settings_mod.CFG.get("model_profiles") or []):
        if str(p.get("id") or "") == pid:
            return p
    return None

def _llm_endpoint(prefer_aux: bool) -> tuple[str, str, str]:
    prof = _resolve_profile()
    if prof:
        if prefer_aux:
            # Only use the aux model when the chosen profile actually defines one;
            # otherwise return empty so the gate is skipped (fail open to reasoner).
            if not prof.get("aux_llm_enabled"):
                return "", "", ""
            aux = prof.get("aux_llm") or {}
            url, model, api_key = aux.get("target_url", ""), aux.get("model_name", ""), aux.get("api_key", "")
        else:
            url, model, api_key = prof.get("target_url", ""), prof.get("model_name", ""), prof.get("api_key", "")
        return _normalize_chat_url(url), model, (api_key or "").strip()

    # Fallback: active profile (mirrored into the flat llm / intelligence.aux_llm blocks).
    intel = settings_mod.CFG.get("intelligence") or {}
    llm_cfg = settings_mod.CFG.get("llm") or {}
    aux = intel.get("aux_llm") or {}
    if prefer_aux:
        url = (aux.get("target_url") or "").strip() or llm_cfg.get("target_url", "")
        model = (aux.get("model_name") or "").strip() or llm_cfg.get("model_name", "")
        api_key = (aux.get("api_key") or "").strip() or (llm_cfg.get("api_key") or "").strip()
    else:
        url = llm_cfg.get("target_url", "")
        model = llm_cfg.get("model_name", "")
        api_key = (llm_cfg.get("api_key") or "").strip()
    return _normalize_chat_url(url), model, api_key

async def _llm_complete(messages: list[dict], *, prefer_aux: bool, max_tokens: int, temperature: float = 0.2, timeout: float = 30.0) -> str:
    from llm_client import get_llm_client
    url, model, api_key = _llm_endpoint(prefer_aux)
    if not url or not model:
        return ""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    client = await get_llm_client()
    resp = await client.post(url, json=payload, headers=headers, timeout=timeout)
    if resp.status_code != 200:
        log_detail("ambient", "LLM_HTTP", status=resp.status_code)
        return ""
    raw = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S)
    raw = re.sub(r"<think>.*", "", raw, flags=re.S)
    return raw.strip()

def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            return None
    return None

async def _aux_gate(context: dict) -> bool:
    """Optional cheap yes/no gate. Returns True when a proactive thought is
    worth the main reasoner call. Fails open (True) when no aux LLM."""
    if not _cfg().get("use_aux_llm_gate", True):
        return True
    url, model, _ = _llm_endpoint(prefer_aux=True)
    if not url or not model:
        return True  # no aux model → let the main reasoner decide

    if context.get("trigger") in {"checkin", "scan"}:
        return True  # check-ins/scans are throttled by schedule + duration pre-filter

    ev = context.get("events") or []
    if not ev:
        return False
    summary = "; ".join(f"{e['name']} ({e['area'] or 'n/a'}): {e['from']}→{e['to']}" for e in ev[:8])
    sys = core_i18n.t("brain.ambient.aux_gate_system")
    usr = f"Time: {context['now']}\nEvents: {summary}\nWorth a proactive thought?"
    try:
        out = await _llm_complete(
            [{"role": "system", "content": sys}, {"role": "user", "content": usr + " /no_think"}],
            prefer_aux=True, max_tokens=8, temperature=0.0, timeout=10.0,
        )
        return "yes" in out.lower()
    except Exception:
        return True

def _get_ui_language() -> str:
    """Return the full language name based on user's UI setting."""
    return core_i18n.t("brain.language_name")

def default_reasoner_prompt() -> str:
    """Built-in system prompt for the ambient reasoner (settings default / reset)."""
    return core_i18n.t("brain.ambient.reasoner_system_prompt")

def reasoner_system_prompt(language_name: str | None = None) -> str:
    """Configured reasoner prompt with {language_name} substituted."""
    custom = str(_cfg().get("reasoner_prompt") or "").strip()
    template = custom or default_reasoner_prompt()
    lang = language_name or _get_ui_language()
    return template.replace("{language_name}", lang)

async def _reason(context: dict) -> Optional[dict]:
    weather_section = ""
    if context.get("weather"):
        weather_section = "\n\nWeather/sensors:\n" + json.dumps(context["weather"], ensure_ascii=False)
    events_section = ""
    if context.get("upcoming_events"):
        events_section = "\n\nUpcoming calendar events:\n" + json.dumps(context["upcoming_events"], ensure_ascii=False)

    policy = str(context.get("proactive_policy") or "").strip()
    issues_section = ""
    if context.get("new_proactive_issues") is not None:
        issues_section = (
            "\n\nNEW issues (notify now — user has NOT been told yet):\n"
            + (json.dumps(context.get("new_proactive_issues") or [], ensure_ascii=False) or "[]")
            + "\n\nAlready notified (do NOT repeat):\n"
            + (json.dumps(context.get("already_notified_issues") or [], ensure_ascii=False) or "[]")
        )

    usr = (
        f"Time: {context['now']}\n"
        f"Trigger: {context['trigger']}"
        + (f" ({context['checkin_kind']})" if context.get("checkin_kind") else "")
        + (f"\n\nPolicy: {policy}" if policy else "")
        + issues_section
        + "\n\nRecent events:\n"
        + (json.dumps(context["events"], ensure_ascii=False) if context["events"] else "(none)")
        + "\n\nLong-running devices (left ON/open a while — likely worth acting on):\n"
        + (json.dumps(context.get("long_running") or [], ensure_ascii=False) if context.get("long_running") else "(none)")
        + "\n\nHome state (relevant devices, with minutes_in_state):\n"
        + json.dumps(context["home"], ensure_ascii=False)
        + weather_section
        + events_section
        + "\n\nAvailable actions (use ONLY these tools in actions[]):\n"
        + format_ambient_actions_catalog(context)
        + "\n\nDecide. Respond with ONLY the JSON object."
    )
    system_prompt = reasoner_system_prompt()
    out = await _llm_complete(
        [{"role": "system", "content": system_prompt}, {"role": "user", "content": usr}],
        prefer_aux=False, max_tokens=600, temperature=0.2, timeout=45.0,
    )
    decision = _extract_json(out)
    if not isinstance(decision, dict):
        return None
    return decision

