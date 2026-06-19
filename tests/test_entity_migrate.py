import pytest

from core.dashboard.entity_migrate import migrate_legacy_widget_type


def test_migrate_legacy_button_preset():
    assert migrate_legacy_widget_type({"type": "button"})["type"] == "entity"


def test_migrate_legacy_switch_tile_preset():
    out = migrate_legacy_widget_type({"type": "switch_tile"})
    assert out["type"] == "entity"
    assert out["switch_style"] is True


def test_migrate_legacy_light_preset():
    assert migrate_legacy_widget_type({"type": "light"})["type"] == "entity"


def test_migrate_entity_unchanged():
    out = migrate_legacy_widget_type({"type": "entity", "entity_id": "sensor.x"})
    assert out["type"] == "entity"
