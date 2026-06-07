"""Device resolution helpers for the agent."""

from __future__ import annotations

from typing import Optional

from device_resolver import find_device_details as _find_device_details
from brain.cortex.config import CONTEXT_LOCK, USER_CONTEXT

async def find_device_details(target: str, user_id: str, user_message: Optional[str] = None):
    return await _find_device_details(
        target, user_id, user_message=user_message,
        context_lock=CONTEXT_LOCK, user_context=USER_CONTEXT,
    )


