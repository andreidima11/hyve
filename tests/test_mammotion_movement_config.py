"""Mammotion movement_use_wifi runtime config."""

from __future__ import annotations

from unittest.mock import MagicMock

from components.mammotion.hub import MammotionHub
from components.mammotion.utils import movement_use_wifi_from_entry


def test_movement_use_wifi_from_entry_parses_bool_and_string():
    assert movement_use_wifi_from_entry({"movement_use_wifi": True}) is True
    assert movement_use_wifi_from_entry({"movement_use_wifi": False}) is False
    assert movement_use_wifi_from_entry({"movement_use_wifi": "true"}) is True
    assert movement_use_wifi_from_entry({"movement_use_wifi": "false"}) is False
    assert movement_use_wifi_from_entry({}) is False


def test_hub_apply_runtime_options_updates_coordinators():
    hub = MammotionHub(account="a@b.c", password="x", cache={}, movement_use_wifi=False)
    coord = MagicMock()
    coord.movement_use_wifi = False
    hub._coordinators["Luba-TEST"] = coord

    hub.apply_runtime_options(movement_use_wifi=True)

    assert hub.movement_use_wifi is True
    assert coord.movement_use_wifi is True
