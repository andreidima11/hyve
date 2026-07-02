"""Dashboard card interactions and YAML format tests."""

from __future__ import annotations

from core.dashboard.interactions import (
    default_interactions_for_widget,
    normalize_interactions,
    resolve_effective_interaction,
    widget_is_interactive,
)
from core.dashboard.normalize import _normalize_widget_record
from core.dashboard.yaml_format import (
    page_section_to_yaml_dict,
    prepare_yaml_widget_for_store,
    widget_to_yaml_dict,
)


def test_switch_defaults_to_toggle_on_tap():
    widget = {"type": "entity", "entity_id": "switch.kitchen", "domain": "switch"}
    assert resolve_effective_interaction(widget, "tap")["action"] == "toggle"
    assert resolve_effective_interaction(widget, "double_tap")["action"] == "more_info"


def test_light_defaults_to_toggle_on_tap():
    widget = {"type": "entity", "entity_id": "light.living", "domain": "light", "renderer": "light"}
    assert resolve_effective_interaction(widget, "tap")["action"] == "toggle"
    assert resolve_effective_interaction(widget, "double_tap")["action"] == "more_info"
    assert resolve_effective_interaction(widget, "hold")["action"] == "more_info"


def test_sensor_numeric_defaults_to_history_on_tap():
    widget = {"type": "entity", "entity_id": "sensor.temperature", "domain": "sensor", "renderer": "sensor"}
    assert resolve_effective_interaction(widget, "tap")["action"] == "history"


def test_stored_interactions_override_defaults():
    widget = {
        "type": "entity",
        "entity_id": "switch.kitchen",
        "domain": "switch",
        "config": {
            "interactions": {
                "tap": {"action": "more_info"},
            },
        },
    }
    assert resolve_effective_interaction(widget, "tap")["action"] == "more_info"


def test_normalize_persists_interactions_in_config():
    raw = {
        "type": "entity",
        "entity_id": "switch.kitchen",
        "interactions": {
            "hold": {"action": "history", "hours": 6},
        },
    }
    normalized = _normalize_widget_record(raw)
    interactions = normalized["config"]["interactions"]
    assert interactions["hold"]["action"] == "history"
    assert interactions["hold"]["hours"] == 6


def test_yaml_widget_roundtrip_hoists_interactions():
    widget = _normalize_widget_record({
        "id": "w1",
        "type": "entity",
        "entity_id": "switch.kitchen",
        "config": {
            "interactions": {
                "tap": {"action": "more_info"},
            },
        },
    })
    yaml_widget = widget_to_yaml_dict(widget)
    assert yaml_widget["interactions"]["tap"]["action"] == "more_info"
    restored = prepare_yaml_widget_for_store(yaml_widget)
    assert restored["config"]["interactions"]["tap"]["action"] == "more_info"


def test_yaml_omits_default_interactions():
    widget = _normalize_widget_record({
        "id": "w2",
        "type": "entity",
        "entity_id": "switch.kitchen",
        "domain": "switch",
    })
    yaml_widget = widget_to_yaml_dict(widget)
    assert "interactions" not in yaml_widget


def test_page_yaml_projects_panels_and_widgets():
    section = {
        "page_id": "home",
        "title": "Home",
        "subtitle": "",
        "icon": "",
        "columns": 0,
        "theme": "",
        "parent_page_id": "",
        "preferences": {},
        "panels": [{
            "id": "panel_1",
            "title": "Main",
            "widgets": [{
                "id": "abc",
                "type": "entity",
                "entity_id": "sensor.temp",
                "domain": "sensor",
                "renderer": "sensor",
            }],
        }],
    }
    data = page_section_to_yaml_dict(section)
    assert data["id"] == "home"
    assert data["panels"][0]["widgets"][0]["entity_id"] == "sensor.temp"
    assert widget_is_interactive({"entity_id": "sensor.temp", "renderer": "sensor"}) is True


def test_normalize_interactions_rejects_unknown_action():
    parsed = normalize_interactions({"tap": {"action": "explode"}})
    assert parsed is None


def test_normalize_persists_perform_and_confirmation():
    parsed = normalize_interactions({
        "double_tap": {"action": "perform_action", "perform": "unlock"},
        "tap": {"action": "toggle", "confirmation": True},
    })
    assert parsed is not None
    assert parsed["double_tap"]["perform"] == "unlock"
    assert parsed["tap"]["confirmation"] is True


def test_scene_defaults_to_perform_on_tap():
    widget = {"type": "entity", "entity_id": "scene.evening", "domain": "scene", "renderer": "scene"}
    assert resolve_effective_interaction(widget, "tap")["action"] == "perform_action"


def test_normalize_persists_navigate_and_url():
    parsed = normalize_interactions({
        "tap": {"action": "navigate", "page_id": "kitchen"},
        "hold": {"action": "url", "url": "https://example.com"},
    })
    assert parsed is not None
    assert parsed["tap"]["page_id"] == "kitchen"
    assert parsed["hold"]["url"] == "https://example.com"
