"""Tests for the static automation schema introspection (describe_schema)."""

from core.automation_definitions import describe_schema


def test_describe_schema_has_expected_top_level_keys():
    schema = describe_schema()
    assert set(schema.keys()) >= {
        "version", "modes", "weekdays",
        "trigger_platforms", "condition_kinds", "action_kinds",
        "service",
    }
    assert "channels" not in schema


def test_describe_schema_modes_match_validator():
    assert set(describe_schema()["modes"]) == {"single", "restart", "queued", "parallel"}


def test_describe_schema_service_section_pins_security_contract():
    svc = describe_schema()["service"]
    verbs = set(svc["verbs"])
    assert {"turn_on", "turn_off", "toggle", "set"}.issubset(verbs)
    assert svc["data_max_bytes"] == 4096
    assert svc["supports_target_keys"] == ["entity_id"]
    assert "area_id" in svc["rejected_target_keys"]
    assert "device_id" in svc["rejected_target_keys"]


def test_describe_schema_lists_all_supported_action_kinds():
    kinds = set(describe_schema()["action_kinds"])
    assert kinds >= {"service", "scene", "skill", "notify", "delay",
                     "wait_template", "repeat", "choose"}


def test_describe_schema_lists_all_supported_trigger_platforms():
    platforms = set(describe_schema()["trigger_platforms"])
    assert platforms >= {"time", "datetime", "interval", "state", "numeric_state",
                         "template", "sun", "event", "time_pattern"}


def test_describe_schema_is_pure_data_no_side_effects():
    """Calling twice must return equal payloads (no mutable global state)."""
    assert describe_schema() == describe_schema()
