"""MammotionHub — auth-only test and sync delegation."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from components.mammotion.hub import MammotionHub


def test_test_auth_returns_after_login_without_full_sync():
    hub = MammotionHub(account="a@b.com", password="secret", cache=None)
    hub._ensure_client = MagicMock(return_value=MagicMock())
    hub._ensure_http = AsyncMock(return_value=MagicMock(closed=False))

    with patch("components.mammotion.session_binding.bind_http_to_client"), patch(
        "components.mammotion.cloud_login.async_test_cloud_login",
        new_callable=AsyncMock,
        return_value=(True, "Autentificare reușită — 1 dispozitive găsite.", 1),
    ) as test_login:
        ok, message, count = asyncio.run(hub.test_auth())

    test_login.assert_awaited_once()
    assert ok is True
    assert count == 1
    assert "1 dispozitive" in message


def test_test_auth_reports_failure():
    hub = MammotionHub(account="a@b.com", password="secret", cache=None)
    hub._ensure_client = MagicMock(return_value=MagicMock())
    hub._ensure_http = AsyncMock(return_value=MagicMock(closed=False))

    with patch("components.mammotion.session_binding.bind_http_to_client"), patch(
        "components.mammotion.cloud_login.async_test_cloud_login",
        new_callable=AsyncMock,
        return_value=(False, "Autentificare Mammotion eșuată.", 0),
    ):
        ok, message, count = asyncio.run(hub.test_auth())

    assert ok is False
    assert count == 0


def test_session_test_connection_uses_test_auth():
    from components.mammotion.client import MammotionSession

    session = MammotionSession(account="a@b.com", password="x", cache=None)
    session._hub.test_auth = AsyncMock(return_value=(True, "OK", 2))

    ok, msg, n = asyncio.run(session.test_connection())

    session._hub.test_auth.assert_awaited_once()
    assert ok and n == 2


def test_hub_on_push_callback():
    calls: list[str] = []
    hub = MammotionHub(account="a@b.com", password="secret", cache=None, on_push=lambda: calls.append("push"))
    assert hub._on_push is not None
    hub._on_push()
    assert calls == ["push"]


def test_pull_live_connects_then_reads_memory_only():
    hub = MammotionHub(account="a@b.com", password="secret", cache=None)
    hub.connect = AsyncMock()
    hub._ensure_watchers = AsyncMock()
    hub.build_live_payload = AsyncMock(return_value={"devices": [{"device_name": "Luba-X"}]})
    hub._iter_device_names = MagicMock(return_value=[])

    payload = asyncio.run(hub.pull_live())

    hub.connect.assert_awaited_once()
    hub.build_live_payload.assert_awaited_once()
    assert payload["devices"][0]["device_name"] == "Luba-X"


def test_build_live_payload_without_network():
    hub = MammotionHub(account="a@b.com", password="secret", cache=None)
    payload = asyncio.run(hub.build_live_payload())
    assert payload == {"devices": []}


def test_pull_live_skips_cloud_poll_when_registry_ready():
    hub = MammotionHub(account="a@b.com", password="secret", cache=None)
    hub._iter_device_names = MagicMock(return_value=["Luba-X"])
    hub._ensure_watchers = AsyncMock()
    hub.build_live_payload = AsyncMock(return_value={"devices": []})
    payload = asyncio.run(hub.pull_live())
    hub.build_live_payload.assert_awaited_once()
    assert payload == {"devices": []}


def test_connect_skips_restore_when_session_already_active():
    hub = MammotionHub(account="a@b.com", password="secret", cache={"token": "stale"})
    mock_client = MagicMock()
    mock_session = MagicMock(account_id="a@b.com")
    mock_client._account_registry.all_sessions = [mock_session]
    hub._client = mock_client
    hub._ensure_http = AsyncMock(return_value=MagicMock(closed=False))
    hub._ensure_watchers = AsyncMock()
    hub._iter_device_names = MagicMock(return_value=["Luba-X"])

    with patch("components.mammotion.session_binding.bind_http_to_client"), patch(
        "components.mammotion.hub.mqtt_transport_connected", return_value=True
    ), patch(
        "components.mammotion.cloud_login.async_attempt_cloud_login", new_callable=AsyncMock
    ) as cloud_login:
        asyncio.run(hub.connect())

    cloud_login.assert_not_called()
    hub._ensure_watchers.assert_awaited_once()


def test_connect_uses_cloud_login_then_finalize():
    hub = MammotionHub(account="a@b.com", password="secret", cache={"aep_data": {"id": 1}})
    hub._ensure_http = AsyncMock(return_value=MagicMock(closed=False))
    hub._finalize_connect = AsyncMock()
    hub._ensure_client = MagicMock(return_value=MagicMock(_account_registry=MagicMock(all_sessions=[])))

    with patch("components.mammotion.session_binding.bind_http_to_client"), patch(
        "components.mammotion.cloud_login.async_attempt_cloud_login",
        new_callable=AsyncMock,
        return_value={"aep_data": {"id": 1}},
    ) as cloud_login:
        asyncio.run(hub.connect())

    cloud_login.assert_awaited_once()
    hub._finalize_connect.assert_awaited_once()


def test_bootstrap_runs_once_per_device():
    hub = MammotionHub(account="a@b.com", password="secret", cache=None)
    client = MagicMock()
    hub._client = client
    hub._iter_device_names = MagicMock(return_value=["Luba-X"])

    with patch("components.mammotion.hub.mqtt_transport_connected", return_value=True), patch(
        "components.mammotion.hub.bootstrap_device", new_callable=AsyncMock
    ) as bootstrap, patch("components.mammotion.hub.wait_for_telemetry", new_callable=AsyncMock):
        client.mower.return_value = MagicMock(_rate_limited=False)
        asyncio.run(hub._bootstrap_devices_once())
        asyncio.run(hub._bootstrap_devices_once())

    bootstrap.assert_awaited_once()
    assert "Luba-X" in hub._bootstrapped_devices


def test_save_cache_if_unhealthy_does_not_wipe_existing_cache():
    hub = MammotionHub(account="a@b.com", password="secret", cache={"token": "keep"})
    hub._persist_cache = MagicMock()
    hub._iter_device_names = MagicMock(return_value=[])
    asyncio.run(hub._save_cache_if_healthy())
    hub._persist_cache.assert_not_called()
    assert hub._cache == {"token": "keep"}


def test_session_active_matches_account():
    hub = MammotionHub(account="a@b.com", password="secret", cache=None)
    assert hub._session_active() is False
    mock_client = MagicMock()
    mock_client._account_registry.all_sessions = [MagicMock(account_id="other@b.com")]
    hub._client = mock_client
    assert hub._session_active() is False
    mock_client._account_registry.all_sessions = [MagicMock(account_id="a@b.com")]
    assert hub._session_active() is True
