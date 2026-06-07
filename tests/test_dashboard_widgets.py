import asyncio
import copy

import pytest
from fastapi import HTTPException

from routers import dashboard


@pytest.fixture(autouse=True)
def _isolate_dashboard_store(monkeypatch):
    """Dashboard tests must never touch the real ``dashboards/`` directory."""
    memory: dict = {"pages": [], "current_page_id": "", "templates": []}

    def _load_store() -> dict:
        return {
            "pages": copy.deepcopy(memory["pages"]),
            "current_page_id": memory["current_page_id"],
            "templates": copy.deepcopy(memory["templates"]),
        }

    def _save_store(store: dict) -> None:
        memory["pages"] = copy.deepcopy(store.get("pages") or [])
        memory["current_page_id"] = str(store.get("current_page_id") or "")
        memory["templates"] = copy.deepcopy(store.get("templates") or [])

    monkeypatch.setattr(dashboard.dashboard_store, "load_store", _load_store)
    monkeypatch.setattr(dashboard.dashboard_store, "save_store", _save_store)


def _seed_dashboard_store(payload: dict) -> None:
    """Seed the in-memory dashboard file store used by tests."""
    store = dashboard._normalize_dashboard_store(payload)
    dashboard.dashboard_store.save_store(store)


def _loaded_store() -> dict:
    return dashboard.dashboard_store.load_store()


def test_infer_source_marks_zigbee_entities():
    assert dashboard._infer_source("switch.kitchen_light", "Kitchen light") == "zigbee2mqtt"
    assert dashboard._infer_source("switch.zigbee2mqtt_bridge_permit_join", "Bridge") == "zigbee2mqtt"
    assert dashboard._infer_source("z2m:living_room_lamp", "Living Room Lamp") == "zigbee2mqtt"


def test_extract_z2m_candidates_keeps_switchable_entities():
    payload = {
        "devices": [
            {"friendly_name": "Living Lamp", "state": "ON", "type": "EndDevice"},
            {"friendly_name": "Temp Sensor", "state": "OFF", "type": "Router"},
        ]
    }

    items = dashboard._extract_z2m_candidates(payload)

    assert any(item["unique_id"] == "z2m:living_lamp" for item in items)
    assert any(item["name"] == "Living Lamp" for item in items)


def test_extract_pago_candidates_exposes_info_entities():
    payload = {
        "facturi": [{"furnizor": "engie.gas", "suma_datorata": 124.5, "scadenta": "2026-04-30"}],
        "vehicule": [{"nr_inmatriculare": "B-123-ABC", "alerte": {"rca_expira": "2026-07-01 00:00", "itp_expira": "2026-09-15 00:00"}}],
        "abonament": {"activ": True, "plati_ramase": 2, "pret": 39.99},
        "conturi_facturi": [{"furnizor_nume": "Engie", "locatie": "Acasă", "ultima_plata_suma": 88.2, "ultima_plata_data": "2026-03-11 12:00", "auto_plata": True}],
        "carduri": [{"alias": "BT Gold", "last4": "4242", "tip_card": "Visa", "activ": True, "default": True}],
        "plati": [{"furnizor_nume": "Engie", "locatie": "Acasă", "suma_platita": 88.2, "data": "2026-03-11 12:00", "status": "PAID"}],
    }

    items = dashboard._extract_pago_candidates(payload)
    by_id = {item["unique_id"]: item for item in items}

    assert "pago:factura_1" in by_id
    assert by_id["pago:factura_1"]["state"] == "124.50 RON • scadentă 2026-04-30 • factură"
    assert "pago:vehicul_1" in by_id
    assert by_id["pago:vehicul_1"]["state"] == "RCA 2026-07-01 • ITP 2026-09-15"
    assert by_id["pago:abonament"]["state"] == "Activ • 2 plăți rămase • 39.99 RON"
    assert by_id["pago:cont_1"]["state"] == "88.20 RON • 2026-03-11 • autoplată"
    assert by_id["pago:card_1"]["state"] == "****4242 • Visa • implicit • activ"
    assert by_id["pago:plata_1"]["state"] == "88.20 RON • 2026-03-11 • PAID"
    assert all(item["source"] == "pago" for item in items)


