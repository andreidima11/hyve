from core import event_bus
from core.state_observer import TOPIC_STATE_CHANGED, _publish_diffs


def test_publish_diffs_emits_changed_and_new_entities():
    received = []
    handler_id = "test_state_observer_changed_and_new"
    event_bus.subscribe(TOPIC_STATE_CHANGED, handler_id, received.append)
    try:
        fired = _publish_diffs(
            {
                "switch.existing": {"entity_id": "switch.existing", "state": "off"},
                "switch.same": {"entity_id": "switch.same", "state": "on"},
            },
            {
                "switch.existing": {"entity_id": "switch.existing", "state": "on"},
                "switch.same": {"entity_id": "switch.same", "state": "on"},
                "switch.new": {"entity_id": "switch.new", "state": "on"},
            },
        )
    finally:
        event_bus.unsubscribe(TOPIC_STATE_CHANGED, handler_id)

    assert fired == 2
    assert [item["entity_id"] for item in received] == ["switch.existing", "switch.new"]
    assert received[0]["old_state"] == "off"
    assert received[0]["new_state"] == "on"
    assert received[1]["old_state"] is None
    assert received[1]["new_state"] == "on"