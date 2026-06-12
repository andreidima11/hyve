"""Mammotion ensure_control_path (user command prep)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from components.mammotion.hub import MammotionHub


def test_ensure_control_path_allows_live_telemetry_without_mqtt_flag():
    hub = MammotionHub(account="a@b.com", password="secret", cache={})
    mock_client = MagicMock()
    hub._ensure_client = MagicMock(return_value=mock_client)
    hub._ensure_http = AsyncMock(return_value=MagicMock(closed=False))
    hub._session_active = MagicMock(return_value=True)
    hub._iter_device_names = MagicMock(return_value=["Luba-X"])
    hub._ensure_watchers = AsyncMock()

    async def _run():
        with patch("components.mammotion.session_binding.bind_http_to_client"), patch(
            "components.mammotion.session_binding.ensure_account_http", new_callable=AsyncMock
        ), patch(
            "components.mammotion.session_bootstrap.control_path_ready", return_value=True
        ), patch(
            "components.mammotion.device_registration.ensure_mqtt_transports", new_callable=AsyncMock
        ) as ensure_mqtt:
            await hub.ensure_control_path()
        ensure_mqtt.assert_not_awaited()

    asyncio.run(_run())


def test_ensure_control_path_reconnects_for_control_when_not_ready():
    hub = MammotionHub(account="a@b.com", password="secret", cache={})
    mock_client = MagicMock()
    hub._ensure_client = MagicMock(return_value=mock_client)
    hub._ensure_http = AsyncMock(return_value=MagicMock(closed=False))
    hub._session_active = MagicMock(return_value=True)
    hub._iter_device_names = MagicMock(return_value=["Luba-X"])
    hub._ensure_watchers = AsyncMock()

    ready = {"value": False}

    def _ready(_client, _name):
        return ready["value"]

    async def _reconnect(*_args, **_kwargs):
        ready["value"] = True
        return True

    async def _run():
        with patch("components.mammotion.session_binding.bind_http_to_client"), patch(
            "components.mammotion.session_binding.ensure_account_http", new_callable=AsyncMock
        ), patch("components.mammotion.session_bootstrap.control_path_ready", side_effect=_ready), patch(
            "components.mammotion.device_registration.ensure_mqtt_transports", side_effect=_reconnect
        ) as ensure_mqtt:
            await hub.ensure_control_path()
        ensure_mqtt.assert_awaited_once()
        assert ensure_mqtt.await_args.kwargs.get("for_control") is True

    asyncio.run(_run())