def test_extract_fusion_solar_candidates_exposes_energy_entities():
    payload = {
        "summary": {
            "station_count": 1,
            "realtime_power_kw": 4.8,
            "daily_energy_kwh": 21.3,
            "lifetime_energy_kwh": 15432.1,
            "status": "online",
        }
    }

    items = dashboard._extract_fusion_solar_candidates(payload)

    assert any(item["unique_id"] == "fusion_solar:realtime_power" for item in items)
    assert any(item["unique_id"] == "fusion_solar:daily_energy" for item in items)
    assert all(item["source"] == "fusion_solar" for item in items)


def test_extract_weather_candidates_exposes_multiple_open_meteo_entities():
    payload = {
        "locations": [
            {
                "weather": {
                    "entity_id": "weather.openmeteo",
                    "friendly_name": "Arad, Romania",
                    "state": "Partly cloudy",
                    "condition": "Partly cloudy",
                    "weather_code": 2,
                    "temperature": 22.4,
                    "temperature_unit": "°C",
                    "humidity": 48,
                    "wind_speed": 11.2,
                    "wind_speed_unit": "km/h",
                    "forecast": [
                        {"datetime": "2026-04-01", "condition": "Clear sky", "temperature": 24, "templow": 13}
                    ],
                }
            },
            {
                "weather": {
                    "entity_id": "weather.openmeteo_bucharest",
                    "friendly_name": "Bucharest, Romania",
                    "state": "Rain",
                    "condition": "Rain",
                    "weather_code": 63,
                    "temperature": 18.1,
                    "temperature_unit": "°C",
                    "humidity": 72,
                    "wind_speed": 8.5,
                    "wind_speed_unit": "km/h",
                    "forecast": [
                        {"datetime": "2026-04-01", "condition": "Rain", "temperature": 19, "templow": 11}
                    ],
                }
            },
        ]
    }

    items = dashboard._extract_weather_candidates(payload, "open_meteo")

    assert len(items) == 2
    assert [item["entity_id"] for item in items] == ["weather.openmeteo", "weather.openmeteo_bucharest"]
    assert all(item["domain"] == "weather" for item in items)
    assert all(item["source"] == "open_meteo" for item in items)
    assert items[0]["attributes"]["temperature"] == 22.4
    assert items[1]["attributes"]["forecast"][0]["datetime"] == "2026-04-01"


def test_dashboard_widget_body_accepts_info_button_and_label_tiles():
    body = dashboard.DashboardWidgetBody(type="info", entity_id="sensor.living_temperature", title="Temperatură living")
    button = dashboard.DashboardWidgetBody(type="button", entity_id="switch.coffee_machine", title="Cafea")
    label = dashboard.DashboardWidgetBody(type="label", entity_id="label.dashboard_title", title="Lumini")
    weather = dashboard.DashboardWidgetBody(type="weather", entity_id="weather.openmeteo", title="Vreme")
    climate = dashboard.DashboardWidgetBody(type="climate", entity_id="climate.living_ac", title="AC Living")
    preset = dashboard.DashboardWidgetBody(type="switch_tile", renderer="button", entity_id="switch.kitchen", title="Bucătărie")
    assert body.type == "info"
    assert button.type == "button"
    assert label.type == "label"
    assert weather.type == "weather"
    assert climate.type == "climate"
    assert preset.type == "switch_tile"
    assert preset.renderer == "button"

def test_dashboard_toggle_body_accepts_climate_payload():
    body = dashboard.DashboardToggleBody(action="set_temperature", entity_id="climate.bedroom_ac", data={"temperature": 22.5})
    assert body.action == "set_temperature"
    assert body.entity_id == "climate.bedroom_ac"
    assert body.data == {"temperature": 22.5}


