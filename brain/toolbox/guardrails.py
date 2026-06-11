from __future__ import annotations

import core.settings as settings_mod
from brain.injection_guard import sanitize_untrusted_content

def _is_explicit_skill_request(description: str) -> bool:
    """Guardrail: create_skill should run only when user explicitly asks for coding/tool creation."""
    d = (description or "").strip().lower()
    if len(d) < 3:
        return False
    explicit_markers = (
        "skill", "tool", "plugin", "script", "function", "automation module",
        "code", "coding", "program", "implementation", "api endpoint",
        "creeaza un skill", "fă un skill", "fa un skill", "construieste un tool",
        "scrie un script", "genereaza cod", "editeaza skill", "improve skill",
    )
    return any(marker in d for marker in explicit_markers)


def _guard(text: str, source: str) -> str:
    """Apply anti-injection guard if enabled in config."""
    sec = (settings_mod.CFG.get("security") or {})
    if sec.get("anti_injection", True):
        return sanitize_untrusted_content(text, source)
    return text


def _tool_guardrails_enabled() -> bool:
    """Check if tool guardrails (shell approval, etc.) are enabled."""
    return (settings_mod.CFG.get("security") or {}).get("tool_guardrails", True)


_UNTRUSTED_CONTEXT_SAFE_TOOL_NAMES = frozenset({
    "search_web",
    "search_web_images",
    "read_web_page",
    "extract_web_data",
    "cctv_describe",
    "get_app_help",
    "get_system_status",
    "get_entity_history",
    "get_device_state",
})


def is_tool_allowed_for_untrusted_context(name: str) -> bool:
    """Only allow a narrow read-only subset when the current turn is tainted by untrusted content."""
    return (name or "") in _UNTRUSTED_CONTEXT_SAFE_TOOL_NAMES

