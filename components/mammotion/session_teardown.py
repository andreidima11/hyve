"""Clean shutdown for pymammotion clients (stop MQTT loops + sign out)."""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("mammotion")


async def teardown_mammotion_client(client: Any, account: str | None = None) -> None:
    """Disconnect cloud transports and sign out so auth callbacks stop."""
    if client is None:
        return
    sign_out = getattr(client, "_sign_out_existing_session", None)
    if callable(sign_out):
        try:
            await sign_out(account)
        except Exception as exc:
            log.debug("mammotion sign_out failed: %s", exc)
    try:
        await client.stop()
    except Exception as exc:
        log.debug("mammotion client.stop failed: %s", exc)
