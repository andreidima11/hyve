"""Shared httpx.AsyncClient for LLM/router calls — connection pooling, no quality change."""
import asyncio
from typing import Optional

import httpx

_http_client: Optional[httpx.AsyncClient] = None
_client_lock = asyncio.Lock()

DEFAULT_TIMEOUT = 120.0
LIMITS = httpx.Limits(max_keepalive_connections=8, keepalive_expiry=30.0)


async def get_llm_client() -> httpx.AsyncClient:
    """Return a shared AsyncClient for LLM/router requests. Created lazily, reused for keep-alive."""
    global _http_client
    if _http_client is not None:
        return _http_client
    async with _client_lock:
        # Double-check after acquiring lock
        if _http_client is not None:
            return _http_client
        _http_client = httpx.AsyncClient(
            timeout=DEFAULT_TIMEOUT,
            limits=LIMITS,
        )
    return _http_client


async def close_llm_client() -> None:
    """Close the shared client (e.g. on shutdown)."""
    global _http_client
    async with _client_lock:
        if _http_client is not None:
            await _http_client.aclose()
            _http_client = None