def test_apply_widget_patch_normalizes_multi_climate_entity_ids():
    updated = dashboard._apply_widget_patch({
        "id": "climate_card",
        "type": "climate",
        "entity_id": "climate.living_ac",
        "title": "AC",
    }, {
        "config": {
            "entities": [
                {"entity_id": "climate.living_ac", "title": "Living", "subtitle": "Jos"},
                {"entity_id": "climate.bedroom_ac", "title": "Dormitor", "subtitle": "Sus"},
                {"entity_id": "climate.living_ac", "title": "Duplicat"},
                {"entity_id": ""},
            ],
        }
    })

    assert updated["config"]["entity_ids"] == ["climate.living_ac", "climate.bedroom_ac"]
    assert updated["config"]["entities"] == [
        {"entity_id": "climate.living_ac", "title": "Living", "subtitle": "Jos"},
        {"entity_id": "climate.bedroom_ac", "title": "Dormitor", "subtitle": "Sus"},
    ]


def test_hydrate_widgets_adds_multi_climate_entities():
    widgets = [{
        "id": "climate_card",
        "type": "climate",
        "entity_id": "climate.living_ac",
        "title": "AC",
        "entity_name": "AC",
        "config": {"entities": [
            {"entity_id": "climate.living_ac", "title": "Living", "subtitle": "Parter"},
            {"entity_id": "climate.bedroom_ac", "title": "Dormitor", "subtitle": "Etaj"},
        ]},
    }]
    entities = [
        {
            "entity_id": "climate.living_ac",
            "name": "Living AC",
            "state": "cool",
            "domain": "climate",
            "unit": "°C",
            "attributes": {"current_temperature": 24, "temperature": 22},
            "controllable": True,
            "source": "midea_ac",
        },
        {
            "entity_id": "climate.bedroom_ac",
            "name": "Bedroom AC",
            "state": "heat",
            "domain": "climate",
            "unit": "°C",
            "attributes": {"current_temperature": 21, "temperature": 23},
            "controllable": True,
            "source": "midea_ac",
        },
    ]

    hydrated = dashboard._hydrate_widgets(widgets, entities)

    assert [item["entity_id"] for item in hydrated[0]["entities"]] == ["climate.living_ac", "climate.bedroom_ac"]
    assert hydrated[0]["entities"][0]["title"] == "Living"
    assert hydrated[0]["entities"][1]["subtitle"] == "Etaj"
    assert hydrated[0]["entities"][1]["current_state"] == "heat"
    assert hydrated[0]["entities"][1]["attributes"]["temperature"] == 23


def test_panel_entity_ids_includes_multi_climate_children():
    panels = [{
        "id": "main",
        "widgets": [{
            "id": "climate_card",
            "type": "climate",
            "entity_id": "climate.living_ac",
            "config": {"entity_ids": ["climate.living_ac", "climate.bedroom_ac"]},
        }],
    }]

    assert dashboard._panel_entity_ids(panels) == {"climate.living_ac", "climate.bedroom_ac"}


def test_toggle_dashboard_widget_routes_to_target_climate_entity(monkeypatch):
    calls = []

    class FakeComponent:
        async def control_entity(self, target_id, action, payload):
            calls.append((target_id, action, payload))
            return {"ok": True}

    class FakeManager:
        def get_by_entry(self, entry_id):
            return FakeComponent()
        def get(self, slug):
            return FakeComponent()

    async def fake_available_entities():
        return [
            {"entity_id": "climate.living_ac", "unique_id": "midea:living", "source": "midea_ac", "entry_id": "entry_1"},
            {"entity_id": "climate.bedroom_ac", "unique_id": "midea:bedroom", "source": "midea_ac", "entry_id": "entry_1"},
        ]

    monkeypatch.setattr(dashboard, "_dashboard_section", lambda page_id=None: {
        "panels": [{
            "widgets": [{
                "id": "climate_card",
                "type": "climate",
                "entity_id": "climate.living_ac",
                "source": "midea_ac",
                "config": {"entity_ids": ["climate.living_ac", "climate.bedroom_ac"]},
            }]
        }]
    })
    monkeypatch.setattr(dashboard, "_available_entities", fake_available_entities)
    monkeypatch.setattr(dashboard, "get_integration_manager", lambda: FakeManager())

    result = asyncio.run(dashboard.toggle_dashboard_widget(
        "climate_card",
        dashboard.DashboardToggleBody(action="set_hvac_mode", entity_id="climate.bedroom_ac", data={"hvac_mode": "heat"}),
        db=None,
        user=None,
    ))

    assert result["status"] == "ok"
    assert calls == [("midea:bedroom", "set_hvac_mode", {"hvac_mode": "heat"})]


