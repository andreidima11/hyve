"""Mammotion cloud login helpers (HA parity)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from components.mammotion.cloud_login import (
    async_attempt_cloud_login,
    load_cached_credentials,
    store_cloud_credentials,
)


def test_load_cached_credentials_maps_connect_data():
    cache = {"connect_data": {"data": {}}, "mammotion_mqtt": {}, "mammotion_device_records": []}
    loaded = load_cached_credentials(cache)
    assert "connect_response" in loaded
    assert loaded["connect_response"] == {"data": {}}


def test_store_cloud_credentials_maps_connect_response():
    client = MagicMock()
    client.to_cache.return_value = {"connect_response": {"x": 1}, "aep_data": {"y": 2}}
    stored = store_cloud_credentials(client)
    assert stored.get("connect_data") == {"x": 1}
    assert stored.get("aep_data") == {"y": 2}


def test_async_attempt_cloud_login_fresh():
    client = MagicMock()
    client.login_and_initiate_cloud = AsyncMock()
    client.to_cache.return_value = {"aep_data": {"id": 1}}

    result = asyncio.run(
        async_attempt_cloud_login(client, "a@b.com", "secret", MagicMock(), {}, force_fresh=True)
    )

    client.login_and_initiate_cloud.assert_awaited_once()
    client.restore_credentials.assert_not_called()
    assert result.get("aep_data") == {"id": 1}


def test_async_attempt_cloud_login_restores_cache():
    client = MagicMock()
    client.restore_credentials = AsyncMock()
    client.to_cache.return_value = {"aep_data": {"id": 2}}
    cache = {"aep_data": {"id": 2}}

    result = asyncio.run(
        async_attempt_cloud_login(client, "a@b.com", "secret", MagicMock(), cache)
    )

    client.restore_credentials.assert_awaited_once()
    client.login_and_initiate_cloud.assert_not_called()
    assert result.get("aep_data") == {"id": 2}
