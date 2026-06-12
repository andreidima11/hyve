"""Smart home registry — lawn_mower domain."""

from core.smart_home_registry import (
    is_controllable_domain,
    is_visible_domain,
    make_entity_id,
    normalize_entity_record,
)


def test_lawn_mower_is_controllable_and_visible():
    assert is_controllable_domain("lawn_mower")
    assert is_visible_domain("lawn_mower")


def test_normalize_keeps_lawn_mower_domain():
    record = {
        "entity_id": "mammotion:Luba-1",
        "domain": "lawn_mower",
        "source": "mammotion",
    }
    normalize_entity_record(record, default_source="mammotion")
    assert record["domain"] == "lawn_mower"
    assert record["entity_id"].startswith("lawn_mower.")


def test_make_entity_id_lawn_mower():
    assert make_entity_id("lawn_mower", "mammotion", "luba_1") == "lawn_mower.mammotion_luba_1"
