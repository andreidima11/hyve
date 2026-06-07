"""Non-streaming response wrapper."""

from __future__ import annotations

import settings as settings_mod
from logger import log_line
from rich.panel import Panel
from brain.cortex.config import console
from brain.cortex.agent_stream import generate_response_stream

async def generate_response(user_msg, history, user_id, persona_override: Optional[str] = None, conversation_summary: Optional[str] = None, image_base64: Optional[str] = None):
    """Non-streaming wrapper (used by WhatsApp handler etc.)."""
    full_resp = ""
    is_verbose = bool((settings_mod.CFG or {}).get("verbose_logging"))
    async for chunk in generate_response_stream(user_msg, history, user_id, persona_override,
                                                 conversation_summary=conversation_summary,
                                                 image_base64=image_base64):
        if isinstance(chunk, dict):
            continue
        full_resp += chunk
        if is_verbose:
            profile_name = getattr(settings_mod, "get_active_profile_name", lambda: "")()
            title = f"AI REPLY · {profile_name}" if profile_name else "AI REPLY"
            console.print(Panel(f"[medium_purple1]{full_resp}[/]", title=title, border_style="purple"))
    profile_name = getattr(settings_mod, "get_active_profile_name", lambda: "")()
    log_line("reply", "✅", "AI REPLY", f"[{profile_name}] {len(full_resp)} chars" if profile_name else f"{len(full_resp)} chars")
    return full_resp, "Context"

