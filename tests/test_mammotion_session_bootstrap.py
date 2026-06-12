"""Mammotion session bootstrap helpers."""

from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest

from components.mammotion.session_bootstrap import (
    mark_client_rate_limited,
    require_device_ready,
)


class _FakeClient:
    def __init__(self, device=None):
        self._device = device
        self._hyve_rate_limited_until = 0.0

    def get_device_by_name(self, _name: str):
        return self._device


class _FakeHandle:
    availability = type("A", (), {"mqtt_reported_offline": False})()


def test_mqtt_transport_connected_uses_shared_account_transport():
    from pymammotion.transport.base import TransportType

    transport = type("T", (), {"is_connected": True, "transport_type": TransportType.CLOUD_MAMMOTION, "last_received_monotonic": 0.0})()
    acct = type("A", (), {"device_ids": {"Luba-X"}, "mammotion_transport": transport, "aliyun_transport": None})()
    handle = type(
        "H",
        (),
        {
            "has_transport": lambda _self, t: t == TransportType.CLOUD_MAMMOTION,
            "is_transport_connected": lambda _self, _t: False,
            "_transports": {},
        },
    )()
    client = type(
        "C",
        (),
        {
            "mower": lambda _self, _n: handle,
            "_account_registry": type("R", (), {"all_sessions": [acct]})(),
        },
    )()

    from components.mammotion.session_bootstrap import mqtt_transport_connected

    assert mqtt_transport_connected(client, "Luba-X") is True


def test_mqtt_transport_connected_uses_recent_inbound_activity():
    import time

    from pymammotion.transport.base import TransportType

    transport = type(
        "T",
        (),
        {
            "is_connected": False,
            "transport_type": TransportType.CLOUD_MAMMOTION,
            "last_received_monotonic": time.monotonic(),
        },
    )()
    handle = type(
        "H",
        (),
        {
            "has_transport": lambda _self, t: t == TransportType.CLOUD_MAMMOTION,
            "is_transport_connected": lambda _self, _t: False,
            "_transports": {TransportType.CLOUD_MAMMOTION: transport},
        },
    )()
    client = type("C", (), {"mower": lambda _self, _n: handle, "_account_registry": None})()

    from components.mammotion.session_bootstrap import mqtt_transport_connected

    assert mqtt_transport_connected(client, "Luba-X") is True


def test_control_path_ready_when_telemetry_live_without_is_connected():
    dev = type("Dev", (), {"sys_status": 11, "battery_val": 80, "charge_state": 1})()
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": dev})()},
    )()
    client = _FakeClient(device)
    handle = type("H", (), {"availability": type("A", (), {"mqtt_reported_offline": False})()})()
    handle.has_transport = lambda _t: False  # type: ignore[method-assign]
    client.mower = lambda _name: handle  # type: ignore[method-assign]

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.session_bootstrap.mqtt_transport_connected",
            lambda _c, _n: False,
        )
        from components.mammotion.session_bootstrap import control_path_ready

        assert control_path_ready(client, "Luba-X") is True


def test_clear_pymammotion_rate_limit_for_user_command():
    dev = type("Dev", (), {"sys_status": 11, "battery_val": 80, "charge_state": 1})()
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": dev})()},
    )()
    client = _FakeClient(device)
    transport = type("T", (), {"is_rate_limited": True, "_rate_limited_until": 999.0})()
    handle = type("H", (), {"availability": type("A", (), {"mqtt_reported_offline": False})(), "_transports": {}})()
    handle.has_transport = lambda _t: False  # type: ignore[method-assign]
    client.mower = lambda _name: handle  # type: ignore[method-assign]

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.session_bootstrap.mqtt_transport_connected",
            lambda _c, _n: True,
        )
        mp.setattr(
            "components.mammotion.session_bootstrap._iter_cloud_transports",
            lambda _c, _n: [transport],
        )
        from components.mammotion.session_bootstrap import clear_pymammotion_rate_limit_for_command

        clear_pymammotion_rate_limit_for_command(client, "Luba-X")

    assert transport._rate_limited_until == 0.0


def test_prepare_device_does_not_clear_pymammotion_rate_limit():
    client = _FakeClient(None)
    transport = type("T", (), {"is_rate_limited": True, "_rate_limited_until": 999.0})()
    handle = type("H", (), {"availability": type("A", (), {"mqtt_reported_offline": False})()})()
    client.mower = lambda _name: handle  # type: ignore[method-assign]

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.session_bootstrap._iter_cloud_transports",
            lambda _c, _n: [transport],
        )
        from components.mammotion.session_bootstrap import prepare_device_for_command

        prepare_device_for_command(client, "Luba-X")

    assert transport._rate_limited_until == 999.0


