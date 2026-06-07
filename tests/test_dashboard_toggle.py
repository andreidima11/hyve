"""Dashboard widget toggle routing helpers."""

from __future__ import annotations

import asyncio

from routers import dashboard


def test_normalize_widget_control_action_prefers_desired_state():
    assert dashboard._normalize_widget_control_action(
        "toggle",
        entity_snapshot={"state": "off"},
        desired_state="on",
    ) == "turn_on"
    assert dashboard._normalize_widget_control_action(
        "",
        entity_snapshot={"state": "on"},
        desired_state="off",
    ) == "turn_off"


def test_normalize_widget_control_action_infers_from_entity_state():
    assert dashboard._normalize_widget_control_action(
        "toggle",
        entity_snapshot={"state": "on"},
        desired_state=None,
    ) == "turn_off"
    assert dashboard._normalize_widget_control_action(
        "toggle",
        entity_snapshot={"state": "off"},
        desired_state=None,
    ) == "turn_on"


def test_primary_widget_entity_id_falls_back_to_config_entities():
    widget = {
        "id": "w1",
        "config": {"entities": [{"entity_id": "switch.relay_state_l3"}]},
    }
    assert dashboard._primary_widget_entity_id(widget) == "switch.relay_state_l3"


def test_expand_entity_id_aliases_accepts_unique_id():
    allowed = dashboard._expand_entity_id_aliases(
        {"switch.relay_state_l3"},
        [{
            "entity_id": "switch.relay_state_l3",
            "unique_id": "z2m:0xa4c138fe8b1226ab:state_l3",
            "source": "mosquitto",
        }],
    )
    assert "z2m:0xa4c138fe8b1226ab:state_l3" in allowed


def test_toggle_mosquitto_switch_sends_turn_on(monkeypatch):
    calls = []

    class FakeMosquitto:
        async def control_entity(self, target_id, action, payload):
            calls.append((target_id, action, payload))
            return {"ok": True}

    class FakeManager:
        def get_by_entry(self, entry_id):
            return FakeMosquitto()

        def get(self, slug):
            return FakeMosquitto() if slug == "mosquitto" else None

        def entries_for(self, slug):
            return [FakeMosquitto()] if slug == "mosquitto" else []

    async def fake_available_entities():
        return [{
            "entity_id": "switch.relay_state_l3",
            "unique_id": "z2m:0xa4c138fe8b1226ab:state_l3",
            "source": "mosquitto",
            "entry_id": "mqtt_entry",
            "state": "off",
            "domain": "switch",
            "controllable": True,
        }]

    monkeypatch.setattr(dashboard, "_dashboard_section", lambda page_id=None: {
        "panels": [{
            "widgets": [{
                "id": "fe794909",
                "type": "switch",
                "renderer": "switch",
                "entity_id": "switch.relay_state_l3",
                "source": "mosquitto",
                "switch_style": True,
            }]
        }]
    })
    monkeypatch.setattr(dashboard, "_available_entities", fake_available_entities)
    monkeypatch.setattr(dashboard, "get_integration_manager", lambda: FakeManager())

    result = asyncio.run(dashboard.toggle_dashboard_widget(
        "fe794909",
        dashboard.DashboardToggleBody(desired_state="on", action="toggle"),
        page_id="acasa",
        db=None,
        user=None,
    ))

    assert result["status"] == "ok"
    assert result["action"] == "turn_on"
    assert calls == [("z2m:0xa4c138fe8b1226ab:state_l3", "turn_on", None)]
