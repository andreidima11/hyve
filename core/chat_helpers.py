import json
from typing import Callable, List, Optional, Tuple


def extract_json_payload(text):
    if not text or "HA_CALL:" not in text:
        return None
    try:
        raw_part = text.split("HA_CALL:", 1)[1].strip()
        start_idx = raw_part.find("{")
        end_idx = raw_part.rfind("}")
        if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
            return json.loads(raw_part[start_idx:end_idx + 1])
        return None
    except json.JSONDecodeError as exc:
        return {"_error": f"json_decode:{exc}"}
    except Exception as exc:
        return {"_error": f"extract:{type(exc).__name__}:{exc}"}


def extract_json_payload_safe(text, log_line: Callable[[str, str, str, str], None]):
    payload = extract_json_payload(text)
    if isinstance(payload, dict) and payload.get("_error"):
        error = payload["_error"]
        if error.startswith("json_decode:"):
            log_line("error", "⚠️", "JSON", f"HA_CALL parse failed: {error.removeprefix('json_decode:')}")
        else:
            log_line("error", "⚠️", "JSON", f"HA_CALL extract error: {error.removeprefix('extract:')}")
        return None
    return payload


def select_profile_for_auto(
    has_image: bool,
    has_document: bool,
    profiles: list,
    message_length: int = 0,
    history_message_count: int = 0,
) -> Tuple[List[str], str]:
    """Select profiles for auto mode. Prefer local, then context size."""
    visible = [profile for profile in profiles if profile.get("visible_in_selector", True)]
    if not visible:
        return [], "no_profiles"
    need_vision = has_image
    need_reasoning = True
    need_tools = True
    candidates = []
    for profile in visible:
        if need_vision and not profile.get("capability_vision", True):
            continue
        if need_reasoning and not profile.get("capability_reasoning", True):
            continue
        if need_tools and not profile.get("capability_tool_calling", True):
            continue
        candidates.append(profile)
    if not candidates:
        return [], "no_match"
    complex_request = has_document or message_length > 2000 or history_message_count > 15

    def _sort_key(profile):
        is_local = 1 if (profile.get("provider") or "").strip().lower() == "local" else 0
        context_length = int(profile.get("context_length") or 0)
        if complex_request:
            return (-context_length, -is_local)
        return (-is_local, -context_length)

    candidates.sort(key=_sort_key)
    chosen = candidates[0]
    provider = (chosen.get("provider") or "").strip().lower()
    kind = "local" if provider == "local" else "api"
    reason = kind + (" + vision" if has_image else "") + (" + complex" if complex_request else "")
    ordered_ids = [profile.get("id") for profile in candidates if profile.get("id")]
    return ordered_ids, reason


def build_llm_override(profile: Optional[dict]) -> Optional[dict]:
    if not profile:
        return None
    return {
        "target_url": profile.get("target_url") or "",
        "model_name": profile.get("model_name") or "",
        "api_key": profile.get("api_key") or "",
        "provider": profile.get("provider") or "",
        "temperature": float(profile.get("temperature", 0.7)),
        "timeout": int(profile.get("timeout", 120)),
        "context_length": int(profile.get("context_length", 24000)),
        "max_tokens": int(profile.get("max_tokens", 2048)),
    }


def build_session_history(messages: list, working_window: int) -> List[dict]:
    history: List[dict] = []
    for message in messages[-working_window:]:
        item = {"role": message.get("role", "user"), "content": message.get("content") or ""}
        if message.get("tool_calls") is not None:
            item["tool_calls"] = message["tool_calls"]
        if message.get("tool_call_id") is not None:
            item["tool_call_id"] = message["tool_call_id"]
        # Preserve which AI profile/model produced this message (used for cross-model awareness)
        if message.get("model_name"):
            item["model_name"] = message["model_name"]
        history.append(item)
    return history
