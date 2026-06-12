"""Mammotion control dispatch tests."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

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
