"""Contract + security tests for automation_definitions._validate_action.

These tests pin down the v1/v2 (Hyve-legacy / HA-style) action shapes and the
hardening guards we apply at validation time. They run without a database or
scheduler — pure validator coverage.
"""

import pytest

from core.automation_definitions import _validate_action, AutomationValidationError


# --------------------------------------------------------------------------- #
# HA-style (canonical) service action                                         #
# --------------------------------------------------------------------------- #

def test_ha_style_service_action_normalizes_to_internal_shape():
    out = _validate_action({
        "service": "light.turn_on",
        "target": {"entity_id": "light.living"},
        "data": {"brightness": 200},
    })
    assert out == {
        "kind": "service",
        "service": "turn_on",
        "entity_id": "light.living",
        "data": {"brightness": 200},
    }


def test_ha_style_without_data_omits_data_key():
    out = _validate_action({
        "service": "switch.toggle",
        "target": {"entity_id": "switch.lamp"},
    })
    assert out == {
        "kind": "service",
        "service": "toggle",
        "entity_id": "switch.lamp",
    }


def test_ha_style_accepts_top_level_entity_id_without_target():
    # Some YAML samples drop `target` and put entity_id at the top.
    out = _validate_action({
        "service": "light.turn_off",
        "entity_id": "light.kitchen",
    })
    assert out["service"] == "turn_off"
    assert out["entity_id"] == "light.kitchen"


# --------------------------------------------------------------------------- #
# Hyve-legacy service action (kept for backward compatibility)                #
# --------------------------------------------------------------------------- #

def test_legacy_service_action_still_accepted():
    out = _validate_action({
        "service": "turn_on",
        "entity_id": "light.living",
        "data": {"brightness_pct": 50},
    })
    assert out == {
        "kind": "service",
        "service": "turn_on",
        "entity_id": "light.living",
        "data": {"brightness_pct": 50},
    }


# --------------------------------------------------------------------------- #
# Security guards                                                              #
# --------------------------------------------------------------------------- #

def test_rejects_unknown_action_verb():
    with pytest.raises(AutomationValidationError):
        _validate_action({"service": "light.delete_universe", "entity_id": "light.living"})


def test_rejects_domain_entity_mismatch():
    """`service: light.turn_on` + `entity_id: switch.pump` is suspicious — block it."""
    with pytest.raises(AutomationValidationError):
        _validate_action({
            "service": "light.turn_on",
            "target": {"entity_id": "switch.water_pump"},
        })


def test_rejects_invalid_entity_id_format():
    for bad in ["light", "light.", ".living", "light/../etc", "Light.Living", ""]:
        with pytest.raises(AutomationValidationError):
            _validate_action({"service": "turn_on", "entity_id": bad})


def test_rejects_target_area_id_until_supported():
    with pytest.raises(AutomationValidationError):
        _validate_action({
            "service": "light.turn_on",
            "target": {"area_id": "living_room"},
        })


def test_rejects_target_device_id_until_supported():
    with pytest.raises(AutomationValidationError):
        _validate_action({
            "service": "light.turn_on",
            "target": {"device_id": "abc123"},
        })


def test_rejects_target_unknown_keys():
    with pytest.raises(AutomationValidationError):
        _validate_action({
            "service": "light.turn_on",
            "target": {"entity_id": "light.living", "rogue_key": "x"},
        })


def test_rejects_non_dict_data():
    with pytest.raises(AutomationValidationError):
        _validate_action({
            "service": "light.turn_on",
            "target": {"entity_id": "light.living"},
            "data": "brightness=200",
        })


def test_rejects_data_with_nested_dict_until_supported():
    """Cap data depth to 1 to keep the executor surface tight."""
    with pytest.raises(AutomationValidationError):
        _validate_action({
            "service": "light.turn_on",
            "target": {"entity_id": "light.living"},
            "data": {"effect": {"name": "rainbow", "speed": 5}},
        })


def test_rejects_oversized_data_payload():
    huge = {"k": "x" * 10_000}
    with pytest.raises(AutomationValidationError):
        _validate_action({
            "service": "light.turn_on",
            "target": {"entity_id": "light.living"},
            "data": huge,
        })


def test_rejects_missing_entity_id():
    with pytest.raises(AutomationValidationError):
        _validate_action({"service": "light.turn_on", "target": {}})


def test_rejects_empty_service():
    with pytest.raises(AutomationValidationError):
        _validate_action({"service": "", "entity_id": "light.living"})


# --------------------------------------------------------------------------- #
# Other action kinds: ensure refactor doesn't break them                      #
# --------------------------------------------------------------------------- #

def test_notify_action_unchanged():
    assert _validate_action({"notify": {"text": "Hello"}}) == {"kind": "notify", "text": "Hello"}


def test_skill_action_unchanged():
    out = _validate_action({"skill": {"name": "weather.report", "input": {"city": "Cluj"}}})
    assert out == {"kind": "skill", "name": "weather.report", "input": {"city": "Cluj"}}


def test_scene_action_strips_prefix():
    assert _validate_action({"scene": "scene.movie_night"}) == {"kind": "scene", "scene_id": "movie_night"}


def test_delay_action_seconds_normalized():
    assert _validate_action({"delay": 5}) == {"kind": "delay", "seconds": 5}
    assert _validate_action({"delay": "00:01:30"}) == {"kind": "delay", "seconds": 90}


def test_unsupported_action_raises():
    with pytest.raises(AutomationValidationError):
        _validate_action({"completely_unknown": True})
