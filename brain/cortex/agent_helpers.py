"""Agent loop helpers: status events, intent routing, tool labels."""

from __future__ import annotations

from typing import Dict, Optional

from core.logger import log_line

def _event_status(status_type: str, label: str = None, label_key: str = None, params: dict = None) -> dict:
    out = {"t": "status", "type": status_type}
    if label_key is not None:
        out["labelKey"] = label_key
        if params:
            out["params"] = params
    if label is not None:
        out["label"] = label
    return out


_AGENT_MINIMAL_TOOL_NAMES = frozenset({
    "recall_memory", "store_memory", "get_conversation_history",
    "get_app_help", "get_system_status",
})

_DEVICE_QUERY_TOOL_NAMES = frozenset({
    "get_home_status",
    "get_device_state",
    "get_entity_history",
    "recall_memory",
    "store_memory",
    "get_conversation_history",
})


def _effective_tool_intent(routed_intent: Optional[str], user_msg: str) -> str:
    """Intent used for tool filtering."""
    if routed_intent in ("simple_chat", "memory", "device_control", "device_query", "compound", "complex"):
        return routed_intent or "complex"
    try:
        from brain.intent_router import heuristic_intent
        guessed = heuristic_intent(user_msg)
        if guessed:
            return guessed
    except Exception:
        pass
    return "complex"


def _should_suppress_thinking(
    model_name: str,
    tool_intent: str,
    user_msg: str = "",
    thinking_mode: str = "auto",
) -> bool:
    from brain.thinking_control import resolve_thinking_suppression
    return resolve_thinking_suppression(model_name, tool_intent, user_msg, thinking_mode)


def _append_no_think(messages: List[Dict]) -> List[Dict]:
    """Legacy helper — prefer apply_thinking_suppression for Ollama/Qwen."""
    from brain.thinking_control import _append_no_think_suffix
    return _append_no_think_suffix(messages)



def _extract_domain_from_url(url: str) -> str:
    """Extract readable domain from URL for status labels."""
    if not url:
        return "pagină"
    try:
        parts = url.split("/")
        if len(parts) >= 3:
            domain = parts[2]
            # Remove www. prefix
            if domain.startswith("www."):
                domain = domain[4:]
            return domain[:40]
    except Exception:
        pass  # cosmetic fallback — malformed URL is not critical
    return url[:40] if url else "pagină"


def _tool_call_status_label(fn_name: str, fn_args: Dict) -> str:
    """Generate a human-readable status label for a tool call."""
    labels = {
        "control_device": lambda a: f"{'Dimming' if a.get('brightness') else 'Controlling'} {a.get('target', 'device')}...",
        "get_home_status": lambda a: "Checking home status...",
        "set_automation": lambda a: "Setting automation...",
        "validate_automation_yaml": lambda a: "Validating automation YAML...",
        "list_automation_definitions": lambda a: "Listing automations...",
        "get_automation_definition": lambda a: "Loading automation...",
        "create_automation_definition": lambda a: "Creating automation...",
        "update_automation_definition": lambda a: "Updating automation...",
        "enable_automation_definition": lambda a: "Enabling automation...",
        "disable_automation_definition": lambda a: "Disabling automation...",
        "delete_automation_definition": lambda a: "Deleting automation...",
        "run_automation_definition": lambda a: "Running automation...",
        "search_web": lambda a: f"Caut: «{a.get('query', '')[:60]}»",
        "search_web_images": lambda a: f"Caut imagini: «{a.get('query', '')[:50]}»",
        "read_web_page": lambda a: f"Citesc: {_extract_domain_from_url(a.get('url', ''))}",
        "extract_web_data": lambda a: f"Extrag date: {_extract_domain_from_url(a.get('url', ''))}",
        "recall_memory": lambda a: f"Caut în memorie: {a.get('topic', '')[:50]}...",
        "store_memory": lambda a: f"Memorie actualizată",
        "run_skill": lambda a: f"Rulez skill: {a.get('skill_name', '')}...",
        "create_skill": lambda a: "Creez skill nou...",
        "edit_skill": lambda a: f"Editez skill: {a.get('skill_name', '')}...",
        "improve_skill": lambda a: f"Repar skill: {a.get('skill_name', '')}...",
        "allow_shell": lambda a: "Activez acces shell...",
        "run_shell": lambda a: f"Rulez: {(a.get('command') or '')[:50]}...",
        "suggest_shell": lambda a: f"Sugerez comandă: {(a.get('command') or '')[:50]}...",
        "read_file": lambda a: f"Citesc: {(a.get('path') or '')[:50]}...",
        "run_script": lambda a: f"Rulez script {(a.get('language') or '')}...",
        "propose_patch": lambda a: f"Propun modificare: {(a.get('path') or '')[:50]}...",
        "propose_file": lambda a: f"Propun fișier: {(a.get('path') or '')[:50]}...",
        "generate_image": lambda a: f"Generez imagine: «{(a.get('prompt') or '')[:50]}»...",
    }
    fn = labels.get(fn_name)
    if fn:
        try:
            return fn(fn_args)
        except Exception as e:
            log_line("error", "⚠️", "STATUS FMT", f"{fn_name}: {e}")
    return f"Using {fn_name}..."
