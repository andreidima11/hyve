import pytest

from core.dashboard.entity_routing import resolve_entity_effective_renderer


def test_entity_routes_sensor_domain():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "sensor.temp"})

    assert resolved["renderer"] == "sensor"
    assert resolved["switch_style"] is False


def test_entity_routes_number_domain():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "number.brightness"})

    assert resolved["renderer"] == "number"


def test_entity_routes_select_domain():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "select.mode"})

    assert resolved["renderer"] == "select"


def test_entity_routes_light_domain():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "light.kitchen"})

    assert resolved["renderer"] == "light"
    assert resolved["switch_style"] is False


def test_entity_routes_climate_domain():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "climate.living"})

    assert resolved["renderer"] == "climate"


def test_entity_routes_switch_domain_without_toggle_ui():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "switch.lamp"})

    assert resolved["renderer"] == "switch"
    assert resolved["switch_style"] is False


def test_entity_routes_cover_domain_to_tile():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "cover.garage"})

    assert resolved["renderer"] == "tile"
    assert resolved["switch_style"] is False


def test_entity_routes_read_only_to_info():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "person.andrei"})

    assert resolved["renderer"] == "info"


def test_entity_routes_lawn_mower_domain():
    resolved = resolve_entity_effective_renderer({"type": "entity", "entity_id": "lawn_mower.luba"})

    assert resolved["renderer"] == "lawn_mower"
    assert resolved["switch_style"] is False


def test_entity_keeps_explicit_renderer():
    resolved = resolve_entity_effective_renderer({
        "type": "entity",
        "entity_id": "sensor.temp",
        "renderer": "gauge",
    })

    assert resolved["renderer"] == "gauge"
