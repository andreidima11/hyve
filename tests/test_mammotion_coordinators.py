"""Mammotion coordinators — report / map / errors."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from components.mammotion.coordinators.errors import ErrorCoordinator
from components.mammotion.coordinators.map import MapCoordinator
from components.mammotion.coordinators.report import ReportCoordinator
from pymammotion.data.model.enums import SensorCheckState
from pymammotion.utility.constant.device_constant import WorkMode


def test_error_coordinator_collects_sensor_fault():
    dev = MagicMock()
    dev.sys_status = WorkMode.MODE_READY
    dev.bumper_state = SensorCheckState.ERROR
    dev.ult_left = SensorCheckState.OK
    dev.lock_state = MagicMock(lock_state=0)
    dev.fpv_info = None
    dev.self_check_status = 0

    device = MagicMock()
    device.report_data.dev = dev

    client = MagicMock()
    client.get_device_by_name.return_value = device
    coord = ErrorCoordinator(client, "Luba-TEST")
    errors = coord.refresh(device)

    assert "bumper_state" in errors
    assert "fault" in errors["bumper_state"].lower()


def test_map_coordinator_sync_maps():
    client = MagicMock()
    client.start_map_sync = AsyncMock()
    coord = MapCoordinator(client, "Luba-TEST")

    import asyncio

    asyncio.run(coord.sync_maps())

    client.start_map_sync.assert_awaited_once_with("Luba-TEST")
    assert coord.map_sync_status == "synced"


def test_report_coordinator_meta_reflects_telemetry():
    dev = MagicMock()
    dev.sys_status = 11
    dev.battery_val = 55
    device = MagicMock()
    device.report_data.dev = dev

    client = MagicMock()
    client.get_device_by_name.return_value = device

    coord = ReportCoordinator(client, "Luba-TEST")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "components.mammotion.coordinators.report.device_handle_online",
            lambda _c, _n: True,
        )
        meta = coord.meta()

    assert meta["mqtt_online"] is True
    assert meta["telemetry_ready"] is True


def test_mower_coordinator_has_ensure_ready_for_control():
    from components.mammotion.coordinator import MowerCoordinator

    coord = MowerCoordinator(MagicMock(), "Luba-TEST")
    assert hasattr(coord, "_ensure_ready_for_control")
    assert callable(coord._ensure_ready_for_control)