def test_request_report_snapshot_skips_when_pymammotion_rate_limited():
    client = MagicMock()
    transport = MagicMock(is_rate_limited=True)
    client.mower.return_value = MagicMock()

    async def _run():
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(
                "components.mammotion.session_bootstrap._iter_cloud_transports",
                lambda _c, _n: [transport],
            )
            from components.mammotion.session_bootstrap import request_report_snapshot

            await request_report_snapshot(client, "Luba-X")
        client.request_iot_sync.assert_not_called()

    import asyncio

    asyncio.run(_run())


def test_require_device_ready_relaxed_when_rate_limited():
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": None})()},
    )()
    client = _FakeClient(device)
    mark_client_rate_limited(client, seconds=60.0)

    client.mower = lambda _name: _FakeHandle()  # type: ignore[method-assign]
    require_device_ready(client, "Luba-X", strict=False)


def test_raise_if_device_rate_limited_only_for_hyve_backoff():
    device = type("D", (), {"online": True})()
    client = _FakeClient(device)
    handle = type("H", (), {"_rate_limited": True})()
    client.mower = lambda _name: handle  # type: ignore[method-assign]

    from components.mammotion.session_bootstrap import raise_if_device_rate_limited

    raise_if_device_rate_limited(client, "Luba-X")

    mark_client_rate_limited(client, seconds=60.0)
    with pytest.raises(ValueError, match="1–2 minute"):
        raise_if_device_rate_limited(client, "Luba-X")


def test_device_handle_online_ignores_stale_mqtt_offline_when_telemetry_live():
    dev = type("Dev", (), {"sys_status": 11, "battery_val": 0, "charge_state": 1})()
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": dev})()},
    )()
    client = _FakeClient(device)
    avail = type("A", (), {"mqtt_reported_offline": True, "mqtt": object()})()
    handle = type(
        "H",
        (),
        {
            "availability": avail,
            "has_transport": lambda _self, _t: True,
        },
    )()
    client.mower = lambda _name: handle  # type: ignore[method-assign]

    with __import__("pytest").MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.session_bootstrap.mqtt_transport_connected",
            lambda _c, _n: True,
        )
        from components.mammotion.session_bootstrap import device_handle_online

        assert device_handle_online(client, "Luba-X") is True


def test_prepare_device_clears_stale_mqtt_offline_flag():
    dev = type("Dev", (), {"sys_status": 15, "battery_val": 80, "charge_state": 1})()
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": dev})()},
    )()
    client = _FakeClient(device)
    avail = type("A", (), {"mqtt_reported_offline": True, "mqtt": object()})()
    cleared: list[bool] = []

    class _Handle:
        availability = avail

        def has_transport(self, _t):
            return True

        def update_availability(self, _t, _mqtt, *, mqtt_reported_offline=False):
            cleared.append(mqtt_reported_offline)

    client.mower = lambda _name: _Handle()  # type: ignore[method-assign]
    client.get_device_by_name = lambda _name: device  # type: ignore[method-assign]

    from components.mammotion.session_bootstrap import prepare_device_for_command

    prepare_device_for_command(client, "Luba-X")
    assert cleared == [False]


def test_clear_rate_limit_when_telemetry_ready():
    dev = type("Dev", (), {"sys_status": 11, "battery_val": 80})()
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": dev})()},
    )()
    client = _FakeClient(device)
    mark_client_rate_limited(client, seconds=120.0)
    client.mower = lambda _name: _FakeHandle()  # type: ignore[method-assign]

    from components.mammotion.session_bootstrap import clear_rate_limit_if_control_ready

    clear_rate_limit_if_control_ready(client, "Luba-X")
    assert client._hyve_rate_limited_until == 0.0


def test_require_device_ready_for_control_skips_telemetry_poll():
    dev = type("Dev", (), {"sys_status": 0, "battery_val": 0, "charge_state": 0})()
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": dev})()},
    )()
    client = _FakeClient(device)
    client.mower = lambda _name: _FakeHandle()  # type: ignore[method-assign]
    require_device_ready(client, "Luba-X", for_control=True)


def test_require_device_ready_strict_raises_without_telemetry():
    dev = type("Dev", (), {"sys_status": 0, "battery_val": 0})()
    device = type(
        "D",
        (),
        {"online": True, "report_data": type("R", (), {"dev": dev})()},
    )()
    client = _FakeClient(device)
    client.mower = lambda _name: _FakeHandle()  # type: ignore[method-assign]

    with pytest.raises(ValueError, match="pregătit"):
        require_device_ready(client, "Luba-X", strict=True)