def test_toggle_dashboard_widget_rejects_unlisted_climate_target(monkeypatch):
    monkeypatch.setattr(dashboard, "_dashboard_section", lambda page_id=None: {
        "panels": [{
            "widgets": [{
                "id": "climate_card",
                "type": "climate",
                "entity_id": "climate.living_ac",
                "source": "midea_ac",
                "config": {"entity_ids": ["climate.living_ac"]},
            }]
        }]
    })

    with pytest.raises(HTTPException) as exc:
        asyncio.run(dashboard.toggle_dashboard_widget(
            "climate_card",
            dashboard.DashboardToggleBody(action="set_hvac_mode", entity_id="climate.other_ac", data={"hvac_mode": "heat"}),
            db=None,
            user=None,
        ))

    assert exc.value.status_code == 400


def test_apply_widget_patch_resolves_custom_card_renderer_from_catalog():
    updated = dashboard._apply_widget_patch({
        "id": "abc123",
        "type": "button",
        "entity_id": "switch.kitchen",
        "title": "Kitchen",
        "entity_name": "Kitchen",
    }, {
        "type": "switch_tile",
        "renderer": "button",
        "switch_style": True,
    })

    assert updated["type"] == "switch_tile"
    assert updated["renderer"] == "button"
    assert updated["switch_style"] is True


def test_apply_widget_patch_merges_visibility_under_config_namespace():
    widget = {
        "id": "abc123",
        "type": "info",
        "entity_id": "sensor.grid",
        "title": "Flux",
        "entity_name": "Flux",
        "config": {"grid": "sensor.grid"},
    }

    updated = dashboard._apply_widget_patch(widget, {
        "visibility": {
            "enabled": True,
            "logic": "or",
            "conditions": [
                {"entity_id": "switch.coffee_machine", "operator": "is", "value": "on"},
            ],
        }
    })

    assert updated["config"]["grid"] == "sensor.grid"
    assert updated["config"]["visibility"] == {
        "enabled": True,
        "logic": "or",
        "conditions": [
            {"condition": "entity", "entity_id": "switch.coffee_machine", "operator": "is", "value": "on"},
        ],
    }


def test_hydrate_widgets_marks_visibility_true_for_matching_state_condition():
    widgets = [{
        "id": "abc123",
        "type": "button",
        "entity_id": "switch.coffee_machine",
        "title": "Cafea",
        "entity_name": "Cafea",
        "config": {
            "visibility": {
                "enabled": True,
                "logic": "and",
                "conditions": [
                    {"entity_id": "switch.coffee_machine", "operator": "is", "value": "on"},
                ],
            }
        },
    }]
    entities = [{
        "entity_id": "switch.coffee_machine",
        "state": "on",
        "domain": "switch",
        "unit": "",
        "attributes": {},
        "controllable": True,
    }]

    hydrated = dashboard._hydrate_widgets(widgets, entities)

    assert hydrated[0]["visible"] is True


def test_hydrate_widgets_marks_visibility_false_for_missing_or_failed_conditions():
    widgets = [{
        "id": "abc123",
        "type": "info",
        "entity_id": "sensor.temperature",
        "title": "Temp",
        "entity_name": "Temp",
        "config": {
            "visibility": {
                "enabled": True,
                "logic": "and",
                "conditions": [
                    {"entity_id": "sensor.temperature", "operator": ">", "value": 25},
                    {"entity_id": "switch.coffee_machine", "operator": "is", "value": "on"},
                ],
            }
        },
    }]
    entities = [{
        "entity_id": "sensor.temperature",
        "state": "22.4",
        "domain": "sensor",
        "unit": "°C",
        "attributes": {},
        "controllable": False,
    }]

    hydrated = dashboard._hydrate_widgets(widgets, entities)

    assert hydrated[0]["visible"] is False


