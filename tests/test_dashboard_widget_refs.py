"""Dashboard widget unique_id reconciliation."""

from __future__ import annotations

from routers.dashboard.store import reconcile_widget_entity_refs


def test_reconcile_widget_updates_stale_entity_id_from_unique_id():
    widget = {
        "id": "w1",
        "entity_id": "switch.releu_dormitor2_state_l3",
        "unique_id": "mqtt:relay_l3",
        "config": {
            "entities": [{
                "entity_id": "switch.releu_dormitor2_state_l3",
                "unique_id": "mqtt:relay_l3",
            }],
        },
    }
    entity_map = {
        "mqtt:relay_l3": {
            "entity_id": "switch.releu_dormitor2_n_state_l3",
            "unique_id": "mqtt:relay_l3",
        },
        "switch.releu_dormitor2_n_state_l3": {
            "entity_id": "switch.releu_dormitor2_n_state_l3",
            "unique_id": "mqtt:relay_l3",
        },
    }

    assert reconcile_widget_entity_refs(widget, entity_map) is True
    assert widget["entity_id"] == "switch.releu_dormitor2_n_state_l3"
    assert widget["config"]["entities"][0]["entity_id"] == "switch.releu_dormitor2_n_state_l3"


def test_reconcile_widget_prefers_entity_id_when_refs_conflict():
    """User changed entity in editor; stale unique_id must not win."""
    widget = {
        "id": "w2",
        "entity_id": "binary_sensor.etaj_conectivitate",
        "unique_id": "z2m:releud2:state_l3",
    }
    entity_map = {
        "z2m:releud2:state_l3": {
            "entity_id": "switch.releud2_state_l3",
            "unique_id": "z2m:releud2:state_l3",
        },
        "switch.releud2_state_l3": {
            "entity_id": "switch.releud2_state_l3",
            "unique_id": "z2m:releud2:state_l3",
        },
        "binary_sensor.etaj_conectivitate": {
            "entity_id": "binary_sensor.etaj_conectivitate",
            "unique_id": "mqtt:etaj_connectivity",
        },
    }

    assert reconcile_widget_entity_refs(widget, entity_map) is True
    assert widget["entity_id"] == "binary_sensor.etaj_conectivitate"
    assert widget["unique_id"] == "mqtt:etaj_connectivity"


def test_sync_widget_entity_ref_clears_stale_unique_id():
    from routers.dashboard.store import sync_widget_entity_ref

    widget = {
        "entity_id": "switch.new_entity",
        "unique_id": "z2m:old:state",
    }
    entity_map = {
        "switch.new_entity": {
            "entity_id": "switch.new_entity",
            "unique_id": "mqtt:new",
        },
    }
    assert sync_widget_entity_ref(widget, entity_map) is True
    assert widget["entity_id"] == "switch.new_entity"
    assert widget["unique_id"] == "mqtt:new"
