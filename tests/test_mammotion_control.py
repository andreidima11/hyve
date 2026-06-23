"""Mammotion control dispatch tests."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from components.mammotion.control import control_mammotion, parse_target_id


def test_parse_target_id_primary():
    device, domain, key = parse_target_id("mammotion:Luba-XYZ")
    assert device == "Luba-XYZ"
    assert domain == "lawn_mower"
    assert key == ""


def test_parse_target_id_sub_entity():
    device, domain, key = parse_target_id("mammotion:Luba-XYZ:switch:rain_detection")
    assert device == "Luba-XYZ"
    assert domain == "switch"
    assert key == "rain_detection"


def test_parse_target_id_from_entity_id():
    device, domain, key = parse_target_id(
        "lawn_mower.luba_xyz",
        known_devices=["Luba-XYZ"],
    )
    assert device == "Luba-XYZ"
    assert domain == "lawn_mower"
    assert key == ""


def test_parse_target_id_from_hyve_switch_entity_id():
    device, domain, key = parse_target_id(
        "switch.luba_mnzfswqu_rain_detection",
        known_devices=["Luba-MNZFSWQU"],
    )
    assert device == "Luba-MNZFSWQU"
    assert domain == "switch"
    assert key == "rain_detection"


def test_parse_target_id_from_hyve_button_entity_id():
    device, domain, key = parse_target_id(
        "button.luba_test01_start_map_sync",
        known_devices=["Luba-TEST01"],
    )
    assert device == "Luba-TEST01"
    assert domain == "button"
    assert key == "start_map_sync"


def test_control_switch_via_entity_id():
    coord = MagicMock()
    coord.device_name = "Luba-MNZFSWQU"
    coord.apply_switch = AsyncMock()

    async def _run():
        return await control_mammotion(
            coord,
            "switch.luba_mnzfswqu_rain_detection",
            "turn_on",
            {},
        )

    result = asyncio.run(_run())
    coord.apply_switch.assert_awaited_once_with("rain_detection", True)
    assert result["status"] == "ok"


def test_control_switch_via_unique_id():
    coord = MagicMock()
    coord.device_name = "Luba-XYZ"
    coord.apply_switch = AsyncMock()

    async def _run():
        return await control_mammotion(coord, "mammotion:Luba-XYZ:switch:rain_detection", "turn_on", {})

    result = asyncio.run(_run())
    coord.apply_switch.assert_awaited_once_with("rain_detection", True)
    assert result["status"] == "ok"
    assert result["action"] == "turn_on"


def test_control_lawn_mower_start():
    coord = MagicMock()
    coord.device_name = "Luba-XYZ"
    coord.start_mow = AsyncMock()

    async def _run():
        return await control_mammotion(coord, "mammotion:Luba-XYZ", "start", {"areas": [1]})

    result = asyncio.run(_run())
    coord.start_mow.assert_awaited_once_with(areas=[1])
    assert result["status"] == "ok"


def test_control_mowing_zone_select_via_entity_id():
    coord = MagicMock()
    coord.device_name = "Luba-TEST01"
    coord.apply_config_select = AsyncMock()

    async def _run():
        return await control_mammotion(
            coord,
            "select.luba_test01_mowing_zone",
            "set",
            {"value": "111"},
        )

    result = asyncio.run(_run())
    coord.apply_config_select.assert_awaited_once_with("mowing_zone", "111")
    assert result["status"] == "ok"


def test_set_mowing_zone_single_area():
    from components.mammotion.coordinator import MowerCoordinator

    coord = MowerCoordinator(MagicMock(), "Luba-TEST01")
    coord.set_mowing_zone("111")
    assert coord.operation_settings.areas == [111]


def test_set_mowing_zone_all_resets_to_every_area(monkeypatch):
    from components.mammotion.coordinator import MowerCoordinator

    client = MagicMock()
    client.get_device_by_name.return_value = MagicMock()
    coord = MowerCoordinator(client, "Luba-TEST01")
    coord.operation_settings.areas = [111]
    monkeypatch.setattr(
        "components.mammotion.snapshot.map_data.iter_map_area_pairs",
        lambda _device: [(111, "Front"), (222, "Back")],
    )
    coord.set_mowing_zone("all")
    assert coord.operation_settings.areas == [111, 222]


def test_set_mowing_zone_invalid_value_raises():
    from components.mammotion.coordinator import MowerCoordinator

    coord = MowerCoordinator(MagicMock(), "Luba-TEST01")
    with pytest.raises(ValueError, match="Zonă de lucru"):
        coord.set_mowing_zone("not-a-hash")


def test_control_nudge_button_calls_move_left():
    coord = MagicMock()
    coord.device_name = "Luba-TEST01"
    coord.press_button = AsyncMock()

    async def _run():
        return await control_mammotion(
            coord,
            "button.luba_test01_emergency_nudge_left",
            "press",
            {},
        )

    result = asyncio.run(_run())
    coord.press_button.assert_awaited_once_with("emergency_nudge_left")
    assert result["status"] == "ok"


def test_nudge_move_uses_pymammotion_command_keys():
    from unittest.mock import patch

    from components.mammotion.coordinator import MowerCoordinator
    from pymammotion.utility.constant.device_constant import WorkMode

    client = MagicMock()
    device = MagicMock()
    dev = MagicMock()
    dev.sys_status = WorkMode.MODE_READY
    device.report_data.dev = dev
    client.get_device_by_name.return_value = device

    coord = MowerCoordinator(client, "Luba-TEST01", movement_use_wifi=True)
    with (
        patch(
            "components.mammotion.session_bootstrap.ensure_nudge_transport",
            new_callable=AsyncMock,
            return_value="cloud_mammotion",
        ),
        patch.object(coord, "_send", new_callable=AsyncMock) as send,
    ):
        asyncio.run(coord.move_left(0.35))
    move_calls = [c for c in send.await_args_list if c.args and c.args[0] == "move_left"]
    assert len(move_calls) == 5
    assert move_calls[0].kwargs == {"prefer_ble": False, "angular": 0.35}


def test_nudge_blocked_on_dock_without_release():
    from components.mammotion.coordinator import MowerCoordinator
    from pymammotion.utility.constant.device_constant import WorkMode

    client = MagicMock()
    device = MagicMock()
    dev = MagicMock()
    dev.sys_status = WorkMode.MODE_CHARGING
    device.report_data.dev = dev
    client.get_device_by_name.return_value = device

    coord = MowerCoordinator(client, "Luba-TEST01", movement_use_wifi=True)
    with pytest.raises(ValueError, match="dock"):
        asyncio.run(coord.move_forward())
