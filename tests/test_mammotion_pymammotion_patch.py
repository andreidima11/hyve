"""pymammotion 0.8.x compatibility patches."""

from __future__ import annotations

from components.mammotion.pymammotion_compat import apply_pymammotion_patches


def test_apply_pymammotion_patches_idempotent():
    apply_pymammotion_patches()
    from pymammotion.client import MammotionClient

    assert getattr(MammotionClient._full_relogin, "_hyve_patched", False) is True
    apply_pymammotion_patches()
    assert getattr(MammotionClient._full_relogin, "_hyve_patched", False) is True


def test_mammotion_http_uses_ha_app_version_header():
    from pymammotion.http.http import MammotionHTTP

    from components.mammotion.utils import mammotion_ha_fingerprint

    tag = mammotion_ha_fingerprint()
    http = MammotionHTTP(ha_version=tag)
    assert http._headers.get("App-Version") == f"HA,2.{tag}"
    assert hasattr(http, "devices_shared_info")


def test_mammotion_ha_fingerprint_defaults_to_known_good_tag(monkeypatch):
    from components.mammotion.utils import mammotion_ha_fingerprint

    monkeypatch.delenv("MAMMOTION_HA_FINGERPRINT", raising=False)
    assert mammotion_ha_fingerprint() == "0.6.4"


def test_login_and_initiate_cloud_is_not_wrapped():
    apply_pymammotion_patches()
    from pymammotion.client import MammotionClient

    assert getattr(MammotionClient.login_and_initiate_cloud, "_hyve_patched", False) is False


def test_pymammotion_patch_shim_reexports():
    from components.mammotion import pymammotion_patch

    assert callable(pymammotion_patch.apply_pymammotion_patches)
    assert callable(pymammotion_patch.complete_device_registration)
    assert callable(pymammotion_patch.list_http_device_names)


def test_full_relogin_patch_is_applied():
    apply_pymammotion_patches()
    from pymammotion.client import MammotionClient

    assert getattr(MammotionClient._full_relogin, "_hyve_patched", False) is True
    assert getattr(MammotionClient._restore_aliyun, "_hyve_patched", False) is True
    assert getattr(MammotionClient._setup_aliyun_transport, "_hyve_patched", False) is True


def test_full_relogin_patch_accepts_transport_type():
    import inspect

    apply_pymammotion_patches()
    from pymammotion.client import MammotionClient

    params = inspect.signature(MammotionClient._full_relogin).parameters
    assert "transport_type" in params


def test_active_transport_patch_prefers_usable_mqtt():
    from unittest.mock import MagicMock

    import components.mammotion.pymammotion_compat as compat
    from pymammotion.device.handle import DeviceHandle
    from pymammotion.transport.base import TransportType

    compat._PATCHED = False
    compat.apply_pymammotion_patches()

    dead_aliyun = MagicMock()
    dead_aliyun.is_usable = False
    dead_aliyun.is_connected = False
    live_mammotion = MagicMock()
    live_mammotion.is_usable = True
    live_mammotion.is_connected = True
    live_mammotion.transport_type = TransportType.CLOUD_MAMMOTION

    handle = MagicMock()
    handle._prefer_ble = False
    handle._transports = {
        TransportType.CLOUD_ALIYUN: dead_aliyun,
        TransportType.CLOUD_MAMMOTION: live_mammotion,
    }
    handle._availability.mqtt_reported_offline = False
    handle._last_active_transport_log = None
    handle.device_name = "Luba-TEST"
    handle.device_id = "dev1"

    selected = DeviceHandle.active_transport(handle, prefer_ble=False)
    assert selected is live_mammotion


def test_full_relogin_patch_delegates_with_transport_type():
    import asyncio
    from unittest.mock import AsyncMock, MagicMock, patch

    import components.mammotion.pymammotion_compat as compat
    from pymammotion.client import MammotionClient
    from pymammotion.transport.base import TransportType

    orig = AsyncMock()
    with patch.object(MammotionClient, "_full_relogin", orig):
        compat._PATCHED = False
        compat.apply_pymammotion_patches()

        client = MagicMock()
        http_sess = MagicMock()
        client._hyve_http_session = http_sess
        session = MagicMock()
        session.mammotion_http = MagicMock()
        session.cloud_client = None

        asyncio.run(
            MammotionClient._full_relogin(client, session, transport_type=TransportType.CLOUD_ALIYUN)
        )

    orig.assert_awaited_once_with(client, session, transport_type=TransportType.CLOUD_ALIYUN)
