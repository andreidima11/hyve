"""Mammotion select entity options."""

from __future__ import annotations

from components.mammotion.specs.mower import build_mower_entities
from components.mammotion.specs.row import MowerRow
from components.mammotion.specs.selects import resolve_select_option, select_options_for_key


def test_channel_mode_options_use_pymammotion_enum_names():
    names = select_options_for_key("channel_mode", {}, "Luba-TEST")
    assert "single_grid" in names
    assert "parallel" not in names


def test_resolve_select_option_from_int():
    options = select_options_for_key("mowing_laps", {}, "Luba-TEST")
    assert resolve_select_option("mowing_laps", 2, options) == "two"


def test_select_entity_includes_dropdown_options():
    row = MowerRow.from_snapshot(
        {
            "device_name": "Luba-TEST01",
            "name": "Robot",
            "online": True,
            "status": {"sys_status": 11, "charge_state": 1, "battery": 80},
            "flags": {"is_luba_pro": True},
            "selects": {"channel_mode": 1, "voice_gender": "MAN"},
        }
    )
    entities = build_mower_entities(row)
    channel = next(e for e in entities if e["entity_id"].endswith("_channel_mode"))
    opts = channel["attributes"]["capabilities"]["options"]
    assert len(opts) >= 4
    assert channel["state"] == "double_grid"
    assert any(o["value"] == "double_grid" for o in opts)