def test_hydrate_widgets_supports_or_visibility_logic():
    widgets = [{
        "id": "abc123",
        "type": "button",
        "entity_id": "switch.kitchen",
        "title": "Kitchen",
        "entity_name": "Kitchen",
        "config": {
            "visibility": {
                "enabled": True,
                "logic": "or",
                "conditions": [
                    {"entity_id": "switch.kitchen", "operator": "is", "value": "off"},
                    {"entity_id": "sensor.temperature", "operator": ">=", "value": 20},
                ],
            }
        },
    }]
    entities = [
        {
            "entity_id": "switch.kitchen",
            "state": "on",
            "domain": "switch",
            "unit": "",
            "attributes": {},
            "controllable": True,
        },
        {
            "entity_id": "sensor.temperature",
            "state": 21,
            "domain": "sensor",
            "unit": "°C",
            "attributes": {},
            "controllable": False,
        },
    ]

    hydrated = dashboard._hydrate_widgets(widgets, entities)

    assert hydrated[0]["visible"] is True


def test_dashboard_defaults_include_title_metadata():
    section = dashboard._dashboard_section()
    assert 'title' in section
    assert 'subtitle' in section
    assert 'icon' in section
    assert 'panels' in section


def test_dashboard_section_migrates_legacy_widgets_into_single_panel():
    _seed_dashboard_store({
        "widgets": [
            {
                "id": "abc123",
                "type": "button",
                "entity_id": "switch.coffee_machine",
                "entity_name": "Coffee Machine",
                "title": "Cafea",
            }
        ]
    })

    section = dashboard._dashboard_section()

    assert len(section["panels"]) == 1
    assert section["panels"][0]["title"] == "Panou"
    assert section["panels"][0]["widgets"][0]["id"] == "abc123"


def test_dashboard_section_exposes_pages_for_legacy_dashboard():
    _seed_dashboard_store({
        "title": "Control",
        "subtitle": "Acasă",
        "icon": "fa-house",
        "panels": [
            {
                "id": "panel_1",
                "title": "Lumini",
                "widgets": [],
            }
        ],
    })

    section = dashboard._dashboard_section()

    assert section["page_id"] == "dashboard_home"
    assert section["current_page_id"] == "dashboard_home"
    assert len(section["pages"]) == 1
    assert section["pages"][0]["title"] == "Control"
    assert section["pages"][0]["icon"] == "fas fa-house"


def test_dashboard_section_reads_requested_page_from_pages_store():
    _seed_dashboard_store({
        "current_page_id": "energy",
        "pages": [
            {
                "id": "dashboard_home",
                "title": "Acasă",
                "subtitle": "Principal",
                "icon": "fa-house",
                "panels": [],
            },
            {
                "id": "energy",
                "title": "Energie",
                "subtitle": "Solar",
                "icon": "fa-bolt",
                "panels": [
                    {
                        "id": "panel_energy",
                        "title": "Consum",
                        "widgets": [],
                    }
                ],
            },
        ],
    })

    section = dashboard._dashboard_section("energy")

    assert section["page_id"] == "energy"
    assert section["title"] == "Energie"
    assert section["subtitle"] == "Solar"
    assert section["panels"][0]["id"] == "panel_energy"


