from ui_catalog import dashboard_card_catalog, integration_catalog, resolve_dashboard_card


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


def test_integration_catalog_includes_sync_capable_sources():
    entries = integration_catalog()
    by_slug = {entry["slug"]: entry for entry in entries}

    assert "pago" in by_slug
    assert by_slug["pago"]["supports_sync"] is True


def test_integration_catalog_marks_config_schema_availability():
    entries = integration_catalog()
    by_slug = {entry["slug"]: entry for entry in entries}

    assert "piper" in by_slug
    assert by_slug["piper"]["has_config_schema"] is False

    assert "mosquitto" in by_slug
    assert by_slug["mosquitto"]["has_config_schema"] is True