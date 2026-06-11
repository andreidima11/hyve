import pytest

from integrations import config_entries
from core import sqlite_sidecar
from core.ui_catalog import (
    _CATALOG_PATH,
    dashboard_card_catalog,
    integration_catalog,
    resolve_dashboard_card,
)


def test_ui_catalog_json_lives_at_repo_root():
    assert _CATALOG_PATH.name == "ui_catalog.json"
    assert _CATALOG_PATH.is_file()
    entries = integration_catalog()
    slugs = {entry["slug"] for entry in entries}
    assert "waha" in slugs
    assert "comfyui" in slugs


def test_integration_catalog_has_i18n_keys_for_all_entries():
    entries = integration_catalog()
    assert len(entries) >= 19
    for entry in entries:
        slug = entry["slug"]
        assert entry.get("title_key") == f"config.{slug}_section"
        assert entry.get("description_key") == f"integrations.catalog.{slug}_desc"


def test_integration_catalog_orders_are_unique():
    entries = integration_catalog()
    orders = [entry["order"] for entry in entries]
    assert len(orders) == len(set(orders))


# Bundled components without a settings row (internal helpers).
_CATALOG_OPTIONAL_SLUGS = frozenset({"sun", "hyve_scenes", "forge"})


def test_catalog_covers_user_facing_components():
    from pathlib import Path

    components_dir = Path(__file__).resolve().parent.parent / "components"
    component_slugs = {
        p.name
        for p in components_dir.iterdir()
        if p.is_dir() and not p.name.startswith("_")
    }
    catalog_slugs = {entry["slug"] for entry in integration_catalog()}
    missing = sorted(component_slugs - catalog_slugs - _CATALOG_OPTIONAL_SLUGS)
    assert not missing, f"components missing from ui_catalog.json: {missing}"


@pytest.fixture()
def isolated_entries_db(tmp_path, monkeypatch):
    db_path = tmp_path / "integration_entries.sqlite"
    monkeypatch.setattr(config_entries, "_DB_PATH", db_path)
    sqlite_sidecar.reset_initialized()
    config_entries._init()
    yield db_path
    sqlite_sidecar.reset_initialized()


def test_dashboard_card_catalog_exposes_catalog_entries():
    cards = dashboard_card_catalog()
    ids = {entry["id"] for entry in cards}

    assert "button" in ids
    assert "switch_tile" in ids
    assert any(entry["renderer"] == "button" for entry in cards if entry["id"] == "switch_tile")


def test_resolve_dashboard_card_keeps_preset_type_but_uses_renderer():
    resolved = resolve_dashboard_card("switch_tile")

    assert resolved["id"] == "switch_tile"
    assert resolved["renderer"] == "button"
    assert resolved["supports_switch_style"] is True


def test_resolve_dashboard_card_ignores_stale_generic_renderer_on_dedicated_type():
    resolved = resolve_dashboard_card("fusion_solar", "button")

    assert resolved["id"] == "fusion_solar"
    assert resolved["renderer"] == "fusion_solar"


def test_resolve_dashboard_card_maps_removed_weather_gradient_alias():
    resolved = resolve_dashboard_card("weather_gradient", "weather_gradient")

    assert resolved["id"] == "weather"
    assert resolved["renderer"] == "weather"


def test_integration_catalog_includes_sync_capable_sources():
    entries = integration_catalog()
    by_slug = {entry["slug"]: entry for entry in entries}

    assert "pago" in by_slug
    assert by_slug["pago"]["supports_sync"] is True


def test_integration_catalog_marks_config_schema_availability():
    entries = integration_catalog()
    by_slug = {entry["slug"]: entry for entry in entries}

    assert "piper" in by_slug
    assert by_slug["piper"]["has_config_schema"] is True

    assert "mosquitto" in by_slug
    assert by_slug["mosquitto"]["has_config_schema"] is True


def test_integration_catalog_enabled_follows_config_entries(isolated_entries_db, monkeypatch):
    config_entries.create_entry(
        slug="open_meteo",
        title="Meteo",
        data={"latitude": 44.0, "longitude": 26.0},
        schema=[],
        enabled=True,
    )
    import core.settings as settings

    monkeypatch.setitem(
        settings.CFG,
        "open_meteo",
        {"enabled": False, "latitude": 44.0, "longitude": 26.0},
    )
    by_slug = {entry["slug"]: entry for entry in integration_catalog()}
    assert by_slug["open_meteo"]["enabled"] is True