def test_save_dashboard_persists_updated_page_inside_pages_store():
    _seed_dashboard_store({
        "current_page_id": "dashboard_home",
        "pages": [
            {
                "id": "dashboard_home",
                "title": "Acasă",
                "subtitle": "Principal",
                "icon": "fa-house",
                "preferences": {"layout_mode": "comfortable", "show_unavailable": True, "filter_mode": "all"},
                "panels": [],
            },
            {
                "id": "energy",
                "title": "Energie",
                "subtitle": "Solar",
                "icon": "fa-bolt",
                "preferences": {"layout_mode": "compact", "show_unavailable": False, "filter_mode": "all"},
                "panels": [],
            },
        ],
    })

    dashboard._save_dashboard({
        "pages": [
            {
                "id": "dashboard_home",
                "title": "Acasă",
                "subtitle": "Principal",
                "icon": "fa-house",
                "preferences": dashboard._DEFAULT_PREFS,
                "panels": [],
            },
            {
                "id": "energy",
                "title": "Energie solară",
                "subtitle": "Acum",
                "icon": "fa-solar-panel",
                "preferences": {"layout_mode": "compact", "show_unavailable": False, "filter_mode": "all"},
                "panels": [{"id": "panel_energy", "title": "Consum", "widgets": []}],
            },
        ],
        "page_id": "energy",
        "current_page_id": "energy",
        "title": "Energie solară",
        "subtitle": "Acum",
        "icon": "fa-solar-panel",
        "preferences": {"layout_mode": "compact", "show_unavailable": False, "filter_mode": "all"},
        "panels": [{"id": "panel_energy", "title": "Consum", "widgets": []}],
    }, "energy")

    stored = _loaded_store()
    assert stored["current_page_id"] == "energy"
    assert len(stored["pages"]) == 2
    assert stored["pages"][1]["title"] == "Energie solară"
    assert stored["pages"][1]["icon"] == "fas fa-solar-panel"


def test_save_dashboard_can_persist_brand_new_blank_page():
    _seed_dashboard_store({
        "current_page_id": "dashboard_home",
        "pages": [
            {
                "id": "dashboard_home",
                "title": "Acasă",
                "subtitle": "Principal",
                "icon": "fa-house",
                "preferences": dashboard._DEFAULT_PREFS,
                "panels": [{"id": "panel_1", "title": "Lumini", "widgets": []}],
            }
        ],
    })

    new_page = dashboard._make_page(
        title="Birou",
        subtitle="Nou",
        icon="fa-briefcase",
        panels=[],
        preferences=dashboard._DEFAULT_PREFS,
        page_id="birou",
    )

    dashboard._save_dashboard(
        {
            **dashboard._dashboard_section(),
            "pages": [dashboard._dashboard_section()["pages"][0], new_page],
            "page_id": "birou",
            "current_page_id": "birou",
            "title": new_page["title"],
            "subtitle": new_page["subtitle"],
            "icon": new_page["icon"],
            "preferences": new_page["preferences"],
            "panels": [],
        },
        "birou",
    )

    stored_new_page = next(page for page in _loaded_store()["pages"] if page["id"] == "birou")
    assert stored_new_page["panels"] == []
    assert stored_new_page["title"] == "Birou"


def test_reorder_dashboard_page_moves_page_before_target():
    _seed_dashboard_store({
        "current_page_id": "dashboard_home",
        "pages": [
            {"id": "dashboard_home", "title": "Acasă", "panels": []},
            {"id": "birou", "title": "Birou", "panels": []},
            {"id": "solar", "title": "Solar", "panels": []},
        ],
    })

    section = dashboard._dashboard_section()
    pages = list(section["pages"])
    moved = pages.pop(2)
    pages.insert(1, moved)
    dashboard._save_dashboard({**section, "pages": pages, "current_page_id": "dashboard_home"}, "dashboard_home")

    assert [page["id"] for page in _loaded_store()["pages"]] == ["dashboard_home", "solar", "birou"]


def test_reorder_dashboard_page_moves_page_down_when_target_is_next():
    _seed_dashboard_store({
        "current_page_id": "dashboard_home",
        "pages": [
            {"id": "dashboard_home", "title": "Acasă", "panels": []},
            {"id": "birou", "title": "Birou", "panels": []},
            {"id": "solar", "title": "Solar", "panels": []},
        ],
    })

    result = asyncio.run(
        dashboard.reorder_dashboard_page(
            "dashboard_home",
            dashboard.DashboardReorderBody(target_id="birou"),
            None,
        )
    )

    assert [page["id"] for page in _loaded_store()["pages"]] == ["birou", "dashboard_home", "solar"]
    assert [page["id"] for page in result["pages"]] == ["birou", "dashboard_home", "solar"]


