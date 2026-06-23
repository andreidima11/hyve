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


def _mower_row_with_areas(selected: set[int]) -> MowerRow:
    return MowerRow.from_snapshot(
        {
            "device_name": "Luba-TEST01",
            "name": "Robot",
            "online": True,
            "status": {"sys_status": 11, "battery": 80},
            "flags": {},
            "areas": [
                {"hash": 111, "name": "Front", "selected": 111 in selected},
                {"hash": 222, "name": "Back", "selected": 222 in selected},
            ],
        }
    )


def test_mowing_zone_select_lists_areas_and_all_option():
    entities = build_mower_entities(_mower_row_with_areas({111}))
    zone = next(e for e in entities if e["entity_id"].endswith("_mowing_zone"))
    assert zone["domain"] == "select"
    assert zone["controllable"] is True
    options = zone["attributes"]["capabilities"]["options"]
    values = [o["value"] for o in options]
    assert values[0] == "all"
    assert "111" in values and "222" in values
    labels = {o["value"]: o["label"] for o in options}
    assert labels["111"] == "Front"
    # exactly one area selected → that area is the current option
    assert zone["state"] == "111"


def test_mowing_zone_state_all_when_multiple_or_none_selected():
    multi = build_mower_entities(_mower_row_with_areas({111, 222}))
    zone_multi = next(e for e in multi if e["entity_id"].endswith("_mowing_zone"))
    assert zone_multi["state"] == "all"

    none = build_mower_entities(_mower_row_with_areas(set()))
    zone_none = next(e for e in none if e["entity_id"].endswith("_mowing_zone"))
    assert zone_none["state"] == "all"


def test_no_mowing_zone_select_without_areas():
    row = MowerRow.from_snapshot(
        {
            "device_name": "Luba-TEST01",
            "name": "Robot",
            "online": True,
            "status": {"sys_status": 11, "battery": 80},
            "flags": {},
        }
    )
    entities = build_mower_entities(row)
    assert not any(e["entity_id"].endswith("_mowing_zone") for e in entities)
