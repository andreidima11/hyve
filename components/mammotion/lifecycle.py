"""Mammotion integration lifecycle — slower entry test and post-create pacing."""

from __future__ import annotations

import asyncio
from typing import Any

ENTRY_TEST_TIMEOUT_SECONDS = 120.0


async def before_initial_sync(*, manager: Any, entry_id: str, slug: str) -> None:
    del manager, entry_id, slug
    # UI "Test connection" often logs in seconds before Save — brief pause
    # reduces Mammotion cloud rate-limit failures on the first real sync.
    await asyncio.sleep(3)