def test_delete_dashboard_page_rejects_last_remaining_page():
    _seed_dashboard_store({
        "current_page_id": "dashboard_home",
        "pages": [
            {"id": "dashboard_home", "title": "Acasă", "panels": []},
        ],
    })

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(dashboard.delete_dashboard_page("dashboard_home", None))

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == {"key": "dashboard.min_one_page"}


def test_delete_dashboard_page_keeps_current_page_when_deleting_another():
    _seed_dashboard_store({
        "current_page_id": "solar",
        "pages": [
            {"id": "dashboard_home", "title": "Acasă", "panels": []},
            {"id": "birou", "title": "Birou", "panels": []},
            {"id": "solar", "title": "Solar", "panels": []},
        ],
    })

    result = asyncio.run(dashboard.delete_dashboard_page("birou", None))

    stored = _loaded_store()
    assert [page["id"] for page in stored["pages"]] == ["dashboard_home", "solar"]
    assert stored["current_page_id"] == "solar"
    assert result["current_page_id"] == "solar"


def test_apply_widget_patch_updates_visual_editor_fields():
    widget = {
        "id": "abc123",
        "type": "switch",
        "entity_id": "switch.coffee_machine",
        "entity_name": "Coffee Machine",
        "title": "Cafea",
        "source": "zigbee2mqtt",
        "icon": "",
        "color": "",
        "size": "md",
        "favorite": False,
    }

    updated = dashboard._apply_widget_patch(widget, {
        "type": "label",
        "entity_id": "label.section_title",
        "entity_name": "",
        "title": "Lumini",
        "size": "wide",
        "color": "#ff8800",
        "show_background": True,
        "switch_style": True,
    })

    assert updated["id"] == "abc123"
    assert updated["type"] == "label"
    assert updated["title"] == "Lumini"
    assert updated["entity_name"] == ""
    assert updated["size"] == "wide"
    assert updated["color"] == "#ff8800"
    assert updated["show_background"] is True
    assert updated["switch_style"] is True


def test_normalize_panel_record_keeps_size_metadata():
    panel = dashboard._normalize_panel_record({
        "id": "panel_1",
        "title": "Acasă",
        "size": "md",
        "icon": "fa-house",
        "col_start": 9,
        "row_start": 3,
        "row_span": 5,
        "widgets": [],
    })

    assert panel["size"] == "md"
    assert panel["icon"] == "fas fa-house"
    assert panel["col_start"] == 9
    assert panel["row_start"] == 3
    assert panel["row_span"] == 5


def test_hydrate_panels_keeps_size_metadata():
    panels = dashboard._hydrate_panels([
        {
            "id": "panel_1",
            "title": "Lumini",
            "size": "sm",
            "icon": "fas fa-lightbulb",
            "col_start": 5,
            "row_start": 7,
            "row_span": 3,
            "widgets": [],
        }
    ], [])

    assert panels[0]["size"] == "sm"
    assert panels[0]["icon"] == "fas fa-lightbulb"
    assert panels[0]["col_start"] == 5
    assert panels[0]["row_start"] == 7
    assert panels[0]["row_span"] == 3
    assert panels[0]["kind"] == "panel"


def test_normalize_icon_accepts_fa_short_form():
    assert dashboard._normalize_icon("fa-bolt") == "fas fa-bolt"
    assert dashboard._normalize_icon("fa-solid fa-house") == "fa-solid fa-house"
    assert dashboard._normalize_icon("not-an-icon", "fas fa-table-cells-large") == "fas fa-table-cells-large"


def test_normalize_entities_includes_sensor_cards_for_dashboard():
    states = [
        {"entity_id": "sensor.living_temperature", "state": "23", "attributes": {"friendly_name": "Living Temperature"}},
        {"entity_id": "switch.coffee_machine", "state": "off", "attributes": {"friendly_name": "Coffee Machine"}},
    ]

    items = dashboard._normalize_entities(states, [])

    assert any(item["entity_id"] == "sensor.living_temperature" for item in items)
    assert any(item["entity_id"] == "switch.coffee_machine" for item in items)
