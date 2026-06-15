"""Add-on health checks (TCP/HTTP)."""

from __future__ import annotations

import asyncio

from addons.discovery import get_manifest
from addons.state_store import get_state

async def check_health(slug: str) -> dict:
    """Run a health check for an addon. Returns { ok: bool, detail: str }."""
    manifest = get_manifest(slug)
    if not manifest:
        return {"ok": False, "detail": "unknown_addon"}

    state = get_state(slug)
    if not state.get("installed"):
        return {"ok": False, "detail": "not_configured"}

    hc = manifest.get("health_check")
    if not hc:
        return {"ok": True, "detail": "no_check"}

    cfg = state.get("config", {})
    host = hc.get("host") or cfg.get(hc.get("host_key", "host"), "localhost")
    port = int(cfg.get(hc.get("port_key", "port"), 0))

    if not port:
        return {"ok": False, "detail": "no_port_configured"}

    hc_type = hc.get("type", "tcp")

    if hc_type == "tcp":
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=5
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"ok": True, "detail": "connected"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    elif hc_type == "http":
        try:
            import httpx
            url = f"http://{host}:{port}{hc.get('path', '/')}"
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(url)
                return {"ok": r.status_code < 400, "detail": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    return {"ok": False, "detail": f"unknown_check_type: {hc_type}"}
