"""Mammotion command transport and HA-parity mower control flows."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from components.mammotion.coordinator import MowerCoordinator
from pymammotion.utility.constant.device_constant import WorkMode


def _device(*, sys_status: int, charge_state: int = 0, bp_info: int = 0):
    dev = MagicMock()
    dev.sys_status = sys_status
    dev.charge_state = charge_state
    work = MagicMock()
    work.bp_info = bp_info
    report_data = MagicMock()
    report_data.dev = dev
    report_data.work = work
    device = MagicMock()
    device.report_data = report_data
    return device


def test_generate_route_information_uses_one_hashs():
    device = _device(sys_status=WorkMode.MODE_READY)
    client = MagicMock()
    client.get_device_by_name.return_value = device
    coord = MowerCoordinator(client, "Luba-TEST")
    coord.operation_settings.areas = [101, 202]

    import asyncio

    route = asyncio.run(coord.generate_route_information(coord.operation_settings))

    assert route.one_hashs == [101, 202]
    assert route.path_order


def test_start_mow_ready_plans_route_then_waits_for_start_ack():
    device = _device(sys_status=WorkMode.MODE_READY, bp_info=0)
    client = MagicMock()
    client.get_device_by_name.return_value = device

    coord = MowerCoordinator(client, "Luba-TEST")
    coord._ensure_fresh_state = AsyncMock()
    coord.plan_route = AsyncMock()
    coord._send = AsyncMock()
    coord._send_and_wait = AsyncMock()
    coord.request_report_snapshot = AsyncMock()

    import asyncio

    asyncio.run(coord.start_mow())

    coord.plan_route.assert_awaited_once()
    coord._send_and_wait.assert_awaited_once_with(
        "start_job",
        "zone_start_precent_t",
        send_timeout=15.0,
    )
    coord._send.assert_not_awaited()
    coord.request_report_snapshot.assert_awaited()


def test_start_mow_ready_with_breakpoint_sends_start_job_directly():
    device = _device(sys_status=WorkMode.MODE_READY, bp_info=1)
    client = MagicMock()
    client.get_device_by_name.return_value = device

    coord = MowerCoordinator(client, "Luba-TEST")
    coord._ensure_fresh_state = AsyncMock()
    coord.plan_route = AsyncMock()
    coord._send = AsyncMock()
    coord._send_and_wait = AsyncMock()
    coord.request_report_snapshot = AsyncMock()

    import asyncio

    asyncio.run(coord.start_mow())

    coord._send_and_wait.assert_awaited_once_with(
        "query_generate_route_information",
        "bidire_reqconver_path",
    )
    coord._send.assert_awaited_once_with("start_job")
    coord.plan_route.assert_not_awaited()


def test_dock_starts_report_stream_and_sends_return_to_dock():
    device = _device(sys_status=WorkMode.MODE_READY, charge_state=0)
    client = MagicMock()
    client.get_device_by_name.return_value = device

    coord = MowerCoordinator(client, "Luba-TEST")
    coord._send = AsyncMock()
    coord.request_report_snapshot = AsyncMock()

    with pytest.MonkeyPatch.context() as mp:
        stream = AsyncMock()
        mp.setattr("components.mammotion.session_bootstrap.start_report_stream", stream)
        import asyncio

        asyncio.run(coord.dock())

    stream.assert_awaited_once_with(client, "Luba-TEST")
    coord._send.assert_awaited_once_with("return_to_dock")
    coord.request_report_snapshot.assert_awaited()


def test_async_send_command_raises_when_offline():
    from components.mammotion.command_transport import async_send_command

    client = MagicMock()
    client.get_device_by_name.return_value = MagicMock()
    client.mower.return_value = MagicMock(_rate_limited=False)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.command_transport.device_handle_online",
            lambda _c, _n: False,
        )
        with pytest.raises(ValueError, match="offline"):
            import asyncio

            asyncio.run(async_send_command(client, "Luba-X", "start_job"))


def test_async_send_command_raises_when_no_transport():
    from components.mammotion.command_transport import async_send_command

    client = MagicMock()
    client.get_device_by_name.return_value = MagicMock()
    handle = MagicMock()
    handle.has_usable_transport = False
    client.mower.return_value = handle

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.command_transport.device_handle_online",
            lambda _c, _n: True,
        )
        with pytest.raises(ValueError, match="Comanda nu a putut"):
            import asyncio

            asyncio.run(async_send_command(client, "Luba-X", "move_forward", linear=0.4))


def test_async_send_command_uses_send_raw():
    from components.mammotion.command_transport import async_send_command

    client = MagicMock()
    client.get_device_by_name.return_value = MagicMock()
    handle = MagicMock()
    handle.has_usable_transport = True
    handle.commands.move_forward.return_value = b"\x01\x02"
    client.mower.return_value = handle
    client._get_session_for_device.return_value = MagicMock()
    client._send_with_auth_retry = AsyncMock()

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.command_transport.device_handle_online",
            lambda _c, _n: True,
        )
        import asyncio

        asyncio.run(async_send_command(client, "Luba-X", "move_forward", linear=0.4, prefer_ble=False))

    client._send_with_auth_retry.assert_awaited_once()
