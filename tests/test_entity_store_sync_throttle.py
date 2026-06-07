"""Entity store sync throttling — automatic vs forced refresh."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from addons.entity_store import IntegrationEntityStore, SyncThrottledError


@pytest.fixture
def store():
    st = IntegrationEntityStore()
    st.register_fetcher("demo", AsyncMock(return_value={"devices": []}))
    return st


def test_automatic_sync_respects_interval(store, monkeypatch):
    monkeypatch.setattr(store, "seconds_until_next_sync", lambda slug: 120.0)
    monkeypatch.setattr(store, "configured_interval", lambda slug, fallback=300: 600)

    async def _run():
        with pytest.raises(SyncThrottledError) as exc:
            await store.do_sync("demo", force=False)
        assert exc.value.retry_after == 120
        store._fetchers["demo"].assert_not_called()

    asyncio.run(_run())


def test_forced_sync_bypasses_interval(store, monkeypatch):
    monkeypatch.setattr(store, "seconds_until_next_sync", lambda slug: 120.0)
    monkeypatch.setattr(store, "touch_last_fetch", MagicMock())
    monkeypatch.setattr(store, "set_entities", MagicMock())
    monkeypatch.setattr(store, "get_schedule", lambda slug: {"interval_seconds": 600})
    monkeypatch.setattr(store, "update_schedule", MagicMock())

    async def _run():
        await store.do_sync("demo", force=True)
        store._fetchers["demo"].assert_awaited_once()

    asyncio.run(_run())
